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
  async validate(payload: { user_id: string; username: string }) {
    const existUser = await this.userRepository.findOne({
      where: { user_id: payload.user_id },
    });
    if (!existUser) {
      throw new UnauthorizedException('token不正确');
    }
    return existUser;
  }
}
