import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * AI 用量计数（按人按天一行）。
 *
 * 为什么必须落库而不是放内存计数器：配额是**花钱的闸门**，
 * 内存计数在多实例部署下会各算一份，且重启即清零，等于没有配额。
 *
 * 计数时机：请求**开始前**就 +1。这样用户中途断开也照样扣次数，
 * 否则「断开重连」就能绕过配额。
 */
@Entity('ai_usage')
@Index(['user_id', 'stat_date'], { unique: true })
export class AiUsage {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  user_id: string;

  /** 统计日期（YYYY-MM-DD）。字段名避开 MySQL 保留字 `date` */
  @Column({ type: 'date' })
  stat_date: string;

  @Column({ type: 'int', default: 0 })
  request_count: number;

  @Column({ type: 'int', default: 0 })
  prompt_tokens: number;

  @Column({ type: 'int', default: 0 })
  completion_tokens: number;
}
