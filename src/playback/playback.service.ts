import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createReadStream, existsSync, statSync } from 'fs';
import { basename, isAbsolute, join, resolve } from 'path';
import { Repository } from 'typeorm';
import {
  minioConfig,
  playbackConfig,
  qbittorrentConfig,
} from '../core/config/config';
import { MinioService } from '../storage/minio.service';
import { CreatePlaybackDto } from './dto/create-playback.dto';
import { AutoPlaybackDto } from './dto/auto-playback.dto';
import {
  PlaybackSession,
  PlaybackStatus,
} from './entities/playback-session.entity';
import { QbittorrentService } from './qbittorrent.service';
import { MagnetSearchService } from './magnet-search.service';

@Injectable()
export class PlaybackService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PlaybackService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @InjectRepository(PlaybackSession)
    private readonly sessionRepo: Repository<PlaybackSession>,
    private readonly qb: QbittorrentService,
    private readonly minio: MinioService,
    private readonly magnetSearch: MagnetSearchService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => {
      this.pollActiveSessions().catch((e) =>
        this.logger.warn(`poll: ${e instanceof Error ? e.message : e}`),
      );
    }, playbackConfig.pollIntervalMs);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async qbHealth() {
    if (!this.qb.isEnabled()) {
      return { ok: false, message: 'QB_ENABLED=false' };
    }
    return this.qb.healthCheck();
  }

  /**
   * 按关键词+集数搜磁力，并创建播放会话（一键点集播放）
   */
  async createFromEpisode(userId: string, dto: AutoPlaybackDto) {
    this.qb.assertEnabled();
    const best = await this.magnetSearch.pickBest({
      keyword: dto.keyword,
      episodeSort: dto.episodeSort,
      altKeywords: dto.altKeyword ? [dto.altKeyword] : [],
    });
    if (!best) {
      throw new BadRequestException(
        `未找到「${dto.keyword}」第 ${dto.episodeSort} 话的磁力资源，可手动粘贴 magnet`,
      );
    }
    this.logger.log(
      `auto magnet: ep=${dto.episodeSort} score=${best.score} ${best.title}`,
    );
    return this.create(userId, {
      uri: best.uri,
      bangumiId: dto.bangumiId,
      episodeSort: dto.episodeSort,
      fileIndex: dto.fileIndex,
    });
  }

  async searchMagnets(keyword: string, episodeSort: number, alt?: string) {
    return this.magnetSearch.searchForEpisode({
      keyword,
      episodeSort,
      altKeywords: alt ? [alt] : [],
    });
  }

  async create(userId: string, dto: CreatePlaybackDto) {
    this.qb.assertEnabled();
    const uri = (dto.uri || '').trim();
    if (!uri.startsWith('magnet:') && !/^https?:\/\//i.test(uri)) {
      throw new BadRequestException('uri 须为 magnet: 或 http(s) 种子链接');
    }

    const session = this.sessionRepo.create({
      user_id: userId,
      bangumi_id: dto.bangumiId ?? null,
      episode_sort: dto.episodeSort ?? null,
      source_uri: uri,
      status: 'fetching',
      file_index: dto.fileIndex ?? -1,
    });
    await this.sessionRepo.save(session);

    try {
      const hash = await this.qb.addMagnetOrUrl(uri);
      session.info_hash = hash;
      session.status = 'downloading';

      // 等待 metadata
      let files = await this.qb.getFiles(hash);
      for (let i = 0; i < 20 && !files.length; i++) {
        await this.sleep(1500);
        files = await this.qb.getFiles(hash);
      }
      if (!files.length) {
        throw new BadRequestException('种子无文件列表（metadata 超时）');
      }

      let file =
        dto.fileIndex != null
          ? files.find((f) => f.index === dto.fileIndex)
          : this.qb.pickBestVideoFile(files);
      if (!file) {
        throw new BadRequestException('未找到可播放的视频文件');
      }

      await this.qb.setOnlyFile(hash, file.index);
      session.file_index = file.index;
      session.file_name = file.name;
      session.size_bytes = String(file.size);
      session.local_path = this.resolveLocalPath(hash, file.name);
      await this.sessionRepo.save(session);
    } catch (e) {
      session.status = 'failed';
      session.error_message =
        e instanceof Error ? e.message : '创建播放会话失败';
      await this.sessionRepo.save(session);
      throw e;
    }

    return this.toView(session);
  }

  async getSession(id: string, userId: string) {
    const session = await this.findOwned(id, userId);
    // 同步一次进度
    await this.refreshOne(session);
    return this.toView(session);
  }

  async listFiles(id: string, userId: string) {
    const session = await this.findOwned(id, userId);
    if (!session.info_hash) return [];
    return this.qb.getFiles(session.info_hash);
  }

  /**
   * 打开可读流（支持 Range）。优先本地 BT 目录，其次 MinIO。
   */
  async openStream(
    id: string,
    userId: string,
    rangeHeader?: string,
  ): Promise<{
    stream: NodeJS.ReadableStream;
    contentType: string;
    size: number;
    start: number;
    end: number;
    partial: boolean;
  }> {
    const session = await this.findOwned(id, userId);
    await this.refreshOne(session);

    if (session.status === 'failed') {
      throw new BadRequestException(session.error_message || '播放失败');
    }
    if (
      session.status !== 'playable' &&
      session.status !== 'ready' &&
      session.status !== 'downloading'
    ) {
      throw new BadRequestException('资源尚未可播，请稍候');
    }

    // 出流优先级：本地 BT 目录（边下边播）→ MinIO 完整缓存（二次播放/清盘后）
    const local = session.local_path;
    if (local && existsSync(local)) {
      const st = statSync(local);
      const size = st.size;
      if (size < 1024) {
        throw new BadRequestException('文件过小，仍在缓冲');
      }
      // 边下边播：至少达到阈值
      if (
        session.status === 'downloading' &&
        size < playbackConfig.playableMinBytes
      ) {
        throw new BadRequestException('缓冲不足，请稍候');
      }

      return this.buildRangeFromSize(
        size,
        rangeHeader,
        (start, end) => createReadStream(local, { start, end }),
        this.guessContentType(session.file_name),
      );
    }

    if (session.minio_object) {
      const stat = await this.minio.getObjectStat(session.minio_object);
      const size = stat.size || 0;
      if (!size) {
        throw new BadRequestException('MinIO 对象大小为 0');
      }
      // 完整对象支持 Range（getPartialObject）
      let start = 0;
      let end = size - 1;
      let partial = false;
      if (rangeHeader) {
        const parsed = this.parseRange(rangeHeader, size);
        start = parsed.start;
        end = parsed.end;
        partial = parsed.partial;
      }
      const length = end - start + 1;
      const stream = partial
        ? await this.minio.getObjectPartial(session.minio_object, start, length)
        : await this.minio.getObjectStream(session.minio_object);
      return {
        stream,
        contentType: this.guessContentType(session.file_name),
        size,
        start,
        end,
        partial,
      };
    }

    throw new BadRequestException('文件尚未落地，请稍候');
  }

  private async findOwned(id: string, userId: string) {
    const session = await this.sessionRepo.findOne({ where: { id } });
    if (!session || session.user_id !== userId) {
      throw new NotFoundException('播放会话不存在');
    }
    return session;
  }

  private async pollActiveSessions() {
    if (!this.qb.isEnabled()) return;
    const list = await this.sessionRepo
      .createQueryBuilder('s')
      .where('s.status IN (:...st)', {
        st: ['fetching', 'downloading', 'playable'],
      })
      .orderBy('s.update_time', 'DESC')
      .take(30)
      .getMany();
    for (const s of list) {
      try {
        await this.refreshOne(s);
      } catch (e) {
        this.logger.debug(
          `refresh ${s.id}: ${e instanceof Error ? e.message : e}`,
        );
      }
    }
  }

  private async refreshOne(session: PlaybackSession) {
    if (!session.info_hash) return session;
    // 默认同机：ready 后只认本地路径，不必等 MinIO
    if (
      session.status === 'ready' &&
      (!playbackConfig.uploadToMinio || session.minio_object)
    ) {
      return session;
    }

    const info = await this.qb.getTorrent(session.info_hash);
    if (!info) {
      // 种已从 qB 删除：仅当开启 MinIO 备份且已上传时仍可播
      if (session.minio_object) {
        session.status = 'ready';
        await this.sessionRepo.save(session);
      }
      return session;
    }

    session.progress = info.progress ?? 0;
    session.downloaded_bytes = String(info.downloaded ?? 0);
    if (info.size) session.size_bytes = String(info.size);

    // 同机：容器 /downloads → 宿主机 QB_DOWNLOAD_PATH（DB 存 local_path）
    session.local_path = this.resolveLocalPath(
      session.file_name,
      info.save_path,
      info.content_path,
    );

    const localReady =
      !!session.local_path &&
      existsSync(session.local_path) &&
      statSync(session.local_path).size >=
        Math.min(
          playbackConfig.playableMinBytes,
          Number(session.size_bytes) || playbackConfig.playableMinBytes,
        );

    if (info.progress >= 0.999) {
      session.status = 'ready';
      await this.sessionRepo.save(session);
      // 可选：再拷一份到 MinIO（默认关，避免双份存储）
      if (playbackConfig.uploadToMinio) {
        this.uploadToMinio(session).catch((e) =>
          this.logger.warn(
            `minio upload ${session.id}: ${
              e instanceof Error ? e.message : e
            }`,
          ),
        );
      }
      return session;
    }

    if (localReady || info.progress >= playbackConfig.playableProgress) {
      session.status = 'playable';
    } else if (session.status !== 'failed') {
      session.status = 'downloading';
    }

    await this.sessionRepo.save(session);
    return session;
  }

  /**
   * 可选：下载完成后上传 MinIO（PLAYBACK_UPLOAD_TO_MINIO=true）。
   * 默认同机部署不调用——直接用 qB 落盘路径出流。
   */
  private async uploadToMinio(session: PlaybackSession) {
    if (!playbackConfig.uploadToMinio) return;
    if (session.minio_object) return;
    if (!session.local_path || !existsSync(session.local_path)) {
      this.logger.warn(
        `skip minio upload ${session.id}: local missing ${session.local_path}`,
      );
      return;
    }
    const st = statSync(session.local_path);
    if (st.size < 1024) return;

    const safeName = basename(session.file_name || 'video.bin').replace(
      /[^a-zA-Z0-9._\-一-鿿]/g,
      '_',
    );
    const objectName = `${minioConfig.playbackPrefix}/${
      session.info_hash || session.id
    }/${safeName}`;

    const exists = await this.minio.objectExists(objectName);
    if (!exists) {
      this.logger.log(
        `upload to MinIO: ${session.local_path} -> ${objectName}`,
      );
      await this.minio.fPutObject(
        objectName,
        session.local_path,
        this.guessContentType(session.file_name),
      );
    }
    session.minio_object = objectName;
    await this.sessionRepo.save(session);
  }

  /**
   * 同机路径映射：
   * - qB 容器内 save_path 一般为 /downloads
   * - compose: ./data/bt-downloads:/downloads
   * - Nest QB_DOWNLOAD_PATH 指向同一宿主机目录
   */
  private resolveLocalPath(
    fileName: string,
    savePath?: string,
    contentPath?: string,
  ) {
    const hostRoot = resolve(qbittorrentConfig.downloadPath);

    // content_path 有时是完整文件路径（单文件种子）
    if (contentPath && contentPath.includes('/') && !contentPath.endsWith('/')) {
      const mapped = this.mapContainerPathToHost(contentPath, hostRoot);
      if (mapped && existsSync(mapped)) return mapped;
    }

    if (fileName) {
      const byName = join(hostRoot, fileName);
      if (existsSync(byName)) return byName;
    }

    if (savePath) {
      const mappedSave = this.mapContainerPathToHost(savePath, hostRoot);
      if (mappedSave && fileName) {
        const p = join(mappedSave, fileName);
        if (existsSync(p)) return p;
      }
    }

    return fileName ? join(hostRoot, fileName) : hostRoot;
  }

  /** 把容器路径 /downloads/... 映射到宿主机 QB_DOWNLOAD_PATH/... */
  private mapContainerPathToHost(containerPath: string, hostRoot: string) {
    const p = containerPath.replace(/\/+$/, '');
    if (p === '/downloads' || p.startsWith('/downloads/')) {
      const rel = p === '/downloads' ? '' : p.slice('/downloads/'.length);
      return rel ? join(hostRoot, rel) : hostRoot;
    }
    // 已是宿主机绝对路径
    if (isAbsolute(p) && existsSync(p)) return p;
    return null;
  }

  private parseRange(rangeHeader: string, size: number) {
    let start = 0;
    let end = size - 1;
    let partial = false;
    const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
    if (m) {
      if (m[1] !== '') start = parseInt(m[1], 10);
      if (m[2] !== '') end = parseInt(m[2], 10);
      if (Number.isNaN(start)) start = 0;
      if (Number.isNaN(end) || end >= size) end = size - 1;
      if (start > end || start >= size) {
        throw new BadRequestException('Invalid Range');
      }
      partial = true;
    }
    return { start, end, partial };
  }

  private buildRangeFromSize(
    size: number,
    rangeHeader: string | undefined,
    open: (start: number, end: number) => NodeJS.ReadableStream,
    contentType: string,
  ) {
    let start = 0;
    let end = size - 1;
    let partial = false;
    if (rangeHeader) {
      const parsed = this.parseRange(rangeHeader, size);
      start = parsed.start;
      end = parsed.end;
      partial = parsed.partial;
    }
    return {
      stream: open(start, end),
      contentType,
      size,
      start,
      end,
      partial,
    };
  }

  private guessContentType(name: string) {
    const lower = (name || '').toLowerCase();
    if (lower.endsWith('.mp4') || lower.endsWith('.m4v')) return 'video/mp4';
    if (lower.endsWith('.webm')) return 'video/webm';
    if (lower.endsWith('.mkv')) return 'video/x-matroska';
    if (lower.endsWith('.ts')) return 'video/mp2t';
    return 'application/octet-stream';
  }

  private toView(session: PlaybackSession) {
    const playable =
      session.status === 'playable' || session.status === 'ready';
    return {
      id: session.id,
      status: session.status as PlaybackStatus,
      progress: session.progress,
      sizeBytes: Number(session.size_bytes) || 0,
      downloadedBytes: Number(session.downloaded_bytes) || 0,
      fileName: session.file_name,
      fileIndex: session.file_index,
      infoHash: session.info_hash,
      errorMessage: session.error_message || undefined,
      bangumiId: session.bangumi_id,
      episodeSort: session.episode_sort,
      /** 前端播放地址（需带 JWT，走后端 Range 代理） */
      playUrl: playable ? `/api/playback/sessions/${session.id}/stream` : null,
      playMode: 'progressive' as const,
    };
  }

  private sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }
}
