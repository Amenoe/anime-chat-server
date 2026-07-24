import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { Repository } from 'typeorm';
import { outboundGet } from '../core/http/outbound';
import { CreateMediaSourceDto } from './dto/create-media-source.dto';
import { UpdateMediaSourceDto } from './dto/update-media-source.dto';
import { MediaSource, MediaSourceKind } from './entities/media-source.entity';

function hashUrl(url: string) {
  return createHash('sha256').update(url.trim()).digest('hex');
}

/** creamycake 默认订阅（用户首次打开数据源时写入） */
export const DEFAULT_MEDIA_SOURCE_URLS = [
  {
    name: '流媒体订阅 (css1)',
    url: 'https://sub.creamycake.org/v1/css1.json',
    kind: 'web' as MediaSourceKind,
    sort_order: 0,
  },
  {
    name: 'BT 订阅 (bt1)',
    url: 'https://sub.creamycake.org/v1/bt1.json',
    kind: 'rss' as MediaSourceKind,
    sort_order: 1,
  },
];

export type ParsedMediaSourceEntry = {
  factoryId: string;
  name: string;
  description: string;
  iconUrl: string;
  searchConfig: Record<string, any>;
  subscriptionUrl: string;
  subscriptionName: string;
};

@Injectable()
export class MediaSourceService {
  private readonly logger = new Logger(MediaSourceService.name);
  /** url → 缓存 */
  private cache = new Map<
    string,
    { at: number; entries: ParsedMediaSourceEntry[] }
  >();
  private readonly cacheTtlMs = 10 * 60 * 1000;

  constructor(
    @InjectRepository(MediaSource)
    private readonly repo: Repository<MediaSource>,
  ) {}

  /** 列出用户数据源；空则写入默认 creamycake 订阅 */
  async list(userId: string) {
    await this.ensureDefaults(userId);
    return this.repo.find({
      where: { user_id: userId },
      order: { sort_order: 'ASC', create_time: 'ASC' },
    });
  }

  async add(userId: string, dto: CreateMediaSourceDto) {
    const url = dto.url.trim();
    const url_hash = hashUrl(url);
    const exists = await this.repo.findOne({
      where: { user_id: userId, url_hash },
    });
    if (exists) {
      throw new BadRequestException('该订阅 URL 已存在');
    }

    let kind: MediaSourceKind = 'mixed';
    let name = (dto.name || '').trim();
    try {
      const entries = await this.fetchAndParse(url);
      kind = this.inferKind(entries);
      if (!name && entries[0]?.name) {
        name = entries
          .map((e) => e.name)
          .slice(0, 3)
          .join(' / ');
      }
    } catch (e) {
      this.logger.warn(
        `preview source failed: ${e instanceof Error ? e.message : e}`,
      );
    }

    const row = this.repo.create({
      user_id: userId,
      url,
      url_hash,
      name: name || url,
      kind,
      enabled: 1,
      sort_order: 100,
    });
    return this.repo.save(row);
  }

  async update(userId: string, id: string, dto: UpdateMediaSourceDto) {
    const row = await this.findOwned(userId, id);
    if (dto.name != null) row.name = dto.name.trim();
    if (dto.enabled != null) row.enabled = dto.enabled ? 1 : 0;
    if (dto.sortOrder != null) row.sort_order = dto.sortOrder;
    if (dto.url != null) {
      const url = dto.url.trim();
      const url_hash = hashUrl(url);
      if (url_hash !== row.url_hash) {
        const clash = await this.repo.findOne({
          where: { user_id: userId, url_hash },
        });
        if (clash && clash.id !== row.id) {
          throw new BadRequestException('该订阅 URL 已存在');
        }
        row.url = url;
        row.url_hash = url_hash;
        this.cache.delete(url);
      }
    }
    return this.repo.save(row);
  }

  async remove(userId: string, id: string) {
    const row = await this.findOwned(userId, id);
    await this.repo.remove(row);
    return { ok: true };
  }

  /** 刷新订阅缓存并更新 last_fetched */
  async refresh(userId: string, id: string) {
    const row = await this.findOwned(userId, id);
    try {
      this.cache.delete(row.url);
      const entries = await this.fetchAndParse(row.url);
      row.kind = this.inferKind(entries);
      row.last_fetched_at = new Date();
      row.last_error = '';
      await this.repo.save(row);
      return {
        ok: true,
        count: entries.length,
        kind: row.kind,
        entries: entries.map((e) => ({
          name: e.name,
          factoryId: e.factoryId,
          description: e.description,
        })),
      };
    } catch (e) {
      row.last_error = e instanceof Error ? e.message : String(e);
      await this.repo.save(row);
      throw new BadRequestException(`拉取订阅失败: ${row.last_error}`);
    }
  }

