/** 加入 / 创建聊天室 */
export interface AddGroupDto {
  anime_id: number;
  /** 本地 anime 表可能无此番，前端可带 Bangumi 标题 */
  group_name?: string;
}

/** 群消息发送 */
export interface GroupMessageDto {
  group_id: string;
  user_id: string;
  message: string;
  message_type: string;
  time?: number;
}

/** 推送给前端的消息（含用户展示字段） */
export interface GroupMessageView {
  id: string;
  group_id: string;
  user_id: string;
  message: string;
  message_type: string;
  time: number;
  nickname: string;
  avatar?: string;
}
