import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type AiMessageRole = 'user' | 'assistant';

/**
 * AI 会话的一条消息。
 *
 * `tool_results` 保存该轮的工具返回（番剧卡片数组）。必须落库，否则用户刷新页面后
 * 只剩文字、卡片全没了 —— 而卡片是「模型不编造番剧」这条设计原则的载体。
 */
@Entity('ai_message')
@Index(['conversation_id'])
export class AiMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  conversation_id: string;

  /** 冗余一份 user_id：列表/删除等鉴权查询可少一次 join */
  @Column()
  user_id: string;

  @Column('enum', { enum: ['user', 'assistant'] })
  role: AiMessageRole;

  @Column({ type: 'text' })
  content: string;

  /** 工具返回的番剧卡片（仅 assistant 消息可能有） */
  @Column({ type: 'json', nullable: true })
  tool_results: unknown[] | null;

  @CreateDateColumn({ type: 'datetime' })
  create_time: Date;
}
