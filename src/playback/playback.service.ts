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
import { playbackConfig, qbittorrentConfig } from '../core/config/config';
import { outboundGet } from '../core/http/outbound';
import { CreatePlaybackDto } from './dto/create-playback.dto';
import { AutoPlaybackDto } from './dto/auto-playback.dto';
import { StreamPlaybackDto } from './dto/stream-playback.dto';
import {
  PlaybackSession,
  PlaybackStatus,
} from './entities/playback-session.entity';
import { QbittorrentService } from './qbittorrent.service';
import { PlayCandidate, SourceSearchService } from './source-search.service';

@Injectable()
export class PlaybackService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PlaybackService.name);
  private timer: NodeJS.Timeout | null = null;
  /** sessionId → 流媒体源请求头 */
  private streamHeaders = new Map<string, Record<string, string>>();

  constructor(
    @InjectRepository(PlaybackSession)
    private readonly sessionRepo: Repository<PlaybackSession>,
    private readonly qb: QbittorrentService,
    private readonly sourceSearch: SourceSearchService,
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
      return { ok: false, message: 'QB_ENABLED=false（BT 播放不可用）' };
    }
    return this.qb.healthCheck();
  }

  /** 从用户数据源搜索 BT + 流媒体候选 */
  async searchSources(
    userId: string,
    keyword: string,
    episodeSort: number,
    alt?: string,
  ): Promise<PlayCandidate[]> {
    return this.sourceSearch.search({
      userId,
      keyword,
      episodeSort,
      altKeywords: alt ? [alt] : [],
    });
  }

  /** 单站点搜索（抽屉） */
  async searchOneSource(
    _userId: string,
    body: {
      factoryId: string;
      name: string;
      searchConfig: Record<string, any>;
      keyword: string;
      episodeSort: number;
      altKeyword?: string;
      subscriptionName?: string;
    },
  ): Promise<PlayCandidate[]> {
    return this.sourceSearch.searchOne(body);
  }

  /**
   * 兼容旧 auto：服务端代搜（可能受机房网络限制）。
   * 推荐前端在浏览器搜源后调用 sessions/stream 或 sessions。
   */
  async createFromEpisode(userId: string, dto: AutoPlaybackDto) {
    const { stream, bt } = await this.sourceSearch.pickBest({
      userId,
      keyword: dto.keyword,
      episodeSort: dto.episodeSort,
      altKeywords: dto.altKeyword ? [dto.altKeyword] : [],
    });

    if (stream && /^https?:\/\//i.test(stream.uri)) {
      return this.createFromStream(userId, {
        streamUrl: stream.uri,
        title: stream.title,
        headers: stream.headers,
        bangumiId: dto.bangumiId,
        episodeSort: dto.episodeSort,
      });
    }

    if (bt) {
      return this.create(userId, {
        uri: bt.uri,
        bangumiId: dto.bangumiId,
        episodeSort: dto.episodeSort,
        fileIndex: dto.fileIndex,
      });
    }

    throw new BadRequestException(
      `服务端未找到资源。请使用前端浏览器搜源（走用户网络），或手动粘贴 magnet / 直链`,
    );
  }

  /** 流媒体直链会话：立即 ready，stream 走后端代理 */
  async createFromStream(userId: string, dto: StreamPlaybackDto) {
    const url = (dto.streamUrl || '').trim();
    if (!/^https?:\/\//i.test(url)) {
      throw new BadRequestException('streamUrl 须为 http(s) 地址');
    }

    const session = this.sessionRepo.create({
      user_id: userId,
      bangumi_id: dto.bangumiId ?? null,
      episode_sort: dto.episodeSort ?? null,
      source_uri: url,
      status: 'ready',
      file_index: 0,
      file_name: dto.title || basename(url.split('?')[0]) || 'stream',
      local_path: '',
      size_bytes: '0',
      downloaded_bytes: '0',
      progress: 1,
      info_hash: '',
      minio_object: '',
    });
    await this.sessionRepo.save(session);

    if (dto.headers && Object.keys(dto.headers).length) {
      this.streamHeaders.set(session.id, dto.headers);
    }
    return this.toView(session, 'stream');
  }

  async create(userId: string, dto: CreatePlaybackDto) {
    const uri = (dto.uri || '').trim();
    if (!uri.startsWith('magnet:') && !/^https?:\/\//i.test(uri)) {
      throw new BadRequestException('uri 须为 magnet: 或 http(s) 种子/直链');
    }

    // 直链视频 → 流媒体通道
    if (
      /^https?:\/\//i.test(uri) &&
      this.looksLikeMedia(uri) &&
      !/\.torrent(\?|$)/i.test(uri)
    ) {
      return this.createFromStream(userId, {
        streamUrl: uri,
        bangumiId: dto.bangumiId,
        episodeSort: dto.episodeSort,
      });
    }

    this.qb.assertEnabled();

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

      let files = await this.qb.getFiles(hash);
      for (let i = 0; i < 20 && !files.length; i++) {
        await this.sleep(1500);
        files = await this.qb.getFiles(hash);
      }
      if (!files.length) {
        throw new BadRequestException('种子无文件列表（metadata 超时）');
      }

      const file =
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
      session.local_path = this.resolveLocalPath(file.name);
      await this.sessionRepo.save(session);
    } catch (e) {
      session.status = 'failed';
      session.error_message =
        e instanceof Error ? e.message : '创建播放会话失败';
      await this.sessionRepo.save(session);
      throw e;
    }

    return this.toView(session, 'progressive');
  }

  async getSession(id: string, userId: string) {
    const session = await this.findOwned(id, userId);
    await this.refreshOne(session);
    const mode = this.isStreamSession(session) ? 'stream' : 'progressive';
    return this.toView(session, mode);
  }

  async listFiles(id: string, userId: string) {
    const session = await this.findOwned(id, userId);
    if (!session.info_hash) return [];
    return this.qb.getFiles(session.info_hash);
  }

  /**
   * 出流：
   * 1) 流媒体：代理远端 URL（Range）
   * 2) BT：本地 qB 目录 Range
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

    if (this.isStreamSession(session)) {
      return this.openRemoteStream(session, rangeHeader);
    }

    if (
      session.status !== 'playable' &&
      session.status !== 'ready' &&
      session.status !== 'downloading'
    ) {
      throw new BadRequestException('资源尚未可播，请稍候');
    }

    const local = session.local_path;
    if (!local || !existsSync(local)) {
      throw new BadRequestException('文件尚未落地，请稍候');
    }

    const st = statSync(local);
    const size = st.size;
    if (size < 1024) {
      throw new BadRequestException('文件过小，仍在缓冲');
    }
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

  private async openRemoteStream(
    session: PlaybackSession,
    rangeHeader?: string,
  ) {
    const url = session.source_uri;
    const extra = this.streamHeaders.get(session.id) || {};
    const headers: Record<string, string> = {
      'User-Agent':
        extra['User-Agent'] ||
        extra['userAgent'] ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      ...extra,
    };
    if (rangeHeader) headers.Range = rangeHeader;

    try {
      const res = await outboundGet(url, {
        responseType: 'stream',
        headers,
        timeout: 60000,
        maxRedirects: 5,
        validateStatus: (s) => s >= 200 && s < 400,
      });

      const contentType =
        (res.headers['content-type'] as string) ||
        this.guessContentType(session.file_name || url);
      const contentLength = parseInt(
        String(res.headers['content-length'] || '0'),
        10,
      );
      const contentRange = String(res.headers['content-range'] || '');
      const partial = res.status === 206 || !!contentRange;

      let start = 0;
      let end = contentLength > 0 ? contentLength - 1 : 0;
      let size = contentLength;

      if (contentRange) {
        const m = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/.exec(contentRange);
        if (m) {
          start = parseInt(m[1], 10);
          end = parseInt(m[2], 10);
          if (m[3] !== '*') size = parseInt(m[3], 10);
          else size = end + 1;
        }
      } else if (rangeHeader && contentLength > 0) {
        const parsed = this.parseRange(rangeHeader, contentLength);
        start = parsed.start;
        end = parsed.end;
      }

      return {
        stream: res.data as NodeJS.ReadableStream,
        contentType,
        size: size || 0,
        start,
        end,
        partial,
      };
    } catch (e) {
      this.logger.warn(
        `remote stream ${session.id}: ${e instanceof Error ? e.message : e}`,
      );
      throw new BadRequestException(
        '拉流失败：源站不可达或需要特殊鉴权，可换源或改用 BT',
      );
    }
  }

  private isStreamSession(session: PlaybackSession) {
    return (
      !session.info_hash &&
      /^https?:\/\//i.test(session.source_uri || '') &&
      !/\.torrent(\?|$)/i.test(session.source_uri || '')
    );
  }

  private looksLikeMedia(url: string) {
    return (
      /\.(mp4|m3u8|mkv|webm|m4v|flv|ts)(\?|$)/i.test(url) ||
      /m3u8|bilivideo|akamaized|cloudflarestorage|tos-cn|sign\.bytetos/i.test(
        url,
      )
    );
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
    if (this.isStreamSession(session)) {
      if (session.status !== 'ready') {
        session.status = 'ready';
        session.progress = 1;
        await this.sessionRepo.save(session);
      }
      return session;
    }

    if (!session.info_hash) return session;
    if (session.status === 'ready') return session;
    if (!this.qb.isEnabled()) return session;

    const info = await this.qb.getTorrent(session.info_hash);
    if (!info) return session;

    session.progress = info.progress ?? 0;
    session.downloaded_bytes = String(info.downloaded ?? 0);
    if (info.size) session.size_bytes = String(info.size);

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

  private resolveLocalPath(
    fileName: string,
    savePath?: string,
    contentPath?: string,
  ) {
    const hostRoot = resolve(qbittorrentConfig.downloadPath);

    if (
      contentPath &&
      contentPath.includes('/') &&
      !contentPath.endsWith('/')
    ) {
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

  private mapContainerPathToHost(containerPath: string, hostRoot: string) {
    const p = containerPath.replace(/\/+$/, '');
    if (p === '/downloads' || p.startsWith('/downloads/')) {
      const rel = p === '/downloads' ? '' : p.slice('/downloads/'.length);
      return rel ? join(hostRoot, rel) : hostRoot;
    }
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
    if (lower.includes('.m3u8')) return 'application/vnd.apple.mpegurl';
    if (lower.endsWith('.mp4') || lower.endsWith('.m4v')) return 'video/mp4';
    if (lower.endsWith('.webm')) return 'video/webm';
    if (lower.endsWith('.mkv')) return 'video/x-matroska';
    if (lower.endsWith('.ts')) return 'video/mp2t';
    return 'application/octet-stream';
  }

  private toView(
    session: PlaybackSession,
    playMode: 'progressive' | 'stream' = 'progressive',
  ) {
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
      playUrl: playable ? `/api/playback/sessions/${session.id}/stream` : null,
      playMode,
    };
  }

  private sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }
}
