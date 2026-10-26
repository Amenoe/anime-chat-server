import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { createHash } from 'crypto';
import { danmakuConfig } from 'src/core/config/config';

/**
 * 弹幕来源：dandanplay 开放平台。
 *
 * <h2>为什么必须走服务端代理</h2>
 * 它的鉴权是 `base64(sha256(AppId + Timestamp + Path + AppSecret))`。
 * AppSecret 一旦下发到浏览器，任何人都能冒用我们的配额 —— 所以签名只在服务端做。
 *
 * <h2>两个踩过的细节</h2>
 * 1. **签名只覆盖 path，不含 query**。把 `?anime=xxx` 一起签会得到 403（实测）。
 * 2. **弹幕接口返回 302**，重定向到 CDN。axios 默认跟随，但这里显式开启，
 *    避免将来有人为了「看清状态码」关掉 followRedirects 而把 302 当成失败。
 */

/** 前端渲染需要的单条弹幕（已按 artplayer-plugin-danmuku 的字段命名） */
export interface DanmakuItem {
  /** 出现时间（秒） */
  time: number;
  /** 0=滚动 1=顶部 2=底部 */
  type: 0 | 1 | 2;
  /** #rrggbb */
  color: string;
  text: string;
}

export interface DanmakuResult {
  /** 命中的 dandanplay 番剧名（用于前端提示「匹配到的是哪部」） */
  matchedTitle: string;
  /** 命中的集标题 */
  matchedEpisode: string;
  episodeId: number;
  items: DanmakuItem[];
  /** 是否来自缓存 */
  cached: boolean;
}

interface CacheEntry<T> {
  value: T;
  expireAt: number;
}

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE = 200;

@Injectable()
export class DanmakuService {
  private readonly logger = new Logger(DanmakuService.name);
  private readonly searchCache = new Map<
    string,
    CacheEntry<{ animeId: number; title: string } | null>
  >();
  private readonly commentCache = new Map<string, CacheEntry<DanmakuItem[]>>();

  private get enabled(): boolean {
    return !!(danmakuConfig.appId && danmakuConfig.appSecret);
  }

  /** 签名：base64(sha256(appId + timestamp + path + appSecret))，**path 不含 query** */
  private sign(path: string, timestamp: string): string {
    return createHash('sha256')
      .update(
        `${danmakuConfig.appId}${timestamp}${path}${danmakuConfig.appSecret}`,
      )
      .digest('base64');
  }

  private async request<T>(
    path: string,
    params?: Record<string, string | number>,
  ): Promise<T> {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const url = `https://api.dandanplay.net${path}`;
    const response = await axios.get<T>(url, {
      params,
      timeout: 15000,
      maxRedirects: 5,
      headers: {
        'X-AppId': danmakuConfig.appId,
        'X-Signature': this.sign(path, timestamp),
        'X-Timestamp': timestamp,
        Accept: 'application/json',
        // 它按 UA 做基础风控，缺失会被判异常流量
        'User-Agent': 'anime-chat/1.0 (https://github.com/Amenoe/anime-chat)',
      },
    });
    return response.data;
  }

