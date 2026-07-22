import { IsInt, IsOptional, IsString, Min, MinLength } from 'class-validator';

export class CreatePlaybackDto {
  /** magnet:?xt=... 或 http(s)://.../*.torrent */
  @IsString()
  @MinLength(10)
  uri: string;

  @IsOptional()
  @IsInt()
  bangumiId?: number;

  @IsOptional()
  episodeSort?: number;

  /** 多文件种子时指定文件序号；不传则自动选最大视频文件 */
  @IsOptional()
  @IsInt()
  @Min(0)
  fileIndex?: number;
}
