import { Transform, Type } from 'class-transformer';
import {
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class TrackEventsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  event?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  userId?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  cursor?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  @Type(() => Number)
  size = 50;

  @IsOptional()
  @Transform(({ value }) => value === '1' || value === 'true')
  includeProps = false;
}

export class AiConversationsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  userId?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  cursor?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  size = 50;
}
