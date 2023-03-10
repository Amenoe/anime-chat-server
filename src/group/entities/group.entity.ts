import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity()
export class Group {
  @PrimaryGeneratedColumn('uuid')
  group_id: string;

  @Column({ default: 'admin' })
  user_id: string;

  @Column()
  anime_id: number;

  @Column()
  group_name: string;

  @Column({ default: '文明交流' })
  notice: string;

  @Column()
  create_time: string;
}
