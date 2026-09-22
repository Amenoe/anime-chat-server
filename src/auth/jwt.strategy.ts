import { UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { InjectRepository } from '@nestjs/typeorm';
import { StrategyOptions, Strategy, ExtractJwt } from 'passport-jwt';
import { jwtConfig } from 'src/core/config/config';
import { User } from 'src/user/entities/user.entity';
import { Repository } from 'typeorm';

export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {
    super({
      // 视频 <video>/hls 无法自定义 Header，允许 ?token= 传递 JWT
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        ExtractJwt.fromUrlQueryParameter('token'),
      ]),
      secretOrKey: jwtConfig.secret,
    } as StrategyOptions);
  }

  /** 校验 JWT payload 对应用户仍存在，挂到 req.user */
  async validate(payload: { user_id: string; username: string; typ?: string }) {
    // 只有 accessToken 能访问业务接口；refreshToken 仅限 POST /auth/refresh
    if (payload.typ === 'refresh') {
      throw new UnauthorizedException('token 类型不正确');
    }
    const existUser = await this.userRepository.findOne({
      where: { user_id: payload.user_id },
    });
    if (!existUser) {
      throw new UnauthorizedException('token不正确');
    }
    /*
     * 封禁在这里拦截 —— 这是「封禁即时生效」能低成本成立的关键。
     * 本方法**本来就每个请求查一次库**，所以在同一次查询上多判一个字段是免费的，
     * 不需要引入 accessToken 黑名单、也不需要为「可吊销」把 accessToken 落库。
     */
    if (existUser.disabled_at != null) {
      throw new UnauthorizedException(
        existUser.disabled_reason
          ? `账号已被禁用：${existUser.disabled_reason}`
          : '账号已被禁用',
      );
    }
    return existUser;
  }
}