  /**
   * 个人中心：服务端拉取订阅 JSON（规避浏览器 CORS），返回站点列表
   */
  async listCatalog(userId: string): Promise<{
    entries: Array<{
      key: string;
      factoryId: string;
      name: string;
      description: string;
      iconUrl: string;
      searchUrl: string;
      searchConfig: Record<string, any>;
      subscriptionUrl: string;
      subscriptionName: string;
      subscriptionId: string;
    }>;
    errors: string[];
  }> {
    await this.ensureDefaults(userId);
    const rows = await this.repo.find({
      where: { user_id: userId },
      order: { sort_order: 'ASC', create_time: 'ASC' },
    });
    const entries: Array<{
      key: string;
      factoryId: string;
      name: string;
      description: string;
      iconUrl: string;
      searchUrl: string;
      searchConfig: Record<string, any>;
      subscriptionUrl: string;
      subscriptionName: string;
      subscriptionId: string;
    }> = [];
    const errors: string[] = [];

    for (const row of rows) {
      if (!row.enabled) continue;
      try {
        const parsed = await this.fetchAndParse(row.url);
        row.kind = this.inferKind(parsed);
        row.last_fetched_at = new Date();
        row.last_error = '';
        await this.repo.save(row);
        for (const e of parsed) {
          const searchUrl = String(e.searchConfig?.searchUrl || '');
          const key = `${row.id}::${e.factoryId}::${e.name}`;
          entries.push({
            key,
            factoryId: e.factoryId,
            name: e.name,
            description: e.description,
            iconUrl: e.iconUrl,
            searchUrl,
            searchConfig: e.searchConfig || {},
            subscriptionUrl: row.url,
            subscriptionName: row.name || row.url,
            subscriptionId: row.id,
          });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        row.last_error = msg;
        await this.repo.save(row);
        errors.push(`${row.name || row.url}: ${msg}`);
        this.logger.warn(`catalog ${row.url}: ${msg}`);
      }
    }
    return { entries, errors };
  }

  /** 批量更新订阅排序（ids 从前到后） */
  async reorder(userId: string, ids: string[]) {
    if (!Array.isArray(ids) || !ids.length) {
      throw new BadRequestException('ids 不能为空');
    }
    let order = 0;
    for (const id of ids) {
      const row = await this.repo.findOne({ where: { id, user_id: userId } });
      if (!row) continue;
      row.sort_order = order++;
      await this.repo.save(row);
    }
    return this.list(userId);
  }

  /**
   * 汇总用户已启用订阅中的全部 mediaSources 条目（供搜索使用）
   */
  async loadEnabledEntries(userId: string): Promise<ParsedMediaSourceEntry[]> {
    await this.ensureDefaults(userId);
    const rows = await this.repo.find({
      where: { user_id: userId, enabled: 1 },
      order: { sort_order: 'ASC' },
    });
    const all: ParsedMediaSourceEntry[] = [];
    for (const row of rows) {
      try {
        const entries = await this.fetchAndParse(row.url);
        for (const e of entries) {
          e.subscriptionUrl = row.url;
          e.subscriptionName = row.name || row.url;
        }
        all.push(...entries);
        row.last_fetched_at = new Date();
        row.last_error = '';
        await this.repo.save(row);
      } catch (e) {
        row.last_error = e instanceof Error ? e.message : String(e);
        await this.repo.save(row);
        this.logger.warn(`load ${row.url}: ${row.last_error}`);
      }
    }
    return all;
  }

  async fetchAndParse(url: string): Promise<ParsedMediaSourceEntry[]> {
    const hit = this.cache.get(url);
    if (hit && Date.now() - hit.at < this.cacheTtlMs) {
      return hit.entries.map((e) => ({ ...e }));
    }

    // 用 text 再 JSON.parse，避免部分 CDN Content-Type 导致 axios 解析异常
    const res = await outboundGet<string>(url, {
      timeout: 20000,
      responseType: 'text',
      transformResponse: [(d) => d],
      headers: {
        Accept: 'application/json, text/plain, */*',
      },
    });

    let data: any = res.data;
    if (typeof data === 'string') {
      const text = data.replace(/^﻿/, '').trim();
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error('订阅内容不是合法 JSON');
      }
    }

    const list =
      data?.exportedMediaSourceDataList?.mediaSources ||
      data?.mediaSources ||
      (Array.isArray(data) ? data : null);

    if (!Array.isArray(list)) {
      throw new Error('订阅 JSON 格式无法识别（缺少 mediaSources）');
    }

    const entries: ParsedMediaSourceEntry[] = list.map((raw: any) => {
      const args = raw?.arguments || {};
      return {
        factoryId: String(raw?.factoryId || ''),
        name: String(args.name || '未命名源'),
        description: String(args.description || ''),
        iconUrl: String(args.iconUrl || ''),
        searchConfig: args.searchConfig || {},
        subscriptionUrl: url,
        subscriptionName: '',
      };
    });

    this.cache.set(url, { at: Date.now(), entries });
    return entries.map((e) => ({ ...e }));
  }

  private inferKind(entries: ParsedMediaSourceEntry[]): MediaSourceKind {
    if (!entries.length) return 'mixed';
    const ids = new Set(entries.map((e) => e.factoryId));
    if (ids.size === 1 && ids.has('rss')) return 'rss';
    if (ids.size === 1 && ids.has('web-selector')) return 'web';
    if ([...ids].every((id) => id === 'rss')) return 'rss';
    if ([...ids].every((id) => id === 'web-selector')) return 'web';
    return 'mixed';
  }

  private async ensureDefaults(userId: string) {
    const count = await this.repo.count({ where: { user_id: userId } });
    if (count > 0) return;
    for (const d of DEFAULT_MEDIA_SOURCE_URLS) {
      const row = this.repo.create({
        user_id: userId,
        name: d.name,
        url: d.url,
        url_hash: hashUrl(d.url),
        kind: d.kind,
        enabled: 1,
        sort_order: d.sort_order,
      });
      await this.repo.save(row);
    }
  }

  private async findOwned(userId: string, id: string) {
    const row = await this.repo.findOne({ where: { id } });
    if (!row || row.user_id !== userId) {
      throw new NotFoundException('数据源不存在');
    }
    return row;
  }
}
