import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
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
}
