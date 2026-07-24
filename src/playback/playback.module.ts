import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MediaSourceModule } from '../media-source/media-source.module';
import { PlaybackSession } from './entities/playback-session.entity';
import { PlaybackController } from './playback.controller';
import { PlaybackService } from './playback.service';
import { QbittorrentService } from './qbittorrent.service';
import { SourceSearchService } from './source-search.service';

@Module({
  imports: [TypeOrmModule.forFeature([PlaybackSession]), MediaSourceModule],
  controllers: [PlaybackController],
  providers: [PlaybackService, QbittorrentService, SourceSearchService],
  exports: [PlaybackService],
})
export class PlaybackModule {}
