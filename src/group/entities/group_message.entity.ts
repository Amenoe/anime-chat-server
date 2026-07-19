import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity()
export class GroupMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  group_id: string;

  @Column()
  user_id: string;

  @Column({ type: 'text' })
  message: string;

  @Column({ default: 'text' })
  message_type: string;

  /**
   * 毫秒时间戳。必须用 bigint：Date.now() ≈ 1.7e12 会撑爆 MySQL INT（最大 2^31-1）。
   * TypeORM 读 bigint 时可能是 string，业务侧用 Number() 即可。
   */
  @Column({ type: 'bigint' })
  time: number;
}
