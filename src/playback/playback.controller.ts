import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Response } from 'express';
import { CreatePlaybackDto } from './dto/create-playback.dto';
import { AutoPlaybackDto } from './dto/auto-playback.dto';
import { PlaybackService } from './playback.service';

@Controller('playback')
@UseGuards(AuthGuard('jwt'))
export class PlaybackController {
  constructor(private readonly playbackService: PlaybackService) {}

  /**
   * 创建播放会话：提交 magnet / torrent URL
   * 后端交 qBittorrent 下载，进度轮询后返回 playUrl
   */
  @Post('sessions')
  create(@Req() req, @Body() dto: CreatePlaybackDto) {
    return this.playbackService.create(req.user.user_id, dto);
  }

  /**
   * 一键：按番名+集数搜磁力并开始下载播放
   */
  @Post('sessions/auto')
  createAuto(@Req() req, @Body() dto: AutoPlaybackDto) {
    return this.playbackService.createFromEpisode(req.user.user_id, dto);
  }

  /** 仅搜索磁力列表（调试/手动挑选） */
  @Get('magnets')
  searchMagnets(
    @Query('keyword') keyword: string,
    @Query('episodeSort') episodeSort: string,
    @Query('altKeyword') altKeyword?: string,
  ) {
    const ep = Number(episodeSort);
    if (!keyword?.trim() || Number.isNaN(ep)) {
      throw new BadRequestException('keyword 与 episodeSort 必填');
    }
    return this.playbackService.searchMagnets(
      keyword.trim(),
      ep,
      altKeyword?.trim(),
    );
  }

  @Get('sessions/:id')
  getOne(@Req() req, @Param('id') id: string) {
    return this.playbackService.getSession(id, req.user.user_id);
  }

  /** qB 连通性（需登录 JWT） */
  @Get('health/qb')
  qbHealth() {
    return this.playbackService.qbHealth();
  }

  @Get('sessions/:id/files')
  files(@Req() req, @Param('id') id: string) {
    return this.playbackService.listFiles(id, req.user.user_id);
  }

  /**
   * 媒体流（支持 Range）。浏览器 / Artplayer 直接把此 URL 当 src。
   * 需 Authorization: Bearer <token>
   */
  @Get('sessions/:id/stream')
  async stream(
    @Req() req,
    @Param('id') id: string,
    @Headers('range') range: string | undefined,
    @Res() res: Response,
  ) {
    try {
      const result = await this.playbackService.openStream(
        id,
        req.user.user_id,
        range,
      );
      const { stream, contentType, size, start, end, partial } = result;

      res.setHeader('Content-Type', contentType);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'no-store');

      if (partial) {
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
        res.setHeader('Content-Length', String(end - start + 1));
      } else {
        res.status(200);
        if (size > 0) res.setHeader('Content-Length', String(size));
      }

      stream.on('error', () => {
        if (!res.headersSent) res.status(500).end();
        else res.end();
      });
      stream.pipe(res);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'stream error';
      if (e instanceof BadRequestException) {
        throw e;
      }
      throw new BadRequestException(msg);
    }
  }
}
