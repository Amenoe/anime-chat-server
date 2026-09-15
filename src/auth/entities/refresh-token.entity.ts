import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * refreshToken 落库记录（便于吊销）。
 * 只存 JWT 的 sha256，不存明文：库被拖走也无法冒用。
 * 每次刷新作废旧行、签发新行（rotation），旧行被再次使用即视为泄露，整户吊销。
 */
@Entity('refresh_token')
@Index('IDX_refresh_token_user', ['user_id'])
export class RefreshToken {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 36 })
  user_id: string;

  /** sha256(jwt) hex */
  @Column({ type: 'char', length: 64, unique: true })
  token_hash: string;

  @Column({ type: 'datetime' })
  expires_at: Date;

  /** 0 有效 / 1 已作废（登出、轮换、改密、复用检测） */
  @Column({ type: 'tinyint', default: 0 })
  revoked: number;

  /** 轮换后的后继记录 id */
  @Column({ type: 'varchar', length: 36, default: '' })
  replaced_by: string;

  @Column({ type: 'varchar', length: 255, default: '' })
  user_agent: string;

  @Column({ type: 'datetime', nullable: true })
  last_used_at: Date | null;

  @CreateDateColumn({ type: 'datetime' })
  create_time: Date;
}
