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
