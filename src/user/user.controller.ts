import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  ClassSerializerInterceptor,
  UseInterceptors,
  UseGuards,
  Req,
  UploadedFile,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
// multer 为 @nestjs/platform-express 传递依赖；无 @types/multer 时用 require
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { memoryStorage } = require('multer') as {
  memoryStorage: () => unknown;
};
import { AuthGuard } from '@nestjs/passport';
import { UserService } from './user.service';
import { AccountCleanupService } from 'src/account/account-cleanup.service';
import { RefreshTokenService } from 'src/auth/refresh-token.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

@Controller('user')
@UseInterceptors(ClassSerializerInterceptor)
export class UserController {
  constructor(
    private readonly userService: UserService,
    private readonly accountCleanup: AccountCleanupService,
    private readonly refreshTokenService: RefreshTokenService,
  ) {}

  /**
   * 注册接口
   * @returns 用户信息(不包含密码)
   */
  @Post('register')
  register(@Body() createUserDto: CreateUserDto) {
    return this.userService.register(createUserDto);
  }

  /**
   * 上传头像（multipart field 名：file）
   * 须在 :id 路由前声明；memoryStorage 后由 service 上传到 MinIO
   */
  @UseGuards(AuthGuard('jwt'))
  @Post('avatar')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 2 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        const ok = [
          'image/jpeg',
          'image/jpg',
          'image/png',
          'image/gif',
          'image/webp',
        ].includes(file.mimetype);
        cb(
          ok ? null : new BadRequestException('仅支持 jpg/png/gif/webp 图片'),
          ok,
        );
      },
    }),
  )
  uploadAvatar(@Req() req, @UploadedFile() file) {
    if (!file) {
      throw new BadRequestException('请选择头像文件');
    }
    return this.userService.uploadAvatar(req.user.user_id, file);
  }

  // 这里原本有一个 `GET /api/user`（列出全表用户），已删除：
  // 它只要求「登录」而不要求 root，等于任何注册用户都能枚举全站账号
  // （含 username / nickname / role —— 连谁是管理员都暴露了），
  // 而前端全仓从未调用过它。管理端需要列表时走 `GET /api/admin/users`
  // （分页 + 关键词 + 字段白名单），不要在这里复活一个无分页的全量接口。

  /**
   * 修改用户在线状态（路由须在 :id 之前）
   */
  @UseGuards(AuthGuard('jwt'))
  @Patch('status/:id')
  updateStatus(
    @Req() req,
    @Param('id') id: string,
    @Body() updateUserDto: UpdateUserDto,
  ) {
    if (id !== req.user.user_id && req.user.role !== 'root') {
      throw new ForbiddenException('只能修改自己的在线状态');
    }
    return this.userService.updateStatus(id, updateUserDto);
  }

  @UseGuards(AuthGuard('jwt'))
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.userService.findOne(id);
  }

  /**
   * 通过 id 修改用户数据（昵称/密码/头像 URL）
   */
  @UseGuards(AuthGuard('jwt'))
  @Patch(':id')
  update(
    @Req() req,
    @Param('id') id: string,
    @Body() updateUserDto: UpdateUserDto,
  ) {
    if (id !== req.user.user_id && req.user.role !== 'root') {
      throw new ForbiddenException('只能修改自己的资料');
    }
    return this.userService.update(id, updateUserDto);
  }

  /**
   * 删除账号。
   *
   * 直接调 `AccountCleanupService.purge` 而**不是** `UserService.delete` ——
   * 后者原本只删 `user` 一行，留下 8 张表的孤儿数据。现在没有那个方法了：
   * 删号只有「级联清理」一种实现，两个入口（这里 + `AdminUserService.remove`）都调它，
   * 不存在「有个人调了那个裸删方法」的可能。
   */
  @UseGuards(AuthGuard('jwt'))
  @Delete(':id')
  async delete(@Req() req, @Param('id') id: string) {
    // 保持既有语义「本人或 root」不变 —— 本次只修孤儿数据，
    // 不顺带收紧权限（`DELETE /api/admin/users/:id` 是管理端的独立入口）
    if (id !== req.user.user_id && req.user.role !== 'root') {
      throw new ForbiddenException('只能删除自己的账号');
    }
    await this.accountCleanup.purge(id);
    // purge 已硬删 refresh_token；这里再吊销一次覆盖「purge 之后、响应之前」
    // 可能刚签发出来的会话（幂等，代价极低）
    await this.refreshTokenService.revokeAllForUser(id);
    return { deleted: true };
  }
}
