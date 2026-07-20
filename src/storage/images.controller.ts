import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { MinioService } from './minio.service';
import { minioConfig } from '../core/config/config';

/**
 * 将 Private 桶中的头像代理给前端。
 * 前端仍使用 /api/images/avatars/... 路径，与旧本地静态资源兼容。
 */
@Controller('images')
export class ImagesController {
  constructor(private readonly minioService: MinioService) {}

  @Get('avatars/:filename')
  async getAvatar(@Param('filename') filename: string, @Res() res: Response) {
    // 防止路径穿越
    const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '');
    if (!safe) {
      throw new BadRequestException('无效的文件名');
    }
    const objectName = `${minioConfig.avatarPrefix}/${safe}`;
    const stat = await this.minioService.getObjectStat(objectName);
    const stream = await this.minioService.getObjectStream(objectName);

    res.setHeader(
      'Content-Type',
      (stat.metaData &&
        (stat.metaData['content-type'] || stat.metaData['Content-Type'])) ||
        'application/octet-stream',
    );
    res.setHeader('Cache-Control', 'public, max-age=86400');
    if (stat.size) {
      res.setHeader('Content-Length', String(stat.size));
    }
    stream.pipe(res);
  }
}
