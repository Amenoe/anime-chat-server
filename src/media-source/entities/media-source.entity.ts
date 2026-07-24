import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/** rss = BT 订阅；web-selector / stream = 流媒体站点订阅 */
export type MediaSourceKind = 'rss' | 'web' | 'mixed';

/**
 * 唯一键用 url_hash，避免 user_id+url(1024) 在 utf8mb4 下超过 InnoDB 3072 字节索引限制。
 */
@Entity('media_source')
@Index(['user_id', 'url_hash'], { unique: true })
export class MediaSource {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 所属用户；系统默认也会挂到该用户 */
  @Column({ type: 'varchar', length: 36 })
  user_id: string;

  @Column({ type: 'varchar', length: 128, default: '' })
  name: string;

  /** 订阅 JSON URL（如 creamycake css1/bt1） */
  @Column({ type: 'varchar', length: 1024 })
  url: string;

  /** sha256(url) hex，用于唯一约束 */
  @Column({ type: 'varchar', length: 64 })
  url_hash: string;

  /** 解析后的类型提示 */
  @Column({ type: 'varchar', length: 16, default: 'mixed' })
  kind: MediaSourceKind;

  @Column({ type: 'tinyint', default: 1 })
  enabled: number;

  /** 列表排序，越小越前 */
  @Column({ type: 'int', default: 0 })
  sort_order: number;

  /** 最近一次成功拉取的时间 */
  @Column({ type: 'datetime', nullable: true })
  last_fetched_at: Date | null;

  @Column({ type: 'varchar', length: 512, default: '' })
  last_error: string;

  @CreateDateColumn({ type: 'datetime' })
  create_time: Date;

  @UpdateDateColumn({ type: 'datetime' })
  update_time: Date;
}
