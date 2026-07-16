import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { extname, join } from 'path';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { User } from './entities/user.entity';

/** multer 内存存储的文件形状（避免强依赖 @types/multer） */
export type UploadedAvatarFile = {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
};

const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const AVATAR_MIME = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
]);
const AVATAR_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
  ) {}

  async register(createUserDto: CreateUserDto) {
    const { username, password, nickname, avatar } = createUserDto;
    const existUser = await this.userRepository.findOne({
      where: { username },
    });
    if (existUser) {
      throw new HttpException('用户名已存在', HttpStatus.BAD_REQUEST);
    }

    const newUser = this.userRepository.create({
      username,
      password,
      nickname,
      avatar: avatar || '/api/images/avatar(1).png',
      role: 'user',
      status: 0,
    });

    try {
      const data = await this.userRepository.save(newUser);
      return data;
    } catch (error) {
      throw new HttpException('服务器出错', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  async findAll() {
    return await this.userRepository.find();
  }

  async findOne(id: string) {
    const data = await this.userRepository.findOne({
      where: { user_id: id },
    });
    if (!data) {
      throw new HttpException('该用户不存在', HttpStatus.BAD_REQUEST);
    }
    return data;
  }

  async update(id: string, update: UpdateUserDto) {
    const exist = await this.userRepository.findOne({ where: { user_id: id } });
    if (!exist) {
      throw new BadRequestException('用户不存在');
    }

    const patch: Partial<User> = {};
    if (update.nickname !== undefined) patch.nickname = update.nickname;
    if (update.avatar !== undefined) patch.avatar = update.avatar;
    if (update.status !== undefined) patch.status = update.status;
    // 仅在显式传 password 时 hash，避免二次加密
    if (update.password) {
      patch.password = bcrypt.hashSync(update.password, 10);
    }

    if (Object.keys(patch).length === 0) {
      throw new BadRequestException('没有可更新的字段');
    }

    const result = await this.userRepository.update(id, patch);
    if (result.affected === 0) {
      throw new BadRequestException('更新失败');
    }
    return await this.findOne(id);
  }

  async updateStatus(id: string, update: UpdateUserDto) {
    if (update.status === undefined) {
      throw new BadRequestException('status 不能为空');
    }
    const result = await this.userRepository.update(id, {
      status: update.status,
    });
    if (result.affected === 0) {
      throw new BadRequestException('更新失败');
    }
    return result;
  }

  /**
   * 上传头像：落盘到 public/images/uploads，avatar 存可访问 URL
   */
  async uploadAvatar(userId: string, file?: UploadedAvatarFile) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('请选择头像文件');
    }
    if (file.size > AVATAR_MAX_BYTES) {
      throw new BadRequestException('头像不能超过 2MB');
    }
    if (!AVATAR_MIME.has(file.mimetype)) {
      throw new BadRequestException('仅支持 jpg/png/gif/webp 图片');
    }

    let ext = extname(file.originalname || '').toLowerCase();
    if (!AVATAR_EXT.has(ext)) {
      // 从 mime 推断扩展名
      const map: Record<string, string> = {
        'image/jpeg': '.jpg',
        'image/jpg': '.jpg',
        'image/png': '.png',
        'image/gif': '.gif',
        'image/webp': '.webp',
      };
      ext = map[file.mimetype] || '.png';
    }

    const exist = await this.userRepository.findOne({
      where: { user_id: userId },
    });
    if (!exist) {
      throw new BadRequestException('用户不存在');
    }

    const uploadDir = join(
      process.cwd(),
      'src',
      'public',
      'images',
      'uploads',
    );
    if (!existsSync(uploadDir)) {
      mkdirSync(uploadDir, { recursive: true });
    }

    const filename = `${userId.slice(0, 8)}-${Date.now()}${ext}`;
    writeFileSync(join(uploadDir, filename), file.buffer);

    const avatar = `/api/images/uploads/${filename}`;
    await this.userRepository.update(userId, { avatar });
    return await this.findOne(userId);
  }

  async delete(id: string) {
    const result = await this.userRepository.delete(id);
    if (result.affected === 0) {
      throw new BadRequestException('删除失败');
    }
    return result;
  }
}
