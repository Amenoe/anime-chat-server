import {
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  MinLength,
} from 'class-validator';

/** 流媒体直链播放（m3u8 / mp4 等） */
export class StreamPlaybackDto {
  @IsString()
  @IsUrl({ require_protocol: true })
  streamUrl: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  title?: string;

  /** 源站要求的 Referer / Cookie / User-Agent 等 */
  @IsOptional()
  @IsObject()
  headers?: Record<string, string>;

  @IsOptional()
  @IsInt()
  bangumiId?: number;

  @IsOptional()
  episodeSort?: number;
}
