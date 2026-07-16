import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserAnime } from './entities/user-anime.entity';
import { UserAnimeController } from './user-anime.controller';
import { UserAnimeService } from './user-anime.service';

@Module({
  imports: [TypeOrmModule.forFeature([UserAnime])],
  controllers: [UserAnimeController],
  providers: [UserAnimeService],
  exports: [UserAnimeService],
})
export class UserAnimeModule {}
