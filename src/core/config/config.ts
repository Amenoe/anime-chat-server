import { config as loadEnv } from 'dotenv';
import { join } from 'path';

// 在任意模块 import 本文件时尽早加载 .env（本地开发；生产用真实环境变量）
loadEnv({ path: join(process.cwd(), '.env') });

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(
      `Missing env ${name}. Copy .env.example to .env and fill in values.`,
    );
  }
  return value;
}

export const jwtConfig = {
  secret: required('JWT_SECRET', 'dev-only-change-me'),
};

/** TypeORM MySQL 连接（密钥只从环境变量读，不写进仓库） */
export const DBConifg = {
  type: 'mysql' as const,
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  username: required('DB_USERNAME', 'root'),
  password: required('DB_PASSWORD'),
  database: required('DB_DATABASE', 'anime_chat'),
};

/**
 * MinIO / S3 兼容对象存储。
 * Private 桶仍可被后端用 Access Key 读写；浏览器不能直接匿名访问。
 */
export const minioConfig = {
  endPoint: process.env.MINIO_ENDPOINT || '127.0.0.1',
  port: Number(process.env.MINIO_PORT || 9000),
  useSSL: (process.env.MINIO_USE_SSL || 'false').toLowerCase() === 'true',
  accessKey: required('MINIO_ACCESS_KEY', ''),
  secretKey: required('MINIO_SECRET_KEY', ''),
  bucket: process.env.MINIO_BUCKET || 'anime-chat',
  /** 对象键前缀，例如 avatars/xxx.png */
  avatarPrefix: process.env.MINIO_AVATAR_PREFIX || 'avatars',
  /** 播放缓存对象前缀 playback/{infohash}/... */
  playbackPrefix: process.env.MINIO_PLAYBACK_PREFIX || 'playback',
};

/**
 * qBittorrent Web API（推荐 Docker 部署，见 docker-compose.playback.yml）
 * 云服务器：与 Nest 同机跑容器即可，不必系统级安装 qBittorrent 桌面版
 */
export const qbittorrentConfig = {
  /** 例如 http://127.0.0.1:8085 */
  baseUrl: (process.env.QB_URL || 'http://127.0.0.1:8085').replace(/\/$/, ''),
  username: process.env.QB_USERNAME || 'admin',
  password: process.env.QB_PASSWORD || 'adminadmin',
  /** 与 compose 中 downloads 卷对应的宿主机路径（Nest 读文件用） */
  downloadPath:
    process.env.QB_DOWNLOAD_PATH || join(process.cwd(), 'data', 'bt-downloads'),
  /** 为 false 时播放接口返回 503，便于未部署 qB 时其它功能仍可用 */
  enabled: (process.env.QB_ENABLED || 'true').toLowerCase() === 'true',
};

export const playbackConfig = {
  /** 边下边播：已下载比例达到该值且至少 playableMinBytes 可尝试出流 */
  playableProgress: Number(process.env.PLAYBACK_PLAYABLE_PROGRESS || 0.15),
  playableMinBytes: Number(
    process.env.PLAYBACK_PLAYABLE_MIN_BYTES || 30 * 1024 * 1024,
  ),
  /** 轮询 qB 进度间隔 ms */
  pollIntervalMs: Number(process.env.PLAYBACK_POLL_INTERVAL_MS || 3000),
  /**
   * 是否在下完后把文件再拷到 MinIO（默认 false）。
   * 同机部署应直接读 qB 落盘路径，避免双份存储与额外传输。
   * 仅当需要「清本地盘仍能播 / 多实例共享成片」时再设 true。
   */
  uploadToMinio:
    (process.env.PLAYBACK_UPLOAD_TO_MINIO || 'false').toLowerCase() === 'true',
};
