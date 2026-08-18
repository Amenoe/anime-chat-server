import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Group } from '../group/entities/group.entity';
import { GroupMessage } from '../group/entities/group_message.entity';
import { GroupUserMap } from '../group/entities/group_user_map.entity';
import { CreateRoomDto } from './dto/create-room.dto';
import { generateSeasonId } from '../utils/id';

export interface PlaybackStateView {
  group_id: string;
  season_id: string;
  status: string;
  episode_id: number | null;
  episode_sort: number | null;
  session_id: string;
  stream_url: string | null;
  position: number;
  paused: boolean;
  title: string;
  host_user_id: string;
  server_time: number;
  updated_at: Date | null;
}

@Injectable()
export class RoomService {
  constructor(
    @InjectRepository(Group)
    private readonly groupRepository: Repository<Group>,
    @InjectRepository(GroupMessage)
    private readonly groupMessageRepository: Repository<GroupMessage>,
    @InjectRepository(GroupUserMap)
    private readonly groupUserMapRepository: Repository<GroupUserMap>,
  ) {}

  async createRoom(userId: string, dto: CreateRoomDto): Promise<Group> {
    const group = this.groupRepository.create({
      season_id: generateSeasonId(),
      host_user_id: userId,
      user_id: userId,
      anime_id: dto.anime_id,
      episode_id: dto.episode_id ?? null,
      episode_sort: dto.episode_sort ?? null,
      group_name:
        dto.group_name ??
        (dto.episode_sort != null
          ? `番剧 #${dto.anime_id} 第 ${dto.episode_sort} 话`
          : `番剧 #${dto.anime_id}`),
      playback_episode_id: dto.episode_id ?? null,
      playback_episode_sort: dto.episode_sort ?? null,
      playback_status: 'idle',
      create_time: String(Date.now()),
    });
    return this.groupRepository.save(group);
  }

  async listByAnime(animeId: number, episodeSort?: number): Promise<Group[]> {
    const qb = this.groupRepository
      .createQueryBuilder('g')
      .where('g.anime_id = :animeId', { animeId })
      .andWhere("g.season_id IS NOT NULL AND g.season_id != ''");
    if (episodeSort != null) {
      qb.andWhere('g.episode_sort = :episodeSort', { episodeSort });
    }
    return qb.getMany();
  }

  async findBySeasonId(seasonId: string): Promise<Group | null> {
    const group = await this.groupRepository.findOne({
      where: { season_id: seasonId },
    });
    return group ?? null;
  }

  toPlaybackState(group: Group): PlaybackStateView {
    return {
      group_id: group.group_id,
      season_id: group.season_id,
      status: group.playback_status,
      episode_id: group.playback_episode_id,
      episode_sort: group.playback_episode_sort,
      session_id: group.playback_session_id,
      stream_url: group.playback_stream_url,
      position: group.playback_position,
      paused: group.playback_status === 'paused',
      title: group.playback_title,
      host_user_id: group.host_user_id,
      server_time: Date.now(),
      updated_at: group.playback_updated_at,
    };
  }

  async updatePlayback(
    groupId: string,
    hostUserId: string,
    patch: Partial<
      Pick<
        Group,
        | 'playback_status'
        | 'playback_episode_id'
        | 'playback_episode_sort'
        | 'playback_session_id'
        | 'playback_stream_url'
        | 'playback_position'
        | 'playback_title'
      >
    >,
  ): Promise<Group> {
    const group = await this.groupRepository.findOne({
      where: { group_id: groupId },
    });
    if (!group) throw new NotFoundException('房间不存在');
    if (group.host_user_id !== hostUserId) {
      throw new ForbiddenException('只有房主可以控制播放');
    }
    Object.assign(group, patch, { playback_updated_at: new Date() });
    return this.groupRepository.save(group);
  }

  async transferHost(groupId: string, newHostUserId: string): Promise<Group> {
    const group = await this.groupRepository.findOne({
      where: { group_id: groupId },
    });
    if (!group) throw new NotFoundException('房间不存在');
    group.host_user_id = newHostUserId;
    return this.groupRepository.save(group);
  }

  async destroyRoom(groupId: string): Promise<void> {
    const messages = await this.groupMessageRepository.find({
      where: { group_id: groupId },
    });
    if (messages.length) {
      await this.groupMessageRepository.remove(messages);
    }

    const maps = await this.groupUserMapRepository.find({
      where: { group_id: groupId },
    });
    if (maps.length) {
      await this.groupUserMapRepository.remove(maps);
    }

    const group = await this.groupRepository.findOne({
      where: { group_id: groupId },
    });
    if (group) {
      await this.groupRepository.remove(group);
    }
  }
}
