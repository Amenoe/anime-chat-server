import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { extname } from 'path';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { User } from './entities/user.entity';
import { MinioService } from '../storage/minio.service';
import { minioConfig } from '../core/config/config';

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
    private readonly minioService: MinioService,
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
      avatar: avatar || '',
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
   * 上传头像到 MinIO Private 桶。
   * DB 中存后端代理路径 /api/images/avatars/xxx，前端无需直连 MinIO。
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

    const filename = `${userId.slice(0, 8)}-${Date.now()}${ext}`;
    const objectName = `${minioConfig.avatarPrefix}/${filename}`;

    await this.minioService.putObject({
      objectName,
      buffer: file.buffer,
      contentType: file.mimetype,
    });

    // 尽量清理旧的 MinIO 头像（本地静态默认图不删）
    const old = exist.avatar || '';
    const marker = '/api/images/avatars/';
    if (old.startsWith(marker)) {
      const oldName = old.slice(marker.length).split('?')[0];
      if (oldName && oldName !== filename) {
        await this.minioService.removeObject(
          `${minioConfig.avatarPrefix}/${oldName}`,
        );
      }
    }

    const avatar = `/api/images/avatars/${filename}`;
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
