import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Response } from 'express';
import { RootGuard } from 'src/auth/root.guard';
import { AiService } from './ai.service';
import { ChatDto } from './dto/chat.dto';

/**
 * AI 助手接口，全部需要登录。
 *
 * SSE 说明：`POST /api/ai/chat` 返回 `text/event-stream`。
 * 浏览器 `EventSource` 只能发 GET 且不能带 Header，前端走 `fetch` + `ReadableStream`；
 * JWT 由 `JwtStrategy` 同时支持 Header 与 `?token=`（与播放流同一套约定），
 * 因此需要时也可以用 `?token=` 传令牌。
 */
@Controller('ai')
@UseGuards(AuthGuard('jwt'))
export class AiController {
  constructor(private readonly aiService: AiService) {}

  /**
   * 一轮对话（SSE 流）。
   *
   * 注意这里用 `@Res()` 自行写出：一旦写了 `text/event-stream` 头，
   * 就不能再走全局 `TransformInterceptor` 的 `{code,message,data}` 信封。
   * 配额超限 / 上游不可用等错误发生在写头之前，仍会走 `HttpExceptionFilter` 的 JSON 信封。
   */
  @Post('chat')
  async chat(
    @Req() req,
    @Body() dto: ChatDto,
    @Res() res: Response,
  ): Promise<void> {
    await this.aiService.streamChat(res, req.user.user_id, dto);
  }

  /** 会话列表（按更新时间倒序，最多 50 条） */
  @Get('conversations')
  list(@Req() req) {
    return this.aiService.listConversations(req.user.user_id);
  }

  /** 某个会话的全部消息（含工具返回的番剧卡片），用于刷新后恢复界面 */
  @Get('conversations/:id/messages')
  messages(@Req() req, @Param('id') id: string) {
    return this.aiService.getMessages(req.user.user_id, id);
  }

  @Delete('conversations/:id')
  async remove(@Req() req, @Param('id') id: string) {
    await this.aiService.deleteConversation(req.user.user_id, id);
    return { deleted: true };
  }

  // ── 用量统计（**仅管理员**）────────────────────────────────
  // 两个守卫缺一不可：没有 AuthGuard('jwt') 时 req.user 恒为 undefined，
  // 连管理员都会被 RootGuard 判成 403。统计面向全站聚合，没有「本人」一说。

  /** 总览：请求数、成功率、token、延迟、独立用户数 */
  @Get('stats/overview')
  @UseGuards(AuthGuard('jwt'), RootGuard)
  statsOverview() {
    return this.aiService.statsOverview();
  }

  /** 按天趋势 */
  @Get('stats/daily')
  @UseGuards(AuthGuard('jwt'), RootGuard)
  statsDaily(@Query('days') days?: string) {
    return this.aiService.statsDaily(Number(days) || 14);
  }

  /** 工具使用分布 */
  @Get('stats/tools')
  @UseGuards(AuthGuard('jwt'), RootGuard)
  statsTools(@Query('days') days?: string) {
    return this.aiService.statsTools(Number(days) || 14);
  }

  /** 访问量 / 消耗 / 使用率（含 AI vs 手动搜索对比） */
  @Get('stats/engagement')
  @UseGuards(AuthGuard('jwt'), RootGuard)
  statsEngagement(@Query('days') days?: string) {
    return this.aiService.statsEngagement(Number(days) || 14);
  }

  /** 用量最高的用户 */
  @Get('stats/top-users')
  @UseGuards(AuthGuard('jwt'), RootGuard)
  statsTopUsers(@Query('days') days?: string, @Query('limit') limit?: string) {
    return this.aiService.statsTopUsers(
      Number(days) || 14,
      Number(limit) || 20,
    );
  }
}
