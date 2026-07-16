import { IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';

/** ≥6 位，须含字母与数字 */
const PASSWORD_PATTERN = /^(?=.*[A-Za-z])(?=.*\d).{6,}$/;

export class CreateUserDto {
  @IsNotEmpty({ message: '用户名不能为空' })
  @IsString()
  @Matches(/^[A-Za-z0-9]{3,10}$/, {
    message: '用户名需为 3-10 位字母或数字',
  })
  username: string;

  @IsNotEmpty({ message: '密码不能为空' })
  @IsString()
  @Matches(PASSWORD_PATTERN, {
    message: '密码至少 6 位，须包含英文字母和数字',
  })
  password: string;

  @IsNotEmpty({ message: '昵称不能为空' })
  @IsString()
  @Matches(/^[a-zA-Z0-9一-龥]{1,10}$/, {
    message: '昵称需为 1-10 位中英文或数字',
  })
  nickname: string;

  @IsOptional()
  @IsString()
  avatar?: string;
}
