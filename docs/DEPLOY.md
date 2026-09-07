# 部署說明（Docker Compose + Cloudflare Tunnel）

正式環境：https://grading.wuretedu.com
伺服器：`richie@192.168.30.111`（Ubuntu，Docker 29 + Compose v5），與 SDL 專案共用同一台 VM。

## 1. 架構決策

本專案原本以 k3s / k8s + kustomize 部署（manifests 保留在 `deploy/k8s-legacy/`）。2026-09-07 評估後改為
Docker Compose，理由：

- k8s 資產只有最基本的 Deployment / Service / PVC / Job / Ingress，沒有 operator、CRD、HPA、CronJob、RBAC，
  程式碼也不呼叫 k8s API，翻成 compose 不會失真。
- 目標 VM 的主機 80 已被 SDL 的 nginx 佔用、UFW 不能關；k3s 必須關掉 Traefik 與 ServiceLB 並放行 pod / service
  網段，還得在 containerd 再養一份 1.2GB 的映像，且日誌輪替、非 root 等加固都要重做一遍。
- 只有一位維運者，既有 runbook 全是 compose。

3 副本的設計是為了配合 3 把 Gemini key 的 BullMQ 吞吐，不是可用性需求；compose 從 1 副本起步，需要時再加
`deploy.replicas`。完整盤點與規則命中情況見對話紀錄；資源對應如下：

| k8s 概念 | compose 對應 |
|---|---|
| gradsystem / websocket Deployment | `app` / `websocket` 服務 |
| Ingress `/socket.io` 與 `/` + cert-manager TLS | `nginx` 兩個 location；TLS 由 Cloudflare 邊緣終結 |
| db-migrate Job + initContainer | CI 在 `up -d` 前 `docker compose run --rm --no-deps app npx prisma migrate deploy` |
| createbuckets Job | `minio-init` 一次性服務，`app` 依賴 `service_completed_successfully` |
| readiness / liveness probe | `healthcheck` |
| resources.limits | `deploy.resources.limits`（app 3G、pdf-worker 1.5G、其餘 128M 到 1G） |
| PVC | named volume `postgres_data` / `redis_data` / `minio_data` |
| POD_NAME 等 downward API | 不設 |

盤點時發現舊 manifests 與程式碼有漂移，compose 以程式碼為準：websocket 的 `MAIN_API_URL` 應為 `MAIN_APP_URL`
且需要 `INTERNAL_API_KEY`；pdf-service 只讀 `REDIS_URL`；gradsystem 的 512Mi 對 Puppeteer / Chromium 不夠。

## 2. 拓撲與元件

```
Internet ──HTTPS──▶ Cloudflare edge ──tunnel──▶ cloudflared ──▶ nginx:80 ──┬──▶ app:3000 (React Router SSR + BullMQ worker)
                                                                            └──▶ websocket:3001 (/socket.io/)
                                                            app ──▶ postgres:5432 / redis:6379(db0) / minio:9000 / pdf-api:8000
                                                            pdf-api ──▶ redis:6379(db1) ◀── pdf-worker (Celery)
```

| 服務 | 映像 | 容器埠 | 主機埠（僅 127.0.0.1） | 非 root |
|---|---|---|---|---|
| nginx | nginx:1.27-alpine | 80 | 8080（區網除錯、CI verify） | 映像預設 |
| cloudflared | cloudflare/cloudflared:latest，profile `tunnel` | 無 | 無 | 映像預設 |
| app | ghcr.io/richie1129/grading-app:`<sha>` | 3000 | 無 | Dockerfile `USER node` |
| websocket | ghcr.io/richie1129/grading-websocket:`<sha>` | 3001 | 無 | 映像 uid 1001 |
| postgres | postgres:16-alpine | 5432 | 25432 | 映像預設 |
| redis | redis:7.4-alpine | 6379 | 26379 | 映像預設 |
| minio | minio/minio:RELEASE.2025-05-24T17-08-30Z | 9000 / 9001 | 29000 / 29001 | 映像預設 |
| pdf-api / pdf-worker | ghcr.io/richie1129/grading-pdf@sha256:98dc91e0… | 8000 / 無 | 無 | compose `user: 10001` |

主機埠刻意避開 SDL 的 80 / 15432 / 9000 / 9001 / 5555 與主機 systemd PostgreSQL 的 5432。
沒有任何新的 UFW 規則；對外流量全走 tunnel。

## 3. 固定資訊

| 項目 | 值 |
|---|---|
| 伺服器部署目錄 | `/home/richie/grading`（`docker-compose.yml`、`nginx.conf`、`.env`） |
| compose 專案名稱 | `grading`（寫在 compose 檔的 `name:`，容器名 `grading-<service>-1`） |
| Cloudflare tunnel | 名稱由 Zero Trust 後台管理，ID `017d2f9f-90fe-4471-94ef-8be566e3a286`，Public Hostname `grading.wuretedu.com → http://nginx:80` |
| DNS | proxied CNAME `grading` → `017d2f9f-90fe-4471-94ef-8be566e3a286.cfargotunnel.com`（Cloudflare 自動建立） |
| GitHub self-hosted runner | `grading-server`，目錄 `/home/richie/actions-runner-grading`，systemd `actions.runner.Richie1129-grading.grading-server.service` |
| GitHub secrets | `SERVER_HOST`、`SERVER_USER`、`SERVER_SSH_KEY`（對應 `~/.ssh/id_ed25519_ci`） |
| 映像 registry | ghcr.io/richie1129/grading-app、grading-websocket、grading-pdf（private，CI 以 GITHUB_TOKEN 推拉） |

