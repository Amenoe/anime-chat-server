import { config as loadEnv } from 'dotenv';
import { existsSync } from 'fs';
import { join } from 'path';

/**
 * development / production 两套配置：
 *   .env.development  ← pnpm start:dev
 *   .env.production   ← pnpm start:prod
 */
const nodeEnv = process.env.NODE_ENV || 'development';
const cwd = process.cwd();
const envFile = join(cwd, `.env.${nodeEnv}`);
if (existsSync(envFile)) {
  loadEnv({ path: envFile, override: false });
} else {
  // eslint-disable-next-line no-console
  console.warn(
    `[config] missing ${envFile} — set env vars or create .env.${nodeEnv}`,
  );
}

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(
      `Missing env ${name}. Create .env.${nodeEnv} and fill in values.`,
    );
  }
  return value;
}

export const appConfig = {
  nodeEnv,
  isDev: nodeEnv === 'development',
  isProd: nodeEnv === 'production',
};

function durationToSeconds(value: string): number {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)([smhd]?)$/i);
  if (!match) throw new Error(`Invalid JWT duration: ${value}`);
  const amount = Number(match[1]);
  const unit = (match[2] || 's').toLowerCase();
  return amount * ({ s: 1, m: 60, h: 3600, d: 86400 }[unit] || 1);
}

/**
 * 双 token：
 *   accessToken  —— 随请求头下发，短时效（默认 2h），不落库
 *   refreshToken —— 仅用于 /api/auth/refresh 换新，长时效（默认 30d），落库可吊销
 * JWT_REFRESH_SECRET 缺省时由主密钥派生，避免与 accessToken 混用同一密钥。
 */
export const jwtConfig = {
  secret: required('JWT_SECRET', 'dev-only-change-me'),
  refreshSecret:
    process.env.JWT_REFRESH_SECRET ||
    `${required('JWT_SECRET', 'dev-only-change-me')}:refresh`,
  accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '2h',
  refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  accessExpiresInSec: durationToSeconds(
    process.env.JWT_ACCESS_EXPIRES_IN || '2h',
  ),
  refreshExpiresInSec: durationToSeconds(
    process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  ),
};

export const DBConifg = {
  type: 'mysql' as const,
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  username: required('DB_USERNAME', 'root'),
  password: required('DB_PASSWORD'),
  database: required('DB_DATABASE', 'anime_chat'),
};

/** MinIO：仅头像 */
export const minioConfig = {
  endPoint: process.env.MINIO_ENDPOINT || '127.0.0.1',
  port: Number(process.env.MINIO_PORT || 9000),
  useSSL: (process.env.MINIO_USE_SSL || 'false').toLowerCase() === 'true',
  accessKey: required('MINIO_ACCESS_KEY', ''),
  secretKey: required('MINIO_SECRET_KEY', ''),
  bucket: process.env.MINIO_BUCKET || 'anime-chat',
  avatarPrefix: process.env.MINIO_AVATAR_PREFIX || 'avatars',
};

/**
 * qBittorrent：BT 边下边播
 * 下载目录与 compose 卷对齐
 */
export const qbittorrentConfig = {
  baseUrl: (process.env.QB_URL || 'http://127.0.0.1:8085').replace(/\/$/, ''),
  username: process.env.QB_USERNAME || 'admin',
  password: process.env.QB_PASSWORD || 'adminadmin',
  downloadPath:
    process.env.QB_DOWNLOAD_PATH ||
    (nodeEnv === 'development'
      ? '/Users/rain/Movies/anime'
      : join(cwd, 'data', 'bt-downloads')),
  enabled: (process.env.QB_ENABLED || 'false').toLowerCase() === 'true',
};

export const playbackConfig = {
  playableProgress: Number(process.env.PLAYBACK_PLAYABLE_PROGRESS || 0.15),
  playableMinBytes: Number(
    process.env.PLAYBACK_PLAYABLE_MIN_BYTES || 30 * 1024 * 1024,
  ),
  pollIntervalMs: Number(process.env.PLAYBACK_POLL_INTERVAL_MS || 3000),
  /** 单次搜源整体时限 ms（避免前端 10s 先超时） */
  searchBudgetMs: Number(process.env.PLAYBACK_SEARCH_BUDGET_MS || 25000),
  /** 单个 web 源探测超时 */
  searchSourceTimeoutMs: Number(
    process.env.PLAYBACK_SEARCH_SOURCE_TIMEOUT_MS || 8000,
  ),
  /** 并行探测的 web 源数量上限 */
  searchMaxWebSources: Number(process.env.PLAYBACK_SEARCH_MAX_WEB || 6),
};

