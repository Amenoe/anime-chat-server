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
import { createReadStream } from 'fs';
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
    @Query('token') token: string | undefined,
    @Query('format') format: string | undefined,
    @Res() res: Response,
  ) {
    try {
      const accessToken =
        token ||
        (typeof req.headers.authorization === 'string'
          ? req.headers.authorization.replace(/^Bearer\s+/i, '')
          : undefined);
      const result = await this.playbackService.openStream(
        id,
        req.user.user_id,
        range,
        {
          accessToken,
          // ?format=fmp4：强制走 ffmpeg（mkv/HEVC），前端在 remuxRequired 时带
          forceTranscode: format === 'fmp4' || format === 'mp4',
        },
      );
      await this.pipeStreamResult(res, result);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[playback.stream] failed', e);
      const msg = e instanceof Error ? e.message : 'stream error';
      if (e instanceof BadRequestException) throw e;
      throw new BadRequestException(msg || '播放失败');
    }
  }

  /** 当前会话的内嵌字幕轨（供播放器列字幕菜单） */
  @Get('sessions/:id/subtitles')
  subtitles(@Req() req, @Param('id') id: string) {
    return this.playbackService.getSubtitleTracks(id, req.user.user_id);
  }

  /**
   * 内嵌字幕转 WebVTT。
   * `<track>` 无法带 Authorization 头，所以和 stream 一样支持 ?token=。
   */
  @Get('sessions/:id/subtitle/:track')
  async subtitle(
    @Req() req,
    @Param('id') id: string,
    @Param('track') track: string,
    @Res() res: Response,
  ) {
    const n = Number(String(track).replace(/\.vtt$/i, ''));
    const vtt = await this.playbackService.getSubtitleVtt(
      id,
      req.user.user_id,
      n,
    );
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(vtt);
  }

  /**
   * mkv/HEVC 的 HLS 播放列表：整条 VOD playlist（全部 EXTINF + ENDLIST），
   * 播放器因此能显示真实总时长并允许拖动进度。
   */
  @Get('sessions/:id/hls.m3u8')
  async hlsPlaylist(
    @Req() req,
    @Param('id') id: string,
    @Query('token') token: string | undefined,
    @Res() res: Response,
  ) {
    const accessToken =
      token ||
      (typeof req.headers.authorization === 'string'
        ? req.headers.authorization.replace(/^Bearer\s+/i, '')
        : undefined);
    const playlist = await this.playbackService.getHlsPlaylist(
      id,
      req.user.user_id,
      accessToken,
    );
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-store');
    res.send(playlist);
  }

  /** 单个 HLS 分片（首次请求触发转码，之后命中缓存） */
  @Get('sessions/:id/hls/:index')
  async hlsSegment(
    @Req() req,
    @Param('id') id: string,
    @Param('index') index: string,
    @Res() res: Response,
  ) {
    const n = Number(String(index).replace(/\.ts$/i, ''));
    const seg = await this.playbackService.getHlsSegment(
      id,
      req.user.user_id,
      n,
    );
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Content-Length', String(seg.size));
    res.setHeader('Cache-Control', 'private, max-age=3600');
    createReadStream(seg.path).pipe(res);
  }

  /**
   * HLS 分片 / enc.key / 嵌套 m3u8 同源代理（由 stream 改写后的 playlist 引用）
   */
  @Get('sessions/:id/asset')
  async asset(
    @Req() req,
    @Param('id') id: string,
    @Query('url') url: string,
    @Query('token') token: string | undefined,
    @Headers('range') range: string | undefined,
    @Res() res: Response,
  ) {
    if (!url?.trim()) {
      throw new BadRequestException('url 必填');
    }
    try {
      const accessToken =
        token ||
        (typeof req.headers.authorization === 'string'
          ? req.headers.authorization.replace(/^Bearer\s+/i, '')
          : undefined);
      const result = await this.playbackService.openRemoteAsset(
        id,
        req.user.user_id,
        url,
        range,
        { accessToken },
      );
      await this.pipeStreamResult(res, result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'asset error';
      if (e instanceof BadRequestException) throw e;
      throw new BadRequestException(msg);
    }
  }

  private async pipeStreamResult(
    res: Response,
    result: {
      stream: NodeJS.ReadableStream;
      contentType: string;
      size: number;
      start: number;
      end: number;
      partial: boolean;
    },
  ) {
    const { stream, contentType, size, start, end, partial } = result;

    res.setHeader('Content-Type', contentType);
    // 转封装流（size=0）是从头生成的 fMP4，不接受 Range，别让浏览器误以为能 seek
    if (size > 0) res.setHeader('Accept-Ranges', 'bytes');
    else res.setHeader('Accept-Ranges', 'none');
    res.setHeader('Cache-Control', 'no-store');
    // 转码/转封装耗时不固定，关掉中间层缓冲，让首帧尽快出来
    res.setHeader('X-Accel-Buffering', 'no');

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
  }
}
