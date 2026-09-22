import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { RootGuard } from 'src/auth/root.guard';
import { AdminUserService, type AdminActor } from './admin-user.service';
import {
  BanUserDto,
  ChangeUserRoleDto,
  ListUsersQueryDto,
  ResetPasswordDto,
} from './dto/admin-user.dto';

/**
 * 管理端用户管理。
 *
 * ⚠️ **每个方法都必须挂 `@UseGuards(AuthGuard('jwt'), RootGuard)`，两个都挂、顺序不能换。**
 * 类级别的守卫不足以表达这一点时会很难查（漏一个方法就是一个提权/越权入口），
 * 所以这里刻意**逐个方法显式声明**，让漏挂的风险在 review 时肉眼可见。
 *
 * 所有写操作都会写审计（`admin_audit_log`），且审计失败会让操作一起失败 ——
 * 「不知道是谁提的权」比「这次操作没成功」严重得多。
 */
@Controller('admin/users')
export class AdminUserController {
  constructor(private readonly adminUserService: AdminUserService) {}

  @Get()
  @UseGuards(AuthGuard('jwt'), RootGuard)
  list(@Query() query: ListUsersQueryDto) {
    return this.adminUserService.list(query);
  }

  @Get('audit')
  @UseGuards(AuthGuard('jwt'), RootGuard)
  auditLogs(@Query('limit') limit?: string) {
    return this.adminUserService.auditLogs(Number(limit) || 50);
  }

  /*
   * 注意 `audit` 必须声明在 `:id` **之前**：Nest 按声明顺序匹配路由，
   * 反过来的话 `/admin/users/audit` 会被 `:id` 吃掉，然后报「用户不存在」。
   */
  @Get(':id')
  @UseGuards(AuthGuard('jwt'), RootGuard)
  detail(@Param('id') id: string) {
    return this.adminUserService.detail(id);
  }

  @Patch(':id/ban')
  @UseGuards(AuthGuard('jwt'), RootGuard)
  ban(@Req() req, @Param('id') id: string, @Body() dto: BanUserDto) {
    return this.adminUserService.setBanned(actorOf(req), id, dto);
  }

  @Patch(':id/role')
  @UseGuards(AuthGuard('jwt'), RootGuard)
  role(@Req() req, @Param('id') id: string, @Body() dto: ChangeUserRoleDto) {
    return this.adminUserService.setRole(actorOf(req), id, dto);
  }

  @Post(':id/password')
  @UseGuards(AuthGuard('jwt'), RootGuard)
  resetPassword(
    @Req() req,
    @Param('id') id: string,
    @Body() dto: ResetPasswordDto,
  ) {
    return this.adminUserService.resetPassword(actorOf(req), id, dto);
  }

  @Delete(':id')
  @UseGuards(AuthGuard('jwt'), RootGuard)
  remove(@Req() req, @Param('id') id: string) {
    return this.adminUserService.remove(actorOf(req), id);
  }
}

/**
 * 从请求里取操作者上下文。
 *
 * `username` 要落成**快照**存进审计表：操作者本人被删号后，
 * 审计记录仍要能读出「是谁干的」，不能靠 JOIN 现查。
 */
function actorOf(req: {
  user?: { user_id?: string; username?: string };
  ip?: string;
  headers?: Record<string, unknown>;
}): AdminActor {
  const ua = req.headers?.['user-agent'];
  return {
    userId: req.user?.user_id ?? '',
    username: req.user?.username ?? '',
    ip: req.ip ?? '',
    userAgent: typeof ua === 'string' ? ua : '',
  };
}
