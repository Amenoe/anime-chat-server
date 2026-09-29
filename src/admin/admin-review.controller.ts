import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Response } from 'express';
import { once } from 'events';
import { RootGuard } from 'src/auth/root.guard';
import { AdminActor } from './admin-user.service';
import { AdminReviewService } from './admin-review.service';
import {
  AiConversationsQueryDto,
  TrackEventsQueryDto,
} from './dto/admin-review.dto';

@Controller('admin')
export class AdminReviewController {
  constructor(private readonly review: AdminReviewService) {}

  @Get('ai/conversations')
  @UseGuards(AuthGuard('jwt'), RootGuard)
  conversations(@Req() req, @Query() query: AiConversationsQueryDto) {
    return this.review.conversations(actorOf(req), query);
  }

  @Get('ai/conversations/:id/messages')
  @UseGuards(AuthGuard('jwt'), RootGuard)
  messages(@Req() req, @Param('id') id: string) {
    return this.review.messages(actorOf(req), id);
  }

  @Get('track/events')
  @UseGuards(AuthGuard('jwt'), RootGuard)
  events(@Query() query: TrackEventsQueryDto) {
    return this.review.listTrackEvents(query);
  }

  @Get('track/events/export')
  @UseGuards(AuthGuard('jwt'), RootGuard)
  async export(
    @Req() req,
    @Query() query: TrackEventsQueryDto,
    @Res() res: Response,
  ) {
    const filters = {
      event: query.event,
      userId: query.userId,
      from: query.from,
      to: query.to,
    };
    try {
      this.review.validateExportRange(filters);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : '导出范围无效',
      );
    }
    const matchedRows = await this.review.countTrack(filters);
    // 审计必须先成功再发送响应；否则 CSV 已经写出后审计失败，调用方无法再得到可靠错误。
    await this.review.auditTrackExport(
      actorOf(req),
      filters,
      Math.min(matchedRows, 50000),
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="track-events.csv"',
    );
    await writeChunk(res, '\uFEFF');
    const columns = [
      'id',
      'event',
      'user_id',
      'anonymous_id',
      'page',
      'target',
      'client_ts',
      'create_time',
    ];
    if (query.includeProps) columns.push('props');
    await writeChunk(res, `${columns.join(',')}\r\n`);
    let cursor: string | undefined;
    let count = 0;
    while (count < 50000) {
      const rows = await this.review.exportTrack(
        filters,
        cursor,
        Math.min(2000, 50000 - count),
      );
      if (!rows.length) break;
      for (const row of rows) {
        const record = row as unknown as Record<string, unknown>;
        await writeChunk(
          res,
          `${columns.map((key) => csvCell(record[key])).join(',')}\r\n`,
        );
      }
      count += rows.length;
      cursor = rows[rows.length - 1].id;
      if (rows.length < 2000) break;
    }
    res.end();
  }
}

async function writeChunk(res: Response, chunk: string) {
  if (!res.write(chunk)) await once(res, 'drain');
}

function csvCell(value: unknown): string {
  let text =
    value == null
      ? ''
      : value instanceof Date
      ? value.toISOString()
      : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function actorOf(req: {
  user?: { user_id?: string; username?: string };
  ip?: string;
  headers?: Record<string, unknown>;
}): AdminActor {
  return {
    userId: req.user?.user_id ?? '',
    username: req.user?.username ?? '',
    ip: req.ip ?? '',
    userAgent:
      typeof req.headers?.['user-agent'] === 'string'
        ? (req.headers['user-agent'] as string)
        : '',
  };
}
