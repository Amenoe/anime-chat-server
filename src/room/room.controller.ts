import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  NotFoundException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { RoomService } from './room.service';
import { CreateRoomDto } from './dto/create-room.dto';

@Controller('rooms')
@UseGuards(AuthGuard('jwt'))
export class RoomController {
  constructor(private readonly roomService: RoomService) {}

  @Get()
  async list(
    @Query('anime_id') animeId: string,
    @Query('episode_sort') episodeSort?: string,
  ) {
    const aid = Number(animeId);
    if (!aid) return [];
    const sort = episodeSort != null ? Number(episodeSort) : undefined;
    return this.roomService.listByAnime(aid, sort);
  }

  @Post()
  async create(@Req() req, @Body() dto: CreateRoomDto) {
    return this.roomService.createRoom(req.user.user_id, dto);
  }

  @Get('by-key/:seasonId')
  async getByKey(@Param('seasonId') seasonId: string) {
    const room = await this.roomService.findBySeasonId(seasonId);
    if (!room) throw new NotFoundException('房间不存在');
    return room;
  }
}
