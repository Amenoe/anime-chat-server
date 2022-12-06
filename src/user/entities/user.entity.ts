import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('user')
export class User {
  @PrimaryGeneratedColumn('uuid')
  user_id: string;

  @Column()
  username: string;

  @Column()
  password: string;

  @Column()
  nickname: string;

  @Column()
  avatar: string;

  //管理员可以删除聊天室和用户数据
  @Column('enum', { enum: ['root', 'user'], default: 'user' })
  role: string;

  @Column()
  status: number;

  @CreateDateColumn({ type: 'date' })
  create_time: Date;
}
