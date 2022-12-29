import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity()
export class GroupUserMap {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  group_id: string;

  @Column()
  user_id: string;
}
