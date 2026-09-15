import {
  Body,
  ClassSerializerInterceptor,
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { LogoutDto } from './dto/logout.dto';
import { RefreshDto } from './dto/refresh.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /** 登录：Local 策略校验账号密码，成功签发 accessToken + refreshToken */
  @UseGuards(AuthGuard('local'))
  @UseInterceptors(ClassSerializerInterceptor)
  @Post('login')
  async login(
    @Req() req,
    @Body() _body: LoginDto,
    @Headers('user-agent') userAgent?: string,
  ) {
    // req.user 来自 local.strategy；_body 走 ValidationPipe 约束字段
    return await this.authService.login(req.user, userAgent || '');
  }

  /** 刷新：用 refreshToken 换一对新 token（rotation，旧 refreshToken 立即作废） */
  @UseInterceptors(ClassSerializerInterceptor)
  @HttpCode(200)
  @Post('refresh')
  async refresh(
    @Body() body: RefreshDto,
    @Headers('user-agent') userAgent?: string,
  ) {
    return await this.authService.refresh(body.refreshToken, userAgent || '');
  }

  /** 登出：吊销 refreshToken，使其无法再刷新 */
  @HttpCode(200)
  @Post('logout')
  async logout(@Body() body: LogoutDto) {
    return await this.authService.logout(body?.refreshToken);
  }
}
