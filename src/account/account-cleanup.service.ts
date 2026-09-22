import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/typeorm';
import { Connection } from 'typeorm';
import { minioConfig } from 'src/core/config/config';
import { Group } from 'src/group/entities/group.entity';
import { GroupUserMap } from 'src/group/entities/group_user_map.entity';
import { MediaSource } from 'src/media-source/entities/media-source.entity';
import { MinioService } from 'src/storage/minio.service';
import { UserAnime } from 'src/user-anime/entities/user-anime.entity';
import { AiConversation } from 'src/ai/entities/ai-conversation.entity';
import { AiMessage } from 'src/ai/entities/ai-message.entity';
import { AiUsage } from 'src/ai/entities/ai-usage.entity';
import { RefreshToken } from 'src/auth/entities/refresh-token.entity';
import { PlaybackSession } from 'src/playback/entities/playback-session.entity';
import { RoomService } from 'src/room/room.service';
import { User } from 'src/user/entities/user.entity';

/** 头像 URL 前缀，与 `UserService.uploadAvatar` 写入时保持一致 */
const AVATAR_URL_MARKER = '/api/images/avatars/';

/**
 * 账号数据清理（**唯一实现**）。
 *
 * 存在的理由：「用户自删」与「管理员删号」是同一件事，必须有同一条路径。
 * 之前只有 `UserService.delete` 自己删 `user` 一行，于是留下 8 张表的孤儿数据 ——
 * 这种 bug 的根因不是「忘了写 DELETE」，而是**同一个语义有两份实现，必然漂移**。
 * 所以抽到这里，两边都调它。
 *
 * ⚠️ 三个**明确保留**的东西（不是遗漏，是想清楚了才不删）：
 * - `group` / `group_message`：房间是多人共享的上下文，删掉会毁掉其他成员的聊天记录。
 *   但**用户正主持的房间要先按放映室既有逻辑销毁**，否则房主指向一个不存在的用户。
 * - `track_event`：行为统计不属于个人数据删除范围。已删用户的行会自然退化成
 *   「user_id 指向不存在的用户」，`statsTopUsers` 的 LEFT JOIN 早已把它显示成「已注销」。
 * - MinIO 头像：**best-effort**，删失败只记日志不阻断 —— 账号已经删了，
 *   为了一张图让整个操作回滚没有意义。
 */
@Injectable()
export class AccountCleanupService {
  private readonly logger = new Logger(AccountCleanupService.name);

  constructor(
    @InjectConnection() private readonly conn: Connection,
    private readonly minioService: MinioService,
    private readonly roomService: RoomService,
  ) {}

  /**
   * 彻底清理一个账号的全部私有数据。
   *
   * 返回被删掉的各表行数，供管理员接口回显（也方便排查「到底删干净没有」）。
   */
  async purge(userId: string): Promise<Record<string, number>> {
    // 先把「该用户正主持的放映室」按放映室既有逻辑销毁：
    // destroyRoom 会连带清掉该房间的 group_message 与 group_user_map。
    const hosted = await this.conn.getRepository(Group).find({
      where: { host_user_id: userId },
    });
    for (const room of hosted) {
      await this.roomService.destroyRoom(room.group_id);
      this.logger.log(`删号清理：销毁其主持的放映室 ${room.group_id}`);
    }

    const avatar = await this.readAvatar(userId);

    // 事务内按「叶子 → 主体」顺序硬删。
    // refresh_token 是**硬删**而不是置 revoked=1：账号都没了，留着行只会变成垃圾。
    const counts = await this.conn.transaction(async (m) => {
      const removed: Record<string, number> = {};
      const step = async (name: string, run: () => Promise<unknown>) => {
        const res = (await run()) as { affected?: number } | undefined;
        removed[name] = res?.affected ?? 0;
      };

      await step('ai_message', () => m.delete(AiMessage, { user_id: userId }));
      await step('ai_conversation', () =>
        m.delete(AiConversation, { user_id: userId }),
      );
      await step('ai_usage', () => m.delete(AiUsage, { user_id: userId }));
      await step('user_anime', () => m.delete(UserAnime, { user_id: userId }));
      await step('media_source', () =>
        m.delete(MediaSource, { user_id: userId }),
      );
      await step('refresh_token', () =>
        m.delete(RefreshToken, { user_id: userId }),
      );
      await step('group_user_map', () =>
        m.delete(GroupUserMap, { user_id: userId }),
      );
      await step('playback_session', () =>
        m.delete(PlaybackSession, { user_id: userId }),
      );
      await step('user', () => m.delete(User, { user_id: userId }));
      return removed;
    });

    // 头像清理放在事务**之后**：MinIO 不参与数据库事务，
    // 放事务里失败会把已删的行回滚，而对象存储的状态又回不来，反而更乱。
    if (avatar) {
      try {
        await this.minioService.removeObject(avatar);
      } catch (e) {
        this.logger.warn(
          `删号清理：删除头像对象失败（已忽略） ${avatar} ${
            e instanceof Error ? e.message : e
          }`,
        );
      }
    }

    return counts;
  }

  /** 从用户的 avatar URL 反推出 MinIO 对象名；非本站头像（默认图/外链）返回空 */
  private async readAvatar(userId: string): Promise<string> {
    const user = await this.conn.getRepository(User).findOne({
      where: { user_id: userId },
    });
    const url = user?.avatar ?? '';
    if (!url.startsWith(AVATAR_URL_MARKER)) {
      return '';
    }
    const filename = url.slice(AVATAR_URL_MARKER.length).split('?')[0];
    return filename ? `${minioConfig.avatarPrefix}/${filename}` : '';
  }
}