  private readCache<T>(
    map: Map<string, CacheEntry<T>>,
    key: string,
  ): T | undefined {
    const hit = map.get(key);
    if (!hit) return undefined;
    if (hit.expireAt < Date.now()) {
      map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  private writeCache<T>(
    map: Map<string, CacheEntry<T>>,
    key: string,
    value: T,
  ): void {
    // 简单容量保护：满了就丢最早的（Map 保持插入顺序）
    if (map.size >= MAX_CACHE) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
    map.set(key, { value, expireAt: Date.now() + TTL_MS });
  }

  /**
   * 按番剧名找 dandanplay 的 animeId。
   *
   * 用 `/search/episodes?anime=` 而不是精确匹配：站内标题常带「第二季」「～在异世界…～」
   * 这类装饰，dandanplay 的标题也各不相同，精确相等几乎必然落空。
   */
  private async findAnime(
    title: string,
  ): Promise<{ animeId: number; title: string } | null> {
    const key = title.trim().toLowerCase();
    const cached = this.readCache(this.searchCache, key);
    if (cached !== undefined) return cached;

    const data = await this.request<{
      animes?: Array<{ animeId: number; animeTitle: string }>;
    }>('/api/v2/search/episodes', { anime: title });

    const first = data.animes?.[0];
    const value = first
      ? { animeId: first.animeId, title: first.animeTitle }
      : null;
    this.writeCache(this.searchCache, key, value);
    return value;
  }

  /** 在 anime 的分集列表里按集号找 episodeId */
  private async findEpisode(
    animeId: number,
    episode: number,
  ): Promise<{ id: number; title: string } | null> {
    // ⚠️ 返回字段是 `bangumi` 而不是 `anime` —— 读错字段会静默拿到空数组，
    // 表现成「搜到了番但一集都匹配不上」，非常难查。
    const data = await this.request<{
      bangumi?: {
        episodes?: Array<{ episodeId: number; episodeTitle: string }>;
      };
    }>(`/api/v2/bangumi/${animeId}`);

    const list = data.bangumi?.episodes ?? [];
    if (!list.length) return null;

    // dandanplay 的标题形如「第1话 xxx」「第 1 集」，先按数字匹配，退化为按序号取
    const matched =
      list.find((e) => {
        const m = e.episodeTitle.match(/第\s*(\d+(?:\.\d+)?)\s*[话集回]/);
        return m ? Number(m[1]) === episode : false;
      }) ?? list[Math.max(0, episode - 1)];

    return matched
      ? { id: matched.episodeId, title: matched.episodeTitle }
      : null;
  }

  /**
   * 把 dandanplay 的 `p` 字段解析成前端格式。
   *
   * `p` = `时间,类型,颜色,用户ID`，其中类型 1/2/3=滚动、4=底部、5=顶部，
   * 颜色是十进制 RGB。插件用的是 0=滚动 1=顶部 2=底部，这里统一转换，
   * 让前端不需要知道两套枚举的差异。
   */
  private parseComments(raw: {
    comments?: Array<{ p: string; m: string }>;
  }): DanmakuItem[] {
    const items: DanmakuItem[] = [];
    for (const c of raw.comments ?? []) {
      const [timePart, modePart, colorPart] = c.p.split(',');
      const time = Number(timePart);
      if (!Number.isFinite(time) || time < 0) continue;

      const mode = Number(modePart);
      const type: 0 | 1 | 2 = mode === 5 ? 1 : mode === 4 ? 2 : 0;

      const colorNum = Number(colorPart);
      const color = Number.isFinite(colorNum)
        ? `#${colorNum.toString(16).padStart(6, '0')}`
        : '#ffffff';

      const text = (c.m ?? '').trim();
      if (text) items.push({ time, type, color, text });
    }
    // 按时间排序，渲染时不必再排
    items.sort((a, b) => a.time - b.time);
    // 极端集有上万条（实测某集 3213 条已算正常），全塞给前端会拖垮渲染。
    // 超限时**均匀抽样**而不是截断：截断会让后半集完全没有弹幕，看起来像坏了。
    const limit = danmakuConfig.maxItems;
    if (items.length > limit) {
      const step = items.length / limit;
      const sampled: DanmakuItem[] = [];
      for (let i = 0; i < limit; i++) sampled.push(items[Math.floor(i * step)]);
      this.logger.warn(`弹幕 ${items.length} 条超过上限 ${limit}，已均匀抽样`);
      return sampled;
    }
    return items;
  }

  /** 已知 dandanplay episodeId 时直接取弹幕，省掉搜索这一步 */
  async fetchByEpisodeId(episodeId: number): Promise<DanmakuResult | null> {
    if (!this.enabled || !Number.isFinite(episodeId) || episodeId <= 0)
      return null;

    const cacheKey = String(episodeId);
    const cachedItems = this.readCache(this.commentCache, cacheKey);
    if (cachedItems) {
      return {
        matchedTitle: '',
        matchedEpisode: '',
        episodeId,
        items: cachedItems,
        cached: true,
      };
    }

    const raw = await this.request<{
      comments?: Array<{ p: string; m: string }>;
    }>(`/api/v2/comment/${episodeId}`);
    const items = this.parseComments(raw);
    this.writeCache(this.commentCache, cacheKey, items);
    return {
      matchedTitle: '',
      matchedEpisode: '',
      episodeId,
      items,
      cached: false,
    };
  }

  /**
   * 拉取某一集的弹幕。
   *
   * @param title   番剧名（站内标题即可，会做模糊搜索）
   * @param episode 集号（从 1 开始）
   */
  async fetch(title: string, episode: number): Promise<DanmakuResult | null> {
    if (!this.enabled) {
      this.logger.warn('未配置 DANDANPLAY_APP_ID / APP_SECRET，弹幕功能不可用');
      return null;
    }
    if (!title?.trim() || !Number.isFinite(episode) || episode <= 0)
      return null;

    const anime = await this.findAnime(title);
    if (!anime) return null;

    const ep = await this.findEpisode(anime.animeId, episode);
    if (!ep) return null;

    const cacheKey = String(ep.id);
    const cachedItems = this.readCache(this.commentCache, cacheKey);
    if (cachedItems) {
      return {
        matchedTitle: anime.title,
        matchedEpisode: ep.title,
        episodeId: ep.id,
        items: cachedItems,
        cached: true,
      };
    }

    const raw = await this.request<{
      comments?: Array<{ p: string; m: string }>;
    }>(`/api/v2/comment/${ep.id}`);
    const items = this.parseComments(raw);
    this.writeCache(this.commentCache, cacheKey, items);

    this.logger.log(`弹幕命中 ${anime.title} ${ep.title}：${items.length} 条`);
    return {
      matchedTitle: anime.title,
      matchedEpisode: ep.title,
      episodeId: ep.id,
      items,
      cached: false,
    };
  }
}
