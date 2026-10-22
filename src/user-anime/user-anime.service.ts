import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateUserAnimeDto } from './dto/create-user-anime.dto';
import { UpdateUserAnimeDto } from './dto/update-user-anime.dto';
import { UserAnime, UserAnimeStatus } from './entities/user-anime.entity';

@Injectable()
export class UserAnimeService {
  constructor(
    @InjectRepository(UserAnime)
    private readonly userAnimeRepo: Repository<UserAnime>,
  ) {}

  /** 新增或覆盖状态（upsert） */
  async upsert(userId: string, dto: CreateUserAnimeDto) {
    let row = await this.userAnimeRepo.findOne({
      where: { user_id: userId, bangumi_id: dto.bangumi_id },
    });

    if (row) {
      row.status = dto.status;
      if (dto.title !== undefined) row.title = dto.title;
      if (dto.name_cn !== undefined) row.name_cn = dto.name_cn;
      if (dto.cover !== undefined) row.cover = dto.cover;
      // 总集数只在明确给了非零值时才覆盖，避免二次收藏把已知的集数抹成 0
      if (dto.total_episodes !== undefined && dto.total_episodes > 0) {
        row.total_episodes = dto.total_episodes;
      }
      // 进度取较大值：重新收藏不该把「已经看到第 8 集」退回到 0
      if (dto.watched_episode !== undefined && dto.watched_episode > row.watched_episode) {
        row.watched_episode = dto.watched_episode;
      }
    } else {
      row = this.userAnimeRepo.create({
        user_id: userId,
        bangumi_id: dto.bangumi_id,
        status: dto.status,
        title: dto.title ?? null,
        name_cn: dto.name_cn ?? null,
        cover: dto.cover ?? null,
        watched_episode: dto.watched_episode ?? 0,
        total_episodes: dto.total_episodes ?? 0,
      });
    }

    return await this.userAnimeRepo.save(row);
  }

  async update(userId: string, bangumiId: number, dto: UpdateUserAnimeDto) {
    const row = await this.userAnimeRepo.findOne({
      where: { user_id: userId, bangumi_id: bangumiId },
    });
    if (!row) {
      throw new NotFoundException('未找到该追番记录');
    }

    if (dto.status !== undefined) row.status = dto.status;
    if (dto.title !== undefined) row.title = dto.title;
    if (dto.name_cn !== undefined) row.name_cn = dto.name_cn;
    if (dto.cover !== undefined) row.cover = dto.cover;
    if (dto.total_episodes !== undefined && dto.total_episodes > 0) {
      row.total_episodes = dto.total_episodes;
    }
    // **重看不影响进度**：取较大值。
    // 用户在放映室或播放页重看旧集时，不该把「已经看到第 20 话」退回第 3 话。
    if (dto.watched_episode !== undefined && dto.watched_episode > row.watched_episode) {
      row.watched_episode = dto.watched_episode;
    }

    // 注意：这里必须与上面实际赋值的字段**保持同步**，
    // 否则只传新字段（如播放页只上报 watched_episode）会被误判成「空更新」退回 400。
    if (
      dto.status === undefined &&
      dto.title === undefined &&
      dto.name_cn === undefined &&
      dto.cover === undefined &&
      dto.watched_episode === undefined &&
      dto.total_episodes === undefined
    ) {
      throw new BadRequestException('没有可更新的字段');
    }

    return await this.userAnimeRepo.save(row);
  }

  async remove(userId: string, bangumiId: number) {
    const result = await this.userAnimeRepo.delete({
      user_id: userId,
      bangumi_id: bangumiId,
    });
    if (!result.affected) {
      throw new NotFoundException('未找到该追番记录');
    }
    return { affected: result.affected };
  }

  async list(userId: string, status?: UserAnimeStatus) {
    const where: { user_id: string; status?: UserAnimeStatus } = {
      user_id: userId,
    };
    if (status) {
      where.status = status;
    }
    return await this.userAnimeRepo.find({
      where,
      order: { update_time: 'DESC' },
    });
  }

  /** 无记录返回 null（契约约定） */
  async findOne(userId: string, bangumiId: number) {
    const row = await this.userAnimeRepo.findOne({
      where: { user_id: userId, bangumi_id: bangumiId },
    });
    return row ?? null;
  }
}
