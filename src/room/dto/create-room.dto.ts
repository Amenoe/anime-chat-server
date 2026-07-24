import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Min, MinLength } from 'class-validator';

export class CreateRoomDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  anime_id: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  episode_id?: number;

  @IsOptional()
  @Type(() => Number)
  episode_sort?: number;

  @IsOptional()
  @IsString()
  @MinLength(1)
  group_name?: string;
}
