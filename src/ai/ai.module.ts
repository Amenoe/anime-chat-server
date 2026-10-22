import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { AiConversation } from './entities/ai-conversation.entity';
import { AiMessage } from './entities/ai-message.entity';
import { AiUsage } from './entities/ai-usage.entity';
import { TrackEvent } from 'src/track/entities/track-event.entity';
import { UserAnime } from 'src/user-anime/entities/user-anime.entity';

/**
 * AI 网关模块：鉴权 + 配额 + 会话落库 + SSE 透传到 anime-ai。
 *
 * 检索与模型编排不在这里 —— 见 docs/ai-rag-practice-roadmap.md 的架构边界说明。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      AiConversation,
      AiMessage,
      AiUsage,
      TrackEvent,
      // 只在转发前查一次用户的追番摘要，不写业务逻辑
      UserAnime,
    ]),
  ],
  controllers: [AiController],
  providers: [AiService],
  exports: [AiService],
})
export class AiModule {}
