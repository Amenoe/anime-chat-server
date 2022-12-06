import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { getRepository, Repository } from 'typeorm';
import { CreateAnimeDto } from './dto/create-anime.dto';
import { UpdateAnimeDto } from './dto/update-anime.dto';
import { Anime } from './entities/anime.entity';

@Injectable()
export class AnimeService {
  constructor(
    @InjectRepository(Anime)
    private animeRepository: Repository<Anime>,
  ) {}

  // async search(title: string, page: number) {
  //   const searchResult = await getRepository(Anime)
  //     .createQueryBuilder('anime')
  //     .where('anime.title LIKE :title', { title: `%${title}%` })
  //     .skip((page - 1) * 20)
  //     .take(20)
  //     .getMany();

  //   const data = {
  //     pageindex: page,
  //     pagetotal: searchResult.length / 20,
  //     results: searchResult,
  //   };
  //   // console.log(searchResult);
  //   return data;
  // }

  // //主页数据
  // async getIndex() {
  //   const banners = await this.animeRepository.query(
  //     "SELECT * FROM `anime` WHERE FIND_IN_SET('轮播',status)",
  //   );
  //   const bannersData = banners.map((item) => {
  //     return {
  //       cover: item.cover,
  //       id: item.anime_id,
  //       title: item.title,
  //     };
  //   });
  //   const hots = await this.animeRepository.query(
  //     "SELECT * FROM `anime` WHERE FIND_IN_SET('热门',status)",
  //   );
  //   const hotsData = hots.map((item) => {
  //     return {
  //       cover: item.cover,
  //       id: item.anime_id,
  //       season: item.season,
  //       title: item.title,
  //       date: item.pub_time,
  //       description: item.description,
  //     };
  //   });
  //   const latest = await this.animeRepository.find({
  //     order: {
  //       update_time: 'DESC',
  //     },
  //     take: 5,
  //   });

  //   const latestData = latest.map((item) => {
  //     return {
  //       cover: item.cover,
  //       id: item.cover,
  //       season: item.season,
  //       title: item.title,
  //     };
  //   });
  //   const data = {
  //     banner: bannersData,
  //     hots: hotsData,
  //     latest: latestData,
  //   };
  //   return data;
  // }

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
