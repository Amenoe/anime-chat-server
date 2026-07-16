import { BadRequestException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { InjectRepository } from '@nestjs/typeorm';
import { compareSync } from 'bcryptjs';
import { IStrategyOptions, Strategy } from 'passport-local';
import { User } from 'src/user/entities/user.entity';
import { Repository } from 'typeorm';

/**
 * 本地验证策略
 */
export class LocalStrategy extends PassportStrategy(Strategy) {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {
    super({
      usernameField: 'username',
      passwordField: 'password',
    } as IStrategyOptions);
  }

  /**
   * 校验用户名密码，通过后挂到 req.user
   */
  async validate(username: string, password: string) {
    const user = await this.userRepository
      .createQueryBuilder('user')
      .where('user.username=:username', { username })
      .getOne();

    if (!user) {
      throw new BadRequestException('不存在此用户');
    }

    if (!compareSync(password, user.password)) {
      throw new BadRequestException('密码错误');
    }
    return user;
  }
}
