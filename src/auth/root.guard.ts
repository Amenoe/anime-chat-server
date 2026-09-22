import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

/**
 * 仅 `role === 'root'` 可通行。
 *
 * **必须与 `AuthGuard('jwt')` 叠加使用**，顺序也是：
 * `@UseGuards(AuthGuard('jwt'), RootGuard)`。
 * 单独挂本守卫是不行的 —— 没有 JWT 守卫时 `req.user` 恒为 `undefined`，
 * 于是**连管理员都会被判成 403**。这个坑在本项目里真实踩过两次
 * （先是统计接口漏挂 JWT 守卫，后来是把它抄进新 controller 时又漏一次），
 * 所以现在抽成一个守卫：只要「挂错」这件事发生一次，就会立刻暴露，
 * 而不是靠每个 controller 各写一份 `assertRoot` 各漏各的。
 *
 * 为什么是 Guard 而不是拦截器/中间件：它要出现在 `@UseGuards` 里，
 * 与鉴权守卫并排，读代码时一眼能看出「这个接口要管理员」。
 */
@Injectable()
export class RootGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<{ user?: { role?: string } }>();
    if (req.user?.role !== 'root') {
      throw new ForbiddenException('仅管理员可访问');
    }
    return true;
  }
}
