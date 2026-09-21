import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { aiConfig } from 'src/core/config/config';

/**
 * 发起一轮 AI 对话。
 *
 * 注意全局 `ValidationPipe` 开了 `forbidNonWhitelisted`，
 * 传未声明字段会直接 400 —— 前端只能发这两个字段。
 */
export class ChatDto {
  /** 不传则新建会话，服务端通过响应头 `X-Conversation-Id` 回传 */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  conversationId?: string;

  @IsString()
  @IsNotEmpty({ message: 'message 不能为空' })
  @MaxLength(aiConfig.maxMessageLength, { message: 'message 过长' })
  message: string;
}
