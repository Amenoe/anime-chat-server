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

  @Column({ type: 'tinyint', default: 0 })
  status: number;

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
