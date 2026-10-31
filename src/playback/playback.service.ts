import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createReadStream, existsSync, readFileSync, statSync } from 'fs';
import { basename, isAbsolute, join, resolve } from 'path';
import { Readable } from 'stream';
import { Repository } from 'typeorm';
import {
  playbackConfig,
  qbittorrentConfig,
  transcodeConfig,
} from '../core/config/config';
import { outboundGet } from '../core/http/outbound';
import { Group } from '../group/entities/group.entity';
import { GroupUserMap } from '../group/entities/group_user_map.entity';
import { CreatePlaybackDto } from './dto/create-playback.dto';
import { AutoPlaybackDto } from './dto/auto-playback.dto';
import { StreamPlaybackDto } from './dto/stream-playback.dto';
import {
  PlaybackSession,
  PlaybackStatus,
} from './entities/playback-session.entity';
import { MediaTranscodeService, ProbedMedia } from './media-transcode.service';
import { QbittorrentService } from './qbittorrent.service';
import { PlayCandidate, SourceSearchService } from './source-search.service';

@Injectable()
export class PlaybackService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PlaybackService.name);
  private timer: NodeJS.Timeout | null = null;
  /** sessionId → 流媒体源请求头 */
  private streamHeaders = new Map<string, Record<string, string>>();
  /** 本地文件探测结果缓存（path → 编码信息），避免每次 Range 请求都跑 ffprobe */
  private probeCache = new Map<string, ProbedMedia | null>();
  /** 探测失败后的冷却时间（避免对半截文件反复跑 ffprobe） */
  private probeRetryAt = new Map<string, number>();
  private hlsCleanupTimer: NodeJS.Timeout | null = null;
  /** 同一分片并发生成时复用同一个转码任务 */
  private segmentTasks = new Map<string, Promise<string>>();
  /** 分片转码并发上限：每个 ffmpeg 都吃 CPU，开太多会把播放拖死 */
  private activeTranscodes = 0;
  private transcodeQueue: Array<() => void> = [];

  constructor(
    @InjectRepository(PlaybackSession)
    private readonly sessionRepo: Repository<PlaybackSession>,
    @InjectRepository(Group)
    private readonly groupRepo: Repository<Group>,
    @InjectRepository(GroupUserMap)
    private readonly groupUserMapRepo: Repository<GroupUserMap>,
    private readonly qb: QbittorrentService,
    private readonly sourceSearch: SourceSearchService,
    private readonly transcoder: MediaTranscodeService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => {
      this.pollActiveSessions().catch((e) =>
        this.logger.warn(`poll: ${e instanceof Error ? e.message : e}`),
      );
    }, playbackConfig.pollIntervalMs);

    // HLS 分片缓存按 TTL 清理：一部番能转出几百 MB，不能无限堆
    this.hlsCleanupTimer = setInterval(
      () => this.transcoder.cleanupSegmentCache(),
      30 * 60 * 1000,
    );
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    if (this.hlsCleanupTimer) clearInterval(this.hlsCleanupTimer);
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

  /**
   * 流媒体会话：
   * - 若 streamUrl 已是 m3u8/mp4 → 直接代理
   * - 若是剧集播放页（Animeko 搜源产出）→ 再 resolve 真实视频地址
   */
  async createFromStream(userId: string, dto: StreamPlaybackDto) {
    let url = (dto.streamUrl || '').trim();
    if (!/^https?:\/\//i.test(url)) {
      throw new BadRequestException('streamUrl 须为 http(s) 地址');
    }

    let headers = { ...(dto.headers || {}) };

    // 播放页 → 真实媒体（对齐 Animeko WebVideoMatcher 阶段）
    // 必须传入前端 headers（Referer/Cookie），否则部分站解析失败
    if (!this.looksLikeMedia(url)) {
      this.logger.log(`resolve play page: ${url.slice(0, 120)}`);
      const resolved = await this.sourceSearch.resolvePlayUrl(
        url,
        undefined,
        headers,
      );
      if (resolved?.url && this.looksLikeMedia(resolved.url)) {
        url = resolved.url;
        headers = { ...headers, ...(resolved.headers || {}) };
        this.logger.log(`resolved media: ${url.slice(0, 160)}`);
      } else if (resolved?.url) {
        // 解析出 URL 但扩展名不标准，仍尝试当媒体用
        url = resolved.url;
        headers = { ...headers, ...(resolved.headers || {}) };
        this.logger.log(`resolved nonstandard media: ${url.slice(0, 160)}`);
      } else {
        // 禁止把 HTML 播放页当视频流代理（会「创建成功但播不了」）
        throw new BadRequestException(
          '无法从播放页解析出视频地址，请换线路或数据源',
        );
      }
    }

    const session = this.sessionRepo.create({
      user_id: userId,
      group_id: dto.groupId || '',
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

    if (Object.keys(headers).length) {
      this.streamHeaders.set(session.id, headers);
    }
    // m3u8 → hls（前端加 type=m3u8）；mp4 等仍为 stream progressive
    const mode = this.looksLikeHlsPlaylist(url) ? 'hls' : 'stream';
    return this.toView(session, mode);
  }

  /**
   * 创建 BT 播放会话。
   *
   * **不再等 metadata**：先落库（fetching）立刻返回，前端拿到 id 就能挂播放器/轮询；
   * 选文件、开顺序下载、等元数据都在后台 `prepareTorrent` 里做。
   *
   * 以前这里要同步等到文件列表（最长 30s），失败就 400，表现就是「还没下载就说不能播」。
   */
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
      group_id: dto.groupId || '',
      bangumi_id: dto.bangumiId ?? null,
      episode_sort: dto.episodeSort ?? null,
      source_uri: uri,
      status: 'fetching',
      file_index: dto.fileIndex ?? -1,
    });
    await this.sessionRepo.save(session);

    void this.prepareTorrent(session, dto);

    return this.toView(session, 'progressive');
  }

  /** 后台补齐种子 metadata：选文件、置顺序下载、算本地路径 */
  private async prepareTorrent(
    session: PlaybackSession,
    dto: CreatePlaybackDto,
  ): Promise<void> {
    try {
      const hash = await this.qb.addMagnetOrUrl(session.source_uri);
      session.info_hash = hash;
      session.status = 'downloading';
      await this.sessionRepo.save(session);

      const files = await this.waitForFiles(hash, 20000);
      if (!files.length) {
        // 还没拿到 metadata 不是「不能播」，只是慢：保持 fetching，后续轮询会自动补齐
        session.status = 'fetching';
        session.error_message = '种子信息获取中（磁力可能需要 1-2 分钟）';
        await this.sessionRepo.save(session);
        return;
      }

      await this.applyTorrentFiles(session, files, dto.fileIndex);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '创建播放会话失败';
      // 「添加种子超时 / metadata 未就绪」都属于暂时状态，别标 failed
      const transient = /metadata|超时|timeout|timed out/i.test(msg);
      session.status = transient ? 'fetching' : 'failed';
      session.error_message = msg;
      await this.sessionRepo.save(session).catch(() => undefined);
      this.logger.warn(`prepareTorrent ${session.id}: ${msg}`);
    }
  }

  /** 从 qB 文件列表里选定视频文件并发起顺序下载 */
  private async applyTorrentFiles(
    session: PlaybackSession,
    files: Array<{ index: number; name: string; size: number }>,
    fileIndex?: number,
  ): Promise<void> {
    const file =
      fileIndex != null
        ? files.find((f) => f.index === fileIndex)
        : this.qb.pickBestVideoFile(files as never);
    if (!file) {
      session.status = 'failed';
      session.error_message = '未找到可播放的视频文件';
      await this.sessionRepo.save(session);
      return;
    }

    // 只下这一个文件 + 顺序下载：整包（字幕/截图/其它集）会抢带宽，也拖慢边下边播
    await this.qb.setOnlyFile(session.info_hash, file.index);
    await this.qb.setSequential(session.info_hash, true);

    session.file_index = file.index;
    session.file_name = file.name;
    session.size_bytes = String(file.size);
    session.local_path = this.resolveLocalPath(file.name);
    session.status = 'downloading';
    session.error_message = '';
    await this.sessionRepo.save(session);
  }

  /** 等 qB 拿到文件列表（metadata）。下载中拿不到列表时给出明确失败原因 */
  private async waitForFiles(hash: string, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    let files = await this.qb.getFiles(hash);
    while (!files.length && Date.now() < deadline) {
      await this.sleep(1000);
      files = await this.qb.getFiles(hash);
    }
    return files;
  }

  async getSession(id: string, userId: string) {
    const session = await this.findOwned(id, userId);
    await this.refreshOne(session);
    let mode: 'progressive' | 'stream' | 'hls' = 'progressive';
    if (this.isStreamSession(session)) {
      mode = this.looksLikeHlsPlaylist(session.source_uri) ? 'hls' : 'stream';
    }
    return this.toView(session, mode);
  }

  async listFiles(id: string, userId: string) {
    const session = await this.findOwned(id, userId);
    if (!session.info_hash) return [];
    return this.qb.getFiles(session.info_hash);
  }

  /**
   * 出流：
   * 1) 流媒体：代理远端 URL（Range）；HLS playlist 会改写相对 URI 并同源代理分片/密钥
   * 2) BT 原生容器（mp4/webm/ts）：下载中即可出流，只读**已下载区间**
   * 3) BT 非原生容器（mkv/HEVC）：ffmpeg 把已下载部分转成 fMP4 流
   */
  async openStream(
    id: string,
    userId: string,
    rangeHeader?: string,
    opts?: { accessToken?: string; forceTranscode?: boolean },
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
      return this.openRemoteStream(session, rangeHeader, opts?.accessToken);
    }

    if (!session.local_path) {
      throw new ServiceUnavailableException('正在解析种子，请稍候');
    }

    const probed = await this.probeLocal(session);
    const remux = this.transcoder.needsRemux(session.file_name);
    const badCodec = this.transcoder.needsVideoTranscode(probed?.videoCodec);
    if (remux || badCodec || opts?.forceTranscode) {
      return this.openRemuxedStream(session, rangeHeader, probed);
    }

    // 原生容器：下载中也允许出流，但只返回真实落地的字节
    const avail = await this.waitForAvailable(session, rangeHeader, 15000);
    if (avail < 1024) {
      throw new ServiceUnavailableException('缓冲不足，请稍候');
    }
    const st = statSync(session.local_path);
    const size = st.size;
    const { start, end, partial } = this.computeRange(rangeHeader, size, avail);
    return {
      stream: createReadStream(session.local_path, { start, end }),
      contentType: this.guessContentType(session.file_name),
      size,
      start,
      end,
      partial,
    };
  }

  /**
   * 当前会话的内嵌字幕轨列表（只列能转 VTT 的；PGS 这类图形字幕没法转）。
   *
   * 外挂字幕文件（种子里的 .srt/.ass）目前**不下载** —— 只下载选中的视频文件，
   * 见 `docs/playback-architecture.md`。
   */
  async getSubtitleTracks(id: string, userId: string) {
    const session = await this.findOwned(id, userId);
    await this.refreshOne(session);
    if (session.status === 'failed') {
      throw new BadRequestException(session.error_message || '播放失败');
    }
    const probed = await this.probeLocal(session);
    return (probed?.subtitleTracks || [])
      .filter((t) => t.convertible)
      .map((t, i) => ({
        index: t.index,
        label: t.title || t.language || `字幕 ${i + 1}`,
        language: t.language,
        codec: t.codec,
      }));
  }

  /** 把某条内嵌字幕轨转成 WebVTT（结果按会话缓存，重复请求不再跑 ffmpeg） */
  async getSubtitleVtt(
    id: string,
    userId: string,
    trackIndex: number,
  ): Promise<string> {
    const session = await this.findOwned(id, userId);
    await this.refreshOne(session);
    const probed = await this.probeLocal(session);
    const track = (probed?.subtitleTracks || []).find(
      (t) => t.index === trackIndex && t.convertible,
    );
    if (!track) throw new NotFoundException('字幕轨不存在');

    const outPath = join(
      this.transcoder.segmentDir(session.id),
      `sub-${trackIndex}.vtt`,
    );
    if (this.isFilePath(outPath)) return readFileSync(outPath, 'utf8');

    const inflight = this.segmentTasks.get(outPath);
    if (inflight) {
      await inflight;
      return readFileSync(outPath, 'utf8');
    }

    const task = this.runWithConcurrencyLimit(async () => {
      await this.transcoder.extractSubtitleVtt(
        session.local_path,
        trackIndex,
        outPath,
      );
      return outPath;
    });
    this.segmentTasks.set(outPath, task);
    try {
      await task;
      return readFileSync(outPath, 'utf8');
    } finally {
      this.segmentTasks.delete(outPath);
    }
  }

  /**
   * HLS 播放列表（mkv/HEVC 专用）。
   *
   * 与 fMP4 单流的关键区别：**整条 playlist 一次性给出全部 EXTINF**，
   * 所以 hls.js 能算出总时长（进度条 = 视频真实长度）并允许 seek；
   * 每个分片在第一次被请求时才转码，之后命中磁盘缓存。
   */
  async getHlsPlaylist(
    id: string,
    userId: string,
    token?: string,
  ): Promise<string> {
    const session = await this.findOwned(id, userId);
    await this.refreshOne(session);
    if (session.status === 'failed') {
      throw new BadRequestException(session.error_message || '播放失败');
    }
    if (!this.transcoder.checkAvailable()) {
      throw new BadRequestException(
        '服务器未安装 ffmpeg，无法播放 mkv/HEVC 资源，请换 mp4 源',
      );
    }

    const probed = await this.probeLocal(session);
    const duration = probed?.durationSec || 0;
    if (duration < 1) {
      throw new ServiceUnavailableException('正在读取视频信息，请稍候');
    }

    const seg = transcodeConfig.segmentSeconds;
    const count = Math.ceil(duration / seg);
    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${Math.ceil(seg)}`,
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-PLAYLIST-TYPE:VOD',
    ];
    const q = token ? `?token=${encodeURIComponent(token)}` : '';
    for (let i = 0; i < count; i++) {
      const d = Math.min(seg, duration - i * seg);
      lines.push(`#EXTINF:${d.toFixed(3)},`);
      lines.push(`/api/playback/sessions/${id}/hls/${i}.ts${q}`);
    }
    lines.push('#EXT-X-ENDLIST');
    return lines.join('\n');
  }

  /** 单个 HLS 分片：命中缓存直接给文件，否则按需转码（并发去重 + 限流） */
  async getHlsSegment(
    id: string,
    userId: string,
    index: number,
  ): Promise<{ path: string; size: number }> {
    const session = await this.findOwned(id, userId);
    await this.refreshOne(session);
    if (session.status === 'failed') {
      throw new BadRequestException(session.error_message || '播放失败');
    }

    const probed = await this.probeLocal(session);
    const duration = probed?.durationSec || 0;
    if (duration < 1) {
      throw new ServiceUnavailableException('正在读取视频信息，请稍候');
    }

    const seg = transcodeConfig.segmentSeconds;
    const total = Math.ceil(duration / seg);
    if (!Number.isFinite(index) || index < 0 || index >= total) {
      throw new BadRequestException('分片不存在');
    }

    const start = index * seg;
    const dur = Math.min(seg, duration - start);
    // 还没下到这个位置：让 hls.js 自己退避重试，别把 0 字节当视频返回
    const downloaded = this.downloadedSeconds(session, duration);
    if (session.status !== 'ready' && downloaded + 1 < start) {
      throw new ServiceUnavailableException('该位置尚未下载，请稍候');
    }

    const outPath = join(this.transcoder.segmentDir(session.id), `${index}.ts`);
    if (this.isFilePath(outPath)) {
      return { path: outPath, size: statSync(outPath).size };
    }

    const inflight = this.segmentTasks.get(outPath);
    if (inflight) {
      const path = await inflight;
      return { path, size: statSync(path).size };
    }

    const task = this.runWithConcurrencyLimit(async () => {
      await this.transcoder.transcodeSegment(
        session.local_path,
        start,
        dur,
        probed,
        outPath,
      );
      return outPath;
    });
    this.segmentTasks.set(outPath, task);
    try {
      const path = await task;
      return { path, size: statSync(path).size };
    } finally {
      this.segmentTasks.delete(outPath);
    }
  }

  /**
   * 已下载到第几秒。
   *
   * 依赖「顺序下载」：未下完时前 N 秒是连续的。ready 就直接算全片，
   * 避免 downloaded 统计（含重复分片）比文件大小略小导致最后几片被误判未下载。
   */
  private downloadedSeconds(
    session: PlaybackSession,
    duration: number,
  ): number {
    if (session.status === 'ready') return duration;
    const size = Number(session.size_bytes) || 0;
    if (!size) return 0;
    const avail = this.availableBytes(session);
    return Math.min(duration, (avail / size) * duration);
  }

  /** 分片转码并发闸门：同时最多 2 个 ffmpeg，避免 seek 时把机器打满 */
  private async runWithConcurrencyLimit<T>(fn: () => Promise<T>): Promise<T> {
    if (this.activeTranscodes >= 2) {
      await new Promise<void>((resolve) => this.transcodeQueue.push(resolve));
    }
    this.activeTranscodes += 1;
    try {
      return await fn();
    } finally {
      this.activeTranscodes -= 1;
      const next = this.transcodeQueue.shift();
      if (next) next();
    }
  }

  /** mkv / HEVC 等：把已下载部分转成 fMP4（不依赖 Range，不支持 seek） */
  private async openRemuxedStream(
    session: PlaybackSession,
    rangeHeader: string | undefined,
    probed: ProbedMedia | null,
  ): Promise<{
    stream: NodeJS.ReadableStream;
    contentType: string;
    size: number;
    start: number;
    end: number;
    partial: boolean;
  }> {
    if (!this.transcoder.checkAvailable()) {
      throw new BadRequestException(
        '服务器未安装 ffmpeg，无法播放 mkv/HEVC 资源，请换 mp4 源',
      );
    }
    if (session.status === 'fetching') {
      throw new ServiceUnavailableException('正在解析种子，请稍候');
    }
    const avail = await this.waitForAvailable(session, rangeHeader, 15000);
    if (avail < 1024 * 512) {
      throw new ServiceUnavailableException('缓冲不足，请稍候');
    }
    const stream = this.transcoder.openFmp4Stream(
      session.local_path,
      avail,
      probed,
    );
    return {
      stream,
      contentType: 'video/mp4',
      size: 0,
      start: 0,
      end: 0,
      partial: false,
    };
  }

  /**
   * 等「够读」的字节数。
   *
   * 播放器一上来就请求 `bytes=0-`（甚至整段），下载中的文件只有前几 MB，
   * 这里不会直接 400，而是等一段（默认 15s）再按已有范围返回 ——
   * 配合前端「缓冲不足自动重试」，就是边下边播。
   */
  private async waitForAvailable(
    session: PlaybackSession,
    rangeHeader: string | undefined,
    timeoutMs: number,
  ): Promise<number> {
    const need = this.rangeStart(rangeHeader);
    const deadline = Date.now() + timeoutMs;
    let avail = this.availableBytes(session);
    while (Date.now() < deadline) {
      if (avail > need && avail >= 1024) return avail;
      // 已下完就没必要再等
      if (session.status === 'ready' && avail > 0) return avail;
      await this.sleep(500);
      await this.refreshOne(session).catch(() => undefined);
      avail = this.availableBytes(session);
    }
    return avail;
  }

  /** 已下载/可读字节数：预分配时磁盘大小是整集，不能直接当可用范围 */
  private availableBytes(session: PlaybackSession): number {
    if (!session.local_path || !existsSync(session.local_path)) return 0;
    const st = statSync(session.local_path);
    if (session.status === 'ready') return st.size;
    const downloaded = Number(session.downloaded_bytes) || 0;
    if (downloaded > 0) return Math.min(st.size, downloaded);
    return st.size;
  }

  private rangeStart(rangeHeader?: string): number {
    if (!rangeHeader) return 0;
    const m = /bytes=(\d*)-/.exec(rangeHeader);
    if (!m || m[1] === '') return 0;
    const n = parseInt(m[1], 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  /** 把请求区间裁剪到已下载范围：未下到的地方不返回 0 字节 */
  private computeRange(
    rangeHeader: string | undefined,
    size: number,
    avail: number,
  ): { start: number; end: number; partial: boolean } {
    const maxEnd = Math.min(size - 1, Math.max(0, avail - 1));
    if (!rangeHeader) {
      // 没有 Range 时浏览器按「整段」处理；下载中只能先给到已下载位置
      return { start: 0, end: maxEnd, partial: maxEnd < size - 1 };
    }
    const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
    if (!m) return { start: 0, end: maxEnd, partial: maxEnd < size - 1 };
    const start = m[1] === '' ? 0 : parseInt(m[1], 10) || 0;
    const requestedEnd = m[2] === '' ? size - 1 : parseInt(m[2], 10);
    if (start > maxEnd) {
      throw new ServiceUnavailableException('缓冲不足，请稍候');
    }
    return {
      start,
      end: Math.min(requestedEnd, maxEnd),
      partial: true,
    };
  }

  /** 探测本地视频编码（带缓存：下载中的文件头部信息是稳定的） */
  private async probeLocal(
    session: PlaybackSession,
  ): Promise<ProbedMedia | null> {
    if (!session.local_path || !existsSync(session.local_path)) return null;
    const st = statSync(session.local_path);
    if (st.size < 1024 * 512) return null;
    const cached = this.probeCache.get(session.local_path);
    if (cached !== undefined && cached !== null) return cached;
    if (cached === null) {
      // 上次探测失败：给文件一点时间再试，避免每次 Range 都跑 ffprobe
      const retryAt = this.probeRetryAt.get(session.local_path) || 0;
      if (Date.now() < retryAt) return null;
    }
    const probed = this.transcoder.probe(session.local_path);
    if (probed) {
      this.probeCache.set(session.local_path, probed);
    } else {
      this.probeCache.set(session.local_path, null);
      this.probeRetryAt.set(session.local_path, Date.now() + 10_000);
    }
    return probed;
  }

  /**
   * 代理 HLS 分片 / enc.key / 嵌套 m3u8（避免浏览器 CORS 与相对路径错解析）
   */
  async openRemoteAsset(
    id: string,
    userId: string,
    remoteUrl: string,
    rangeHeader?: string,
    opts?: { accessToken?: string },
  ): Promise<{
    stream: NodeJS.ReadableStream;
    contentType: string;
    size: number;
    start: number;
    end: number;
    partial: boolean;
  }> {
    const session = await this.findOwned(id, userId);
    if (!this.isStreamSession(session)) {
      throw new BadRequestException('仅流媒体会话支持 asset 代理');
    }
    const url = (remoteUrl || '').trim();
    if (!/^https?:\/\//i.test(url)) {
      throw new BadRequestException('asset url 无效');
    }
    // 仅允许 http(s)；防止 file:// 等
    return this.proxyRemoteUrl(session, url, rangeHeader, opts?.accessToken);
  }

  private async openRemoteStream(
    session: PlaybackSession,
    rangeHeader?: string,
    accessToken?: string,
  ) {
    return this.proxyRemoteUrl(
      session,
      session.source_uri,
      rangeHeader,
      accessToken,
    );
  }

  private buildRemoteHeaders(
    session: PlaybackSession,
    rangeHeader?: string,
  ): Record<string, string> {
    const extra = this.streamHeaders.get(session.id) || {};
    const headers: Record<string, string> = {
      'User-Agent':
        extra['User-Agent'] ||
        extra['userAgent'] ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      ...extra,
    };
    if (rangeHeader) headers.Range = rangeHeader;
    return headers;
  }

  private async proxyRemoteUrl(
    session: PlaybackSession,
    url: string,
    rangeHeader?: string,
    accessToken?: string,
  ) {
    const headers = this.buildRemoteHeaders(session, rangeHeader);
    const treatAsHls =
      this.looksLikeHlsPlaylist(url) ||
      // 主 source 若是 m3u8，即使 content-type 怪异也按 playlist 处理
      (url === session.source_uri &&
        this.looksLikeHlsPlaylist(session.source_uri));

    try {
      if (treatAsHls) {
        // playlist 必须完整改写；忽略 Range，避免 206 半截 m3u8
        const h = { ...headers };
        delete h.Range;
        delete h.range;
        const res = await outboundGet<string>(url, {
          responseType: 'text',
          headers: h,
          timeout: 60000,
          maxRedirects: 5,
          validateStatus: (s) => s >= 200 && s < 400,
          transformResponse: [(d) => d],
        });
        const raw =
          typeof res.data === 'string' ? res.data : String(res.data ?? '');
        const rewritten = this.rewriteM3u8(raw, url, session.id, accessToken);
        const buf = Buffer.from(rewritten, 'utf8');
        return {
          stream: Readable.from(buf),
          contentType: 'application/vnd.apple.mpegurl',
          size: buf.length,
          start: 0,
          end: Math.max(0, buf.length - 1),
          partial: false,
        };
      }

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

      // 源站把 m3u8 标成 octet-stream 时，嗅探首包会很麻烦；按 URL 已处理。
      // 若误判为二进制但实际是 playlist，客户端会失败——looksLikeHls 覆盖常见路径。

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

  private looksLikeHlsPlaylist(url: string) {
    return (
      /\.m3u8(\?|$)/i.test(url || '') || /[?&]type=m3u8\b/i.test(url || '')
    );
  }

  /**
   * 将 m3u8 内相对路径 / 外链改为同源 asset 代理，使 enc.key 与 ts 不直连 CDN。
   */
  private rewriteM3u8(
    body: string,
    playlistUrl: string,
    sessionId: string,
    accessToken?: string,
  ): string {
    let base: URL;
    try {
      base = new URL(playlistUrl);
    } catch {
      return body;
    }

    const toProxy = (ref: string): string => {
      const abs = this.resolveAgainstBase(ref, base);
      if (!abs) return ref;
      const q = new URLSearchParams();
      q.set('url', abs);
      if (accessToken) q.set('token', accessToken);
      // 与全局 prefix /api 一致，供浏览器同源请求
      return `/api/playback/sessions/${sessionId}/asset?${q.toString()}`;
    };

    return body
      .split(/\r?\n/)
      .map((line) => {
        const trimmed = line.trim();
        if (!trimmed) return line;

        if (trimmed.startsWith('#')) {
          // #EXT-X-KEY:...,URI="enc.key",...  / #EXT-X-MAP:URI="..."
          // #EXT-X-MEDIA:...,URI="..."
          return line.replace(
            /URI\s*=\s*(["'])([^"']+)\1/gi,
            (_m, quote: string, uri: string) => {
              if (/^data:/i.test(uri)) return `URI=${quote}${uri}${quote}`;
              return `URI=${quote}${toProxy(uri)}${quote}`;
            },
          );
        }

        // 分片或嵌套 playlist 行
        if (/^https?:\/\//i.test(trimmed) || !trimmed.startsWith('#')) {
          // 保留行首空白
          const lead = line.match(/^\s*/)?.[0] || '';
          return lead + toProxy(trimmed);
        }
        return line;
      })
      .join('\n');
  }

  private resolveAgainstBase(ref: string, base: URL): string | null {
    const raw = (ref || '').trim();
    if (!raw || raw.startsWith('#')) return null;
    try {
      return new URL(raw, base).toString();
    } catch {
      return null;
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
    if (!session) throw new NotFoundException('播放会话不存在');

    if (session.user_id === userId) return session;

    if (session.group_id) {
      const group = await this.groupRepo.findOne({
        where: { group_id: session.group_id },
      });
      if (group && group.host_user_id === userId) return session;

      const membership = await this.groupUserMapRepo.findOne({
        where: { group_id: session.group_id, user_id: userId },
      });
      if (membership) return session;
    }

    throw new NotFoundException('播放会话不存在');
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
    if (!this.qb.isEnabled()) return session;

    // metadata 迟到（磁力可能要 1-2 分钟）：补选文件后自动开始下载
    if (!session.file_name) {
      const files = await this.qb.getFiles(session.info_hash);
      if (files.length) {
        await this.applyTorrentFiles(session, files);
        return session;
      }
    }

    // 注意：ready 也要往下走 —— 显式刷新一次 local_path，
    // 否则历史会话（曾把 content_path 目录写进 local_path）永远播不了。

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
      // 下满但文件还没出现（预分配/路径映射问题）时别标 ready，否则前端会一直重试空文件
      if (session.local_path && existsSync(session.local_path)) {
        session.status = 'ready';
        await this.sessionRepo.save(session);
        return session;
      }
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
   * 把 qB 的容器路径映射到宿主机路径。
   *
   * ⚠️ 只接受**文件**：多文件种子的 `content_path` 是目录（如
   * `/downloads/Big Buck Bunny`），以前只要 existsSync 就返回，结果
   * `local_path` 指向目录，出流时 statSync 读到 160 字节、播放器永远「缓冲不足」，
   * 表现就是「下载完也播不了」。
   */
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
      if (mapped && this.isFilePath(mapped)) return mapped;
    }

    if (fileName) {
      const byName = join(hostRoot, fileName);
      if (this.isFilePath(byName)) return byName;
    }

    if (savePath) {
      const mappedSave = this.mapContainerPathToHost(savePath, hostRoot);
      if (mappedSave && fileName) {
        const p = join(mappedSave, fileName);
        if (this.isFilePath(p)) return p;
      }
    }

    return fileName ? join(hostRoot, fileName) : hostRoot;
  }

  /** 存在且是普通文件（新下载的文件还没落地时返回 false） */
  private isFilePath(path: string): boolean {
    try {
      return existsSync(path) && statSync(path).isFile();
    } catch {
      return false;
    }
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
    playMode: 'progressive' | 'stream' | 'hls' = 'progressive',
  ) {
    // 不再是「playable/ready 才给地址」：下载中也要给，前端先挂播放器、缓冲不足自动重试
    const playable = session.status !== 'failed';
    const remuxRequired =
      !this.isStreamSession(session) &&
      (this.transcoder.needsRemux(session.file_name) ||
        this.transcoder.needsVideoTranscode(
          this.probeCache.get(session.local_path)?.videoCodec,
        ));
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
      /** true = 服务端需要 ffmpeg 转封装/转码（mkv、HEVC 等），前端提示「转码播放」 */
      remuxRequired,
    };
  }

  private sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }
}
