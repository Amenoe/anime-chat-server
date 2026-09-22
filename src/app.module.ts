import { Module } from '@nestjs/common';
import { UserModule } from './user/user.module';
import { GroupModule } from './group/group.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from './auth/auth.module';
import { DBConifg } from './core/config/config';
import { ChatModule } from './chat/chat.module';
import { UserAnimeModule } from './user-anime/user-anime.module';
import { StorageModule } from './storage/storage.module';
import { PlaybackModule } from './playback/playback.module';
import { MediaSourceModule } from './media-source/media-source.module';
import { RoomModule } from './room/room.module';
import { AiModule } from './ai/ai.module';
import { TrackModule } from './track/track.module';
import { AdminModule } from './admin/admin.module';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      ...DBConifg,
      autoLoadEntities: true, // forFeature() 注册的实体自动加载
      // 开发环境自动同步表结构；生产请改为 false 并走迁移/schema.sql
      synchronize: true,
    }),
    StorageModule,
    UserModule,
    GroupModule,
    // AnimeModule 已删除：`/api/anime` 全部端点无鉴权且写操作是脚手架桩，
    // 前端零调用、anime/anime_ep 两张表 0 行。`Anime` 实体保留给
    // chat.gateway 的旧 addGroup 路径（见 src/anime/entities/anime.entity.ts）。
    AuthModule,
    ChatModule,
    UserAnimeModule,
    MediaSourceModule,
    PlaybackModule,
    RoomModule,
    AiModule,
    TrackModule,
    AdminModule,
  ],
})
export class AppModule {}
