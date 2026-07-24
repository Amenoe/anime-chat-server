import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type PlaybackStatus =
  | 'created'
  | 'fetching'
  | 'downloading'
  | 'playable'
  | 'ready'
  | 'failed';

/**
 * MySQL：TEXT/BLOB 不能带 DEFAULT（非 null 默认值会报错）。
 * 路径/文件名用 varchar；长 magnet 用 text 且无 default。
 */
@Entity('playback_session')
export class PlaybackSession {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 36 })
  user_id: string;

  @Column({ type: 'int', nullable: true })
  bangumi_id: number | null;

  @Column({ type: 'float', nullable: true })
  episode_sort: number | null;

  /** magnet: 或 http(s)://...torrent（TEXT 无 default） */
  @Column({ type: 'text' })
  source_uri: string;

  @Column({ type: 'varchar', length: 64, default: '' })
  info_hash: string;

  /** qB 内文件 index；-1 表示尚未选定 */
  @Column({ type: 'int', default: -1 })
  file_index: number;

  @Column({ type: 'varchar', length: 512, default: '' })
  file_name: string;

  /** BT 落盘路径（流媒体会话为空） */
  @Column({ type: 'varchar', length: 1024, default: '' })
  local_path: string;

  /**
   * 历史列，播放不再使用 MinIO；保留列避免改表。
   * @deprecated
   */
  @Column({ type: 'varchar', length: 512, default: '' })
  minio_object: string;

  @Column({
    type: 'varchar',
    length: 32,
    default: 'created',
  })
  status: PlaybackStatus;

  @Column({ type: 'varchar', length: 512, default: '' })
  error_message: string;

  /** 0~1 */
  @Column({ type: 'float', default: 0 })
  progress: number;

  @Column({ type: 'bigint', default: 0 })
  size_bytes: string;

  @Column({ type: 'bigint', default: 0 })
  downloaded_bytes: string;

  @CreateDateColumn({ type: 'datetime' })
  create_time: Date;

  @UpdateDateColumn({ type: 'datetime' })
  update_time: Date;
}
