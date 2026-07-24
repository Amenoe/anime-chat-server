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
import { StreamPlaybackDto } from './dto/stream-playback.dto';
import { SearchOneDto } from './dto/search-one.dto';
import { PlaybackService } from './playback.service';

@Controller('playback')
@UseGuards(AuthGuard('jwt'))
export class PlaybackController {
  constructor(private readonly playbackService: PlaybackService) {}

  /** BT：magnet / torrent URL */
  @Post('sessions')
  create(@Req() req, @Body() dto: CreatePlaybackDto) {
    return this.playbackService.create(req.user.user_id, dto);
  }

  /** 流媒体直链（m3u8 / mp4） */
  @Post('sessions/stream')
  createStream(@Req() req, @Body() dto: StreamPlaybackDto) {
    return this.playbackService.createFromStream(req.user.user_id, dto);
  }

  /**
   * 一键：数据源搜索 → 优先流媒体直链，否则 BT
   */
  @Post('sessions/auto')
  createAuto(@Req() req, @Body() dto: AutoPlaybackDto) {
    return this.playbackService.createFromEpisode(req.user.user_id, dto);
  }

  /**
   * 搜索用户启用的数据源（css 流媒体 + bt RSS）
   */
  @Get('search')
  search(
    @Req() req,
    @Query('keyword') keyword: string,
    @Query('episodeSort') episodeSort: string,
    @Query('altKeyword') altKeyword?: string,
  ) {
    const ep = Number(episodeSort);
    if (!keyword?.trim() || Number.isNaN(ep)) {
      throw new BadRequestException('keyword 与 episodeSort 必填');
    }
    return this.playbackService.searchSources(
      req.user.user_id,
      keyword.trim(),
      ep,
      altKeyword?.trim(),
    );
  }

  /** 单站点搜索（播放抽屉逐源状态） */
  @Post('search-one')
  searchOne(@Req() req, @Body() dto: SearchOneDto) {
    return this.playbackService.searchOneSource(req.user.user_id, dto);
  }

  /** @deprecated 兼容旧路径 → 同 search */
  @Get('magnets')
  magnets(
    @Req() req,
    @Query('keyword') keyword: string,
    @Query('episodeSort') episodeSort: string,
    @Query('altKeyword') altKeyword?: string,
  ) {
    return this.search(req, keyword, episodeSort, altKeyword);
  }

  @Get('sessions/:id')
  getOne(@Req() req, @Param('id') id: string) {
    return this.playbackService.getSession(id, req.user.user_id);
  }

  @Get('health/qb')
  qbHealth() {
    return this.playbackService.qbHealth();
  }

  @Get('sessions/:id/files')
  files(@Req() req, @Param('id') id: string) {
    return this.playbackService.listFiles(id, req.user.user_id);
  }

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
        if (size > 0) {
          res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
        }
        if (end >= start) {
          res.setHeader('Content-Length', String(end - start + 1));
        }
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
      if (e instanceof BadRequestException) throw e;
      throw new BadRequestException(msg);
    }
  }
}
