import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { jwtConfig } from 'src/core/config/config';
import { User } from 'src/user/entities/user.entity';
import { UserService } from 'src/user/user.service';
import { RefreshTokenService } from './refresh-token.service';

/** 双 token 会话响应：token 为 accessToken 的兼容别名 */
export interface AuthSession {
  user_id: string;
  username: string;
  token: string;
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  /** accessToken 剩余有效秒数 */
  expiresIn: number;
  /** refreshToken 剩余有效秒数 */
  refreshExpiresIn: number;
  user: {
    user_id: string;
    username: string;
    nickname: string;
    avatar: string;
    role: string;
    status: number;
    create_time: Date;
  };
}

@Injectable()
export class AuthService {
  constructor(
    private jwtService: JwtService,
    private userService: UserService,
    private refreshTokenService: RefreshTokenService,
  ) {}

  /**
   * 本地身份策略登录：签发 accessToken(短时) + refreshToken(长时，落库可吊销)
   */
  async login(user: User, userAgent = ''): Promise<AuthSession> {
    /*
     * 封禁必须在**签发 token 之前**拦。
     * 只在 JwtStrategy 拦的话，被封的人会「登录成功但每个请求都 401」——
     * 界面拿到一个 token 却处处失败，用户完全无从理解发生了什么。
     * 这里拒绝，前端能直接展示「账号已被禁用」。
     */
    this.assertNotDisabled(user);

    await this.userService.updateStatus(user.user_id, { status: 1 });
    const fresh = await this.userService.findOne(user.user_id);

    await this.purgeExpiredQuietly();
    const issued = await this.refreshTokenService.issue(fresh, { userAgent });
    return this.buildSession(fresh, issued.token, issued.recordId);
  }

  /**
   * 刷新：校验并轮换 refreshToken，换回一对新 token
   */
  async refresh(refreshToken: string, userAgent = ''): Promise<AuthSession> {
    const { userId, recordId } = await this.refreshTokenService.consume(
      refreshToken,
    );
    const user = await this.userService.findOne(userId).catch(() => undefined);
    if (!user) {
      throw new UnauthorizedException('账号不存在或已注销');
    }

    /*
     * 第三个拦截点。封禁时虽然已经 `revokeAllForUser`，但那是「尽力而为」；
     * 这里再判一次，才是「被封的账号拿旧 refreshToken 也换不出新 token」的硬保证。
     * 顺手把该用户剩余会话一起吊销 —— 否则其它设备的 refreshToken 还能继续试。
     */
    if (user.disabled_at != null) {
      await this.refreshTokenService.revokeAllForUser(userId);
      this.assertNotDisabled(user);
    }

    const issued = await this.refreshTokenService.issue(user, {
      replacesId: recordId,
      userAgent,
    });
    return this.buildSession(user, issued.token, issued.recordId);
  }

  /**
   * 封禁判定的**唯一实现**（登录与刷新共用）。
   *
   * 抽出来是因为「是不是被封」这个判断散在两处迟早会漂移 ——
   * 一处漏判就是一个能登进去的口子。判定统一用 `!= null` 而不是真值：
   * `disabled_at` 是时间戳，语义是「有值即封禁」，写清楚比省两个字符重要。
   */
  private assertNotDisabled(user: User): void {
    if (user.disabled_at != null) {
      throw new UnauthorizedException(
        user.disabled_reason
          ? `账号已被禁用：${user.disabled_reason}`
          : '账号已被禁用',
      );
    }
  }

  /** 登出：吊销本次会话的 refreshToken（accessToken 自然过期） */
  async logout(refreshToken?: string): Promise<{ revoked: boolean }> {
    if (!refreshToken) {
      return { revoked: false };
    }
    await this.refreshTokenService.revoke(refreshToken);
    return { revoked: true };
  }

  /** 改密等敏感操作后调用：踢掉该用户所有登录设备 */
  async revokeAllSessions(userId: string): Promise<void> {
    await this.refreshTokenService.revokeAllForUser(userId);
  }

  /**
   * 组装会话响应。
   * accessToken 带 jti = refreshToken 记录 id：既保证同一秒内重复签发也是不同 token，
   * 也让 accessToken 可回溯到具体会话，便于审计与定位。
   */
  private async buildSession(
    user: User,
    refreshToken: string,
    sessionId?: string,
  ) {
    const accessToken = this.jwtService.sign(
      {
        user_id: user.user_id,
        username: user.username,
        typ: 'access',
        ...(sessionId ? { jti: sessionId } : {}),
      },
      {
        secret: jwtConfig.secret,
        expiresIn: jwtConfig.accessExpiresIn,
      },
    );

    const session: AuthSession = {
      user_id: user.user_id,
      username: user.username,
      token: accessToken,
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: jwtConfig.accessExpiresInSec,
      refreshExpiresIn: jwtConfig.refreshExpiresInSec,
      user: {
        user_id: user.user_id,
        username: user.username,
        nickname: user.nickname,
        avatar: user.avatar,
        role: user.role,
        status: user.status,
        create_time: user.create_time,
      },
    };
    return session;
  }

  private async purgeExpiredQuietly() {
    try {
      await this.refreshTokenService.purgeExpired();
    } catch {
      // 清理失败不影响登录
    }
  }
}
