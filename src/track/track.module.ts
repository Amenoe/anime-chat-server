import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TrackEvent } from './entities/track-event.entity';
import { TrackController } from './track.controller';
import { TrackService } from './track.service';

/**
 * 埋点模块。
 *
 * `@Global()`：埋点是**横切关注点** —— 任何业务模块（AI 网关、放映室、播放…）
 * 都可能要上报事件，逐个 import 只会让模块声明变噪音。
 * 与 `StorageModule` 用 `@Global()` 的理由一致。
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([TrackEvent])],
  controllers: [TrackController],
  providers: [TrackService],
  exports: [TrackService],
})
export class TrackModule {}
