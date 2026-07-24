import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { playbackConfig } from '../core/config/config';
import { outboundGet } from '../core/http/outbound';
import {
  MediaSourceService,
  ParsedMediaSourceEntry,
} from '../media-source/media-source.service';

export type PlayCandidate = {
  /** bt = 磁力/种子；stream = 直链 m3u8/mp4 */
  kind: 'bt' | 'stream';
  title: string;
  /** magnet / torrent URL / 直链视频 URL */
  uri: string;
  sourceName: string;
  subscriptionName: string;
  score: number;
  /** 流媒体播放可选请求头（Referer 等） */
  headers?: Record<string, string>;
  episodeSort?: number;
};

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

@Injectable()
export class SourceSearchService {
  private readonly logger = new Logger(SourceSearchService.name);

  constructor(private readonly mediaSources: MediaSourceService) {}

  /**
   * 并行搜用户订阅：RSS(BT) + 有限个 web-selector。
   * 单源失败只记日志，不拖垮整次；整体受 searchBudgetMs 限制。
   */
  async search(opts: {
    userId: string;
    keyword: string;
    episodeSort: number;
    altKeywords?: string[];
    maxWebSources?: number;
  }): Promise<PlayCandidate[]> {
    const keyword = (opts.keyword || '').trim();
    if (!keyword) return [];
    const ep = opts.episodeSort;
    const budget = playbackConfig.searchBudgetMs;
    const started = Date.now();

    let entries: ParsedMediaSourceEntry[] = [];
    try {
      entries = await this.mediaSources.loadEnabledEntries(opts.userId);
    } catch (e) {
      this.logger.warn(`load sources: ${e instanceof Error ? e.message : e}`);
      return [];
    }

    const rssEntries = entries.filter((e) => e.factoryId === 'rss');
    const webEntries = entries.filter((e) => e.factoryId === 'web-selector');
    const maxWeb = opts.maxWebSources ?? playbackConfig.searchMaxWebSources;
    const webSlice = webEntries.slice(0, maxWeb);

    const tasks: Promise<PlayCandidate[]>[] = [];

    for (const entry of rssEntries) {
      tasks.push(
        this.withTimeout(
          this.searchRss(entry, keyword, ep),
          playbackConfig.searchSourceTimeoutMs,
          `rss:${entry.name}`,
        ),
      );
    }

    for (const entry of webSlice) {
      tasks.push(
        this.withTimeout(
          this.searchWebSelector(entry, keyword, ep),
          playbackConfig.searchSourceTimeoutMs,
          `web:${entry.name}`,
        ),
      );
    }

    // 备用关键词只塞 2 个 web，控制量
    for (const alt of (opts.altKeywords || []).slice(0, 1)) {
      if (!alt?.trim()) continue;
      for (const entry of webSlice.slice(0, 2)) {
        tasks.push(
          this.withTimeout(
            this.searchWebSelector(entry, alt.trim(), ep),
            playbackConfig.searchSourceTimeoutMs,
            `web-alt:${entry.name}`,
          ),
        );
      }
    }

    const settled = await Promise.allSettled(
      tasks.map((p) => this.raceBudget(p, budget - (Date.now() - started))),
    );

    const results: PlayCandidate[] = [];
    for (const s of settled) {
      if (s.status === 'fulfilled' && Array.isArray(s.value)) {
        results.push(...s.value);
      }
    }

    this.logger.log(
      `search "${keyword}" ep=${ep}: ${results.length} hits from ${
        tasks.length
      } tasks in ${Date.now() - started}ms`,
    );
    return this.dedupeSort(results);
  }

