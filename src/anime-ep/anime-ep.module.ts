import { Module } from '@nestjs/common';
import { AnimeEpService } from './anime-ep.service';
import { AnimeEpController } from './anime-ep.controller';

@Module({
  controllers: [AnimeEpController],
  providers: [AnimeEpService]
})
export class AnimeEpModule {}
