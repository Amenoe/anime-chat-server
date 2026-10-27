import { IsBoolean, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * 弹幕偏好。字段全部可选 —— 前端只提交**用户改过的那部分**，
 * 没提交的项保持原值，避免「换个设备打开播放器把别的设置冲掉」。
 *
 * 校验范围与 artplayer-plugin-danmuku 的 clamp 保持一致：
 * 存进去的值如果超出范围，插件读到时会被静默夹取，表现为「设置不生效」却查不出原因。
 */
export class DanmakuSettingsDto {
  /** 弹幕是否可见（控制栏上的开关） */
  @IsOptional()
  @IsBoolean()
  visible?: boolean;

  /** 滚动时长，1~10 */
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(10)
  speed?: number;

  /** 不透明度 0~1 */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  opacity?: number;

  /** 字号，12~40 */
  @IsOptional()
  @IsNumber()
  @Min(12)
  @Max(40)
  fontSize?: number;

  /** 显示区域（上下边距，像素或百分比字符串） */
  @IsOptional()
  margin?: [number | string, number | string];

  /** 默认模式：0 滚动 1 顶部 2 底部 */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(2)
  mode?: number;

  /** 默认颜色 #rrggbb */
  @IsOptional()
  @IsString()
  color?: string;

  /** 是否防重叠 */
  @IsOptional()
  @IsBoolean()
  antiOverlap?: boolean;
}
