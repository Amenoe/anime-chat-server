import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
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
  // 数据由 ai_request_log 提供；管理员界面是后续工作，这里先把数据通道开出来。

  /** 总览：请求数、成功率、token、延迟、独立用户数 */
  @Get('stats/overview')
  statsOverview(@Req() req) {
    assertRoot(req);
    return this.aiService.statsOverview();
  }

  /** 按天趋势 */
  @Get('stats/daily')
  statsDaily(@Req() req, @Query('days') days?: string) {
    assertRoot(req);
    return this.aiService.statsDaily(Number(days) || 14);
  }

  /** 工具使用分布 */
  @Get('stats/tools')
  statsTools(@Req() req, @Query('days') days?: string) {
    assertRoot(req);
    return this.aiService.statsTools(Number(days) || 14);
  }

  /** 用量最高的用户 */
  @Get('stats/top-users')
  statsTopUsers(
    @Req() req,
    @Query('days') days?: string,
    @Query('limit') limit?: string,
  ) {
    assertRoot(req);
    return this.aiService.statsTopUsers(
      Number(days) || 14,
      Number(limit) || 20,
    );
  }
}

/**
 * 统计接口只给 `role = 'root'`。
 *
 * 与 `user.controller.ts` 里「本人或 root」的判定不同：这里没有「本人」这一说，
 * 全都是全站聚合数据，所以直接拒绝非 root。
 */
function assertRoot(req: { user?: { role?: string } }) {
  if (req.user?.role !== 'root') {
    throw new ForbiddenException('仅管理员可查看统计');
  }
}
