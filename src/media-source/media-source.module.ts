import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MediaSource } from './entities/media-source.entity';
import { MediaSourceController } from './media-source.controller';
import { MediaSourceService } from './media-source.service';

@Module({
  imports: [TypeOrmModule.forFeature([MediaSource])],
  controllers: [MediaSourceController],
  providers: [MediaSourceService],
  exports: [MediaSourceService],
})
export class MediaSourceModule {}
