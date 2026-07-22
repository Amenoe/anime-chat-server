import {
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  MinLength,
} from 'class-validator';

/** 按番名+集数自动搜磁力并创建播放会话 */
export class AutoPlaybackDto {
  /** 主搜索关键词（一般为中文名） */
  @IsString()
  @MinLength(1)
  keyword: string;

  /** 集数（Bangumi sort / 第 n 话） */
  @IsNumber()
  @Min(0)
  episodeSort: number;

  @IsOptional()
  @IsInt()
  bangumiId?: number;

  /** 备用关键词（日文原名等） */
  @IsOptional()
  @IsString()
  altKeyword?: string;

  /** 多文件种子时指定文件序号（一般不用） */
  @IsOptional()
  @IsInt()
  @Min(0)
  fileIndex?: number;
}
