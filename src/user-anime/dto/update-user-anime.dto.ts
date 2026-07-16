import { IsEnum, IsOptional, IsString } from 'class-validator';

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
}
