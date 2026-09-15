import { IsNotEmpty, IsString } from 'class-validator';

/** POST /api/auth/refresh —— 用 refreshToken 换一对新 token */
export class RefreshDto {
  @IsNotEmpty({ message: '缺少 refreshToken' })
  @IsString()
  refreshToken: string;
}
