import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { OptionalJwtGuard } from 'src/auth/optional-jwt.guard';
import { RootGuard } from 'src/auth/root.guard';
import { TrackBatchDto } from './dto/track.dto';
import { TrackService } from './track.service';

/**
 * 埋点上报与统计。
 *
 * 上报**匿名可用**（`OptionalJwtGuard`）：未登录用户的行为也要能统计，
 * 否则拿不到「访客在哪一步流失」。登录时按 `req.user` 归属，未登录时用前端传来的
 * `anonymousId` 串联。
 */
@Controller('track')
export class TrackController {
  constructor(private readonly trackService: TrackService) {}

  /** 批量上报（前端攒批发送） */
  @Post()
  @UseGuards(OptionalJwtGuard)
  async report(@Req() req, @Body() dto: TrackBatchDto) {
    const userId: string | null = req.user?.user_id ?? null;
    await this.trackService.track(
      dto.events.map((e) => ({
        event: e.event,
        userId,
        anonymousId: e.anonymousId ?? null,
        page: e.page ?? null,
        target: e.target ?? null,
        props: e.props ?? null,
        clientTs: e.clientTs ? new Date(e.clientTs) : null,
      })),
    );
    // 上报接口本身要极轻：不回写库结果，避免前端为了等它而阻塞
    return { accepted: dto.events.length };
  }

  // ── 统计（仅管理员）────────────────────────────────────────
  // 两个守卫**缺一不可且顺序不能换**：没有 AuthGuard('jwt') 时 req.user 恒为 undefined，
  // 连管理员都会被 RootGuard 判成 403（本项目真实踩过两次）。

  @Get('stats/overview')
  @UseGuards(AuthGuard('jwt'), RootGuard)
  overview(@Query('days') days?: string) {
    return this.trackService.statsOverview(Number(days) || 14);
  }

  @Get('stats/top-events')
  @UseGuards(AuthGuard('jwt'), RootGuard)
  topEvents(@Query('days') days?: string, @Query('limit') limit?: string) {
    return this.trackService.statsTopEvents(
      Number(days) || 14,
      Number(limit) || 30,
    );
  }

  @Get('stats/daily')
  @UseGuards(AuthGuard('jwt'), RootGuard)
  daily(@Query('days') days?: string) {
    return this.trackService.statsDaily(Number(days) || 14);
  }
}
