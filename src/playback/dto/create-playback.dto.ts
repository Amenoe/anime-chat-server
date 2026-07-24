import { IsInt, IsOptional, IsString, Min, MinLength } from 'class-validator';

export class CreatePlaybackDto {
  /** magnet:?xt=... 或 http(s) 种子 / 直链 */
  @IsString()
  @MinLength(8)
  uri: string;

  @IsOptional()
  @IsInt()
  bangumiId?: number;

  @IsOptional()
  episodeSort?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  fileIndex?: number;
}
