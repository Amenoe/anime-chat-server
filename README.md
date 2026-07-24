# 动漫聊天室

`nest.js` `typeorm` `jwt` `socket.io`

---

## 环境

| 环境 | 文件 | 启动 |
|------|------|------|
| 开发 | `.env.development` | `pnpm start:dev` |
| 生产 | `.env.production` | `pnpm start:prod` |

| 变量 | 说明 |
|------|------|
| `DB_*` / `JWT_SECRET` | MySQL / JWT |
| `MINIO_*` | 头像对象存储 |
| `QB_*` | qBittorrent（BT 边下边播） |
| `OUTBOUND_PROXY` | **可选**。搜源在浏览器完成，服务器通常不需要；仅运维代拉时配置 |

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

---

前端：[anime-chat](https://github.com/Amenoe/anime-chat)
