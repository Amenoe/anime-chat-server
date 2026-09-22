import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { Connection, Repository } from 'typeorm';
import { RefreshTokenService } from 'src/auth/refresh-token.service';
import { AiConversation } from 'src/ai/entities/ai-conversation.entity';
import { AiMessage } from 'src/ai/entities/ai-message.entity';
import { TrackEvent } from 'src/track/entities/track-event.entity';
import { UserAnime } from 'src/user-anime/entities/user-anime.entity';
import { User } from 'src/user/entities/user.entity';
import { AccountCleanupService } from 'src/account/account-cleanup.service';
import { AdminAuditService } from './admin-audit.service';
import type {
  BanUserDto,
  ListUsersQueryDto,
  ResetPasswordDto,
} from './dto/admin-user.dto';
import { ChangeUserRoleDto } from './dto/admin-user.dto';

/** 管理员操作者上下文（从 req 里取，用于审计快照） */
export interface AdminActor {
  userId: string;
  username: string;
  ip?: string;
  userAgent?: string;
}

/**
 * 用户列表/详情的**字段白名单**。
 *
 * 刻意显式列出而不是 `find()` 整行：`password` 目前靠实体上的 `@Exclude()` +
 * `ClassSerializerInterceptor` 保护，而那个拦截器**只挂在 `UserController` 上**。
 * 新 controller 忘了挂，密码就直接漏出去了 —— 显式 select 一次，
 * 比「记得挂拦截器」可靠得多。
 */
const USER_FIELDS = [
  'user_id',
  'username',
  'nickname',
  'avatar',
  'role',
  'status',
  'disabled_at',
  'disabled_reason',
  'create_time',
] as const;

/**
 * 转义 LIKE 的通配符。
 *
 * 不转义的话，管理员在搜索框里输入一个 `%` 就等于**拉全表**（`_` 则变成任意单字符）。
 * 用 `!` 作为转义符而不是默认的反斜杠：反斜杠在 JS 字符串和 SQL 字面量里都要再转一层，
 * 写成 `ESCAPE '\\'` 极易出错，而 `!` 没有这个歧义。
 */
function escapeLike(input: string): string {
  return input.replace(/[!%_]/g, (c) => `!${c}`);
}

