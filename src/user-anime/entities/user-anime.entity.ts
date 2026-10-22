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

  /**
   * 看到第几集（Bangumi 的 sort，可能是 1.5 这种非整数，所以用 float）。
   * 0 表示还没开始看。用于「继续观看」与追番页的进度展示。
   */
  @Column({ type: 'float', default: 0 })
  watched_episode: number;

  /**
   * 总集数。追番时从 Bangumi 的 subject 详情带上，0 表示未知。
   * 单独存一份是为了追番列表不用逐条回查 Bangumi（那会让列表页发 N 个请求）。
   */
  @Column({ type: 'int', default: 0 })
  total_episodes: number;

  @CreateDateColumn({ type: 'datetime' })
  create_time: Date;

  @UpdateDateColumn({ type: 'datetime' })
  update_time: Date;
}
