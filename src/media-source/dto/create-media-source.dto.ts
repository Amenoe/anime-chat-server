import { IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';

export class CreateMediaSourceDto {
  @IsUrl({ require_protocol: true })
  @MaxLength(1024)
  url: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  name?: string;
}
