import { Module } from '@nestjs/common';
import { GroupService } from './group.service';
import { GroupController } from './group.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Group } from './entities/group.entity';
import { GroupUserMap } from './entities/group_user_map.entity';
import { GroupMessage } from './entities/group_message.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Group, GroupUserMap, GroupMessage])],
  controllers: [GroupController],
  providers: [GroupService],
})
export class GroupModule {}
