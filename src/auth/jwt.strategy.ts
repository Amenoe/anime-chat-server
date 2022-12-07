import { UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { InjectRepository } from '@nestjs/typeorm';
import { StrategyOptions, Strategy, ExtractJwt } from 'passport-jwt';
import { jwtConfig } from 'src/core/config/config';
import { User } from 'src/user/entities/user.entity';
import { Repository } from 'typeorm';
import { AuthService } from './auth.service';

export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly authService: AuthService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(), //采用Bearer方案
      // ignoreExpiration: false, // 请求被拒默认返回401未经授权的错误码
      secretOrKey: jwtConfig.secret,
    } as StrategyOptions);
  }

  /**
   * jwt策略内置方法，用于验证token是否正确
   * @param user
   * @returns user
   */
  async validate(user: User) {
    const existUser = await this.userRepository.findOne({
      where: { user_id: user.user_id },
    });
    if (!existUser) {
      throw new UnauthorizedException('token不正确');
    }
    return existUser;
  }
}
