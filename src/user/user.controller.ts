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

  @UseGuards(AuthGuard('jwt'))
  @Get()
  findAll() {
    return this.userService.findAll();
  }

  /**
   * 修改用户在线状态（路由须在 :id 之前）
   */
  @UseGuards(AuthGuard('jwt'))
  @Patch('status/:id')
  updateStatus(@Param('id') id: string, @Body() updateUserDto: UpdateUserDto) {
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
  update(@Param('id') id: string, @Body() updateUserDto: UpdateUserDto) {
    return this.userService.update(id, updateUserDto);
  }

  /**
   * 通过 id 删除用户
   */
  @UseGuards(AuthGuard('jwt'))
  @Delete(':id')
  delete(@Param('id') id: string) {
    return this.userService.delete(id);
  }
}
