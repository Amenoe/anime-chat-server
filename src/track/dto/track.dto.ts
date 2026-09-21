import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/**
 * 单条埋点事件。
 *
 * 注意全局 `ValidationPipe` 开了 `forbidNonWhitelisted`：
 * 这里没声明的字段会直接 400 —— 新增字段要同步加到这里。
 * 但 `props` 内部是自由结构（`@IsObject` 不递归校验），所以埋点属性可以随时扩展。
 */
export class TrackEventDto {
  @IsString()
  @MaxLength(80, { message: 'event 过长' })
  event: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  page?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  target?: string;

  @IsOptional()
  @IsObject()
  props?: Record<string, unknown>;

  /** 事件在前端实际发生的时间（ISO8601） */
  @IsOptional()
  @IsISO8601()
  clientTs?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  anonymousId?: string;
}

/** 批量上报。前端攒批发送，避免每个点击一个请求 */
export class TrackBatchDto {
  @IsArray()
  // 上限既是防滥用，也避免单次请求体过大把连接打满
  @ArrayMaxSize(50, { message: '单次最多上报 50 条' })
  @ValidateNested({ each: true })
  @Type(() => TrackEventDto)
  events: TrackEventDto[];
}
