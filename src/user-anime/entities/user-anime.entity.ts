import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type UserAnimeStatus = 'wish' | 'watching' | 'done';

@Entity('user_anime')
@Index(['user_id', 'bangumi_id'], { unique: true })
export class UserAnime {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  user_id: string;

  @Column({ type: 'int' })
  bangumi_id: number;

  /** wish 想看 / watching 在看 / done 看完 */
  @Column('enum', { enum: ['wish', 'watching', 'done'] })
  status: UserAnimeStatus;

  @Column({ type: 'varchar', length: 255, nullable: true })
  title: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  name_cn: string | null;

  @Column({ type: 'varchar', length: 512, nullable: true })
  cover: string | null;

  @CreateDateColumn({ type: 'datetime' })
  create_time: Date;

  @UpdateDateColumn({ type: 'datetime' })
  update_time: Date;
}
