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
  /** 顺序下载（边下边播依赖它：前面的分片先落地） */
  seq_dl?: boolean;
  /** 首尾分片优先，让容器头部尽早可解析 */
  f_l_piece_prio?: boolean;
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
  async healthCheck(): Promise<{
    ok: boolean;
    version?: string;
    message?: string;
  }> {
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

  /**
   * 添加磁力或种子 URL，返回 infohash。
   *
   * 幂等：qB 5.x 对**已存在**的种子返回 409，这里先按 infohash 查列表再决定是否 add，
   * 并且把 409 当「已存在」继续走；否则同一个磁力第二次播放会直接 503。
   *
   * 添加时开 `seq_dl`（顺序下载）与 `f_l_piece_prio`（首尾分片优先）：
   * 顺序下载让文件从前往后陆续落地，边下边播才真的有东西可读。
   */
  async addMagnetOrUrl(uri: string): Promise<string> {
    const hashFromMagnet = this.extractHash(uri);

    if (hashFromMagnet) {
      const found = await this.findByHash(hashFromMagnet);
      if (found) return found.hash;
    }

    const form = new FormData();
    form.append('urls', uri);
    form.append('savepath', '/downloads');
    form.append('category', 'anime-chat-playback');
    form.append('paused', 'false');
    form.append('autoTMM', 'false');
    form.append('seq_dl', 'true');
    form.append('firstLastPiecePrio', 'true');

    try {
      await this.request(
        'post',
        '/api/v2/torrents/add',
        form,
        form.getHeaders(),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 409 Conflict = 该种子已在 qB 里，继续走下面的匹配逻辑
      if (!msg.includes('-> 409')) throw e;
      this.logger.log(`种子已存在，复用: ${uri.slice(0, 60)}`);
    }

    // 等待出现在列表中
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

  /** 按 infohash 找种子（不存在返回 null） */
  async findByHash(hash: string): Promise<QbTorrentInfo | null> {
    const info = await this.getTorrent(hash);
    return info;
  }

  extractHash(uri: string): string | null {
    const m = uri.match(/btih:([a-fA-F0-9]{40})/i);
    if (m) return m[1].toLowerCase();
    const m2 = uri.match(/btih:([a-zA-Z2-7]{32})/i); // base32
    return m2 ? this.base32ToHex(m2[1]) : null;
  }

  /** qB 的 hash 一律是 40 位十六进制，base32 磁力需要转换才能对上 */
  private base32ToHex(input: string): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';
    for (const ch of input.toUpperCase()) {
      const idx = alphabet.indexOf(ch);
      if (idx < 0) return input.toLowerCase();
      bits += idx.toString(2).padStart(5, '0');
    }
    let hex = '';
    for (let i = 0; i + 4 <= bits.length; i += 4) {
      hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    }
    return hex.toLowerCase();
  }

  /** 设置顺序下载（已经开着就不动，避免 toggle 成关闭） */
  async setSequential(hash: string, enabled = true): Promise<void> {
    try {
      const info = await this.getTorrent(hash);
      if (!info) return;
      if (!!info.seq_dl === enabled) return;
      const body = new URLSearchParams();
      body.set('hashes', hash);
      await this.request(
        'post',
        '/api/v2/torrents/toggleSequentialDownload',
        body.toString(),
        { 'Content-Type': 'application/x-www-form-urlencoded' },
      );
    } catch (e) {
      // 顺序下载只是优化：失败不该让整个播放会话失败
      this.logger.debug(
        `设置顺序下载失败: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
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
    await this.request('post', '/api/v2/torrents/filePrio', body0.toString(), {
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    const body1 = new URLSearchParams();
    body1.set('hash', hash);
    body1.set('id', String(fileIndex));
    body1.set('priority', '1');
    await this.request('post', '/api/v2/torrents/filePrio', body1.toString(), {
      'Content-Type': 'application/x-www-form-urlencoded',
    });
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
