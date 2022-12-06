import { Injectable } from '@nestjs/common';
import { CreateAnimeEpDto } from './dto/create-anime-ep.dto';
import { UpdateAnimeEpDto } from './dto/update-anime-ep.dto';

@Injectable()
export class AnimeEpService {
  create(createAnimeEpDto: CreateAnimeEpDto) {
    return 'This action adds a new animeEp';
  }

  findAll() {
    return `This action returns all animeEp`;
  }

  findOne(id: number) {
    return `This action returns a #${id} animeEp`;
  }

  update(id: number, updateAnimeEpDto: UpdateAnimeEpDto) {
    return `This action updates a #${id} animeEp`;
  }

  remove(id: number) {
    return `This action removes a #${id} animeEp`;
  }
}
