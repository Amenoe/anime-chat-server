import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Group } from '../group/entities/group.entity';
import { GroupUserMap } from '../group/entities/group_user_map.entity';
import { MediaSourceModule } from '../media-source/media-source.module';
import { PlaybackSession } from './entities/playback-session.entity';
import { PlaybackController } from './playback.controller';
import { PlaybackService } from './playback.service';
import { QbittorrentService } from './qbittorrent.service';
import { SourceSearchService } from './source-search.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([PlaybackSession, Group, GroupUserMap]),
    MediaSourceModule,
  ],
  controllers: [PlaybackController],
  providers: [PlaybackService, QbittorrentService, SourceSearchService],
  exports: [PlaybackService],
})
export class PlaybackModule {}
