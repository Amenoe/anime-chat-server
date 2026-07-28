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
import { RoomService } from 'src/room/room.service';
import {
  AddGroupDto,
  GroupMessageDto,
  GroupMessageView,
  JoinRoomDto,
  PlaybackControlDto,
} from './dto/chat.dto';

const HISTORY_LIMIT = 50;

type SocketMeta = {
  userId: string | null;
  groupId: string | null;
  seasonId: string | null;
  joinedAt: number;
};

@WebSocketGateway({ cors: true })
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
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
    private readonly roomService: RoomService,
  ) {}

  @WebSocketServer()
  server: Server;

  /** socket.id → 用户 / 所在房间（兼容旧 @types/socket.io 无 socket.data） */
  private readonly socketMeta = new Map<string, SocketMeta>();

  private readonly lastPlaybackWrite = new Map<string, number>();
  private readonly PLAYBACK_WRITE_THROTTLE = 2000;

  async handleConnection(client: Socket): Promise<void> {
    const raw = (client.handshake as any)?.query?.user_id;
    const userId = raw != null && raw !== '' ? String(raw) : null;
    this.socketMeta.set(client.id, {
      userId,
      groupId: null,
      seasonId: null,
      joinedAt: Date.now(),
    });
  }

  async handleDisconnect(client: Socket): Promise<void> {
    const meta = this.socketMeta.get(client.id);
    const groupId = meta?.groupId;
    const userId = meta?.userId;
    const seasonId = meta?.seasonId;
    this.socketMeta.delete(client.id);
    if (groupId) {
      setImmediate(() => {
        void this.handleLeaveGroup(groupId, userId, seasonId);
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
        group_name?.trim() || animeData?.title || `番剧 #${anime_id}`;

      group = await this.groupRepository.save({
        anime_id,
        group_name: name,
        create_time: String(Date.now()),
      });
    } else if (group_name?.trim() && group.group_name.startsWith('番剧 #')) {
      group.group_name = group_name.trim();
      await this.groupRepository.save(group);
    }

    const meta = this.socketMeta.get(client.id) || {
      userId: null,
      groupId: null,
      seasonId: null,
      joinedAt: Date.now(),
    };
    const prevGroupId = meta.groupId;
    if (prevGroupId && prevGroupId !== group.group_id) {
      client.leave(prevGroupId);
      await this.broadcastActiveUser(prevGroupId);
    }

    client.join(group.group_id);
    meta.groupId = group.group_id;
    meta.seasonId = group.season_id ?? null;
    meta.joinedAt = Date.now();
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
        const existing = this.socketMeta.get(client.id);
        this.socketMeta.set(client.id, {
          userId: user.user_id,
          groupId: roomId,
          seasonId: existing?.seasonId ?? null,
          joinedAt: existing?.joinedAt ?? Date.now(),
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
      typeof room.forEach === 'function' ? Array.from(room as Set<string>) : [];

    const users = new Set<string>();
    for (const sid of socketIds) {
      const meta = this.socketMeta.get(sid);
      users.add(meta?.userId || sid);
    }
    return users.size;
  }

  private async broadcastActiveUser(groupId: string): Promise<void> {
    const members = await this.getOnlineMembers(groupId);
    this.server.to(groupId).emit('activeGroupUser', {
      code: 200,
      message: '查询成功',
      // 兼容：data 仍为人数；members 为头像列表
      data: members.length,
      members,
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

  // ─── joinRoom ────────────────────────────────────────────────

  @SubscribeMessage('joinRoom')
  async joinRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: JoinRoomDto,
  ): Promise<void> {
    try {
      const meta = this.socketMeta.get(client.id) || {
        userId: null,
        groupId: null,
        seasonId: null,
        joinedAt: Date.now(),
      };
      const userId = meta.userId;
      if (!userId) {
        client.emit('joinRoom', { code: 401, message: '未登录', data: null });
        return;
      }

      let group: Group | null = null;

      if (body.season_id) {
        group = await this.roomService.findBySeasonId(body.season_id);
        if (!group) {
          client.emit('joinRoom', {
            code: 404,
            message: '房间不存在',
            data: null,
          });
          return;
        }
      } else if (body.create) {
        if (!body.anime_id) {
          client.emit('joinRoom', {
            code: 400,
            message: '创建房间需要 anime_id',
            data: null,
          });
          return;
        }
        group = await this.roomService.createRoom(userId, {
          anime_id: body.anime_id,
          episode_id: body.episode_id,
          episode_sort: body.episode_sort,
          group_name: body.group_name,
        });
      } else {
        client.emit('joinRoom', {
          code: 400,
          message: '需要 season_id 或 create=true',
          data: null,
        });
        return;
      }

      const prevGroupId = meta.groupId;
      if (prevGroupId && prevGroupId !== group.group_id) {
        client.leave(prevGroupId);
        setImmediate(() => {
          void this.handleLeaveGroup(prevGroupId, userId, meta.seasonId);
        });
      }

      // 进房前已在房内的 user_id，用于判断本次是否「新进入」
      const beforeUserIds = new Set(this.getOnlineUserIds(group.group_id));

      client.join(group.group_id);
      meta.groupId = group.group_id;
      meta.seasonId = group.season_id;
      meta.joinedAt = Date.now();
      this.socketMeta.set(client.id, meta);

      const role = group.host_user_id === userId ? 'host' : 'viewer';
      const playbackState = this.roomService.toPlaybackState(group);
      const recentMessages = await this.fetchRecentMessages(group.group_id);
      const onlineUsers = await this.getOnlineMembers(group.group_id);

      client.emit('joinRoom', {
        code: 200,
        message: '进房成功',
        data: {
          group,
          role,
          playback_state: playbackState,
          recent_messages: recentMessages,
          online_users: onlineUsers,
        },
      });

      // 该用户此前不在房内 → 向其他人广播「进入放映室」
      if (!beforeUserIds.has(userId)) {
        const joinUser = await this.userRepository.findOne({
          where: { user_id: userId },
        });
        client.to(group.group_id).emit('roomNotice', {
          type: 'join',
          user_id: userId,
          nickname: joinUser?.nickname || '用户',
          time: Date.now(),
        });
      }

      await this.broadcastActiveUser(group.group_id);
    } catch (err: any) {
      // eslint-disable-next-line no-console
      console.error('[joinRoom] failed', err);
      client.emit('joinRoom', {
        code: 500,
        message: String(err?.message || '进房失败').slice(0, 200),
        data: null,
      });
    }
  }

  // ─── leaveRoom ───────────────────────────────────────────────

  @SubscribeMessage('leaveRoom')
  async leaveRoom(@ConnectedSocket() client: Socket): Promise<void> {
    const meta = this.socketMeta.get(client.id);
    const groupId = meta?.groupId;
    if (!groupId) return;

    const userId = meta?.userId;
    const seasonId = meta?.seasonId;

    client.leave(groupId);
    meta.groupId = null;
    meta.seasonId = null;
    this.socketMeta.set(client.id, meta);

    await this.handleLeaveGroup(groupId, userId, seasonId);
  }

  // ─── playback:control ───────────────────────────────────────

  @SubscribeMessage('playback:control')
  async playbackControl(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: PlaybackControlDto,
  ): Promise<void> {
    try {
      const meta = this.socketMeta.get(client.id);
      const userId = meta?.userId;
      if (!userId) {
        client.emit('playback:control', {
          code: 401,
          message: '未登录',
        });
        return;
      }

      if (!body?.group_id || !body?.action) {
        client.emit('playback:control', {
          code: 400,
          message: '参数不完整',
        });
        return;
      }

      const group = await this.groupRepository.findOne({
        where: { group_id: body.group_id },
      });
      if (!group) {
        client.emit('playback:control', {
          code: 404,
          message: '房间不存在',
        });
        return;
      }

      if (group.host_user_id !== userId) {
        client.emit('playback:control', {
          code: 403,
          message: '只有房主可以控制播放',
        });
        return;
      }

      const patch: Partial<
        Pick<
          Group,
          | 'playback_status'
          | 'playback_episode_id'
          | 'playback_episode_sort'
          | 'playback_session_id'
          | 'playback_stream_url'
          | 'playback_position'
          | 'playback_title'
        >
      > = {};

      switch (body.action) {
        case 'play':
          patch.playback_status = 'playing';
          if (body.position != null) patch.playback_position = body.position;
          break;
        case 'pause':
          patch.playback_status = 'paused';
          if (body.position != null) patch.playback_position = body.position;
          break;
        case 'seek':
          if (body.position != null) patch.playback_position = body.position;
          break;
        case 'switch_episode':
          if (body.episode_id != null)
            patch.playback_episode_id = body.episode_id;
          if (body.episode_sort != null)
            patch.playback_episode_sort = body.episode_sort;
          patch.playback_position = 0;
          patch.playback_status = 'idle';
          // 切集清空旧源：让房主重新（自动）选源，观众旧视频停止
          patch.playback_session_id = '';
          patch.playback_stream_url = '';
          patch.playback_title = '';
          break;
        case 'set_source':
          if (body.stream_url != null)
            patch.playback_stream_url = body.stream_url;
          if (body.title != null) patch.playback_title = body.title;
          if (body.session_id != null)
            patch.playback_session_id = body.session_id;
          break;
        case 'heartbeat':
          if (body.position != null) patch.playback_position = body.position;
          break;
      }

      const isHeartbeat = body.action === 'heartbeat';
      let shouldWriteDb = true;

      if (isHeartbeat) {
        const now = Date.now();
        const last = this.lastPlaybackWrite.get(body.group_id) || 0;
        if (now - last < this.PLAYBACK_WRITE_THROTTLE) {
          shouldWriteDb = false;
        } else {
          this.lastPlaybackWrite.set(body.group_id, now);
        }
      }

      let updated = group;
      if (shouldWriteDb) {
        updated = await this.roomService.updatePlayback(
          body.group_id,
          userId,
          patch,
        );
      } else {
        Object.assign(updated, patch);
      }

      this.server.to(body.group_id).emit('playback:state', {
        group_id: updated.group_id,
        season_id: updated.season_id,
        status: updated.playback_status,
        episode_id: updated.playback_episode_id,
        episode_sort: updated.playback_episode_sort,
        session_id: updated.playback_session_id,
        stream_url: updated.playback_stream_url,
        position: updated.playback_position,
        paused: updated.playback_status === 'paused',
        title: updated.playback_title,
        host_user_id: updated.host_user_id,
        server_time: Date.now(),
        updated_at: updated.playback_updated_at,
      });
    } catch (err: any) {
      // eslint-disable-next-line no-console
      console.error('[playback:control] failed', err);
      client.emit('playback:control', {
        code: 500,
        message: String(err?.message || '播放控制失败').slice(0, 200),
      });
    }
  }

  // ─── helpers ─────────────────────────────────────────────────

  private async handleLeaveGroup(
    groupId: string,
    userId: string | null | undefined,
    seasonId: string | null | undefined,
  ): Promise<void> {
    try {
      const roomSockets = this.getRoomSocketIds(groupId);

      if (roomSockets.length === 0) {
        await this.roomService.destroyRoom(groupId);
        return;
      }

      // 该用户已无残留 socket 在房 → 向剩余成员广播「离开」
      if (userId) {
        const stillOnline = this.getOnlineUserIds(groupId).includes(userId);
        if (!stillOnline) {
          const leaveUser = await this.userRepository.findOne({
            where: { user_id: userId },
          });
          this.server.to(groupId).emit('roomNotice', {
            type: 'leave',
            user_id: userId,
            nickname: leaveUser?.nickname || '用户',
            time: Date.now(),
          });
        }
      }

      if (userId) {
        const group = await this.groupRepository.findOne({
          where: { group_id: groupId },
        });
        if (group && group.host_user_id === userId) {
          let earliest: SocketMeta | null = null;
          for (const sid of roomSockets) {
            const m = this.socketMeta.get(sid);
            if (
              m?.userId &&
              m.userId !== userId &&
              (!earliest || m.joinedAt < earliest.joinedAt)
            ) {
              earliest = m;
            }
          }
          if (earliest?.userId) {
            await this.roomService.transferHost(groupId, earliest.userId);
            this.server.to(groupId).emit('host:changed', {
              season_id: seasonId ?? group.season_id,
              host_user_id: earliest.userId,
            });
          }
        }
      }

      void this.broadcastActiveUser(groupId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[handleLeaveGroup] failed', err);
    }
  }

  private getRoomSocketIds(groupId: string): string[] {
    const adapter: any = this.server?.sockets?.adapter;
    const room: Set<string> | undefined =
      adapter?.rooms?.get?.(groupId) || adapter?.rooms?.[groupId];
    if (!room) return [];
    return typeof room.forEach === 'function'
      ? Array.from(room as Set<string>)
      : [];
  }

  private getOnlineUserIds(groupId: string): string[] {
    const socketIds = this.getRoomSocketIds(groupId);
    const users = new Set<string>();
    for (const sid of socketIds) {
      const meta = this.socketMeta.get(sid);
      if (meta?.userId) users.add(meta.userId);
    }
    return Array.from(users);
  }

  /** 在线成员（去重 user_id）含昵称头像，供聊天栏展示 */
  private async getOnlineMembers(
    groupId: string,
  ): Promise<Array<{ user_id: string; nickname: string; avatar: string }>> {
    const ids = this.getOnlineUserIds(groupId);
    if (!ids.length) return [];
    const users = await this.userRepository.find({
      where: ids.map((user_id) => ({ user_id })),
    });
    const map = new Map(users.map((u) => [u.user_id, u]));
    return ids.map((user_id) => {
      const u = map.get(user_id);
      return {
        user_id,
        nickname: u?.nickname || '用户',
        avatar: u?.avatar || '',
      };
    });
  }

  private async fetchRecentMessages(
    groupId: string,
  ): Promise<GroupMessageView[]> {
    const messages = await this.groupMessageRepository.find({
      where: { group_id: groupId },
      order: { time: 'DESC' },
      take: HISTORY_LIMIT,
    });
    if (!messages.length) return [];

    const userIds = [...new Set(messages.map((m) => m.user_id))];
    const users = userIds.length
      ? await this.userRepository.find({
          where: userIds.map((user_id) => ({ user_id })),
        })
      : [];
    const userMap = new Map(users.map((u) => [u.user_id, u]));

    return messages
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
  }
}
