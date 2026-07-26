import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { playbackConfig } from '../core/config/config';
import { outboundGet } from '../core/http/outbound';
import {
  MediaSourceService,
  ParsedMediaSourceEntry,
} from '../media-source/media-source.service';

export type PlayCandidate = {
  /**
   * bt = 磁力/种子；
   * stream = 流媒体（可能是剧集播放页，也可能是 m3u8/mp4 直链）
   * 对齐 Animeko：搜索阶段通常只给 playUrl（播放页），真正视频在播放时再解析。
   */
  kind: 'bt' | 'stream';
  title: string;
  /** magnet / torrent / 播放页 / 直链 */
  uri: string;
  sourceName: string;
  subscriptionName: string;
  score: number;
  /** 流媒体播放可选请求头（Referer 等） */
  headers?: Record<string, string>;
  episodeSort?: number;
  /** 线路名（web 多线路） */
  channel?: string;
  /** 是否已是可直接播放的媒体 URL */
  resolved?: boolean;
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
          c.resolved &&
          /^https?:\/\//i.test(c.uri),
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

  // ─────────────────── Web selector（对齐 Animeko SelectorMediaSource） ───────────────────
  //
  // Animeko 流程：
  // 1) searchSubjects → 搜条目页 HTML
  // 2) selectSubjects → CSS 选出条目列表
  // 3) searchEpisodes → 拉条目详情
  // 4) selectEpisodes → 按线路(channel)解析剧集列表，产出 playUrl（播放页，不是 m3u8）
  // 5) 真正的 m3u8/mp4 在播放器 WebView 里用 matchVideo 拦截网络时得到
  //
  // 我们在搜索阶段同样返回「播放页」候选；点播放时再 resolvePlayUrl。

  private async searchWebSelector(
    entry: ParsedMediaSourceEntry,
    keyword: string,
    episodeSort: number,
  ): Promise<PlayCandidate[]> {
    const sc = entry.searchConfig || {};
    const template = String(sc.searchUrl || '');
    if (!template) return [];

    const q = this.buildSearchKeyword(keyword, sc);
    // Animeko 用 path segment 编码，效果接近 encodeURIComponent
    const searchUrl = template.replace(
      /\{keyword\}/g,
      encodeURIComponent(q),
    );

    let html: string;
    try {
      html = await this.fetchText(searchUrl, {
        sc,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      });
    } catch (e) {
      this.logger.debug(
        `web search ${entry.name}: ${e instanceof Error ? e.message : e}`,
      );
      return [];
    }

    if (this.looksLikeCaptcha(html, searchUrl)) {
      this.logger.debug(`web captcha blocked: ${entry.name}`);
      return [];
    }

    const subjects = this.selectSubjects(html, sc, searchUrl);
    if (!subjects.length) {
      this.logger.debug(`web no subjects: ${entry.name} q=${q}`);
      return [];
    }

    // 按名称匹配度选最佳条目（Animeko 有 filter；我们简化为打分）
    subjects.sort(
      (a, b) =>
        this.titleKeywordScore(b.name, keyword) -
        this.titleKeywordScore(a.name, keyword),
    );
    // 只尝试前 2 个条目，避免超时
    const trySubjects = subjects.slice(0, 2);

    const out: PlayCandidate[] = [];

    for (const subject of trySubjects) {
      let detailHtml: string;
      try {
        detailHtml = await this.fetchText(subject.url, { sc });
      } catch {
        continue;
      }
      if (this.looksLikeCaptcha(detailHtml, subject.url)) continue;

      const episodes = this.selectEpisodes(
        detailHtml,
        sc,
        subject.url,
        episodeSort,
      );
      if (!episodes.length) continue;

      for (const ep of episodes) {
        const channelPart = ep.channel ? `${ep.channel} · ` : '';
        out.push({
          kind: 'stream',
          title: `${subject.name} · ${channelPart}${ep.name}`,
          uri: ep.url,
          sourceName: entry.name,
          subscriptionName: entry.subscriptionName,
          score:
            50 +
            this.titleKeywordScore(subject.name, keyword) +
            (ep.exact ? 30 : 0),
          headers: this.buildVideoHeaders(sc, ep.url),
          episodeSort,
          channel: ep.channel,
          resolved: false,
        });
      }
      // 有结果就不再试下一个条目
      if (out.length) break;
    }

    // 搜索阶段不 resolve 直链，尽快把播放页/线路返回给前端点选；
    // 真实 m3u8/mp4 在 createFromStream → resolvePlayUrl 时再解析。
    return out;
  }

  /**
   * 播放时：把剧集播放页解析为 m3u8/mp4（对齐 Animeko WebVideoMatcher）
   */
  async resolvePlayUrl(
    pageOrMediaUrl: string,
    searchConfig?: Record<string, any>,
    extraHeaders?: Record<string, string>,
  ): Promise<{ url: string; headers?: Record<string, string> } | null> {
    const url = (pageOrMediaUrl || '').trim();
    if (!url) return null;
    if (this.looksLikeMedia(url)) {
      return {
        url,
        headers: {
          ...this.buildVideoHeaders(searchConfig || {}, url),
          ...(extraHeaders || {}),
        },
      };
    }

    const sc = searchConfig || {};
    // 前端选源时带来的 Referer/Cookie/UA 合并进 sc.matchVideo
    if (extraHeaders && Object.keys(extraHeaders).length) {
      const cookies =
        extraHeaders.Cookie ||
        extraHeaders.cookie ||
        sc.matchVideo?.cookies ||
        '';
      sc.matchVideo = {
        ...(sc.matchVideo || {}),
        cookies: cookies || sc.matchVideo?.cookies || '',
        addHeadersToVideo: {
          ...(sc.matchVideo?.addHeadersToVideo || {}),
          referer:
            extraHeaders.Referer ||
            extraHeaders.referer ||
            sc.matchVideo?.addHeadersToVideo?.referer ||
            '',
          userAgent:
            extraHeaders['User-Agent'] ||
            extraHeaders['user-agent'] ||
            sc.matchVideo?.addHeadersToVideo?.userAgent ||
            '',
        },
      };
    }

    let html: string;
    try {
      html = await this.fetchText(url, {
        sc,
        timeout: 15000,
        extraHeaders,
      });
    } catch (e) {
      this.logger.warn(
        `resolvePlayUrl fetch failed: ${e instanceof Error ? e.message : e}`,
      );
      return null;
    }
    if (this.looksLikeCaptcha(html, url)) {
      this.logger.warn(`resolvePlayUrl captcha: ${url.slice(0, 120)}`);
      return null;
    }

    const video = await this.resolveVideoFromHtml(html, sc, url);
    if (!video?.url) {
      this.logger.warn(
        `resolvePlayUrl no media in page: ${url.slice(0, 120)} htmlLen=${
          html?.length || 0
        }`,
      );
      return null;
    }
    return {
      url: video.url,
      headers: {
        ...this.buildVideoHeaders(sc, url),
        ...(extraHeaders || {}),
      },
    };
  }

  private buildSearchKeyword(keyword: string, sc: Record<string, any>) {
    let q = (keyword || '').trim();
    // Animeko: searchRemoveSpecial 删剧场版等标记，保留空格供 firstWord
    if (sc.searchRemoveSpecial !== false) {
      q = q
        .replace(/剧场版|特别篇|OVA|OAD|SP/gi, ' ')
        .replace(/[^\w一-鿿\s.-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }
    if (sc.searchUseOnlyFirstWord !== false) {
      const first = q.split(/\s+/)[0];
      if (first) q = first;
    }
    return q || keyword.trim();
  }

  private buildVideoHeaders(sc: Record<string, any>, pageUrl: string) {
    const headers: Record<string, string> = {};
    const add = sc.matchVideo?.addHeadersToVideo || {};
    if (add.referer) headers.Referer = add.referer;
    else {
      try {
        headers.Referer = new URL(pageUrl).origin + '/';
      } catch {
        /* ignore */
      }
    }
    headers['User-Agent'] =
      add.userAgent ||
      sc.matchVideo?.addHeadersToVideo?.userAgent ||
      UA;
    if (sc.matchVideo?.cookies) headers.Cookie = sc.matchVideo.cookies;
    return headers;
  }

  private looksLikeCaptcha(html: string, url: string) {
    const h = (html || '').slice(0, 8000).toLowerCase();
    const u = (url || '').toLowerCase();
    if (u.includes('cloudflare') || h.includes('cf-challenge')) return true;
    if (h.includes('captcha') && h.includes('verify')) return true;
    if (h.includes('just a moment') || h.includes('checking your browser'))
      return true;
    return false;
  }

  /** Animeko selectSubjects */
  private selectSubjects(
    html: string,
    sc: Record<string, any>,
    pageUrl: string,
  ): { name: string; url: string }[] {
    const $ = cheerio.load(html);
    const formatId = String(sc.subjectFormatId || 'a');
    const out: { name: string; url: string }[] = [];
    const base = this.guessBaseUrl(sc, pageUrl);

    if (formatId === 'indexed') {
      const cfg = sc.selectorSubjectFormatIndexed || {};
      const names = $(cfg.selectNames || '').toArray();
      const links = $(cfg.selectLinks || '').toArray();
      const n = Math.max(names.length, links.length);
      for (let i = 0; i < n; i++) {
        const nameEl = names[i];
        const linkEl = links[i] || names[i];
        const name =
          (nameEl ? $(nameEl).text().trim() : '') ||
          $(linkEl).attr('title') ||
          $(linkEl).text().trim() ||
          '';
        const href = $(linkEl).attr('href') || '';
        if (!href || !name) continue;
        out.push({ name, url: this.absUrl(base || pageUrl, href) });
      }
    } else {
      // subjectFormatId === 'a' 或默认
      const cfg = sc.selectorSubjectFormatA || {};
      const sel = cfg.selectLists || 'a';
      $(sel).each((_, el) => {
        const name =
          $(el).attr('title')?.trim() ||
          $(el).text().trim() ||
          $(el).find('img').attr('alt') ||
          '';
        const href = $(el).attr('href') || '';
        if (!href || !name) return;
        out.push({ name, url: this.absUrl(base || pageUrl, href) });
      });
    }

    const preferShorter =
      sc.selectorSubjectFormatA?.preferShorterName ||
      sc.selectorSubjectFormatIndexed?.preferShorterName;
    if (preferShorter) {
      out.sort((a, b) => a.name.length - b.name.length);
    }

    const seen = new Set<string>();
    return out
      .filter((s) => {
        if (seen.has(s.url)) return false;
        seen.add(s.url);
        return true;
      })
      .slice(0, 20);
  }

  /**
   * Animeko selectEpisodes（index-grouped + no-channel）
   * 返回匹配集数的播放页列表（可多线路）
   */
  private selectEpisodes(
    html: string,
    sc: Record<string, any>,
    subjectUrl: string,
    episodeSort: number,
  ): { name: string; url: string; channel?: string; exact: boolean }[] {
    const $ = cheerio.load(html);
    const channelFormatId = String(sc.channelFormatId || 'index-grouped');
    const flat = sc.selectorChannelFormatFlattened || {};
    const noCh = sc.selectorChannelFormatNoChannel || {};
    const base = this.subjectBaseUrl(subjectUrl);

    const epReSrc =
      flat.matchEpisodeSortFromName ||
      noCh.matchEpisodeSortFromName ||
      '第\\s*(?<ep>.+)\\s*[话集]';
    let epRe: RegExp;
    try {
      epRe = new RegExp(epReSrc, 'i');
    } catch {
      epRe = /第\s*(?<ep>.+)\s*[话集]/i;
    }

    type Ep = {
      name: string;
      url: string;
      channel?: string;
      sort: number;
    };
    const all: Ep[] = [];

    const parseSort = (name: string): number => {
      const m = name.match(epRe);
      if (m) {
        const raw = (m.groups?.ep || m[1] || '').toString();
        const n = parseFloat(raw.replace(/[^\d.]/g, ''));
        if (Number.isFinite(n)) return n;
      }
      // 纯数字 / EP01
      const m2 = name.match(/(?:EP?|第)?\s*(\d{1,3}(?:\.\d)?)/i);
      if (m2) return parseFloat(m2[1]);
      // 正片/高清版 → 电影当 1（Animeko convertSpecialEpisodes）
      if (/^(正片|高清版)$/.test(name.trim())) return 1;
      return NaN;
    };

    if (channelFormatId === 'index-grouped' || flat.selectEpisodeLists) {
      const chSel = flat.selectChannelNames || '';
      const listSel = flat.selectEpisodeLists || '';
      const epSel = flat.selectEpisodesFromList || 'a';
      const matchCh = flat.matchChannelName
        ? (() => {
            try {
              return new RegExp(flat.matchChannelName, 'i');
            } catch {
              return null;
            }
          })()
        : null;

      const channelNodes = chSel ? $(chSel).toArray() : [];
      const channelNames = channelNodes.map((el) => {
        const text = $(el).text().trim();
        if (!text) return null;
        if (!matchCh) return text;
        const m = text.match(matchCh);
        if (!m) return null;
        return (m.groups?.ch || m[1] || text).toString().trim() || text;
      });

      const lists = listSel ? $(listSel).toArray() : [];
      for (let i = 0; i < lists.length; i++) {
        const channel =
          channelNames[i] != null
            ? channelNames[i]!
            : channelNames.find((c) => c) || undefined;
        // matchChannelName 过滤掉的线路（如 (?!高清线路3) 在 JS 里需特殊处理）
        if (matchCh && channelNodes[i] && channelNames[i] === null) {
          // 负向：若配置是 (?!xxx) 类，cheerio 文本 match 可能恒 null；放宽：仍解析
        }
        const list = lists[i];
        const linksSel = flat.selectEpisodeLinksFromList;
        const linkHrefs = linksSel
          ? $(list)
              .find(linksSel)
              .toArray()
              .map((a) => $(a).attr('href') || '')
          : null;

        $(list)
          .find(epSel)
          .each((idx, a) => {
            const name = $(a).text().trim() || $(a).attr('title') || '';
            if (!name) return;
            // 跳过像线路名的项
            if (channelNames.includes(name)) return;
            const href =
              (linkHrefs && linkHrefs[idx]) || $(a).attr('href') || '';
            if (!href) return;
            all.push({
              name,
              url: this.absUrl(base, href),
              channel: channel || undefined,
              sort: parseSort(name),
            });
          });
      }
    }

    if (!all.length) {
      const epSel = noCh.selectEpisodes || '';
      const linkSel = noCh.selectEpisodeLinks || '';
      if (epSel) {
        const nameNodes = $(epSel).toArray();
        const linkNodes = linkSel ? $(linkSel).toArray() : nameNodes;
        for (let i = 0; i < Math.max(nameNodes.length, linkNodes.length); i++) {
          const n = nameNodes[i] || linkNodes[i];
          const l = linkNodes[i] || nameNodes[i];
          const name = $(n).text().trim() || $(n).attr('title') || '';
          const href = $(l).attr('href') || '';
          if (!name || !href) continue;
          all.push({
            name,
            url: this.absUrl(base, href),
            sort: parseSort(name),
          });
        }
      }
    }

    if (!all.length) {
      $('a').each((_, a) => {
        const name = $(a).text().trim();
        if (!/第\s*\d+|EP?\s*\d+|\b\d{1,3}\s*[话集]/i.test(name)) return;
        const href = $(a).attr('href') || '';
        if (!href) return;
        all.push({
          name,
          url: this.absUrl(base, href),
          sort: parseSort(name),
        });
      });
    }

    const target = Math.floor(episodeSort);
    const exact = all.filter(
      (e) => Number.isFinite(e.sort) && Math.floor(e.sort) === target,
    );
    const pool = exact.length ? exact : all;
    // 每线路保留一条最匹配
    const byChannel = new Map<string, Ep>();
    for (const e of pool) {
      const key = e.channel || e.url;
      const prev = byChannel.get(key);
      if (!prev) {
        byChannel.set(key, e);
        continue;
      }
      // 精确集数优先
      const prevExact =
        Number.isFinite(prev.sort) && Math.floor(prev.sort) === target;
      const curExact =
        Number.isFinite(e.sort) && Math.floor(e.sort) === target;
      if (curExact && !prevExact) byChannel.set(key, e);
    }

    return [...byChannel.values()].map((e) => ({
      name: e.name,
      url: e.url,
      channel: e.channel,
      exact: Number.isFinite(e.sort) && Math.floor(e.sort) === target,
    }));
  }

  private guessBaseUrl(sc: Record<string, any>, pageUrl: string) {
    if (sc.rawBaseUrl) return String(sc.rawBaseUrl);
    try {
      const u = new URL(pageUrl);
      return `${u.protocol}//${u.host}`;
    } catch {
      return pageUrl;
    }
  }

  private subjectBaseUrl(subjectUrl: string) {
    try {
      const u = new URL(subjectUrl);
      // Animeko: drop last path segment
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length) parts.pop();
      u.pathname = '/' + parts.join('/');
      u.search = '';
      u.hash = '';
      return u.toString().replace(/\/?$/, '/');
    } catch {
      return subjectUrl;
    }
  }

  /** 从 HTML 中提取 MacCMS player_aaaa 等平衡花括号 JSON */
  private extractBalancedJsonObject(
    html: string,
    marker: RegExp,
  ): string | null {
    const m = html.match(marker);
    if (!m || m.index == null) return null;
    const start = html.indexOf('{', m.index);
    if (start < 0) return null;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < html.length; i++) {
      const ch = html[i];
      if (inStr) {
        if (esc) {
          esc = false;
          continue;
        }
        if (ch === '\\') {
          esc = true;
          continue;
        }
        if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') {
        inStr = true;
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return html.slice(start, i + 1);
      }
    }
    return null;
  }

  private normalizeMediaUrl(raw: string): string | null {
    if (!raw) return null;
    let u = raw
      .replace(/\\u002F/gi, '/')
      .replace(/\\\//g, '/')
      .replace(/&amp;/g, '&')
      .trim();
    u = u.replace(/["'<>\\\s].*$/, '');
    if (u.startsWith('//')) u = 'https:' + u;
    if (!/^https?:\/\//i.test(u)) return null;
    return u;
  }

  private async resolveVideoFromHtml(
    html: string,
    sc: Record<string, any>,
    pageUrl: string,
  ): Promise<{ url: string } | null> {
    const mv = sc.matchVideo || {};
    let videoRe: RegExp;
    try {
      videoRe = mv.matchVideoUrl
        ? new RegExp(mv.matchVideoUrl, 'i')
        : /(https?:\/\/[^\s"'<>]+?\.(?:mp4|m3u8|mkv|flv)(?:\?[^\s"'<>]*)?)/i;
    } catch {
      videoRe =
        /(https?:\/\/[^\s"'<>]+?\.(?:mp4|m3u8|mkv|flv)(?:\?[^\s"'<>]*)?)/i;
    }

    const tryMatch = (text: string): string | null => {
      const decoded = text
        .replace(/\\u002F/gi, '/')
        .replace(/\\\//g, '/')
        .replace(/&amp;/g, '&');
      const m = decoded.match(videoRe);
      if (!m) {
        // 站点 matchVideoUrl 过严时回退通用 m3u8/mp4
        const fallback = decoded.match(
          /(https?:\/\/[^\s"'<>\\]+?\.(?:mp4|m3u8)(?:\?[^\s"'<>\\]*)?)/i,
        );
        if (!fallback) return null;
        return this.normalizeMediaUrl(fallback[1] || fallback[0]);
      }
      return this.normalizeMediaUrl(m.groups?.v || m[1] || m[0] || '');
    };

    // 1) MacCMS player_aaaa 优先（平衡括号 JSON，避免嵌套截断）
    const aaaaJson = this.extractBalancedJsonObject(
      html,
      /player_aaaa\s*=/i,
    );
    if (aaaaJson) {
      try {
        const obj = JSON.parse(aaaaJson);
        const candidates = [obj.url, obj.url_next, obj.link].filter(
          (x) => typeof x === 'string',
        ) as string[];
        for (const c of candidates) {
          const u = this.normalizeMediaUrl(c);
          if (u && this.looksLikeMedia(u)) return { url: u };
          // 相对路径或未带扩展名：仍可当候选
          if (u) return { url: u };
        }
        const foundInJson = tryMatch(aaaaJson);
        if (foundInJson) return { url: foundInJson };
      } catch (e) {
        this.logger.debug(
          `player_aaaa parse fail: ${e instanceof Error ? e.message : e}`,
        );
      }
    }

    let found = tryMatch(html);
    if (found) return { url: found };

    // 2) 其它常见字段
    const playerPatterns = [
      /"url"\s*:\s*"((?:https?:)?\\?\/\\?\/[^"]+)"/gi,
      /"url"\s*:\s*"(https?:[^"]+)"/gi,
      /<video[^>]+src=["']([^"']+)["']/i,
      /source\s+src=["']([^"']+)["']/i,
      /src\s*[:=]\s*["'](https?:[^"']+\.m3u8[^"']*)["']/i,
    ];
    for (const re of playerPatterns) {
      re.lastIndex = 0;
      const m = re.exec(html);
      if (!m) continue;
      if (m[1]) {
        const u = this.normalizeMediaUrl(m[1]);
        if (u) return { url: u };
        found = tryMatch(m[1]);
        if (found) return { url: found };
      }
    }

    // 嵌套 iframe / nested url（Animeko shouldLoadPage）
    if (mv.enableNestedUrl && mv.matchNestedUrl && mv.matchNestedUrl !== '$^') {
      try {
        const nestedRe = new RegExp(mv.matchNestedUrl, 'i');
        const hrefs = [...html.matchAll(/https?:\/\/[^\s"'<>]+/g)].map(
          (x) => x[0],
        );
        for (const h of hrefs.slice(0, 5)) {
          if (!nestedRe.test(h)) continue;
          try {
            const nestedHtml = await this.fetchText(h, { sc, timeout: 8000 });
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
    const iframes = $('iframe')
      .toArray()
      .map((el) => $(el).attr('src'))
      .filter(Boolean) as string[];
    for (const iframe of iframes.slice(0, 3)) {
      try {
        const iframeUrl = this.absUrl(pageUrl, iframe);
        const iframeHtml = await this.fetchText(iframeUrl, {
          sc,
          timeout: 8000,
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
      extraHeaders?: Record<string, string>;
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
    const referer = opts?.sc?.matchVideo?.addHeadersToVideo?.referer;
    if (referer) headers.Referer = referer;
    const ua = opts?.sc?.matchVideo?.addHeadersToVideo?.userAgent;
    if (ua) headers['User-Agent'] = ua;
    // 选源时前端带来的 headers 优先级更高
    if (opts?.extraHeaders) {
      for (const [k, v] of Object.entries(opts.extraHeaders)) {
        if (v != null && String(v).trim()) headers[k] = String(v);
      }
    }

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
