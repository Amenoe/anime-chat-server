import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('anime_ep')
export class AnimeEp {
  @PrimaryColumn()
  anime_id: number;
  @Column()
  title: string;
  @Column()
  category: string;
  @Column()
  cover: string;
  @Column()
  pub_time: string;
  @Column()
  update_time: string;
  @Column()
  description: string;
  @Column()
  season: string;
  @Column()
  rank: string;
  @Column()
  region: string;
}
