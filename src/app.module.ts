import { Module } from '@nestjs/common';
import { UserModule } from './user/user.module';
import { GroupModule } from './group/group.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AnimeModule } from './anime/anime.module';
import { AuthModule } from './auth/auth.module';
import { DBConifg } from './core/config/config';
import { ChatModule } from './chat/chat.module';
import { UserAnimeModule } from './user-anime/user-anime.module';
import { StorageModule } from './storage/storage.module';

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
    AnimeModule,
    AuthModule,
    ChatModule,
    UserAnimeModule,
  ],
})
export class AppModule {}
