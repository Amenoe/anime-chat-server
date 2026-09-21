import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * 通用埋点事件表。
 *
 * 设计要点：
 * - **只有一张表、一套写入路径**：前端行为埋点与后端业务事件（如 `ai.chat`）都进这里，
 *   管理员看板就不必为每类数据各写一套查询。
 * - `props` 用 JSON 存自定义属性，避免每加一个字段就改表结构。
 * - `event` 用点号分命名空间（`ai.chat`、`ui.click`、`page.view`），便于按前缀聚合。
 * - `client_ts` 与 `create_time` 分开：前端是**批量延迟上报**的，
 *   入库时间可能比事件真实发生时间晚几秒，分析时要按 `client_ts` 算。
 *
 * ⚠️ 取舍：通用 JSON 表换来扩展性，代价是聚合要 `JSON_EXTRACT`（见 AiService 的统计查询）。
 * 这个量级完全够用；若日后事件量级变大，应按 `ai_usage` 那种思路另建**物化汇总表**，
 * 而不是给这张通用表加业务专用列。
 */
@Entity('track_event')
@Index(['event', 'create_time'])
@Index(['user_id', 'create_time'])
export class TrackEvent {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  /** 事件名，如 ai.chat / ui.click / page.view */
  @Column({ type: 'varchar', length: 80 })
  event: string;

  /** 登录用户；匿名访问时为空 */
  @Column({ type: 'varchar', length: 255, nullable: true })
  user_id: string | null;

  /** 前端生成的匿名标识（localStorage 持久化），用于未登录时的行为串联 */
  @Column({ type: 'varchar', length: 64, nullable: true })
  anonymous_id: string | null;

  /** 来源页面/路由名 */
  @Column({ type: 'varchar', length: 80, nullable: true })
  page: string | null;

  /** 触发对象（元素标识） */
  @Column({ type: 'varchar', length: 120, nullable: true })
  target: string | null;

  /** 自定义属性 */
  @Column({ type: 'json', nullable: true })
  props: Record<string, unknown> | null;

  /** 事件在前端实际发生的时间 */
  @Column({ type: 'datetime', precision: 3, nullable: true })
  client_ts: Date | null;

  /** 入库时间 */
  @CreateDateColumn({ type: 'datetime' })
  create_time: Date;
}