/**
 * 播放转封装 / 转码（ffmpeg）。
 *
 * 浏览器只认 mp4/webm 这类容器与 h264/vp9/av1 这类编码；番剧磁力常见的
 * `xxx.mkv`（HEVC 10bit + ASS 字幕）无法直接播。服务端用 ffmpeg 把**已下载的部分**
 * 转成 fMP4 流，才能做到「边下边播」而不是等整集下完。
 *
 * 未安装 ffmpeg 时自动降级：会话仍可创建，但这类资源会提示换源，
 * 不影响 mp4 直链/种子。
 */
export const transcodeConfig = {
  ffmpegPath: (process.env.FFMPEG_PATH || 'ffmpeg').trim(),
  ffprobePath: (process.env.FFPROBE_PATH || 'ffprobe').trim(),
  enabled: (process.env.PLAYBACK_TRANSCODE || 'true').toLowerCase() === 'true',
  /**
   * auto = 优先硬件编码（macOS 的 h264_videotoolbox、NVIDIA 的 h264_nvenc），
   * 都没有时回落 libx264。也可显式指定编码器名。
   */
  videoEncoder: (process.env.PLAYBACK_VIDEO_ENCODER || 'auto').trim(),
  /** libx264 预设；硬件编码忽略该值 */
  preset: (process.env.PLAYBACK_TRANSCODE_PRESET || 'veryfast').trim(),
  /** 转码输出码率上限 */
  maxBitrate: (process.env.PLAYBACK_TRANSCODE_MAX_BITRATE || '6M').trim(),
  /**
   * HLS 分片时长（秒）。
   *
   * mkv/HEVC 走「按需分片转码 + 静态 m3u8」：playlist 里带全部 EXTINF，
   * 播放器因此知道总时长、能随意 seek；每个分片第一次被请求时才转码并落缓存。
   */
  segmentSeconds: Math.max(2, Number(process.env.PLAYBACK_HLS_SEGMENT || 6)),
  /** 分片缓存目录（默认系统临时目录） */
  hlsCacheDir: (process.env.PLAYBACK_HLS_CACHE_DIR || '').trim(),
  /** 缓存保留时长（小时），超过后由定时器清理 */
  hlsCacheTtlHours: Number(process.env.PLAYBACK_HLS_CACHE_TTL_HOURS || 6),
};

/** 可选：仅运维在服务端代拉外网时配置 */
export const outboundConfig = {
  proxyUrl: (process.env.OUTBOUND_PROXY || '').trim(),
};

/**
 * AI 网关：把前端的对话请求转发到 anime-ai 服务（Spring Boot，默认 8013）。
 *
 * 职责边界：本服务负责鉴权、配额、会话落库与 SSE 透传；
 * 检索与模型编排在 anime-ai，**本服务不碰检索逻辑**。
 *
 * 会话历史的权威来源是这里的 MySQL —— anime-ai 是无状态的，
 * 每次请求由本服务把历史窗口一并送过去。所以 `historyWindow` 是**唯一**的窗口裁剪点。
 */
/**
 * 弹幕（dandanplay 开放平台）。
 *
 * 签名算法 `base64(sha256(AppId + Timestamp + Path + AppSecret))` 只在服务端执行 ——
 * AppSecret 泄露等于任何人都能冒用我们的调用配额。
 *
 * 未配置时弹幕接口返回空，播放器只是没有弹幕，不影响播放本身。
 */
export const danmakuConfig = {
  appId: (process.env.DANDANPLAY_APP_ID || '').trim(),
  appSecret: (process.env.DANDANPLAY_APP_SECRET || '').trim(),
  callback: (process.env.DANDANPLAY_CALLBACK || '').trim(),
  /** 单集弹幕上限：极端集有上万条，全塞给前端会卡渲染 */
  maxItems: Number(process.env.DANMAKU_MAX_ITEMS || 6000),
};

export const aiConfig = {
  serviceUrl: (process.env.AI_SERVICE_URL || 'http://127.0.0.1:8013').replace(
    /\/+$/,
    '',
  ),
  /** 必须与 anime-ai 的 `ai.internal-token` 一致，否则被拒 401 */
  internalToken: process.env.AI_INTERNAL_TOKEN || '',
  /** 每日每人对话配额（次）。<= 0 表示不限量（仅供本地调试） */
  dailyQuota: Number(process.env.AI_DAILY_QUOTA || 50),
  /** 单条用户消息长度上限，与 anime-ai 侧 DTO 保持一致 */
  maxMessageLength: Number(process.env.AI_MAX_MESSAGE_LENGTH || 2000),
  /** 每次送给模型的最近消息条数（唯一的历史裁剪点） */
  historyWindow: Number(process.env.AI_HISTORY_WINDOW || 20),
  /** 建连/首字节超时；流式开始后由 streamTimeoutMs 兜底 */
  upstreamTimeoutMs: Number(process.env.AI_UPSTREAM_TIMEOUT_MS || 30000),
  /** 单次流式总时限，需大于 anime-ai 侧模型超时（60s） */
  streamTimeoutMs: Number(process.env.AI_STREAM_TIMEOUT_MS || 180000),
};
