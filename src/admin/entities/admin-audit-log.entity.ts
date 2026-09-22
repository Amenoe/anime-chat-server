import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * 管理员操作审计日志。
 *
 * **刻意不复用 `track_event`**，三条都是硬性理由：
 * 1. `TrackService.track()` 的契约是「**吞掉所有异常**」（埋点写不进去不能影响业务），
 *    而审计必须反过来 —— **留不下痕就不许操作成功**。同一个方法不可能同时满足两者，
 *    硬塞进去只会让人误以为「有审计」，实际关键记录可能已被静默丢弃。
 * 2. 审计要求与业务改动**同事务**（改角色成功但审计失败 = 不知道是谁提的权），
 *    埋点是旁路异步写，没有事务语义。
 * 3. 检索维度与保留期不同：审计按 actor/action/target 查，长期保留；
 *    埋点按事件/时间聚合，可以定期清理。混在一张表里，两边的索引都做不好。
 */
@Entity('admin_audit_log')
@Index(['actor_user_id', 'create_time'])
@Index(['action', 'create_time'])
@Index(['target_type', 'target_id'])
export class AdminAuditLog {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  /** 操作者 id */
  @Column({ type: 'char', length: 36 })
  actor_user_id: string;

  /**
   * 操作者用户名**快照**。
   * 不靠 JOIN 现查：操作者本人被删号后，审计记录仍要能读出「是谁干的」。
   */
  @Column({ type: 'varchar', length: 255 })
  actor_username: string;

  /** 动作，取值固定：user.ban / user.role / user.password / user.delete / ai.read / track.export / config.update */
  @Column({ type: 'varchar', length: 64 })
  action: string;

  /** 目标类型，如 user / conversation */
  @Column({ type: 'varchar', length: 32 })
  target_type: string;

  @Column({ type: 'varchar', length: 64, default: '' })
  target_id: string;

  /** 变更细节。**绝不写密码/令牌明文** —— 只记「改了哪个字段、从什么变成什么」 */
  @Column({ type: 'json', nullable: true })
  detail: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 64, default: '' })
  ip: string;

  @Column({ type: 'varchar', length: 255, default: '' })
  user_agent: string;

  @CreateDateColumn({ type: 'datetime' })
  create_time: Date;
}
