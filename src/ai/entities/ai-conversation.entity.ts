import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * AI 会话。
 *
 * 一个用户可以有多个会话；`title` 由首轮用户消息裁剪而来，仅用于列表展示。
 *
 * 历史消息的权威来源是本表 + `ai_message`：anime-ai 是无状态的，
 * 每次对话由本服务把历史窗口送过去。
 */
@Entity('ai_conversation')
@Index(['user_id'])
export class AiConversation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  user_id: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  title: string | null;

  @CreateDateColumn({ type: 'datetime' })
  create_time: Date;

  @UpdateDateColumn({ type: 'datetime' })
  update_time: Date;
}
