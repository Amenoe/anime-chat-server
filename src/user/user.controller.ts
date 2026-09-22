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
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

@Controller('user')
@UseInterceptors(ClassSerializerInterceptor)
export class UserController {
  constructor(private readonly userService: UserService) {}

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
   * 通过 id 删除用户
   */
  @UseGuards(AuthGuard('jwt'))
  @Delete(':id')
  delete(@Req() req, @Param('id') id: string) {
    if (id !== req.user.user_id && req.user.role !== 'root') {
      throw new ForbiddenException('只能删除自己的账号');
    }
    return this.userService.delete(id);
  }
}
