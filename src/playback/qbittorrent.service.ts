import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
// form-data CJS
// eslint-disable-next-line @typescript-eslint/no-var-requires
const FormData = require('form-data') as typeof import('form-data');
import { qbittorrentConfig } from '../core/config/config';

export type QbTorrentInfo = {
  hash: string;
  name: string;
  progress: number;
  dlspeed: number;
  size: number;
  downloaded: number;
  state: string;
  save_path: string;
  content_path: string;
};

export type QbTorrentFile = {
  index: number;
  name: string;
  size: number;
  progress: number;
  priority: number;
};

@Injectable()
export class QbittorrentService {
  private readonly logger = new Logger(QbittorrentService.name);
  private cookie = '';
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: qbittorrentConfig.baseUrl,
      timeout: 30000,
      validateStatus: () => true,
    });
  }

  isEnabled() {
    return qbittorrentConfig.enabled;
  }

  assertEnabled() {
    if (!this.isEnabled()) {
      throw new ServiceUnavailableException(
        '播放服务未启用：请配置 QB_ENABLED 并启动 qBittorrent（docker-compose.playback.yml）',
      );
    }
  }

  private async ensureLogin() {
    this.assertEnabled();
    if (this.cookie) return;
    const body = new URLSearchParams();
    body.set('username', qbittorrentConfig.username);
    body.set('password', qbittorrentConfig.password);
    const res = await this.client.post('/api/v2/auth/login', body.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    // 新版 qB 常返回 204 + Set-Cookie: QBT_SID_端口=...；旧版多为 200 + body "Ok."
    const bodyText = res.data == null ? '' : String(res.data);
    const failed =
      bodyText.includes('Fails') ||
      res.status === 401 ||
      res.status === 403 ||
      res.status >= 500;
    if (failed) {
      this.logger.error(`qB login failed: ${res.status} ${bodyText}`);
      throw new ServiceUnavailableException(
        '无法登录 qBittorrent，请检查 QB_URL / 账号密码',
      );
    }
    const raw = res.headers['set-cookie'] as string[] | string | undefined;
    if (Array.isArray(raw) && raw.length) {
      this.cookie = raw.map((c) => c.split(';')[0]).join('; ');
    } else if (typeof raw === 'string' && raw) {
      this.cookie = raw.split(';')[0];
    } else {
      this.cookie = '';
    }
    // 204 无 body 时必须有 SID cookie（如 QBT_SID_8085）
    if (!this.cookie && res.status !== 200) {
      this.logger.error(`qB login missing cookie: status=${res.status}`);
      throw new ServiceUnavailableException(
        'qBittorrent 登录未返回会话 Cookie',
      );
    }
  }

  /** 连通性自检：登录 + 读版本 */
  async healthCheck(): Promise<{ ok: boolean; version?: string; message?: string }> {
    try {
      this.cookie = '';
      await this.ensureLogin();
      const version = await this.request<string>('get', '/api/v2/app/version');
      return { ok: true, version: String(version) };
    } catch (e) {
      return {
        ok: false,
        message: e instanceof Error ? e.message : String(e),
      };
    }
  }

  private async request<T = any>(
    method: 'get' | 'post',
    url: string,
    data?: any,
    headers?: Record<string, string>,
  ): Promise<T> {
    await this.ensureLogin();
    const res = await this.client.request({
      method,
      url,
      data,
      headers: {
        Cookie: this.cookie,
        ...headers,
      },
    });
    if (res.status === 403) {
      this.cookie = '';
      await this.ensureLogin();
      const retry = await this.client.request({
        method,
        url,
        data,
        headers: { Cookie: this.cookie, ...headers },
      });
      if (retry.status >= 400) {
        throw new ServiceUnavailableException(
          `qBittorrent API ${url} -> ${retry.status}`,
        );
      }
      return retry.data as T;
    }
    if (res.status >= 400) {
      throw new ServiceUnavailableException(
        `qBittorrent API ${url} -> ${res.status}`,
      );
    }
    return res.data as T;
  }

  /** 添加磁力或种子 URL，返回 infohash（尽量从列表匹配） */
  async addMagnetOrUrl(uri: string): Promise<string> {
    const form = new FormData();
    form.append('urls', uri);
    form.append('savepath', '/downloads');
    form.append('category', 'anime-chat-playback');
    form.append('paused', 'false');
    form.append('autoTMM', 'false');

    await this.request('post', '/api/v2/torrents/add', form, form.getHeaders());

    // 等待出现在列表中
    const hashFromMagnet = this.extractHash(uri);
    for (let i = 0; i < 15; i++) {
      await this.sleep(1000);
      const list = await this.listTorrents();
      if (hashFromMagnet) {
        const found = list.find(
          (t) => t.hash.toLowerCase() === hashFromMagnet.toLowerCase(),
        );
        if (found) return found.hash;
      }
      // 取最新添加的
      if (list.length) {
        const sorted = [...list].sort((a, b) =>
          (b as any).added_on > (a as any).added_on ? 1 : -1,
        );
        if (sorted[0]) return sorted[0].hash;
      }
    }
    throw new ServiceUnavailableException('添加种子超时，请检查 qBittorrent');
  }

  extractHash(uri: string): string | null {
    const m = uri.match(/btih:([a-fA-F0-9]{40})/i);
    if (m) return m[1].toLowerCase();
    const m2 = uri.match(/btih:([a-zA-Z2-7]{32})/i); // base32
    return m2 ? m2[1].toLowerCase() : null;
  }

  async listTorrents(): Promise<QbTorrentInfo[]> {
    const data = await this.request<QbTorrentInfo[]>(
      'get',
      '/api/v2/torrents/info',
    );
    return Array.isArray(data) ? data : [];
  }

  async getTorrent(hash: string): Promise<QbTorrentInfo | null> {
    const data = await this.request<QbTorrentInfo[]>(
      'get',
      `/api/v2/torrents/info?hashes=${hash}`,
    );
    return Array.isArray(data) && data[0] ? data[0] : null;
  }

  async getFiles(hash: string): Promise<QbTorrentFile[]> {
    const data = await this.request<any[]>(
      'get',
      `/api/v2/torrents/files?hash=${hash}`,
    );
    if (!Array.isArray(data)) return [];
    return data.map((f, i) => ({
      index: typeof f.index === 'number' ? f.index : i,
      name: f.name,
      size: f.size,
      progress: f.progress,
      priority: f.priority,
    }));
  }

  /** 只下载选中文件：选中 1，其它 0 */
  async setOnlyFile(hash: string, fileIndex: number) {
    const files = await this.getFiles(hash);
    if (!files.length) return;
    const allIdx = files.map((f) => f.index).join('|');
    const body0 = new URLSearchParams();
    body0.set('hash', hash);
    body0.set('id', allIdx);
    body0.set('priority', '0');
    await this.request(
      'post',
      '/api/v2/torrents/filePrio',
      body0.toString(),
      { 'Content-Type': 'application/x-www-form-urlencoded' },
    );
    const body1 = new URLSearchParams();
    body1.set('hash', hash);
    body1.set('id', String(fileIndex));
    body1.set('priority', '1');
    await this.request(
      'post',
      '/api/v2/torrents/filePrio',
      body1.toString(),
      { 'Content-Type': 'application/x-www-form-urlencoded' },
    );
  }

  pickBestVideoFile(files: QbTorrentFile[]): QbTorrentFile | null {
    const videoExt = /\.(mp4|mkv|avi|mov|webm|m4v|ts|flv)$/i;
    const videos = files.filter((f) => videoExt.test(f.name));
    const pool = videos.length ? videos : files;
    if (!pool.length) return null;
    return pool.reduce((a, b) => (a.size >= b.size ? a : b));
  }

  private sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }
}
