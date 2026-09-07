[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/chunchiehdev/grading)

# Grading

AI 作業評分平台：React Router v7、Prisma、BullMQ、Socket.IO。開發指令、架構與程式規範見 `CLAUDE.md`。

## 開發

```bash
docker-compose -f docker-compose.dev.yaml up -d   # postgres / redis / minio / websocket / pgadmin
npm run dev
npm run typecheck
npm run test
```

## 部署

正式環境以 Docker Compose 部署在內網伺服器 192.168.30.111，對外經 Cloudflare Tunnel 提供
https://grading.wuretedu.com。push 到 `master` 會觸發 `.github/workflows/deploy.yml`：
build 映像到 ghcr → mirror pdf-service 映像 → self-hosted runner SSH 進伺服器 pull、migration、up → 驗證。

完整流程、伺服器路徑與埠、tunnel、手動同步設定檔的步驟見 [docs/DEPLOY.md](docs/DEPLOY.md)。

| 路徑 | 用途 |
|---|---|
| `deploy/docker-compose.server.yml` | 伺服器端 compose 檔的版本控管來源（伺服器上是 `docker-compose.yml`） |
| `deploy/nginx.conf` | 反向代理設定（Cloudflare 真實 IP 還原、Socket.IO、SSE） |
| `.github/workflows/deploy.yml` | CI/CD |
| `deploy/k8s-legacy/` | 原本的 k8s / kustomize manifests，已停用，僅供對照 |
| `future-list.md` | 刻意延後的工作項目 |
