# Notify

情侣加密聊天 PWA。端到端加密（ECDH P-256 → AES-256-GCM），服务器零知识。

- 在线地址：`https://w2fnpn2gzv-dev.github.io/notify/`
- 部署：推送到 `main` 自动触发 GitHub Actions 部署（icons.b64 在构建时还原为 PNG 图标）
- 后端：Supabase（数据库函数见 `supabase-*.sql`，推送 Edge Function 见 `functions/`）
