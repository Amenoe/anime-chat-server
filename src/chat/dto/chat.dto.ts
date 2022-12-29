// 群消息
interface GroupMessageDto {
  group_id: string;
  user_id: string;
  message: string;
  message_type: string;
  time?: number;
}
