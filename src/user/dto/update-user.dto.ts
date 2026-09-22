import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  ValidateIf,
} from 'class-validator';

/** ≥6 位，须含字母与数字（有值才校验） */
const PASSWORD_PATTERN = /^(?=.*[A-Za-z])(?=.*\d).{6,}$/;

/** 允许用户自改的字段（禁止改 username / role） */
export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @Matches(/^[a-zA-Z0-9一-龥]{1,10}$/, {
    message: '昵称需为 1-10 位中英文或数字',
  })
  nickname?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== undefined && v !== null && v !== '')
  @IsString()
  @Matches(PASSWORD_PATTERN, {
    message: '密码至少 6 位，须包含英文字母和数字',
  })
  password?: string;

  @IsOptional()
  @IsString()
  avatar?: string;

  /** 0 离线 / 1 在线 */
  @IsOptional()
  @IsNumber()
  @IsIn([0, 1], { message: 'status 必须是 0 或 1' })
  status?: number;
}

/*
 * ── 提权红线（编译期断言，不要删除）─────────────────────────────
 *
 * `PATCH /api/user/:id` 的判定是「**本人或 root**」（见 UserController）——
 * 也就是说普通用户能合法调用它改自己的资料。所以**一旦 `role` 变成可写字段，
 * 任何登录用户都能把自己改成 root**。这是本项目最致命的一处提权面。
 *
 * 光靠注释守不住（下一个人可能顺手加个 `@IsOptional() role?: string`），
 * 所以在这里做一次**编译期**断言：`UpdateUserDto` 上一旦出现 `role` 或 `username`，
 * 下面的类型就会变成 `never`，赋值 `true` 直接**编译失败**。
 *
 * 另外全局 `ValidationPipe` 开了 `forbidNonWhitelisted`，所以请求里多传 `role`
 * 会直接 400（而不是被静默忽略）—— 这条行为在 `scripts/auth-e2e.mjs` 里有断言。
 */
type PrivilegedUserField = 'role' | 'username';
type LeakedField = Extract<keyof UpdateUserDto, PrivilegedUserField>;
export const _assertNoPrivilegedFieldInUpdateDto: LeakedField extends never
  ? true
  : never = true;
