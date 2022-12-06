import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './core/filter/http-exception.filter';
import { TransformInterceptor } from './core/interceptor/transform.interceptor';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  //注册全局错误过滤器
  app.useGlobalFilters(new HttpExceptionFilter());
  //注册全局响应拦截器
  app.useGlobalInterceptors(new TransformInterceptor());
  //允许跨域
  app.enableCors();
  await app.listen(3000);
}
bootstrap();
