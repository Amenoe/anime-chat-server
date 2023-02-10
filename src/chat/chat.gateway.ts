import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { ChatService } from './chat.service';
import { InjectRepository } from '@nestjs/typeorm';
import { User } from 'src/user/entities/user.entity';
import { Group } from 'src/group/entities/group.entity';
import { Repository } from 'typeorm';
import { GroupUserMap } from 'src/group/entities/group_user_map.entity';
import { GroupMessage } from 'src/group/entities/group_message.entity';
import { Server, Socket } from 'socket.io';
import { BadRequestException, HttpException } from '@nestjs/common';
import { Anime } from 'src/anime/entities/anime.entity';

@WebSocketGateway({ cors: true })
export class ChatGateway {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Anime)
    private readonly animeRepository: Repository<Anime>,
    @InjectRepository(Group)
    private readonly groupRepository: Repository<Group>,
    @InjectRepository(GroupUserMap)
    private readonly groupUserRepository: Repository<GroupUserMap>,
    @InjectRepository(GroupMessage)
    private readonly groupMessageRepository: Repository<GroupMessage>,
  ) {}

  @WebSocketServer()
  server: Server;

  // 默认群
  defaultGroup = 'default';

  // socket连接钩子
  async handleConnection(client: Socket): Promise<string> {
    // 连接默认房间
    client.join(this.defaultGroup);
    console.log('连接成功');

    return '连接成功';
  }

  // socket断连钩子
  async handleDisconnect(): Promise<any> {
    console.log('断开连接');
    this.getActiveGroupUser(this.defaultGroup);
  }

  @SubscribeMessage('addGroup')
  async addGroup(
    @ConnectedSocket() client: Socket,
    @MessageBody() anime_id: number,
  ): Promise<any> {
    console.log(anime_id);
    const isHaveGroup = await this.groupRepository.findOne({
      where: { anime_id },
    });
    if (isHaveGroup) {
      // throw new BadRequestException('服务器出错');
      console.log('已有该群组');
      client.join(isHaveGroup.group_id);
      console.log('已连接到该群组');
      this.server.to(isHaveGroup.group_id).emit('addGroup', isHaveGroup);
      this.defaultGroup = isHaveGroup.group_id;
      // 进来统计一下在线人数
      this.getActiveGroupUser(isHaveGroup.group_id);
    } else {
      const animeData = await this.animeRepository.findOne({
        where: { anime_id },
      });
      const groupData = await this.groupRepository.save({
        anime_id: animeData.anime_id,
        group_name: animeData.title,
        create_time: String(new Date().getTime()),
      });
      client.join(groupData.group_id);
      this.defaultGroup = groupData.group_id;
      // 进来统计一下在线人数
      this.getActiveGroupUser(groupData.group_id);
    }
  }

  @SubscribeMessage('chatData')
  async getGroupMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() group_id: string,
  ) {
    const messageList = await this.groupMessageRepository.find({
      where: {
        group_id,
      },
      order: {
        time: 'DESC',
      },
      skip: 0,
      take: 10,
    });
    if (messageList.length) {
      const data1 = messageList.map(async (item) => {
        const userData = await this.userRepository.findOne(item.user_id);
        return {
          id: item.id,
          user_id: userData.user_id,
          nickname: userData.nickname,
          message: item.message,
          time: item.time,
        };
      });
      const data = await Promise.all(data1);
      this.server.to(group_id).emit('chatData', data);
    } else {
      this.server.to(group_id).emit('chatData', '还没有消息');
    }
  }

  @SubscribeMessage('groupMessage')
  async sendGroupMessage(@MessageBody() data: GroupMessageDto) {
    const isUser = await this.userRepository.findOne({ user_id: data.user_id });
    if (isUser) {
      const message = await this.groupMessageRepository.save({
        ...data,
        time: new Date().valueOf(),
      });
      this.server.to(data.group_id).emit('groupMessage', {
        data: message,
        message: '发送成功',
        code: 200,
      });
    } else {
      this.server
        .to(data.group_id)
        .emit('groupMessage', { message: '发送错误', code: 500 });
    }
  }

  async getActiveGroupUser(group_id: string) {
    // const activeUser = await this.userRepository.count({
    //   where: { status: 1 },
    // });
    // 从server中获取连接人数
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore;
    const activeUser = this.server.engine.clientsCount;
    console.log('查询人数' + activeUser);
    this.server.to(group_id).emit('activeGroupUser', {
      data: activeUser,
      message: '查询成功',
      code: 200,
    });
  }
}
