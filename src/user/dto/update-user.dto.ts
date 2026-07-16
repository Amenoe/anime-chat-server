import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  ValidateIf,
} from 'class-validator';

/** ≥6 位，须含字母与数字（有值才校验） */
const PASSWORD_PATTERN = /^(?=.*[A-Za-z])(?=.*\d).{6,}$/;

/** 允许用户自改的字段（禁止改 username / role） */
export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @Matches(/^[a-zA-Z0-9一-龥]{1,10}$/, {
    message: '昵称需为 1-10 位中英文或数字',
  })
  nickname?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== undefined && v !== null && v !== '')
  @IsString()
  @Matches(PASSWORD_PATTERN, {
    message: '密码至少 6 位，须包含英文字母和数字',
  })
  password?: string;

  @IsOptional()
  @IsString()
  avatar?: string;

  /** 0 离线 / 1 在线 */
  @IsOptional()
  @IsNumber()
  @IsIn([0, 1], { message: 'status 必须是 0 或 1' })
  status?: number;
}
