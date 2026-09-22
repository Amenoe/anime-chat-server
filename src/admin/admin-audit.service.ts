import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { AdminAuditLog } from './entities/admin-audit-log.entity';

/** 审计动作取值（与 `docs/admin-roadmap.md` §2.2 的约定一致） */
export type AdminAction =
  | 'user.ban'
  | 'user.role'
  | 'user.password'
  | 'user.delete'
  | 'ai.read'
  | 'track.export'
  | 'config.update';

export interface AuditInput {
  actorUserId: string;
  actorUsername: string;
  action: AdminAction;
  targetType: string;
  targetId?: string;
  /** 变更细节。**不要放密码/令牌明文** */
  detail?: Record<string, unknown> | null;
  ip?: string;
  userAgent?: string;
}

/**
 * 审计写入。
 *
 * ⚠️ 与埋点（`TrackService`）**故意相反**：这里**不吞异常**。
 * 审计的意义就是「留不下痕就不许操作成功」，所以写入失败必须往上抛、
 * 让整个管理操作回滚。如果想要「尽力而为」的日志，那是普通日志（Logger），不是审计。
 *
 * 支持传入 `EntityManager` 以便与业务改动**同事务**：
 * 改角色成功但审计失败 = 不知道是谁提的权，这种状态必须不可能出现。
 */
@Injectable()
export class AdminAuditService {
  private readonly logger = new Logger(AdminAuditService.name);

  constructor(
    @InjectRepository(AdminAuditLog)
    private readonly repo: Repository<AdminAuditLog>,
  ) {}

  async record(input: AuditInput, manager?: EntityManager): Promise<void> {
    const target = manager ? manager.getRepository(AdminAuditLog) : this.repo;
    await target.save(
      target.create({
        actor_user_id: input.actorUserId,
        actor_username: input.actorUsername,
        action: input.action,
        target_type: input.targetType,
        target_id: input.targetId ?? '',
        detail: input.detail ?? null,
        ip: input.ip ?? '',
        user_agent: (input.userAgent ?? '').slice(0, 255),
      }),
    );
    // 只有成功写入了才记日志；失败会抛异常，由调用方处理
    this.logger.log(
      `审计 ${input.action} by ${input.actorUsername} → ${input.targetType}:${
        input.targetId ?? '-'
      }`,
    );
  }

  /**
   * 最近的审计记录。
   *
   * 只给管理员看，因此**不做分页** —— 它是「最近发生了什么」的即时视图，
   * 不是用来翻历史的（要翻历史应该按 actor/action/target 加条件查，
   * 那是后续功能，见 `admin-roadmap.md`）。
   */
  async recent(limit = 50): Promise<AdminAuditLog[]> {
    const take = Math.min(Math.max(Math.trunc(limit) || 50, 1), 200);
    return this.repo.find({ order: { create_time: 'DESC' }, take });
  }
}
