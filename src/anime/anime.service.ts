import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { getRepository, Like, Repository } from 'typeorm';
import { CreateAnimeDto } from './dto/create-anime.dto';
import { UpdateAnimeDto } from './dto/update-anime.dto';
import { Anime } from './entities/anime.entity';
import { AnimeEp } from './entities/anime_ep.entity';

@Injectable()
export class AnimeService {
  constructor(
    @InjectRepository(Anime)
    private animeRepository: Repository<Anime>,
  ) {}

  async getIndex() {
    const banners = await this.animeRepository.query(
      "SELECT * FROM `anime` WHERE FIND_IN_SET('轮播',status)",
    );
    const hots = await this.animeRepository.query(
      "SELECT * FROM `anime` WHERE FIND_IN_SET('热门',status)",
    );
    const latest = await this.animeRepository.find({
      order: {
        update_time: 'DESC',
      },
      take: 10,
    });
    const data = {
      banner: banners,
      hots: hots,
      latest: latest,
    };
    return data;
  }

  async getDetail(id: string) {
    const data = await getRepository(Anime)
      .createQueryBuilder('anime')
      .leftJoinAndMapMany(
        'anime.anime_id',
        AnimeEp,
        'ep',
        'anime.anime_id = ep.anime_id',
      )
      .where('anime.anime_id = :id', { id })
      .getOne();
    return data;
  }

  async filter(param: string) {
    const data = await this.animeRepository.find({
      where: {
        title: Like(`%${param}%`),
      },
    });
    return data;
  }

  create(createAnimeDto: CreateAnimeDto) {
    return 'This action adds a new anime';
  }

  findAll() {
    return `This action returns all anime`;
  }

  //test
  async findOne(id: number) {
    return await this.animeRepository.findOne({
      where: {
        anime_id: id,
      },
    });
  }

  update(id: number, updateAnimeDto: UpdateAnimeDto) {
    return `This action updates a #${id} anime`;
  }

  remove(id: number) {
    return `This action removes a #${id} anime`;
  }
}
