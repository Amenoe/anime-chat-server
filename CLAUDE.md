# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

anime-chat-server — NestJS backend for an anime discussion platform with 「放映室」一起看
(Socket.IO 强同步) and online playback (流媒体 Range 代理 / BT 磁力边下边播).
Frontend repo: [anime-chat](https://github.com/Amenoe/anime-chat). The project uses Chinese
for comments, commit messages, and API messages.

公共记忆与任务看板见根目录 `docs/PROJECT_MEMORY.md`；接口契约 `docs/api-contract.md`；
表结构 `docs/schema.sql`；播放架构 `docs/playback-architecture.md`。

## Commands

```bash
pnpm start:dev                                            # 开发，localhost:3000（NODE_ENV=development）
pnpm start:prod                                           # 生产（需先 pnpm build）
pnpm exec tsc --noEmit -p tsconfig.build.json              # 类型检查
pnpm run build                                            # nest build
pnpm run lint                                             # ESLint --fix
pnpm exec prettier --check "src/**/*.ts"                   # 格式检查
```

## Commit Convention

Emoji-prefixed Angular-style commits（与前端仓库一致）:
`🌟feat` `🐛fix` `📝docs` `💎style` `🌠refactor` `🚀perf` `🚨test` `📦build` `👷ci` `🔂revert`

## Bootstrap（`src/main.ts`）

全局生效、改行为前必须知道：

- 全局前缀 `api` → 所有路由形如 `/api/...`
- `ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true })`
  → **传未声明字段直接 400**，DTO 必须显式声明每个可收字段
- `HttpExceptionFilter` → 错误信封 `{ data, message, code }`，**并设置真实 HTTP 状态码**
- `TransformInterceptor` → 成功信封 `{ data, code: 200, message: '请求成功' }`
  → controller 直接 `return` 业务数据，不要自己包信封
- 静态资源：优先 `src/public`，其次 `dist/public`，挂到 `/api` 前缀
- `app.enableCors()`；监听 `3000`

## Configuration

`src/core/config/config.ts` 用 dotenv 按 `NODE_ENV` 加载 `.env.development` / `.env.production`，
导出 `appConfig` / `jwtConfig` / `DBConifg` / `minioConfig` 等。**`.env*` 一律不提交**
（`.gitignore` 已排除），新增配置必须同时在 README 环境变量表里说明。

JWT 双 token 配置：`JWT_SECRET`（access）、`JWT_REFRESH_SECRET`（缺省由前者派生 `":refresh"`）、
`JWT_ACCESS_EXPIRES_IN`（默认 `2h`）、`JWT_REFRESH_EXPIRES_IN`（默认 `30d`）。

## Modules（`src/`）

| 模块           | 职责                                                                   |
| -------------- | ---------------------------------------------------------------------- |
| `auth`         | 登录、双 token 签发/刷新/吊销（`RefreshTokenService`）、Local/JWT 策略 |
| `user`         | 用户 CRUD、头像上传（转存 MinIO Private 桶）、在线状态                 |
| `user-anime`   | 追番（wish/watching/done），唯一键 `(user_id, bangumi_id)`             |
| `anime`        | 本地番剧兜底表（Bangumi 迁移后基本不用；`addGroup` 旧路径）            |
| `group`        | 旧聊天室表 + 放映室共用 `group` 实体；`addGroup` 已标 deprecated       |
| `room`         | 放映室 HTTP：列房、建房（生成 `season_id`）、按 key 查                 |
| `chat`         | Socket.IO Gateway：进房、播放强同步、聊天、房主转让                    |
| `playback`     | 播放会话：流媒体 Range 代理、HLS 改写、BT（qBittorrent）、搜源         |
| `media-source` | 用户订阅的 Animeko 格式数据源（只存 URL，解析在浏览器）                |
| `storage`      | MinIO（头像）+ 图片代理 controller；`@Global()` 模块                   |

## 埋点（`src/track/`，`@Global()`）

所有事件（前端行为 + 后端业务）都写进**同一张 `track_event` 表**，走 `TrackService` 这一条路径。

- `POST /api/track` —— 前端批量上报，**匿名可用**（`OptionalJwtGuard`）。
  未登录时靠 body 里的 `anonymousId` 归属，否则拿不到「访客在哪一步流失」。
- 后端事件直接注入 `TrackService` 调 `trackOne('ai.chat', { userId, props })`。
- **`TrackService.track()` 吞掉所有异常**：埋点写不进去不该让用户的业务请求失败。
- `props` 是 JSON，所以加埋点字段不用改表；代价是聚合要 `JSON_EXTRACT`。
  量级上来后应另建**物化汇总表**（参考 `ai_usage` 的思路），**不要**给通用表加业务专用列。
- 统计接口（`/api/track/stats/*`、`/api/ai/stats/*`）只给 `role = 'root'`。
- **跨功能口径集中在 `AiService.statsEngagement`**（访问量 / 消耗 / 使用率，
  含 `ai_rate = AI 对话 ÷ (AI + 手动搜索)`）。它依赖几个**前端**埋点事件名
  （常量在该文件顶部），改名前端事件名要一起改 ——
  **查不到事件名不报错，只静默算成 0**，看板上表现为「AI 使用率 100%」这种假象。
  之所以放后端而不是让前端拼：这是业务定义，散在组件里迟早对不上。

⚠️ 五条踩过的坑：

1. **统计接口必须挂 `AuthGuard('jwt')`**。没有守卫时 `req.user` 恒为 `undefined`，
   连管理员都会被 `assertRoot` 判成 403。
2. **`props->>'$.x'` 取出来是字符串**，参与算术必须 `CAST(... AS UNSIGNED)`；
   否则 `+` 会做字符串拼接，`SUM` 出来的结果毫无意义（曾因此 500）。
   而外层为了「返回给前端是数字」再包一层 `CAST` 是**无效**的 —— TypeORM 的 mysql 驱动
   开了 `bigNumberStrings`，COUNT/SUM 回来仍是字符串。返回值类型统一用
   `core/utils/sql.ts` 的 `toNumbers()` / `rowToNumbers()` 在应用层收敛。
3. **每个 `SUM` 都要 `COALESCE(..., 0)`**。零行时 `SUM` 返回 **NULL** 而不是 0
   （`COUNT` 才天然是 0），而 `toNumbers()` 是**故意跳过 null** 的 ——
   它只做「字符串→数字」，不补默认值。漏包的结果是接口把 `null` 漏给前端，
   与「字段都是数字」的契约不符（看板做出 `null` 时实测到的）。
4. **`props` 里存数组的字段（如 `toolNames`）取出来带 JSON 语法**。
   `props->>'$.toolNames'` 是 `["browse_anime"]`，多元素时 MySQL 还会加空格
   （`["a", "b"]`），**不是**逗号分隔的裸名字。要分组就先用 `REPLACE` 剥掉方括号引号。
   别为了方便改写成拍平的字符串 —— 数组才能支持 `JSON_CONTAINS` 这类查询。
5. 统计接口的数值**只保证是数字，不保证有值以外的语义**：`user_id` 可为空（匿名埋点）、
   用户可能已注销，所以 `LEFT JOIN user` 取 `username` 时要接受 `NULL`
   （**必须 LEFT**：INNER 会把匿名行吞掉，排行总数对不上）。

## Auth（改这里前先读 `docs/api-contract.md`）

- 业务接口一律 `@UseGuards(AuthGuard('jwt'))`（**没有全局守卫**，新 controller 必须自己加）
- `JwtStrategy.validate` 拒绝 `typ === 'refresh'` 的 token → refreshToken 不能访问业务接口
- accessToken 载荷 `{ user_id, username, typ: 'access', jti }`，不落库，短时效
- refreshToken 载荷 `{ sub, user_id, username, typ: 'refresh', jti }`，
  `refresh_token` 表**只存 `sha256(jwt)`**，明文只在登录/刷新响应出现一次
- 刷新即**轮换**：旧记录置 `revoked=1` 并写 `replaced_by`；
  `consume()` 用条件更新（`id = :id AND revoked = 0`）原子认领，防并发重复使用
- 已作废 refreshToken 再次出现 → 判定泄露，`revokeAllForUser` 吊销该用户全部会话
- 吊销时机：登出（单条）、改密（全部）、删号（全部）
- 头像涉及「本人校验」的接口（`PATCH/DELETE /user/:id`、`PATCH /user/status/:id`）
  必须比对 `req.user.user_id` 与目标 id，否则 403

## 数据库

- MySQL `anime_chat`；dev 用 TypeORM `synchronize: true` + `autoLoadEntities: true`
- **生产必须关 `synchronize`**，用 `docs/schema.sql` 建表
- 改实体后**同步更新 `docs/schema.sql`**，否则生产建库缺表
- `refresh_token` 表必须存在，否则登录直接失败

## Socket.IO（`chat/chat.gateway.ts`）

- `joinRoom`（含 `create: true` 建房）/ `playback:control`（仅房主）/ `playback:state` 广播
  / `host:changed` / `room:destroyed`
- 进房成功要 upsert `GroupUserMap`，否则观众拉 host 流 404（成员鉴权依赖它）
- 心跳广播 1s 节流，写库 2s 节流

## Playback

- 流媒体：`POST /api/playback/sessions/stream` → Range 代理出流
- BT：`POST /api/playback/sessions`（magnet）→ qBittorrent 边下边播；`QB_ENABLED=false` 不影响流媒体
- `GET /api/playback/sessions/:id/stream?token=` 额外支持 query token（video/hls 无法带 Header）
- HLS 相对 URI 改写 + 同源代理 `enc.key` / `.ts`
- 详见 `docs/playback-architecture.md`

## No Tests

`jest` 已配置但 **`src/` 下没有任何 `*.spec.ts`**。改动后请手动验证：

```bash
pnpm exec tsc --noEmit -p tsconfig.build.json && pnpm run build   # 必过
NODE_ENV=development node dist/main.js                            # 真实启动，确认 DI 与路由
```

鉴权链路已有可重复执行的验收脚本（**改鉴权后必须跑**）：

```bash
node scripts/auth-e2e.mjs                    # 默认打 127.0.0.1:3000
BASE=http://127.0.0.1:3000/api node scripts/auth-e2e.mjs
```

覆盖登录 → 鉴权 → 刷新轮换 → 复用检测 → 登出 → 改密 → 删号，24 项断言，测试账号自动清理。