## 4. CI/CD 流程（.github/workflows/deploy.yml）

push 到 `master` 或手動 `workflow_dispatch`：

1. **build**（ubuntu-latest）：建 app 與 websocket 映像，tag `<commit sha>` 與 `master`，推 ghcr。
2. **mirror-pdf**（ubuntu-latest，與 build 平行）：把 `docker.io/chunchiehdev/grading-pdf@<PDF_SOURCE_DIGEST>`
   以 `docker buildx imagetools create` 複製到 `ghcr.io/richie1129/grading-pdf:master`。複製時 manifest 會重新編碼成
   OCI index，所以 compose 釘的是 ghcr 端的 `PDF_DIGEST`；job 會驗證 manifest digest 與 config digest 都符合，
   不符就失敗。已是相同 digest 時跳過。
3. **deploy**（self-hosted，`appleboy/ssh-action` 釘 SHA）：磁碟剩餘不足 5G 中止 → `docker login ghcr.io` →
   備份 `.env` 並寫入 `IMAGE_TAG` → `docker compose pull` → `up -d --wait postgres redis minio` →
   `run --rm --no-deps app npx prisma migrate deploy`（失敗即中止，app 仍是上一版）→ `up -d --remove-orphans` →
   刪本專案舊映像（保留 master、目前、上一版）→ `docker logout`。
4. **verify**（self-hosted）：所有容器 running / healthy、映像版本符合、`127.0.0.1:8080/health` 回 healthy、
   Socket.IO 握手、pdf-api `/health`。

CI 不會覆寫 `docker-compose.yml`、`nginx.conf`、`.env`。

## 5. 手動同步設定檔

`deploy/docker-compose.server.yml` 或 `deploy/nginx.conf` 有改動時（版本控管來源是 repo）：

```bash
scp deploy/docker-compose.server.yml richie@192.168.30.111:~/grading/docker-compose.yml
scp deploy/nginx.conf               richie@192.168.30.111:~/grading/nginx.conf
ssh richie@192.168.30.111 'cd ~/grading && docker compose config --quiet && docker compose up -d'
```

`.env` 只存在伺服器（範本：`deploy/.env.server.example`）。改完後：

```bash
ssh richie@192.168.30.111 'cd ~/grading && docker compose up -d'   # 只重建環境變數有變的容器
```

新增 `.env` key 時，記得同時在 compose 檔對應服務的 `environment:` 加上 `${KEY}`，app 不用 `env_file` 整包注入。

## 6. 常用維運指令

一律在 `/home/richie/grading` 執行，或帶 `-p grading`，不會碰到同機的 SDL 容器。

```bash
ssh richie@192.168.30.111
cd ~/grading
docker compose ps
docker compose logs -f --tail=100 app            # 或 websocket / nginx / cloudflared / pdf-worker
docker compose run --rm --no-deps app npx prisma migrate deploy
docker compose run --rm --no-deps app npm run seed:admin   # 第一次上線建管理員（FIRST_ADMIN_EMAIL）
docker compose restart app
```

圖形介面一律 SSH 轉埠，不開 UFW：

```bash
ssh -L 25432:127.0.0.1:25432 -L 29001:127.0.0.1:29001 -L 8080:127.0.0.1:8080 richie@192.168.30.111
# psql -h 127.0.0.1 -p 25432 -U grading grading_db ；MinIO console http://127.0.0.1:29001 ；nginx http://127.0.0.1:8080
```

回滾到上一版：`.env.backup` 是部署前的 `.env`，`IMAGE_TAG` 就是上一版 SHA。

```bash
cd ~/grading && PREV=$(grep '^IMAGE_TAG=' .env.backup | cut -d= -f2-) && sed -i "s|^IMAGE_TAG=.*|IMAGE_TAG=${PREV}|" .env && docker compose up -d app websocket
```

手動在伺服器 pull 私有映像時需自備 `read:packages` 的 PAT 執行 `docker login ghcr.io`，用完 `docker logout ghcr.io`。

## 7. 已知限制與待辦

- **評分供應商順序**：Agent 路徑與 AI SDK 路徑都依 `GRADING_PROVIDER_ORDER`（預設 `vllm,gemini,openai`）依序嘗試，
  vLLM 以 `GET /models` 健康檢查決定可用與否；Legacy 路徑仍是 Gemini → OpenAI。目前 `.env` 的 `GEMINI_API_KEY` 是佔位值、
  `OPENAI_API_KEY` 空，所以 vLLM 不可用時評分會失敗；補上真實 key 就自動成為備援。Agent 路徑不支援 OpenAI 備援。
