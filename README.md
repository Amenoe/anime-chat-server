# 动漫聊天室

`nest.js` `typeorm` `jwt` `socket.io`

- 本人毕业设计 `动漫聊天室` 的后端，使用 `nest.js` 框架开发

- 使用 `jwt` 进行用户身份认证

- 使用 `socket.io`库 进行客户端和服务器之间通信

---

## 本地配置（数据库 / JWT）

密钥**不要**写进 `src/` 源码。复制示例环境文件后填写：

```bash
cp .env.example .env
# 编辑 .env：DB_PASSWORD、JWT_SECRET 等
pnpm start:dev
```

| 变量 | 说明 |
|------|------|
| `DB_HOST` / `DB_PORT` | MySQL 地址，默认 `localhost:3306` |
| `DB_USERNAME` / `DB_PASSWORD` | 账号密码 |
| `DB_DATABASE` | 库名，默认 `anime_chat` |
| `JWT_SECRET` | JWT 签名密钥 |
| `MINIO_ENDPOINT` / `MINIO_PORT` | MinIO 地址，默认 `127.0.0.1:9000` |
| `MINIO_USE_SSL` | 是否 HTTPS，默认 `false` |
| `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` | Access Key（Private 桶） |
| `MINIO_BUCKET` | 桶名，默认 `anime-chat` |
| `MINIO_AVATAR_PREFIX` | 头像对象前缀，默认 `avatars` |

头像存 MinIO Private 桶，前端通过 `GET /api/images/avatars/:filename` 代理读取；上传接口为 `POST /api/user/avatar`（multipart field：`file`，需 JWT）。

`.env` 已在 `.gitignore` 中；仓库只保留无密钥的 `.env.example`。

---

前端跳转至 [anime-chat](https://github.com/Amenoe/anime-chat)
