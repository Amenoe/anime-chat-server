import { Module } from '@nestjs/common';
import { DanmakuController } from './danmaku.controller';
import { DanmakuService } from './danmaku.service';

/**
 * 弹幕：dandanplay 开放平台的只读代理。
 *
 * 无数据库依赖、无实体 —— 弹幕本身不落库，靠 24h 内存缓存兜住重复请求。
 */
@Module({
  controllers: [DanmakuController],
  providers: [DanmakuService],
  exports: [DanmakuService],
})
export class DanmakuModule {}
