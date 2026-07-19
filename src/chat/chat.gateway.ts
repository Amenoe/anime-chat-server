import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Server, Socket } from 'socket.io';
import { User } from 'src/user/entities/user.entity';
import { Anime } from 'src/anime/entities/anime.entity';
import { Group } from 'src/group/entities/group.entity';
import { GroupUserMap } from 'src/group/entities/group_user_map.entity';
import { GroupMessage } from 'src/group/entities/group_message.entity';
import {
  AddGroupDto,
  GroupMessageDto,
  GroupMessageView,
} from './dto/chat.dto';

const HISTORY_LIMIT = 50;

type SocketMeta = {
  userId: string | null;
  groupId: string | null;
};

@WebSocketGateway({ cors: true })
export class ChatGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Anime)
    private readonly animeRepository: Repository<Anime>,
    @InjectRepository(Group)
    private readonly groupRepository: Repository<Group>,
    @InjectRepository(GroupUserMap)
    private readonly groupUserRepository: Repository<GroupUserMap>,
    @InjectRepository(GroupMessage)
    private readonly groupMessageRepository: Repository<GroupMessage>,
  ) {}

  @WebSocketServer()
  server: Server;

  /** socket.id → 用户 / 所在房间（兼容旧 @types/socket.io 无 socket.data） */
  private readonly socketMeta = new Map<string, SocketMeta>();

  async handleConnection(client: Socket): Promise<void> {
    const raw = (client.handshake as any)?.query?.user_id;
    const userId = raw != null && raw !== '' ? String(raw) : null;
    this.socketMeta.set(client.id, { userId, groupId: null });
  }

  async handleDisconnect(client: Socket): Promise<void> {
    const meta = this.socketMeta.get(client.id);
    const groupId = meta?.groupId;
    this.socketMeta.delete(client.id);
    if (groupId) {
      // 断连后房间集合已更新，下一 tick 再广播
      setImmediate(() => {
        void this.broadcastActiveUser(groupId);
      });
    }
  }

  /**
   * 加入或创建番剧聊天室
   * body: { anime_id, group_name? } 或兼容旧客户端直接传 anime_id 数字
   */
  @SubscribeMessage('addGroup')
  async addGroup(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: AddGroupDto | number,
  ): Promise<void> {
    const payload = this.normalizeAddGroup(body);
    if (!payload) {
      client.emit('addGroup', {
        code: 400,
        message: 'anime_id 无效',
        data: null,
      });
      return;
    }

    const { anime_id, group_name } = payload;
    let group = await this.groupRepository.findOne({
      where: { anime_id },
    });

    if (!group) {
      // 优先本地 anime 表；没有则用前端标题 / 默认名（Bangumi 番源不依赖本地库）
      const animeData = await this.animeRepository.findOne({
        where: { anime_id },
      });
      const name =
        group_name?.trim() ||
        animeData?.title ||
        `番剧 #${anime_id}`;

      group = await this.groupRepository.save({
        anime_id,
        group_name: name,
        create_time: String(Date.now()),
      });
    } else if (
      group_name?.trim() &&
      group.group_name.startsWith('番剧 #')
    ) {
      group.group_name = group_name.trim();
      await this.groupRepository.save(group);
    }

    const meta = this.socketMeta.get(client.id) || {
      userId: null,
      groupId: null,
    };
    const prevGroupId = meta.groupId;
    if (prevGroupId && prevGroupId !== group.group_id) {
      client.leave(prevGroupId);
      await this.broadcastActiveUser(prevGroupId);
    }

    client.join(group.group_id);
    meta.groupId = group.group_id;
    this.socketMeta.set(client.id, meta);

    // 只回给当前连接，避免别人被切房
    client.emit('addGroup', group);
    await this.broadcastActiveUser(group.group_id);
  }

  /** 拉取历史消息（仅回给请求者） */
  @SubscribeMessage('chatData')
  async getGroupMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() group_id: string,
  ): Promise<void> {
    if (!group_id) {
      client.emit('chatData', []);
      return;
    }

    const messageList = await this.groupMessageRepository.find({
      where: { group_id },
      order: { time: 'DESC' },
      take: HISTORY_LIMIT,
    });

    if (!messageList.length) {
      client.emit('chatData', []);
      return;
    }

    const userIds = [...new Set(messageList.map((m) => m.user_id))];
    const users = userIds.length
      ? await this.userRepository.find({
          where: userIds.map((user_id) => ({ user_id })),
        })
      : [];
    const userMap = new Map(users.map((u) => [u.user_id, u]));

    const views: GroupMessageView[] = messageList
      .map((item) => {
        const user = userMap.get(item.user_id);
        return {
          id: item.id,
          group_id: item.group_id,
          user_id: item.user_id,
          message: item.message,
          message_type: item.message_type,
          time: Number(item.time),
          nickname: user?.nickname || '未知用户',
          avatar: user?.avatar,
        };
      })
      .reverse();

    client.emit('chatData', views);
  }

  /** 发送群消息并广播到房间 */
  @SubscribeMessage('groupMessage')
  async sendGroupMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: GroupMessageDto,
  ): Promise<void> {
    try {
      // 兼容 body 被包一层 / 多参数等情况
      const payload = this.normalizeMessageBody(data);
      const text = payload?.message?.trim();
      if (!payload?.group_id || !text) {
        client.emit('groupMessage', {
          code: 400,
          message: '消息内容不完整',
          data: null,
        });
        return;
      }

      const meta = this.socketMeta.get(client.id);
      const userId = meta?.userId || payload.user_id;
      if (!userId) {
        client.emit('groupMessage', {
          code: 401,
          message: '未识别用户，请重新登录后进入聊天室',
          data: null,
        });
        return;
      }

      // TypeORM 0.2：用 queryBuilder 查 uuid 更稳
      const user = await this.userRepository
        .createQueryBuilder('user')
        .where('user.user_id = :userId', { userId })
        .getOne();
      if (!user) {
        client.emit('groupMessage', {
          code: 401,
          message: '用户不存在',
          data: null,
        });
        return;
      }

      // 确保在房间内（断线重连后 meta 可能丢房间）
      const roomId = payload.group_id;
      if (meta?.groupId !== roomId) {
        client.join(roomId);
        this.socketMeta.set(client.id, {
          userId: user.user_id,
          groupId: roomId,
        });
      }

      const now = Date.now();
      // create + save，确保 uuid 主键由 TypeORM 生成
      const entity = this.groupMessageRepository.create({
        group_id: roomId,
        user_id: user.user_id,
        message: text,
        message_type: payload.message_type || 'text',
        // bigint 列用字符串写入更稳
        time: now as any,
      });
      const saved = await this.groupMessageRepository.save(entity);

      const view: GroupMessageView = {
        id: saved.id,
        group_id: saved.group_id,
        user_id: saved.user_id,
        message: saved.message,
        message_type: saved.message_type,
        time: Number(saved.time) || now,
        nickname: user.nickname,
        avatar: user.avatar,
      };

      const eventBody = {
        code: 200,
        message: '发送成功',
        data: view,
      };
      // 房间广播 + 单独回发送者，避免未入房时自己收不到
      this.server.to(roomId).emit('groupMessage', eventBody);
      client.emit('groupMessage', eventBody);
    } catch (err: any) {
      // eslint-disable-next-line no-console
      console.error('[groupMessage] failed', err);
      const detail =
        err?.message ||
        err?.sqlMessage ||
        (typeof err === 'string' ? err : '发送失败，请稍后重试');
      client.emit('groupMessage', {
        code: 500,
        message: String(detail).slice(0, 200),
        data: null,
      });
    }
  }

  private normalizeMessageBody(data: any): GroupMessageDto | null {
    if (!data) return null;
    if (typeof data === 'string') {
      try {
        return JSON.parse(data) as GroupMessageDto;
      } catch {
        return null;
      }
    }
    // socket.io 有时把参数打成数组
    if (Array.isArray(data)) {
      return this.normalizeMessageBody(data[0]);
    }
    if (typeof data === 'object' && data.message != null) {
      return data as GroupMessageDto;
    }
    return null;
  }

  /**
   * 房间在线人数：按房间内 socket 统计，同一 user_id 多 tab 去重。
   * 不用 server.engine.clientsCount（那是全站连接数）。
   */
  private roomOnlineCount(groupId: string): number {
    const adapter: any = this.server?.sockets?.adapter;
    const room: Set<string> | undefined =
      adapter?.rooms?.get?.(groupId) || adapter?.rooms?.[groupId];

    if (!room) return 0;

    const socketIds: string[] =
      typeof room.forEach === 'function'
        ? Array.from(room as Set<string>)
        : [];

    const users = new Set<string>();
    for (const sid of socketIds) {
      const meta = this.socketMeta.get(sid);
      users.add(meta?.userId || sid);
    }
    return users.size;
  }

  private async broadcastActiveUser(groupId: string): Promise<void> {
    const count = this.roomOnlineCount(groupId);
    this.server.to(groupId).emit('activeGroupUser', {
      code: 200,
      message: '查询成功',
      data: count,
      group_id: groupId,
    });
  }

  private normalizeAddGroup(
    body: AddGroupDto | number,
  ): { anime_id: number; group_name?: string } | null {
    if (typeof body === 'number' && Number.isFinite(body)) {
      return { anime_id: body };
    }
    if (body && typeof body === 'object') {
      const anime_id = Number((body as AddGroupDto).anime_id);
      if (!Number.isFinite(anime_id) || anime_id <= 0) return null;
      return {
        anime_id,
        group_name: (body as AddGroupDto).group_name,
      };
    }
    const n = Number(body as unknown);
    if (Number.isFinite(n) && n > 0) return { anime_id: n };
    return null;
  }
}
