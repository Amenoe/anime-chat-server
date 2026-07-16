import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { existsSync } from 'fs';
import { join } from 'path';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './core/filter/http-exception.filter';
import { TransformInterceptor } from './core/interceptor/transform.interceptor';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.setGlobalPrefix('api');

  // 优先服务源码 public（开发上传头像落盘路径），其次 dist/public
  const srcPublic = join(process.cwd(), 'src', 'public');
  const distPublic = join(__dirname, 'public');
  const publicDir = existsSync(srcPublic) ? srcPublic : distPublic;
  app.useStaticAssets(publicDir, {
    prefix: '/api',
  });

  // 全局参数校验（multipart 上传时跳过非 body 字段即可）
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new TransformInterceptor());
  app.enableCors();
  await app.listen(3000);
}
bootstrap();