  /** 一次搜索同时返回最优 stream / bt，避免 createFromEpisode 搜两遍 */
  async pickBest(opts: {
    userId: string;
    keyword: string;
    episodeSort: number;
    altKeywords?: string[];
  }): Promise<{
    stream: PlayCandidate | null;
    bt: PlayCandidate | null;
    all: PlayCandidate[];
  }> {
    const all = await this.search(opts);
    const stream =
      all.find(
        (c) =>
          c.kind === 'stream' &&
          /^https?:\/\//i.test(c.uri) &&
          this.looksLikeMedia(c.uri),
      ) ||
      all.find((c) => c.kind === 'stream' && /^https?:\/\//i.test(c.uri)) ||
      null;
    const bt =
      all.find((c) => c.kind === 'bt') ||
      all.find((c) => c.uri.startsWith('magnet:')) ||
      null;
    return { stream, bt, all };
  }

  async pickBestStream(opts: {
    userId: string;
    keyword: string;
    episodeSort: number;
    altKeywords?: string[];
  }): Promise<PlayCandidate | null> {
    const { stream } = await this.pickBest(opts);
    return stream;
  }

  async pickBestBt(opts: {
    userId: string;
    keyword: string;
    episodeSort: number;
    altKeywords?: string[];
  }): Promise<PlayCandidate | null> {
    const { bt } = await this.pickBest(opts);
    return bt;
  }

  /**
   * 按单站点配置搜索（抽屉逐源状态用）
   */
  async searchOne(opts: {
    factoryId: string;
    name: string;
    searchConfig: Record<string, any>;
    keyword: string;
    episodeSort: number;
    altKeyword?: string;
    subscriptionName?: string;
  }): Promise<PlayCandidate[]> {
    const entry: ParsedMediaSourceEntry = {
      factoryId: opts.factoryId,
      name: opts.name,
      description: '',
      iconUrl: '',
      searchConfig: opts.searchConfig || {},
      subscriptionUrl: '',
      subscriptionName: opts.subscriptionName || '',
    };
    const keyword = (opts.keyword || '').trim();
    if (!keyword) return [];
    const ep = opts.episodeSort;
    const timeout = playbackConfig.searchSourceTimeoutMs;

    try {
      if (entry.factoryId === 'rss') {
        return await this.withTimeout(
          this.searchRss(entry, keyword, ep),
          timeout,
          `one-rss:${entry.name}`,
        );
      }
      if (entry.factoryId === 'web-selector') {
        let list = await this.withTimeout(
          this.searchWebSelector(entry, keyword, ep),
          timeout,
          `one-web:${entry.name}`,
        );
        if ((!list || !list.length) && opts.altKeyword?.trim()) {
          list = await this.withTimeout(
            this.searchWebSelector(entry, opts.altKeyword.trim(), ep),
            timeout,
            `one-web-alt:${entry.name}`,
          );
        }
        return list || [];
      }
      return [];
    } catch (e) {
      this.logger.debug(
        `searchOne ${opts.name}: ${e instanceof Error ? e.message : e}`,
      );
      return [];
    }
  }

  // ─────────────────── RSS / BT ───────────────────

  private async searchRss(
    entry: ParsedMediaSourceEntry,
    keyword: string,
    episodeSort: number,
  ): Promise<PlayCandidate[]> {
    const sc = entry.searchConfig || {};
    const template = String(sc.searchUrl || '');
    if (!template) return [];

    // AnimeGarden 等 URL 内 JSON 占位：keyword 需编码
    const url = template.replace(/\{keyword\}/g, encodeURIComponent(keyword));
    const xml = await this.fetchText(url, {
      accept: 'application/rss+xml, application/xml, text/xml, */*',
    });
    const items = this.parseRssItems(xml);
    const filterEp = sc.filterByEpisodeSort !== false;

    const scored: PlayCandidate[] = [];
    for (const item of items) {
      const uri = item.magnet || item.enclosure || item.link;
      if (!uri) continue;
      if (!uri.startsWith('magnet:') && !/^https?:\/\//i.test(uri)) continue;

      let score = 10;
      score += this.titleKeywordScore(item.title, keyword);
      const epScore = this.episodeScore(item.title, episodeSort);
      score += epScore;

      scored.push({
        kind: 'bt',
        title: item.title,
        uri: item.magnet || uri,
        sourceName: entry.name,
        subscriptionName: entry.subscriptionName,
        score,
        episodeSort,
      });
    }

    // 有精确集数优先；若过滤后为空则回退全部（避免 0 结果）
    if (filterEp) {
      const matched = scored.filter((c) => c.score >= 40);
      if (matched.length) return matched;
    }
    return scored;
  }

  private parseRssItems(xml: string): {
    title: string;
    link: string;
    enclosure: string;
    magnet: string;
  }[] {
    const items: {
      title: string;
      link: string;
      enclosure: string;
      magnet: string;
    }[] = [];
    const parts = xml.split(/<item[\s>]/i);
    for (let i = 1; i < parts.length; i++) {
      const block = parts[i].split(/<\/item>/i)[0] || '';
      const title = this.xmlTag(block, 'title');
      const link = this.xmlTag(block, 'link');
      const enclosure =
        block.match(/enclosure[^>]+url=["']([^"']+)["']/i)?.[1] || '';
      let magnet = '';
      const mag = block.match(/magnet:\?[^<"'\s]+/i);
      if (mag) magnet = mag[0].replace(/&amp;/g, '&');
      const desc = this.xmlTag(block, 'description');
      if (!magnet) {
        const m2 = desc.match(/magnet:\?[^<"'\s]+/i);
        if (m2) magnet = m2[0].replace(/&amp;/g, '&');
      }
      // nyaa: <link> 常是详情，enclosure/torrent 在 guid
      const guid = this.xmlTag(block, 'guid');
      items.push({
        title: this.decodeXml(title),
        link: this.decodeXml(link || guid),
        enclosure: this.decodeXml(enclosure),
        magnet,
      });
    }
    return items;
  }

  private xmlTag(block: string, tag: string) {
    const re = new RegExp(
      `<${tag}[^>]*>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))</${tag}>`,
      'i',
    );
    const m = block.match(re);
    return (m?.[1] ?? m?.[2] ?? '').trim();
  }

  private decodeXml(s: string) {
    return s
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }

  // ─────────────────── Web selector ───────────────────

  private async searchWebSelector(
    entry: ParsedMediaSourceEntry,
    keyword: string,
    episodeSort: number,
  ): Promise<PlayCandidate[]> {
    const sc = entry.searchConfig || {};
    const template = String(sc.searchUrl || '');
    if (!template) return [];

    let q = keyword;
    if (sc.searchUseOnlyFirstWord) {
      q = keyword.split(/\s+/)[0] || keyword;
    }
    if (sc.searchRemoveSpecial) {
      q = q.replace(/[^\w一-鿿\s]/g, '');
    }

    const searchUrl = template.replace(/\{keyword\}/g, encodeURIComponent(q));
    const html = await this.fetchText(searchUrl, { sc });
    const subjects = this.parseSubjects(html, sc, searchUrl);
    if (!subjects.length) return [];

    subjects.sort(
      (a, b) =>
        this.titleKeywordScore(b.name, keyword) -
        this.titleKeywordScore(a.name, keyword),
    );
    const best = subjects[0];

    const detailHtml = await this.fetchText(best.url, { sc });
    const episode = this.parseEpisodeLink(
      detailHtml,
      sc,
      best.url,
      episodeSort,
    );
    if (!episode) return [];

    const epHtml = await this.fetchText(episode.url, { sc });
    const resolved = await this.resolveVideoFromHtml(epHtml, sc, episode.url);

    const headers: Record<string, string> = {};
    const add = sc.matchVideo?.addHeadersToVideo || {};
    if (add.referer) headers.Referer = add.referer;
    else {
      try {
        headers.Referer = new URL(episode.url).origin + '/';
      } catch {
        /* ignore */
      }
    }
    if (add.userAgent) headers['User-Agent'] = add.userAgent;
    if (sc.matchVideo?.cookies) headers.Cookie = sc.matchVideo.cookies;

    if (!resolved?.url) {
      // 详情页本身不像可播直链时降低分，避免误当 stream
      return [];
    }

    return [
      {
        kind: 'stream',
        title: `${best.name} · ${episode.name}`,
        uri: resolved.url,
        sourceName: entry.name,
        subscriptionName: entry.subscriptionName,
        score: 90 + this.titleKeywordScore(best.name, keyword),
        headers,
        episodeSort,
      },
    ];
  }

  private parseSubjects(
    html: string,
    sc: Record<string, any>,
    pageUrl: string,
  ): { name: string; url: string }[] {
    const $ = cheerio.load(html);
    const formatId = sc.subjectFormatId || 'a';
    const out: { name: string; url: string }[] = [];

    if (formatId === 'indexed' || sc.selectorSubjectFormatIndexed) {
      const cfg = sc.selectorSubjectFormatIndexed || {};
      const names = $(cfg.selectNames || '').toArray();
      const links = $(cfg.selectLinks || '').toArray();
      const n = Math.max(names.length, links.length);
      for (let i = 0; i < n; i++) {
        const nameEl = names[i] || links[i];
        const linkEl = links[i] || names[i];
        const name = $(nameEl).text().trim() || $(linkEl).attr('title') || '';
        const href = $(linkEl).attr('href') || $(nameEl).attr('href') || '';
        if (!href) continue;
        out.push({ name, url: this.absUrl(pageUrl, href) });
      }
    }

    if (!out.length) {
      const cfg = sc.selectorSubjectFormatA || {};
      const sel = cfg.selectLists || 'a';
      $(sel).each((_, el) => {
        const name =
          $(el).text().trim() ||
          $(el).attr('title') ||
          $(el).find('img').attr('alt') ||
          '';
        const href = $(el).attr('href') || '';
        if (!href || !name) return;
        out.push({ name, url: this.absUrl(pageUrl, href) });
      });
    }

    const seen = new Set<string>();
    return out
      .filter((s) => {
        if (seen.has(s.url)) return false;
        seen.add(s.url);
        return true;
      })
      .slice(0, 12);
  }

  private parseEpisodeLink(
    html: string,
    sc: Record<string, any>,
    pageUrl: string,
    episodeSort: number,
  ): { name: string; url: string } | null {
    const $ = cheerio.load(html);
    const flat = sc.selectorChannelFormatFlattened || {};
    const noCh = sc.selectorChannelFormatNoChannel || {};
    const candidates: { name: string; url: string; sort: number }[] = [];

    const epNameRe = new RegExp(
      flat.matchEpisodeSortFromName ||
        noCh.matchEpisodeSortFromName ||
        '第\\s*(?<ep>.+)\\s*[话集]|\\b(?<ep>\\d{1,3})\\b',
      'i',
    );

    const collect = (name: string, href: string) => {
      if (!href) return;
      const m = name.match(epNameRe) || href.match(epNameRe);
      let sort = NaN;
      if (m) {
        const raw = (m.groups?.ep || m[1] || '').toString();
        sort = parseFloat(raw.replace(/[^\d.]/g, '')) || NaN;
      }
      candidates.push({
        name: name || `第${episodeSort}话`,
        url: this.absUrl(pageUrl, href),
        sort: Number.isFinite(sort) ? sort : -1,
      });
    };

    const listSel = flat.selectEpisodeLists;
    const epSel = flat.selectEpisodesFromList || 'a';
    if (listSel) {
      $(listSel).each((_, list) => {
        $(list)
          .find(epSel)
          .each((__, a) => {
            const name = $(a).text().trim() || $(a).attr('title') || '';
            const href = $(a).attr('href') || '';
            collect(name, href);
          });
      });
    }

    if (!candidates.length && noCh.selectEpisodes) {
      const nameNodes = $(noCh.selectEpisodes).toArray();
      const linkNodes = noCh.selectEpisodeLinks
        ? $(noCh.selectEpisodeLinks).toArray()
        : nameNodes;
      for (let i = 0; i < Math.max(nameNodes.length, linkNodes.length); i++) {
        const n = nameNodes[i] || linkNodes[i];
        const l = linkNodes[i] || nameNodes[i];
        collect(
          $(n).text().trim() || $(n).attr('title') || '',
          $(l).attr('href') || '',
        );
      }
    }

    if (!candidates.length) {
      $('a').each((_, a) => {
        const name = $(a).text().trim();
        if (!/第\s*\d+|EP?\s*\d+|\b\d{1,3}\s*话/i.test(name)) return;
        collect(name, $(a).attr('href') || '');
      });
    }

    if (!candidates.length) return null;

    const exact = candidates.find(
      (c) => c.sort === episodeSort || c.sort === Math.floor(episodeSort),
    );
    if (exact) return exact;

    const byName = candidates.find((c) =>
      this.matchesEpisode(c.name, episodeSort),
    );
    if (byName) return byName;

    const idx = Math.max(0, Math.floor(episodeSort) - 1);
    return candidates[idx] || candidates[0];
  }

  private async resolveVideoFromHtml(
    html: string,
    sc: Record<string, any>,
    pageUrl: string,
  ): Promise<{ url: string } | null> {
    const mv = sc.matchVideo || {};
    const videoRe = mv.matchVideoUrl
      ? new RegExp(mv.matchVideoUrl, 'i')
      : /(https?:\/\/[^\s"'<>]+?\.(?:mp4|m3u8|mkv|flv)(?:\?[^\s"'<>]*)?)/i;

    const tryMatch = (text: string): string | null => {
      const m = text.match(videoRe);
      if (!m) return null;
      const url = (m.groups?.v || m[1] || m[0] || '').replace(/\\u002F/g, '/');
      if (!/^https?:\/\//i.test(url)) return null;
      return url;
    };

    let found = tryMatch(html);
    if (found) return { url: found };

    const playerPatterns = [
      /"url"\s*:\s*"(https?:[^"]+)"/gi,
      /"url"\s*:\s*"(https?:[^"]+\.m3u8[^"]*)"/gi,
      /player_aaaa\s*=\s*(\{[\s\S]*?\})\s*;/i,
      /<video[^>]+src=["']([^"']+)["']/i,
      /source\s+src=["']([^"']+)["']/i,
    ];
    for (const re of playerPatterns) {
      const m = html.match(re);
      if (!m) continue;
      if (m[1]?.startsWith('{')) {
        try {
          const obj = JSON.parse(m[1]);
          const u = obj.url || obj.url_next;
          if (u && /^https?:/i.test(u)) return { url: u };
        } catch {
          /* ignore */
        }
      } else if (m[1] && /^https?:/i.test(m[1])) {
        return { url: m[1] };
      } else {
        found = tryMatch(m[0]);
        if (found) return { url: found };
      }
    }

    // 嵌套只探 3 个，避免拖垮时限
    if (mv.enableNestedUrl && mv.matchNestedUrl && mv.matchNestedUrl !== '$^') {
      try {
        const nestedRe = new RegExp(mv.matchNestedUrl, 'i');
        const hrefs = [...html.matchAll(/https?:\/\/[^\s"'<>]+/g)].map(
          (x) => x[0],
        );
        for (const h of hrefs.slice(0, 3)) {
          if (!nestedRe.test(h)) continue;
          try {
            const nestedHtml = await this.fetchText(h, { sc, timeout: 6000 });
            const v = tryMatch(nestedHtml);
            if (v) return { url: v };
          } catch {
            /* skip */
          }
        }
      } catch {
        /* invalid nested re */
      }
    }

    const $ = cheerio.load(html);
    const iframe = $('iframe').attr('src');
    if (iframe) {
      try {
        const iframeUrl = this.absUrl(pageUrl, iframe);
        const iframeHtml = await this.fetchText(iframeUrl, {
          sc,
          timeout: 6000,
        });
        const v = tryMatch(iframeHtml);
        if (v) return { url: v };
      } catch {
        /* skip */
      }
    }

    return null;
  }

  // ─────────────────── helpers ───────────────────

  private async fetchText(
    url: string,
    opts?: {
      sc?: Record<string, any>;
      accept?: string;
      timeout?: number;
    },
  ): Promise<string> {
    const headers: Record<string, string> = {
      'User-Agent': UA,
      Accept:
        opts?.accept ||
        'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    };
    const cookies = opts?.sc?.matchVideo?.cookies;
    if (cookies) headers.Cookie = cookies;

    const res = await outboundGet(url, {
      timeout: opts?.timeout ?? 10000,
      responseType: 'text',
      headers,
      transformResponse: [(d) => d],
    });
    return typeof res.data === 'string' ? res.data : String(res.data);
  }

  private looksLikeMedia(url: string) {
    return (
      /\.(mp4|m3u8|mkv|webm|m4v|flv|ts)(\?|$)/i.test(url) ||
      /m3u8|bilivideo|akamaized|cloudflarestorage|tos-cn|sign\.bytetos/i.test(
        url,
      )
    );
  }

  private async withTimeout<T>(
    p: Promise<T>,
    ms: number,
    label: string,
  ): Promise<T> {
    let timer: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        p,
        new Promise<T>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`timeout ${ms}ms`)),
            Math.max(500, ms),
          );
        }),
      ]);
    } catch (e) {
      this.logger.debug(`${label}: ${e instanceof Error ? e.message : e}`);
      return [] as unknown as T;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async raceBudget<T>(p: Promise<T>, remainMs: number): Promise<T> {
    if (remainMs <= 200) return [] as unknown as T;
    return this.withTimeout(p, remainMs, 'budget');
  }

  private absUrl(base: string, href: string) {
    try {
      return new URL(href, base).toString();
    } catch {
      return href;
    }
  }

  private titleKeywordScore(title: string, keyword: string) {
    const t = (title || '').toLowerCase();
    const parts = keyword
      .toLowerCase()
      .split(/\s+/)
      .filter((p) => p.length >= 1);
    if (!parts.length) return 0;
    let s = 0;
    for (const p of parts) {
      if (t.includes(p)) s += 10;
    }
    const compact = keyword.replace(/\s+/g, '').toLowerCase();
    if (compact && t.replace(/\s+/g, '').includes(compact)) s += 15;
    return s;
  }

  private episodeScore(title: string, ep: number) {
    if (this.matchesEpisode(title, ep)) return 40;
    const n = this.extractEpisode(title);
    if (n == null) return 0;
    return -15;
  }

  private matchesEpisode(title: string, ep: number) {
    const n = this.extractEpisode(title);
    if (n == null) return false;
    return Math.floor(n) === Math.floor(ep);
  }

  private extractEpisode(title: string): number | null {
    const patterns = [
      /第\s*(\d{1,3}(?:\.\d)?)\s*[话集]/,
      /\[(\d{1,3}(?:\.\d)?)\]/,
      /\s-\s(\d{1,3}(?:\.\d)?)\s/,
      /[Ee][Pp]?(\d{1,3})/,
      /\s(\d{2,3})\s*(?:END|Fin|v\d)?[\s.\[]/i,
    ];
    for (const re of patterns) {
      const m = title.match(re);
      if (m) return parseFloat(m[1]);
    }
    return null;
  }

  private dedupeSort(list: PlayCandidate[]) {
    const seen = new Set<string>();
    const unique: PlayCandidate[] = [];
    for (const c of list.sort((a, b) => b.score - a.score)) {
      const key = `${c.kind}|${c.uri}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(c);
    }
    return unique.slice(0, 30);
  }
}
