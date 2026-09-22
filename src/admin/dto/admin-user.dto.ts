import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** 与注册/改密保持同一套规则：≥6 位，须含字母与数字 */
export const PASSWORD_PATTERN = /^(?=.*[A-Za-z])(?=.*\d).{6,}$/;

/** 角色取值，与 `user.role` 的 enum 一致 */
export const USER_ROLES = ['root', 'user'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export class ListUsersQueryDto {
  /** 同时匹配 username / nickname */
  @IsOptional()
  @IsString()
  @MaxLength(50, { message: '关键词过长' })
  keyword?: string;

  @IsOptional()
  @IsEnum(USER_ROLES)
  role?: UserRole;

  /**
   * 只看已封禁 / 未封禁。
   *
   * query string 里一切都是字符串，而 `@Type(() => Boolean)` 会把 `"false"` 变成 `true`
   * （`Boolean("false") === true`）—— 这是最经典的 query 布尔坑，所以这里显式判断字面量。
   */
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  disabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100, { message: '每页最多 100 条' })
  @Type(() => Number)
  size?: number;
}

export class BanUserDto {
  /** true 封禁 / false 解封 */
  @IsBoolean()
  banned: boolean;

  /** 解封时忽略；展示给被封的人看 */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string;
}

export class ChangeUserRoleDto {
  @IsEnum(USER_ROLES)
  role: UserRole;
}

export class ResetPasswordDto {
  @IsNotEmpty({ message: '请输入新密码' })
  @IsString()
  @Matches(PASSWORD_PATTERN, {
    message: '密码至少 6 位，须包含英文字母和数字',
  })
  newPassword: string;
}
