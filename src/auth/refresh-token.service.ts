import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomUUID } from 'crypto';
import { LessThan, Repository } from 'typeorm';
import { jwtConfig } from 'src/core/config/config';
import { User } from 'src/user/entities/user.entity';
import { RefreshToken } from './entities/refresh-token.entity';

/** 轮换结果：新 token + 记录 id，供上层回填 replaced_by */
export type IssuedRefreshToken = {
  token: string;
  recordId: string;
  userId: string;
  expiresAt: Date;
};

/**
 * refreshToken 签发 / 轮换 / 吊销。
 * 库里只存 sha256(jwt)，明文只在登录与刷新响应里出现一次。
 */
@Injectable()
export class RefreshTokenService {
  private readonly logger = new Logger(RefreshTokenService.name);

  constructor(
    private readonly jwtService: JwtService,
    @InjectRepository(RefreshToken)
    private readonly repository: Repository<RefreshToken>,
  ) {}

  /** 签发一枚新的 refreshToken 并落库；replacesId 为轮换时作废的旧记录 */
  async issue(
    user: User,
    opts?: { replacesId?: string; userAgent?: string },
  ): Promise<IssuedRefreshToken> {
    const recordId = randomUUID();
    const expiresAt = new Date(
      Date.now() + jwtConfig.refreshExpiresInSec * 1000,
    );
    const token = this.jwtService.sign(
      {
        sub: user.user_id,
        user_id: user.user_id,
        username: user.username,
        typ: 'refresh',
        jti: recordId,
      },
      {
        secret: jwtConfig.refreshSecret,
        expiresIn: jwtConfig.refreshExpiresIn,
      },
    );

    await this.repository.save(
      this.repository.create({
        id: recordId,
        user_id: user.user_id,
        token_hash: this.hash(token),
        expires_at: expiresAt,
        revoked: 0,
        replaced_by: '',
        user_agent: (opts?.userAgent || '').slice(0, 255),
        last_used_at: null,
      }),
    );

    if (opts?.replacesId) {
      await this.repository.update(opts.replacesId, { replaced_by: recordId });
    }
    return { token, recordId, userId: user.user_id, expiresAt };
  }

  /**
   * 校验并原子消费一枚 refreshToken（轮换的第一步）。
   * 返回其所属用户与记录 id；调用方随后 issue(..., { replacesId }) 完成轮换。
   */
  async consume(token: string): Promise<{ userId: string; recordId: string }> {
    const payload = this.verify(token);
    const record = await this.repository.findOne({
      where: { id: payload.jti },
    });
    if (!record || record.token_hash !== this.hash(token)) {
      throw new UnauthorizedException('登录状态无效，请重新登录');
    }
    if (record.revoked) {
      // 已作废的 token 再次出现 = 疑似被复制使用，整户吊销
      await this.revokeAllForUser(record.user_id);
      this.logger.warn(
        `检测到 refreshToken 复用，已吊销用户全部会话 user_id=${record.user_id}`,
      );
      throw new UnauthorizedException('登录状态异常，请重新登录');
    }
    if (new Date(record.expires_at).getTime() <= Date.now()) {
      await this.repository.delete(record.id);
      throw new UnauthorizedException('登录已过期，请重新登录');
    }

    // 条件更新做原子认领，避免同一 token 被并发使用两次
    const claimed = await this.repository
      .createQueryBuilder()
      .update(RefreshToken)
      .set({ revoked: 1, last_used_at: new Date() })
      .where('id = :id AND revoked = 0', { id: record.id })
      .execute();
    if (!claimed.affected) {
      await this.revokeAllForUser(record.user_id);
      throw new UnauthorizedException('登录状态异常，请重新登录');
    }
    return { userId: record.user_id, recordId: record.id };
  }

  /** 登出：作废单枚（best-effort，token 无效也不报错） */
  async revoke(token?: string): Promise<void> {
    if (!token) return;
    let jti: string | undefined;
    try {
      jti = this.verify(token, false).jti;
    } catch {
      jti = undefined;
    }
    if (jti) {
      await this.repository.update({ id: jti }, { revoked: 1 });
      return;
    }
    await this.repository.update(
      { token_hash: this.hash(token) },
      { revoked: 1 },
    );
  }

  /** 改密 / 风控：吊销该用户全部 refreshToken */
  async revokeAllForUser(userId: string): Promise<void> {
    await this.repository.update(
      { user_id: userId, revoked: 0 },
      { revoked: 1 },
    );
  }

  /** 清理过期记录（登录时顺带调用，避免表无限膨胀） */
  async purgeExpired(): Promise<void> {
    await this.repository.delete({
      expires_at: LessThan(new Date(Date.now() - 24 * 3600 * 1000)),
    });
  }

  /** 解析 refreshToken：默认要求未过期；登出路径可放宽到 ignoreExpiration */
  private verify(token: string, requireValid = true) {
    if (!token || typeof token !== 'string') {
      throw new UnauthorizedException('缺少 refreshToken');
    }
    try {
      const payload = this.jwtService.verify<{
        sub: string;
        user_id: string;
        typ?: string;
        jti: string;
      }>(token, {
        secret: jwtConfig.refreshSecret,
        ignoreExpiration: !requireValid,
      });
      if (payload.typ !== 'refresh') {
        throw new UnauthorizedException('token 类型不正确');
      }
      return payload;
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new UnauthorizedException('登录已过期，请重新登录');
    }
  }

  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
