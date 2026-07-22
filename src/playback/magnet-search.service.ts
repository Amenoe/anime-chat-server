import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

export type MagnetCandidate = {
  title: string;
  uri: string; // magnet: 或 http(s) .torrent
  source: 'mikan';
  score: number;
};

/**
 * 从公开索引站 RSS 检索磁力/种子（不经过浏览器 WebFetch）。
 * 默认蜜柑计划 RSS；站点变更时可能需调整解析。
 */
@Injectable()
export class MagnetSearchService {
  private readonly logger = new Logger(MagnetSearchService.name);

  async searchForEpisode(opts: {
    keyword: string;
    episodeSort: number;
    altKeywords?: string[];
  }): Promise<MagnetCandidate[]> {
    const kw = (opts.keyword || '').trim();
    if (!kw) return [];

    const ep = opts.episodeSort;
    const epPad = String(Math.floor(ep)).padStart(2, '0');
    const queries = Array.from(
      new Set(
        [
          `${kw} ${epPad}`,
          `${kw} ${ep}`,
          ...(opts.altKeywords || []).flatMap((a) =>
            a ? [`${a} ${epPad}`, `${a} ${ep}`] : [],
          ),
        ].filter(Boolean),
      ),
    );

    const all: MagnetCandidate[] = [];
    for (const q of queries.slice(0, 4)) {
      try {
        const batch = await this.searchMikan(q);
        all.push(...batch);
      } catch (e) {
        this.logger.warn(
          `mikan search "${q}": ${e instanceof Error ? e.message : e}`,
        );
      }
    }

    // 按集数过滤 + 打分
    const filtered = all
      .map((c) => ({
        ...c,
        score: c.score + this.episodeScore(c.title, ep),
      }))
      .filter((c) => this.matchesEpisode(c.title, ep))
      .sort((a, b) => b.score - a.score);

    // 去重 uri
    const seen = new Set<string>();
    const unique: MagnetCandidate[] = [];
    for (const c of filtered) {
      const key = c.uri.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(c);
    }
    return unique.slice(0, 15);
  }

  /** 选最优一条（无结果返回 null） */
  async pickBest(opts: {
    keyword: string;
    episodeSort: number;
    altKeywords?: string[];
  }): Promise<MagnetCandidate | null> {
    const list = await this.searchForEpisode(opts);
    return list[0] || null;
  }

  private async searchMikan(searchstr: string): Promise<MagnetCandidate[]> {
    const url = `https://mikanani.me/RSS/Search?searchstr=${encodeURIComponent(
      searchstr,
    )}`;
    const res = await axios.get<string>(url, {
      timeout: 20000,
      responseType: 'text',
      headers: {
        'User-Agent':
          'anime-chat/1.0 (+https://github.com/Amenoe/anime-chat; playback)',
        Accept: 'application/rss+xml, application/xml, text/xml, */*',
      },
      // 部分环境需忽略证书问题时可开，默认关闭
      // httpsAgent: ...
    });
    const xml = typeof res.data === 'string' ? res.data : String(res.data);
    return this.parseRssItems(xml, 'mikan');
  }

  private parseRssItems(
    xml: string,
    source: MagnetCandidate['source'],
  ): MagnetCandidate[] {
    const items: MagnetCandidate[] = [];
    const itemRe = /<item>([\s\S]*?)<\/item>/gi;
    let m: RegExpExecArray | null;
    while ((m = itemRe.exec(xml))) {
      const block = m[1];
      const title = this.decodeXml(
        this.tagText(block, 'title') ||
          this.tagText(block, 'title', true) ||
          '',
      ).trim();
      if (!title) continue;

      let uri =
        this.extractMagnet(block) ||
        this.attr(block, 'enclosure', 'url') ||
        this.tagText(block, 'link') ||
        '';

      uri = this.decodeXml(uri).trim();
      // mikan 有时只有种子页，enclosure 才是 torrent
      if (!uri) continue;
      if (
        !uri.startsWith('magnet:') &&
        !/^https?:\/\//i.test(uri) &&
        !uri.includes('.torrent')
      ) {
        continue;
      }
      // 纯详情页无种子则跳过
      if (
        /^https?:\/\//i.test(uri) &&
        !/\.torrent(\?|$)/i.test(uri) &&
        !/Download\//i.test(uri) &&
        !uri.startsWith('magnet:')
      ) {
        // mikan Download 路径也可被 qB 添加
        if (!/mikanani\.me\/Download/i.test(uri)) continue;
      }

      items.push({
        title,
        uri,
        source,
        score: this.qualityScore(title),
      });
    }
    return items;
  }

  private extractMagnet(block: string): string | null {
    const m = block.match(/magnet:\?[^"'<\s]+/i);
    return m ? m[0].replace(/&amp;/g, '&') : null;
  }

  private tagText(block: string, tag: string, cdata = false): string {
    if (cdata) {
      const re = new RegExp(
        `<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`,
        'i',
      );
      const m = block.match(re);
      if (m) return m[1];
    }
    const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
    const m = block.match(re);
    return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
  }

  private attr(block: string, tag: string, name: string): string {
    const re = new RegExp(`<${tag}[^>]*\\s${name}=["']([^"']+)["']`, 'i');
    const m = block.match(re);
    return m ? m[1] : '';
  }

  private decodeXml(s: string) {
    return s
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }

  /** 标题是否像对应集数 */
  private matchesEpisode(title: string, ep: number): boolean {
    const n = Math.floor(ep);
    const pad = String(n).padStart(2, '0');
    // 常见： - 01、[01]、第01话、EP01、E01
    const patterns = [
      new RegExp(`(?:^|[^0-9])0?${n}(?:[^0-9]|$)`),
      new RegExp(`(?:第)\\s*0?${n}\\s*(?:话|集|話)`),
      new RegExp(`(?:EP|E|S\\d+E)\\s*0?${n}(?:[^0-9]|$)`, 'i'),
      new RegExp(`\\[0?${n}\\]`),
      new RegExp(`【0?${n}】`),
      new RegExp(`-\\s*${pad}(?:\\s|\\[|\\.|$)`),
    ];
    // 合集/全集排除（除非 ep 本身就是范围需求）
    if (/全集|合集|全\d+话|Batch|BD-BOX|完结/i.test(title) && n > 1) {
      // 合集可能含多集，暂降权但不在 matches 里直接否（由 score 处理）
    }
    return patterns.some((p) => p.test(title));
  }

  private episodeScore(title: string, ep: number): number {
    const n = Math.floor(ep);
    const pad = String(n).padStart(2, '0');
    let s = 0;
    if (title.includes(pad)) s += 30;
    if (new RegExp(`第\\s*0?${n}\\s*话`).test(title)) s += 20;
    if (/全集|合集|Batch/i.test(title)) s -= 40;
    return s;
  }

  private qualityScore(title: string): number {
    let s = 0;
    if (/1080p|1920x1080|FHD/i.test(title)) s += 50;
    if (/720p|1280x720/i.test(title)) s += 30;
    if (/2160p|4K|UHD/i.test(title)) s += 40;
    if (/\.mp4|MP4/i.test(title)) s += 15;
    if (/简日|简中|CHS|GB|SC/i.test(title)) s += 10;
    if (/繁日|繁中|CHT|BIG5/i.test(title)) s += 5;
    if (/REPACK|嵌字渣/i.test(title)) s -= 10;
    return s;
  }
}
