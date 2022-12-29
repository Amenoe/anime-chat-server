import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { User } from 'src/user/entities/user.entity';
import { UserService } from 'src/user/user.service';

@Injectable()
export class AuthService {
  constructor(
    private jwtService: JwtService,
    private userService: UserService,
  ) {}

  /**
   * 本地身份策略登录
   * @param user
   * @returns 用户信息和token
   */
  async login(user: User) {
    //生成token
    const token = this.jwtService.sign({
      user_id: user.user_id,
      username: user.username,
    });
    this.userService.updateStatus(user.user_id, { status: 1 });
    return { user_id: user.user_id, username: user.username, token };
  }
}