@Injectable()
export class AdminUserService {
  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectConnection() private readonly conn: Connection,
    private readonly audit: AdminAuditService,
    private readonly cleanup: AccountCleanupService,
    private readonly refreshTokenService: RefreshTokenService,
  ) {}

  /** 分页列表。`user` 表量级小，`skip/take` + `total` 足够（大表才需要游标） */
  async list(query: ListUsersQueryDto) {
    const page = query.page ?? 1;
    const size = query.size ?? 20;

    const qb = this.userRepo
      .createQueryBuilder('u')
      .select(USER_FIELDS.map((f) => `u.${f}`));

    if (query.keyword?.trim()) {
      const kw = `%${escapeLike(query.keyword.trim())}%`;
      qb.andWhere(
        "(u.username LIKE :kw ESCAPE '!' OR u.nickname LIKE :kw ESCAPE '!')",
        { kw },
      );
    }
    if (query.role) {
      qb.andWhere('u.role = :role', { role: query.role });
    }
    if (query.disabled !== undefined) {
      qb.andWhere(
        query.disabled ? 'u.disabled_at IS NOT NULL' : 'u.disabled_at IS NULL',
      );
    }

    const [items, total] = await qb
      .orderBy('u.create_time', 'DESC')
      .skip((page - 1) * size)
      .take(size)
      .getManyAndCount();

    return { items, total, page, size };
  }

  /** 详情：基础信息 + 数据规模，便于判断「这个号是不是该清」 */
  async detail(id: string) {
    const user = await this.userRepo
      .createQueryBuilder('u')
      .select(USER_FIELDS.map((f) => `u.${f}`))
      .where('u.user_id = :id', { id })
      .getOne();
    if (!user) {
      throw new NotFoundException('用户不存在');
    }

    const [conversations, messages, events, animes] = await Promise.all([
      this.conn.getRepository(AiConversation).count({
        where: { user_id: id },
      }),
      this.conn.getRepository(AiMessage).count({ where: { user_id: id } }),
      this.conn.getRepository(TrackEvent).count({ where: { user_id: id } }),
      this.conn.getRepository(UserAnime).count({ where: { user_id: id } }),
    ]);

    return { user, stats: { conversations, messages, events, animes } };
  }

  /**
   * 封禁 / 解封。
   *
   * 即时生效靠**三个拦截点**（`JwtStrategy.validate` / `login` / `refresh`），
   * 不需要 accessToken 黑名单 —— 前者本来就每请求查库，在那里拦一次主键查询就够。
   */
  async setBanned(actor: AdminActor, id: string, dto: BanUserDto) {
    const target = await this.mustFind(id);

    if (dto.banned) {
      if (id === actor.userId) {
        throw new BadRequestException('不能封禁自己');
      }
      /*
       * 防自锁：封掉最后一个还能用的 root，等于把管理能力锁死在门外。
       *
       * `target.disabled_at == null` 这个前提不能少：封一个**已经封了**的 root
       * 并不会减少可用管理员数量，但 `countActiveRoots()` 只数未封禁的 root，
       * 此时必然 ≤1，于是会被误判成「最后一个」而拒绝。
       * 只在**真的会减少**可用 root 时才拦。
       */
      if (
        target.disabled_at == null &&
        target.role === 'root' &&
        (await this.countActiveRoots()) <= 1
      ) {
        throw new BadRequestException('这是最后一个可用的管理员账号，不能封禁');
      }
    }

    await this.conn.transaction(async (m) => {
      await m.update(
        User,
        { user_id: id },
        {
          disabled_at: dto.banned ? new Date() : null,
          disabled_reason: dto.banned ? (dto.reason ?? '').slice(0, 255) : '',
        },
      );
      await this.audit.record(
        {
          actorUserId: actor.userId,
          actorUsername: actor.username,
          action: 'user.ban',
          targetType: 'user',
          targetId: id,
          detail: {
            banned: dto.banned,
            reason: dto.reason ?? '',
            username: target.username,
          },
          ip: actor.ip,
          userAgent: actor.userAgent,
        },
        m,
      );
    });

    if (dto.banned) {
      // 断掉静默续期。即使这步失败，refresh 拦截点也会拒绝 —— 属于双保险，故吞掉异常。
      try {
        await this.refreshTokenService.revokeAllForUser(id);
      } catch {
        /* 见上 */
      }
    }

    return this.detail(id);
  }

  /** 改角色。只走这里，普通用户没有任何路径可以提权 */
  async setRole(actor: AdminActor, id: string, dto: ChangeUserRoleDto) {
    const target = await this.mustFind(id);

    if (id === actor.userId) {
      // 含自我降级：会立刻失去管理能力，纯属手滑，直接挡掉
      throw new BadRequestException('不能修改自己的角色');
    }
    if (target.role === dto.role) {
      return this.detail(id);
    }
    if (
      dto.role === 'user' &&
      target.role === 'root' &&
      // 同 setBanned：目标本来就被封禁时不减少可用 root，不该拦
      target.disabled_at == null &&
      (await this.countActiveRoots()) <= 1
    ) {
      throw new BadRequestException('这是最后一个可用的管理员账号，不能降级');
    }

    await this.conn.transaction(async (m) => {
      await m.update(User, { user_id: id }, { role: dto.role });
      await this.audit.record(
        {
          actorUserId: actor.userId,
          actorUsername: actor.username,
          action: 'user.role',
          targetType: 'user',
          targetId: id,
          detail: {
            from: target.role,
            to: dto.role,
            username: target.username,
          },
          ip: actor.ip,
          userAgent: actor.userAgent,
        },
        m,
      );
    });

    return this.detail(id);
  }

  /**
   * 重置密码。
   *
   * 两个必须记住的点：**更新要显式 hash**（实体上的 `@BeforeInsert` 只在插入时生效，
   * 直接 update 明文会存进去）；**重置后必须吊销全部会话**，否则旧设备还能继续用。
   */
  async resetPassword(actor: AdminActor, id: string, dto: ResetPasswordDto) {
    const target = await this.mustFind(id);
    const hashed = bcrypt.hashSync(dto.newPassword, 10);

    await this.conn.transaction(async (m) => {
      await m.update(User, { user_id: id }, { password: hashed });
      // 审计只记「重置了谁的密码」，**绝不记密码本身**
      await this.audit.record(
        {
          actorUserId: actor.userId,
          actorUsername: actor.username,
          action: 'user.password',
          targetType: 'user',
          targetId: id,
          detail: { username: target.username, self: id === actor.userId },
          ip: actor.ip,
          userAgent: actor.userAgent,
        },
        m,
      );
    });

    await this.refreshTokenService.revokeAllForUser(id);
    return { reset: true };
  }

  /** 删号：与「用户自删」共用 `AccountCleanupService.purge` 这一条路径 */
  async remove(actor: AdminActor, id: string) {
    const target = await this.mustFind(id);

    if (id === actor.userId) {
      // 自己的账号走个人中心那条路（那里有二次确认的正常 UX），
      // 管理面板只用来处置**别人**，避免在管理流程里手滑把自己删了
      throw new BadRequestException('请从个人中心删除自己的账号');
    }

    const counts = await this.cleanup.purge(id);

    await this.audit.record({
      actorUserId: actor.userId,
      actorUsername: actor.username,
      action: 'user.delete',
      targetType: 'user',
      targetId: id,
      detail: { username: target.username, counts },
      ip: actor.ip,
      userAgent: actor.userAgent,
    });

    return { deleted: true, counts };
  }

  /** 审计日志查询（最近 N 条，按时间倒序） */
  async auditLogs(limit = 50) {
    return this.audit.recent(limit);
  }

  // ── 内部 ────────────────────────────────────────────────────

  private async mustFind(id: string): Promise<User> {
    const user = await this.userRepo.findOne({ where: { user_id: id } });
    if (!user) {
      throw new NotFoundException('用户不存在');
    }
    return user;
  }

  /** 「未封禁的 root」数量 —— 防自锁判定的唯一依据 */
  private async countActiveRoots(): Promise<number> {
    return this.userRepo
      .createQueryBuilder('u')
      .where('u.role = :role', { role: 'root' })
      .andWhere('u.disabled_at IS NULL')
      .getCount();
  }
}
