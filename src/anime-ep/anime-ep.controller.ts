import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
} from '@nestjs/common';
import { AnimeEpService } from './anime-ep.service';
import { CreateAnimeEpDto } from './dto/create-anime-ep.dto';
import { UpdateAnimeEpDto } from './dto/update-anime-ep.dto';

@Controller('anime-ep')
export class AnimeEpController {
  constructor(private readonly animeEpService: AnimeEpService) {}

  @Post()
  create(@Body() createAnimeEpDto: CreateAnimeEpDto) {
    return this.animeEpService.create(createAnimeEpDto);
  }

  @Get()
  findAll() {
    return this.animeEpService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.animeEpService.findOne(+id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateAnimeEpDto: UpdateAnimeEpDto) {
    return this.animeEpService.update(+id, updateAnimeEpDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.animeEpService.remove(+id);
  }
}
