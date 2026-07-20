import {
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { Client } from 'minio';
import { minioConfig } from '../core/config/config';

export type PutObjectInput = {
  objectName: string;
  buffer: Buffer;
  contentType: string;
};

@Injectable()
export class MinioService implements OnModuleInit {
  private readonly logger = new Logger(MinioService.name);
  private readonly client: Client;
  private readonly bucket = minioConfig.bucket;

  constructor() {
    this.client = new Client({
      endPoint: minioConfig.endPoint,
      port: minioConfig.port,
      useSSL: minioConfig.useSSL,
      accessKey: minioConfig.accessKey,
      secretKey: minioConfig.secretKey,
    });
  }

  async onModuleInit() {
    try {
      const exists = await this.client.bucketExists(this.bucket);
      if (!exists) {
        await this.client.makeBucket(this.bucket, '');
        this.logger.log(`Created bucket: ${this.bucket}`);
      }
    } catch (error) {
      // 启动不阻断：上传时仍会再次报错，方便本地未起 MinIO 时先开发其它功能
      this.logger.warn(
        `MinIO init failed (${minioConfig.endPoint}:${minioConfig.port}/${
          this.bucket
        }): ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /** 上传对象到 Private 桶（需 Access Key，浏览器匿名不可读） */
  async putObject(input: PutObjectInput): Promise<string> {
    try {
      await this.client.putObject(
        this.bucket,
        input.objectName,
        input.buffer,
        input.buffer.length,
        { 'Content-Type': input.contentType },
      );
      return input.objectName;
    } catch (error) {
      this.logger.error(
        `putObject failed: ${error instanceof Error ? error.message : error}`,
      );
      throw new InternalServerErrorException('头像上传到对象存储失败');
    }
  }

  /** 后端代读 Private 对象流 */
  async getObjectStream(objectName: string) {
    try {
      return await this.client.getObject(this.bucket, objectName);
    } catch (error: any) {
      const code = error?.code || error?.name;
      if (code === 'NoSuchKey' || code === 'NotFound') {
        throw new NotFoundException('头像文件不存在');
      }
      this.logger.error(
        `getObject failed: ${error instanceof Error ? error.message : error}`,
      );
      throw new InternalServerErrorException('读取头像失败');
    }
  }

  async getObjectStat(objectName: string) {
    try {
      return await this.client.statObject(this.bucket, objectName);
    } catch (error: any) {
      const code = error?.code || error?.name;
      if (code === 'NoSuchKey' || code === 'NotFound') {
        throw new NotFoundException('头像文件不存在');
      }
      throw new InternalServerErrorException('读取头像元数据失败');
    }
  }

  /** 可选：删除旧头像对象 */
  async removeObject(objectName: string) {
    try {
      await this.client.removeObject(this.bucket, objectName);
    } catch (error) {
      this.logger.warn(
        `removeObject ignored: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  }
}
