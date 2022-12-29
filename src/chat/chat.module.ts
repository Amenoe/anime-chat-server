import { Module } from '@nestjs/common';
import { ChatService } from './chat.service';
import { ChatGateway } from './chat.gateway';
import { User } from 'src/user/entities/user.entity';
import { Group } from 'src/group/entities/group.entity';
import { GroupUserMap } from 'src/group/entities/group_user_map.entity';
import { GroupMessage } from 'src/group/entities/group_message.entity';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Anime } from 'src/anime/entities/anime.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, Anime, Group, GroupUserMap, GroupMessage]),
  ],
  providers: [ChatGateway, ChatService],
})
export class ChatModule {}
