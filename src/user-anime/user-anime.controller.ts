import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { CreateUserAnimeDto } from './dto/create-user-anime.dto';
import { UpdateUserAnimeDto } from './dto/update-user-anime.dto';
import { UserAnimeStatus } from './entities/user-anime.entity';
import { UserAnimeService } from './user-anime.service';

@Controller('user-anime')
@UseGuards(AuthGuard('jwt'))
export class UserAnimeController {
  constructor(private readonly userAnimeService: UserAnimeService) {}

  @Post()
  upsert(@Req() req, @Body() dto: CreateUserAnimeDto) {
    return this.userAnimeService.upsert(req.user.user_id, dto);
  }

  @Get()
  list(@Req() req, @Query('status') status?: UserAnimeStatus) {
    const allowed: UserAnimeStatus[] = ['wish', 'watching', 'done'];
    const filter =
      status && allowed.includes(status as UserAnimeStatus)
        ? (status as UserAnimeStatus)
        : undefined;
    return this.userAnimeService.list(req.user.user_id, filter);
  }

  @Get(':bangumiId')
  findOne(@Req() req, @Param('bangumiId', ParseIntPipe) bangumiId: number) {
    return this.userAnimeService.findOne(req.user.user_id, bangumiId);
  }

  @Patch(':bangumiId')
  update(
    @Req() req,
    @Param('bangumiId', ParseIntPipe) bangumiId: number,
    @Body() dto: UpdateUserAnimeDto,
  ) {
    return this.userAnimeService.update(req.user.user_id, bangumiId, dto);
  }

  @Delete(':bangumiId')
  remove(@Req() req, @Param('bangumiId', ParseIntPipe) bangumiId: number) {
    return this.userAnimeService.remove(req.user.user_id, bangumiId);
  }
}
