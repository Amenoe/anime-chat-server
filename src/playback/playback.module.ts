import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PlaybackSession } from './entities/playback-session.entity';
import { PlaybackController } from './playback.controller';
import { PlaybackService } from './playback.service';
import { QbittorrentService } from './qbittorrent.service';
import { MagnetSearchService } from './magnet-search.service';

@Module({
  imports: [TypeOrmModule.forFeature([PlaybackSession])],
  controllers: [PlaybackController],
  providers: [PlaybackService, QbittorrentService, MagnetSearchService],
  exports: [PlaybackService],
})
export class PlaybackModule {}
