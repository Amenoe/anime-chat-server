import { Global, Module } from '@nestjs/common';
import { ImagesController } from './images.controller';
import { MinioService } from './minio.service';

@Global()
@Module({
  controllers: [ImagesController],
  providers: [MinioService],
  exports: [MinioService],
})
export class StorageModule {}
