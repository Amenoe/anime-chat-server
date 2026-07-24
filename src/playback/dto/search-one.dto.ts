import { Type } from 'class-transformer';
import {
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Min,
  MinLength,
} from 'class-validator';

export class SearchOneDto {
  @IsString()
  @MinLength(1)
  factoryId: string;

  @IsString()
  @MinLength(1)
  name: string;

  @IsObject()
  searchConfig: Record<string, any>;

  @IsString()
  @MinLength(1)
  keyword: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  episodeSort: number;

  @IsOptional()
  @IsString()
  altKeyword?: string;

  @IsOptional()
  @IsString()
  subscriptionName?: string;
}
