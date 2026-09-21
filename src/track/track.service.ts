import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { clampDays, clampLimit, rowToNumbers, toNumbers } from 'src/core/utils/sql';
import { TrackEvent } from './entities/track-event.entity';

/** 一条待写入的埋点事件 */
export interface TrackEventInput {
  event: string;
  userId?: string | null;
  anonymousId?: string | null;
  page?: string | null;
  target?: string | null;
  props?: Record<string, unknown> | null;
  /** 事件实际发生时间；不传则用入库时间 */
  clientTs?: Date | null;
}

/**
 * 埋点写入与查询的**唯一入口**。
 *
 * 前端的 `POST /api/track` 和后端业务事件（`ai.chat` 等）都走这里，
 * 保证事件字段语义一致、只有一处需要维护。
 *
 * **关键约定：埋点失败绝不能影响业务。** 所有写入都吞异常只记日志 ——
 * 统计丢失是可以接受的，用户请求失败不可以。
 */
@Injectable()
export class TrackService {
  private readonly logger = new Logger(TrackService.name);

  constructor(
    @InjectRepository(TrackEvent)
    private readonly repo: Repository<TrackEvent>,
  ) {}

  /** 批量写入（一次 insert，避免逐条往返） */
  async track(events: TrackEventInput[]): Promise<void> {
    const valid = events.filter(
      (e) => e && typeof e.event === 'string' && e.event.trim(),
    );
    if (!valid.length) {
      return;
    }
    try {
      const rows = valid.map((e) =>
        this.repo.create({
          event: e.event.trim().slice(0, 80),
          user_id: e.userId || null,
          anonymous_id: e.anonymousId || null,
          page: e.page || null,
          target: e.target || null,
          props: e.props ?? null,
          client_ts: e.clientTs ?? null,
        }),
      );
      await this.repo.save(rows);
    } catch (err) {
      // 故意吞掉：埋点写不进去不该让用户的业务请求失败
      this.logger.warn(
        `埋点写入失败（已忽略）: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /** 单条便捷写法，供后端业务代码使用 */
  trackOne(
    event: string,
    input: Omit<TrackEventInput, 'event'> = {},
  ): Promise<void> {
    return this.track([{ event, ...input }]);
  }

  // ── 通用事件统计（管理员看板）────────────────────────────────

  /** 总览：事件总量、独立用户、今日量、人均事件数 */
  async statsOverview(days = 14) {
    const safeDays = clampDays(days);
    const [row] = (await this.repo.query(
      `SELECT COUNT(*)               AS total_events,
              COUNT(DISTINCT user_id) AS users,
              COUNT(DISTINCT event)   AS event_types,
              SUM(create_time >= CURDATE()) AS today_events
       FROM track_event
       WHERE create_time >= DATE_SUB(CURDATE(), INTERVAL ? DAY)`,
      [safeDays],
    )) as Array<Record<string, unknown>>;
    return row
      ? rowToNumbers(row, ['total_events', 'users', 'event_types', 'today_events'])
      : {};
  }

  /** 事件量排行 —— 最直接回答「用户都在干什么」 */
  async statsTopEvents(days = 14, limit = 30) {
    const safeDays = clampDays(days);
    const safeLimit = clampLimit(limit, 30, 100);
    const rows = (await this.repo.query(
      `SELECT event,
              COUNT(*)                AS count,
              COUNT(DISTINCT user_id) AS users
       FROM track_event
       WHERE create_time >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       GROUP BY event
       ORDER BY count DESC
       LIMIT ?`,
      [safeDays, safeLimit],
    )) as Array<Record<string, unknown>>;
    return toNumbers(rows, ['count', 'users']);
  }

  /** 按天趋势 */
  async statsDaily(days = 14) {
    const safeDays = clampDays(days);
    const rows = (await this.repo.query(
      // DATE_FORMAT 见 AiService.statsDaily 的说明（DATE() 会变成 UTC 时间戳）
      `SELECT DATE_FORMAT(create_time, '%Y-%m-%d')          AS day,
              COUNT(*)                      AS events,
              COUNT(DISTINCT user_id)        AS users,
              COUNT(DISTINCT anonymous_id)   AS anonymous
       FROM track_event
       WHERE create_time >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       GROUP BY day
       ORDER BY day DESC`,
      [safeDays],
    )) as Array<Record<string, unknown>>;
    return toNumbers(rows, ['events', 'users', 'anonymous']);
  }
}
