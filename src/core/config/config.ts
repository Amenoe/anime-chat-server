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

export const jwtConfig = {
  secret: required('JWT_SECRET', 'dev-only-change-me'),
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

/** 可选：仅运维在服务端代拉外网时配置 */
export const outboundConfig = {
  proxyUrl: (process.env.OUTBOUND_PROXY || '').trim(),
};
