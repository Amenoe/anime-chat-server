# 动漫聊天室

`nest.js` `typeorm` `jwt` `socket.io`

---

## 环境

| 环境 | 文件               | 启动              |
| ---- | ------------------ | ----------------- |
| 开发 | `.env.development` | `pnpm start:dev`  |
| 生产 | `.env.production`  | `pnpm start:prod` |

| 变量                  | 说明                                                           |
| --------------------- | -------------------------------------------------------------- |
| `DB_*` / `JWT_SECRET` | MySQL / JWT                                                    |
| `MINIO_*`             | 头像对象存储                                                   |
| `QB_*`                | qBittorrent（BT 边下边播）                                     |
| `OUTBOUND_PROXY`      | **可选**。搜源在浏览器完成，服务器通常不需要；仅运维代拉时配置 |

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

核心设计决策与任务看板见 [docs/PROJECT_MEMORY.md](../docs/PROJECT_MEMORY.md)。

---

前端：[anime-chat](https://github.com/Amenoe/anime-chat)
