import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { DanmakuService } from './danmaku.service';

/**
 * 弹幕代理。
 *
 * 为什么要有这层：dandanplay 用 AppSecret 签名，Secret 不能下发到浏览器。
 *
 * 为什么挂鉴权：弹幕请求会消耗我们申请的调用配额，匿名开放等于把配额公开。
 */
@Controller('danmaku')
@UseGuards(AuthGuard('jwt'))
export class DanmakuController {
  constructor(private readonly danmaku: DanmakuService) {}

  /**
   * 按番剧名 + 集号取弹幕。
   *
   * 用「标题 + 集号」而不是 bangumi_id：dandanplay 的 id 体系与 Bangumi 不同源，
   * 只能靠标题搜索匹配，匹配结果会一并返回，便于前端提示「匹配到的是哪部」。
   */
  @Get()
  fetch(
    @Query('title') title: string,
    @Query('episode', ParseIntPipe) episode: number,
  ) {
    return this.danmaku.fetch(title ?? '', episode);
  }

  /** 按 dandanplay 的 episodeId 直接取（前端已有 id 时省一次搜索） */
  @Get(':episodeId')
  fetchById(@Param('episodeId', ParseIntPipe) episodeId: number) {
    return this.danmaku.fetchByEpisodeId(episodeId);
  }
}
