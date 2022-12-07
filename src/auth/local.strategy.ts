import { BadRequestException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { InjectRepository } from '@nestjs/typeorm';
import { compareSync } from 'bcryptjs';
import { IStrategyOptions, Strategy } from 'passport-local';
import { User } from 'src/user/entities/user.entity';
import { Repository } from 'typeorm';

/**
 * 本地验证策略代码
 * PassportStrategy(策略,策略别名)
 * super 传递策略参数
 */
export class LocalStrategy extends PassportStrategy(Strategy) {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {
    // 如果不是username、password， 在constructor中配置
    super({
      usernameField: 'username',
      passwordField: 'password',
    } as IStrategyOptions);
  }

  /**
   * 本地身份策略内置方法，用于校验用户
   * @param username
   * @param password
   * @returns user对象到Req中
   */
  async validate(username: string, password: string) {
    console.log(username, password);
    const user = await this.userRepository
      .createQueryBuilder('user')
      // .addSelect('user.password') //查询隐藏列
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
