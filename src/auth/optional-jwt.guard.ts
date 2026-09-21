import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * 「带了 JWT 就解析出用户，没带也放行」的守卫。
 *
 * 埋点上报必须**匿名可用** —— 未登录用户的行为也要统计，
 * 否则拿不到「访客从哪一步流失」这类最有价值的数据。
 * 直接用 `AuthGuard('jwt')` 会因为缺 token 直接 401。
 *
 * 默认的 `handleRequest` 在 err/user 为空时会抛 UnauthorizedException，
 * 这里改成返回 `null`（不抛），控制器再按 `req.user?.user_id` 决定归属。
 */
@Injectable()
export class OptionalJwtGuard extends AuthGuard('jwt') {
  handleRequest<TUser = unknown>(_err: unknown, user: TUser): TUser {
    return (user || null) as TUser;
  }
}
