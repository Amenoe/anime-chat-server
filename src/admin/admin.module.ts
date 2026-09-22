import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccountCleanupModule } from 'src/account/account-cleanup.module';
import { AiConversation } from 'src/ai/entities/ai-conversation.entity';
import { AiMessage } from 'src/ai/entities/ai-message.entity';
import { AuthModule } from 'src/auth/auth.module';
import { TrackEvent } from 'src/track/entities/track-event.entity';
import { UserAnime } from 'src/user-anime/entities/user-anime.entity';
import { User } from 'src/user/entities/user.entity';
import { AdminAuditService } from './admin-audit.service';
import { AdminUserController } from './admin-user.controller';
import { AdminUserService } from './admin-user.service';
import { AdminAuditLog } from './entities/admin-audit-log.entity';

/**
 * 管理端模块。
 *
 * 权限全部由 controller 上的 `AuthGuard('jwt') + RootGuard` 把关，模块本身不额外设防 ——
 * 这样「哪个接口要管理员」在 controller 里一眼可见，而不是藏在模块配置里。
 *
 * 删号清理走 `AccountCleanupModule`（它与 UserModule 共用同一实现）。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      AdminAuditLog,
      // 以下实体只服务于「详情统计」的计数，删除动作在 AccountCleanupModule 里
      AiConversation,
      AiMessage,
      TrackEvent,
      UserAnime,
    ]),
    AuthModule,
    AccountCleanupModule,
  ],
  controllers: [AdminUserController],
  providers: [AdminUserService, AdminAuditService],
})
export class AdminModule {}
