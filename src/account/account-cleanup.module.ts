import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiConversation } from 'src/ai/entities/ai-conversation.entity';
import { AiMessage } from 'src/ai/entities/ai-message.entity';
import { AiUsage } from 'src/ai/entities/ai-usage.entity';
import { RefreshToken } from 'src/auth/entities/refresh-token.entity';
import { Group } from 'src/group/entities/group.entity';
import { GroupUserMap } from 'src/group/entities/group_user_map.entity';
import { MediaSource } from 'src/media-source/entities/media-source.entity';
import { PlaybackSession } from 'src/playback/entities/playback-session.entity';
import { RoomModule } from 'src/room/room.module';
import { StorageModule } from 'src/storage/storage.module';
import { UserAnime } from 'src/user-anime/entities/user-anime.entity';
import { User } from 'src/user/entities/user.entity';
import { AccountCleanupService } from './account-cleanup.service';

/**
 * 账号清理模块。
 *
 * 单独成模块而不是塞进 `AdminModule`：它的两个调用方分属不同模块 ——
 * 「用户自删」在 `UserModule`、「管理员删号」在 `AdminModule`。
 * 放进 AdminModule 会让 UserModule 反过来依赖 AdminModule（方向别扭，
 * 而且 AdminModule 一旦再需要 UserModule 就成环）。
 * 抽成中立模块后，两边都只依赖它，语义也对：删号清理本来就不属于「管理」这个领域。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      AiMessage,
      AiConversation,
      AiUsage,
      UserAnime,
      MediaSource,
      RefreshToken,
      GroupUserMap,
      Group,
      PlaybackSession,
    ]),
    RoomModule,
    StorageModule,
  ],
  providers: [AccountCleanupService],
  exports: [AccountCleanupService],
})
export class AccountCleanupModule {}