- **`GEMINI_API_KEY` 不能為空字串**：舊版會讓 app 啟動卡住；已改為延遲初始化（`future-list.md` F002），但仍建議放佔位值。
- **pdf-service 是 mirror**：原始碼在公開 repo chunchiehdev/grading-pdf，自建映像見 `future-list.md` F001。
- **nginx 未設 CSP**：React Router hydration 用 inline script，正式強制前需要 nonce 機制。
- **通知原開發者輪替**：`deploy/k8s-legacy/main-service/monitor.k3s/` 與 `overlays/monitor-k3s/helm-values/`
  的 Grafana / InfluxDB admin 密碼與 InfluxDB token 曾以明文提交（2026-01-16，上游 repo 至今仍有），本 repo 已改為
  placeholder，歷史 commit 仍可見。
- `/api/courses/:id/cover-url` 回傳的 presigned URL 指向容器內的 `minio:9000`，瀏覽器無法連；此問題 k8s 時期已存在，
  且目前沒有前端呼叫這個端點。

## 8. 驗證紀錄（2026-09-07 首次上線）

- CI：build、mirror-pdf、deploy 綠燈；verify 在修正 `/health` 檢查方式後綠燈（見 Actions）。
- 伺服器 `docker compose ps`：app / websocket / postgres / redis / minio / pdf-api 皆 healthy，pdf-worker、nginx、cloudflared running，
  minio-init exited(0)。Prisma migration 40 筆全部套用。
- 外部：`http://grading.wuretedu.com` 301 → https；`https://grading.wuretedu.com` HTTP/2 200，回應帶 HSTS、nosniff、
  X-Frame-Options（由 nginx 加、經 Cloudflare 原樣轉出）；`/health` 200；`/socket.io/?EIO=4&transport=polling` 回 `0{"sid":…}`；
  `/api/enrollments` 未登入回 400（參數檢查先於認證）；`/api/admin/queue-status` 未登入回 500，是該路由把 `requireAdmin`
  丟出的 redirect Response 當一般例外處理的既有 bug，與部署無關。
- 真實 client IP：nginx access log 第一欄記到發起 curl 的公網 IP `140.115.126.30`，`via=172.19.0.2` 是 cloudflared 容器；
  轉給 app 的 `X-Forwarded-For` 就是同一個值（程式碼記 IP 的地方都讀這個標頭）。
- 管理員：`npm run seed:admin` 建立 `stone881129@g.ncu.edu.tw`（腳本預設值，`FIRST_ADMIN_EMAIL` 留空）。
- 首次上線時發現：`GEMINI_API_KEY` 為空會讓 app 在啟動階段卡住、不監聽 3000 也不崩潰（healthcheck 因此 unhealthy、
  verify 失敗）。暫以 `.env` 的佔位值 `GEMINI_API_KEY=placeholder-not-configured` 讓服務啟動；根因與修法見 `future-list.md` F002。

### vLLM 評分路徑驗證（2026-09-07，commit e2cc7eb）

- 端點 `https://vllm-193.hsueh.tw/v1`、模型 `/models/gemma-4-26B-A4B-it`：`/v1/models` 可達，
  `/v1/chat/completions` 的 `response_format: json_schema` 與 `tools` 都能用（curl 實測）。
- AI SDK 路徑（`gradeWithVllm`）：用真實的評分 prompt 與 `GradingResultSchema` 打 vLLM，34 秒回傳兩個 criteria 的評語、
  總評與 2 題 sparring questions，schema 驗證通過。
- Agent 路徑（`executeGradingAgent`，伺服器 `USE_AGENT_GRADING=true` 實際走的路徑）：模型選到 vllm，
  think_aloud → calculate_confidence → generate_feedback 三次 tool call，75 到 85 秒，約 16k tokens，信心 0.86 到 0.98。
- 三次實測發現 gemma 會自創 criteriaId、也會用自己的分數尺度（同一份 rubric 分別回 1/1、4/5、1/1，rubric 是 10 分），
  rubric 優化步驟也曾把 maxScore 改成 1。已加 `agent-rubric.server.ts`：優化結果以原始 ID / 名稱 / 總分為準，
  breakdown 依 ID → 名稱 → 順序對回 rubric 並等比例換算分數；第三次實測 breakdown 為 c1 10/10、c2 10/10，總分 20/20。
- 伺服器：CI run 34099642515 全綠後，app 容器內 `GRADING_PROVIDER_ORDER=vllm,gemini,openai`、`USE_AGENT_GRADING=true`，
  從容器內 `fetch https://vllm-193.hsueh.tw/v1/models` 回 200（277 ms），BullMQ worker 正常啟動。
  磁碟使用由 12G 增為 19G（本專案映像與 volume），剩 18G。
- 單元測試：`test/unit/vllm-provider.test.ts`、`ai-grader-sdk.test.ts`、`agent-rubric.test.ts` 共 31 個測試通過
  （需本機 dev DB 與 redis；`vitest.config.ts` 已補 `@` 別名，之前所有單元測試的別名解析本來就是壞的）。
  `test/unit/gemini-key-health.test.ts` 有 1 個既有失敗（health score 期望值），與本次無關。
