import { Module } from '@nestjs/common';
import { UserModule } from './user/user.module';
import { GroupModule } from './group/group.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AnimeModule } from './anime/anime.module';
import { AnimeEpModule } from './anime-ep/anime-ep.module';
import { AuthModule } from './auth/auth.module';
import { DBConifg } from './core/config/config';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      ...DBConifg,
      autoLoadEntities: true, //如果为true,将自动加载实体 forFeature()方法注册的每个实体都将自动添加到配置对象的实体数组中
      // synchronize: true, //将实体同步到数据库
    }),
    UserModule,
    GroupModule,
    AnimeModule,
    AnimeEpModule,
    AuthModule,
  ],
})
export class AppModule {}
