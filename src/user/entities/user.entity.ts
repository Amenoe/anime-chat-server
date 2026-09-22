import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Exclude } from 'class-transformer';
import * as bcrypt from 'bcryptjs';

@Entity('user')
export class User {
  @PrimaryGeneratedColumn('uuid')
  user_id: string;

  @Column({ unique: true })
  username: string;

  @Exclude()
  @Column()
  password: string;

  @Column()
  nickname: string;

  @Column({ default: '' })
  avatar: string;

  // 管理员可以删除聊天室和用户数据
  @Column('enum', { enum: ['root', 'user'], default: 'user' })
  role: string;

  /**
   * 在线状态（0 离线 / 1 在线）：登录置 1，`User.vue` 离开时置 0。
   *
   * ⚠️ **这不是封禁位**。它表达的是「此刻在不在线」，而封禁是「能不能登录」。
   * 复用会导致用户关掉页面就被显示成「已封禁」—— 所以封禁另开 `disabled_at`。
   */
  @Column({ type: 'tinyint', default: 0 })
  status: number;

  /**
   * 封禁时间；`NULL` = 正常。用「时间」而不是布尔量，是为了顺带留下**何时封的**。
   *
   * 判定一律用 `disabled_at != null`，不要写成 `if (user.disabled_at)` —— 后者对
   * 「1970 年」这类合法但为 0 的时间戳会误判，虽然本场景不会出现，
   * 但把「有值即封禁」这件事写清楚比省两个字符重要。
   */
  @Column({ type: 'datetime', nullable: true })
  disabled_at: Date | null;

  /** 封禁原因，展示给被封的人看（避免用户只知道「被封了」而不知道找谁问） */
  @Column({ type: 'varchar', length: 255, default: '' })
  disabled_reason: string;

  @CreateDateColumn({ type: 'datetime' })
  create_time: Date;

  /** 仅插入时加密；更新密码在 service 中显式 hash，避免 BeforeUpdate 二次加密 */
  @BeforeInsert()
  encryptPwd() {
    if (this.password) {
      this.password = bcrypt.hashSync(this.password, 10);
    }
  }
}
