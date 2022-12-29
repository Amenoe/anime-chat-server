import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity()
export class GroupMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  group_id: string;

  @Column()
  user_id: string;

  @Column()
  message: string;

  @Column()
  message_type: string;

  @Column()
  time: number;
}
