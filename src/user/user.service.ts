import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { User } from './entities/user.entity';

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
  ) {}

  async register(createUserDto: CreateUserDto) {
    let data;
    const { username, role } = createUserDto;
    const existUser = await this.userRepository.findOne({
      where: { username },
    });
    const newUser = await this.userRepository.create(createUserDto);

    //错误判断
    if (existUser) {
      throw new HttpException('用户名已存在', HttpStatus.BAD_REQUEST);
    }
    if (role === 'root') {
      throw new HttpException('权限不足', HttpStatus.UNAUTHORIZED);
    }
    try {
      data = await this.userRepository.save(newUser);
    } catch (error) {
      throw new HttpException('服务器出错', HttpStatus.INTERNAL_SERVER_ERROR);
    }
    return data;
  }

  async findAll() {
    return await this.userRepository.find();
  }

  async findOne(id: string) {
    const data = await this.userRepository.findOne({
      where: { user_id: id },
    });
    if (data === undefined) {
      throw new HttpException('该用户不存在', HttpStatus.BAD_REQUEST);
    }
    return data;
  }

  async update(id: string, update: UpdateUserDto) {
    console.log(update);
    const newUser = await this.userRepository.create(update);
    const result = await this.userRepository.update(id, newUser);
    if (result.affected === 0) {
      throw new BadRequestException('更新失败');
    }
    const data = await this.userRepository.findOne({
      where: { user_id: id },
    });
    return data;
  }

  async updateStatus(id: string, update: UpdateUserDto) {
    const result = await this.userRepository.update(id, update);
    if (result.affected === 0) {
      throw new BadRequestException('更新失败');
    }
    return result;
  }

  async delete(id: string) {
    const result = await this.userRepository.delete(id);
    if (result.affected === 0) {
      throw new BadRequestException('删除失败');
    }
    return result;
  }
}
