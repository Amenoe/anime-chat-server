import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('anime_ep')
export class AnimeEp {
  @PrimaryColumn()
  ep_id: number;
  @Column()
  anime_id: number;
  @Column()
  title: string;
  @Column()
  cover: string;
  @Column()
  first_date: string;
  @Column()
  link: string;
}
