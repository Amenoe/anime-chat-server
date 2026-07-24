import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { CreateMediaSourceDto } from './dto/create-media-source.dto';
import { UpdateMediaSourceDto } from './dto/update-media-source.dto';
import { ReorderMediaSourceDto } from './dto/reorder-media-source.dto';
import { MediaSourceService } from './media-source.service';

@Controller('media-sources')
@UseGuards(AuthGuard('jwt'))
export class MediaSourceController {
  constructor(private readonly service: MediaSourceService) {}

  @Get()
  list(@Req() req) {
    return this.service.list(req.user.user_id);
  }

  /** 代拉订阅并展开站点列表（须在 :id 前） */
  @Get('catalog')
  catalog(@Req() req) {
    return this.service.listCatalog(req.user.user_id);
  }

  @Post()
  add(@Req() req, @Body() dto: CreateMediaSourceDto) {
    return this.service.add(req.user.user_id, dto);
  }

  @Put('reorder')
  reorder(@Req() req, @Body() dto: ReorderMediaSourceDto) {
    return this.service.reorder(req.user.user_id, dto.ids);
  }

  @Patch(':id')
  update(
    @Req() req,
    @Param('id') id: string,
    @Body() dto: UpdateMediaSourceDto,
  ) {
    return this.service.update(req.user.user_id, id, dto);
  }

  @Delete(':id')
  remove(@Req() req, @Param('id') id: string) {
    return this.service.remove(req.user.user_id, id);
  }

  @Post(':id/refresh')
  refresh(@Req() req, @Param('id') id: string) {
    return this.service.refresh(req.user.user_id, id);
  }
}
