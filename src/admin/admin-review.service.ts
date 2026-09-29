import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/typeorm';
import { Connection } from 'typeorm';
import { clampLimit } from 'src/core/utils/sql';
import { AiConversation } from 'src/ai/entities/ai-conversation.entity';
import { AiMessage } from 'src/ai/entities/ai-message.entity';
import { TrackEvent } from 'src/track/entities/track-event.entity';
import { AdminActor } from './admin-user.service';
import { AdminAuditService } from './admin-audit.service';
import {
  AiConversationsQueryDto,
  TrackEventsQueryDto,
} from './dto/admin-review.dto';

type ReviewFilters = Pick<
  TrackEventsQueryDto,
  'event' | 'userId' | 'from' | 'to'
>;

@Injectable()
export class AdminReviewService {
  constructor(
    @InjectConnection() private readonly conn: Connection,
    private readonly audit: AdminAuditService,
  ) {}

  async conversations(actor: AdminActor, query: AiConversationsQueryDto) {
    const size = clampLimit(query.size, 50, 100);
    const cursorParts = query.cursor?.split('|');
    if (
      query.cursor &&
      (cursorParts?.length !== 2 ||
        !Number.isFinite(Date.parse(cursorParts[0])))
    ) {
      throw new NotFoundException('会话游标无效');
    }
    await this.audit.record({
      actorUserId: actor.userId,
      actorUsername: actor.username,
      ip: actor.ip,
      userAgent: actor.userAgent,
      action: 'ai.read',
      targetType: 'ai_conversation',
      detail: {
        view: 'list',
        userId: query.userId ?? null,
        from: query.from ?? null,
        to: query.to ?? null,
      },
    });
    const repo = this.conn.getRepository(AiConversation);
    const qb = repo
      .createQueryBuilder('c')
      .select(['c.id', 'c.user_id', 'c.create_time', 'c.update_time'])
      .addSelect(
        '(SELECT COUNT(*) FROM ai_message m WHERE m.conversation_id = c.id)',
        'message_count',
      );
    if (query.userId)
      qb.andWhere('c.user_id = :userId', { userId: query.userId });
    if (query.from) qb.andWhere('c.create_time >= :from', { from: query.from });
    if (query.to) qb.andWhere('c.create_time < :to', { to: query.to });
    if (cursorParts) {
      qb.andWhere(
        '(c.create_time < :cursorTime OR (c.create_time = :cursorTime AND c.id < :cursorId))',
        {
          cursorTime: cursorParts[0],
          cursorId: cursorParts[1],
        },
      );
    }
    const rows = await qb
      .orderBy('c.create_time', 'DESC')
      .addOrderBy('c.id', 'DESC')
      .take(size + 1)
      .getRawMany();

    const hasMore = rows.length > size;
    const items = rows.slice(0, size).map((row) => ({
      id: row.c_id,
      user_id: row.c_user_id,
      create_time: row.c_create_time,
      update_time: row.c_update_time,
      message_count: Number(row.message_count),
    }));
    const last = items[items.length - 1];
    return {
      items,
      nextCursor:
        hasMore && last
          ? `${new Date(last.create_time).toISOString()}|${last.id}`
          : null,
    };
  }

  async messages(actor: AdminActor, conversationId: string) {
    const conversation = await this.conn
      .getRepository(AiConversation)
      .findOne({ where: { id: conversationId }, select: ['id', 'user_id'] });
    if (!conversation) throw new NotFoundException('会话不存在');
    await this.audit.record({
      actorUserId: actor.userId,
      actorUsername: actor.username,
      ip: actor.ip,
      userAgent: actor.userAgent,
      action: 'ai.read',
      targetType: 'ai_conversation',
      targetId: conversationId,
      detail: { view: 'messages', userId: conversation.user_id },
    });
    const messages = await this.conn.getRepository(AiMessage).find({
      where: { conversation_id: conversationId },
      order: { create_time: 'ASC' },
      select: ['id', 'role', 'content', 'tool_results', 'create_time'],
    });
    return { conversationId, messages };
  }

  async listTrackEvents(query: TrackEventsQueryDto) {
    const size = clampLimit(query.size, 50, 200);
    const rows = await this.queryTrack(
      query,
      query.cursor,
      size + 1,
      query.includeProps,
    );
    const hasMore = rows.length > size;
    const items = rows.slice(0, size);
    return {
      items,
      nextCursor: hasMore ? items[items.length - 1]?.id ?? null : null,
    };
  }

  exportTrack(filters: ReviewFilters, cursor?: string, limit = 2000) {
    return this.queryTrack(filters, cursor, limit, true);
  }

  async countTrack(filters: ReviewFilters) {
    const qb = this.conn.getRepository(TrackEvent).createQueryBuilder('t');
    if (filters.event)
      qb.andWhere('t.event = :event', { event: filters.event });
    if (filters.userId)
      qb.andWhere('t.user_id = :userId', { userId: filters.userId });
    if (filters.from)
      qb.andWhere('t.create_time >= :from', { from: filters.from });
    if (filters.to) qb.andWhere('t.create_time < :to', { to: filters.to });
    return qb.getCount();
  }

  async auditTrackExport(
    actor: AdminActor,
    filters: ReviewFilters,
    maxRows: number,
  ) {
    await this.audit.record({
      actorUserId: actor.userId,
      actorUsername: actor.username,
      ip: actor.ip,
      userAgent: actor.userAgent,
      action: 'track.export',
      targetType: 'track_event',
      detail: { ...filters, maxRows },
    });
  }

  validateExportRange(filters: ReviewFilters) {
    if (!filters.from || !filters.to)
      throw new Error('导出必须指定开始与结束时间');
    const from = new Date(filters.from).getTime();
    const to = new Date(filters.to).getTime();
    if (
      !Number.isFinite(from) ||
      !Number.isFinite(to) ||
      to <= from ||
      to - from > 31 * 86400000
    ) {
      throw new Error('导出时间范围须为正且不超过 31 天');
    }
  }

  private queryTrack(
    filters: ReviewFilters,
    cursor: string | undefined,
    limit: number,
    includeProps: boolean,
  ) {
    const qb = this.conn
      .getRepository(TrackEvent)
      .createQueryBuilder('t')
      .select([
        't.id',
        't.event',
        't.user_id',
        't.anonymous_id',
        't.page',
        't.target',
        't.client_ts',
        't.create_time',
      ]);
    if (includeProps) qb.addSelect('t.props');
    if (filters.event)
      qb.andWhere('t.event = :event', { event: filters.event });
    if (filters.userId)
      qb.andWhere('t.user_id = :userId', { userId: filters.userId });
    if (filters.from)
      qb.andWhere('t.create_time >= :from', { from: filters.from });
    if (filters.to) qb.andWhere('t.create_time < :to', { to: filters.to });
    if (cursor) qb.andWhere('t.id < :cursor', { cursor });
    return qb.orderBy('t.id', 'DESC').take(limit).getMany();
  }
}
