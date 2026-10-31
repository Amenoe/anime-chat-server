import { IsOptional, IsString, MaxLength } from 'class-validator';

/** 建一个私人点播室：不绑番剧，靠邀请链接进房 */
export class CreateVodRoomDto {
  @IsOptional()
  @IsString()
  @MaxLength(40, { message: '房间名最多 40 个字' })
  name?: string;
}
