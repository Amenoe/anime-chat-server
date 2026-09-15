import { IsOptional, IsString } from 'class-validator';

/** POST /api/auth/logout —— 带上 refreshToken 才会真正吊销该条会话 */
export class LogoutDto {
  @IsOptional()
  @IsString()
  refreshToken?: string;
}
