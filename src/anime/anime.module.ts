import { Module } from '@nestjs/common';
import { AnimeService } from './anime.service';
import { AnimeController } from './anime.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Anime } from './entities/anime.entity';
import { AnimeEp } from './entities/anime_ep.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Anime, AnimeEp])],
  controllers: [AnimeController],
  providers: [AnimeService],
})
export class AnimeModule {}
