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
};
