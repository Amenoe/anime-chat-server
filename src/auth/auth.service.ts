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
   * @returns user_id / username / token / user（无 password）
   */
  async login(user: User) {
    const token = this.jwtService.sign({
      user_id: user.user_id,
      username: user.username,
    });
    await this.userService.updateStatus(user.user_id, { status: 1 });

    const fresh = await this.userService.findOne(user.user_id);
    return {
      user_id: fresh.user_id,
      username: fresh.username,
      token,
      user: {
        user_id: fresh.user_id,
        username: fresh.username,
        nickname: fresh.nickname,
        avatar: fresh.avatar,
        role: fresh.role,
        status: fresh.status,
        create_time: fresh.create_time,
      },
    };
  }
}
