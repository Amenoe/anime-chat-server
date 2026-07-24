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

  @Column({ type: 'varchar', length: 32, unique: true })
  season_id: string;

  @Column({ type: 'varchar', length: 36, default: '' })
  host_user_id: string;

  @Column({ type: 'tinyint', default: 1 })
  is_public: number;

  @Column({ type: 'int', nullable: true })
  episode_id: number | null;

  @Column({ type: 'float', nullable: true })
  episode_sort: number | null;

  @Column({ type: 'varchar', length: 16, default: 'idle' })
  playback_status: string; // idle | playing | paused

  @Column({ type: 'float', nullable: true })
  playback_episode_sort: number | null;

  @Column({ type: 'int', nullable: true })
  playback_episode_id: number | null;

  @Column({ type: 'varchar', length: 36, default: '' })
  playback_session_id: string;

  @Column({ type: 'text', nullable: true })
  playback_stream_url: string | null;

  @Column({ type: 'float', default: 0 })
  playback_position: number;

  @Column({ type: 'datetime', nullable: true })
  playback_updated_at: Date | null;

  @Column({ type: 'varchar', length: 512, default: '' })
  playback_title: string;
}
