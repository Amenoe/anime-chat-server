# 动漫聊天室

`nest.js` `typeorm` `jwt` `socket.io`

---

## 环境

| 环境 | 文件               | 启动              |
| ---- | ------------------ | ----------------- |
| 开发 | `.env.development` | `pnpm start:dev`  |
| 生产 | `.env.production`  | `pnpm start:prod` |

| 变量                     | 说明                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------ |
| `DB_*`                   | MySQL 连接                                                                                       |
| `JWT_SECRET`             | accessToken 签名密钥                                                                             |
| `JWT_REFRESH_SECRET`     | **可选**。refreshToken 专用密钥；缺省由 `JWT_SECRET` 派生（`":refresh"` 后缀）。生产建议显式设置 |
| `JWT_ACCESS_EXPIRES_IN`  | **可选**。accessToken 有效期，默认 `2h`                                                          |
| `JWT_REFRESH_EXPIRES_IN` | **可选**。refreshToken 有效期，默认 `30d`                                                        |
| `MINIO_*`                | 头像对象存储                                                                                     |
| `QB_*`                   | qBittorrent（BT 边下边播）                                                                       |
| `OUTBOUND_PROXY`         | **可选**。搜源在浏览器完成，服务器通常不需要；仅运维代拉时配置                                   |

## 鉴权（双 token）

| 接口                     | 说明                                                             |
| ------------------------ | ---------------------------------------------------------------- |
| `POST /api/auth/login`   | 签发 accessToken（短时效，不落库）+ refreshToken（长时效，落库） |
| `POST /api/auth/refresh` | 用 refreshToken 换一对新 token；**轮换**，旧的立即作废           |
| `POST /api/auth/logout`  | 吊销传入的 refreshToken                                          |

- `refresh_token` 表只存 `sha256(jwt)`，明文只在登录/刷新响应出现一次
- 已作废 refreshToken 被再次使用 → 判定泄露，吊销该用户全部会话
- 改密、删号会吊销该用户全部 refreshToken
- 业务接口只接受 accessToken（`typ=access`），refreshToken 访问会 401

## 数据源

个人中心「数据源」：订阅 JSON（Animeko 格式）。默认：

- `https://sub.creamycake.org/v1/css1.json` — 流媒体
- `https://sub.creamycake.org/v1/bt1.json` — BT RSS

**订阅拉取与搜源在用户浏览器执行**（走用户自己的网络 / 代理）。服务器只保存订阅 URL，并在用户选定资源后：

1. **流媒体**：`POST /api/playback/sessions/stream` → 代理 Range 出流
2. **BT**：`POST /api/playback/sessions` magnet → qB 边下边播

## 播放 API

```http
POST /api/playback/sessions/stream   # 直链
POST /api/playback/sessions          # magnet / torrent
GET  /api/playback/sessions/:id/stream?token=
GET  /api/media-sources              # 用户订阅列表
```

BT 需 `QB_ENABLED=true` + docker-compose.playback.yml。

## 放映室（一起看）

- `GET /api/rooms?anime_id=&episode_sort=` — 该番进行中的房间
- `POST /api/rooms` — 创建房间（生成 `season_id` 房间 key，绑定集数）
- `GET /api/rooms/by-key/:seasonId` — 按房间 key 取详情
- Socket.IO：`joinRoom`（含 `create: true` 建房）、`playback:control`（仅房主）、`playback:state` 广播、`host:changed` / `room:destroyed`
- 同房拉流：播放会话带 `group_id`，`openStream` 鉴权 = 属主 / 房主 / `group_user_map` 成员
- 房主离开 → 转让最早加入者；空房 → 硬删消息/成员映射/房间

核心设计决策与任务看板见 [docs/PROJECT_MEMORY.md](../docs/PROJECT_MEMORY.md)，
接口契约见 [docs/api-contract.md](../docs/api-contract.md)，表结构见 [docs/schema.sql](../docs/schema.sql)。

> 改实体后请同步更新 `docs/schema.sql`：生产环境关闭 `synchronize`，建库依赖该文件。

---

前端：[anime-chat](https://github.com/Amenoe/anime-chat)
