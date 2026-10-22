import { IsEnum, IsInt, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class UpdateUserAnimeDto {
  @IsOptional()
  @IsEnum(['wish', 'watching', 'done'], {
    message: 'status 必须是 wish / watching / done',
  })
  status?: 'wish' | 'watching' | 'done';

  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  name_cn?: string;

  @IsOptional()
  @IsString()
  cover?: string;
  /** 看到第几集（Bangumi sort），播放页上报 */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  watched_episode?: number;

  /** 总集数，追番时从详情带上；0 表示未知 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  total_episodes?: number;
}
