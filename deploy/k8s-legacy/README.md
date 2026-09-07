# k8s-legacy（已停用）

這裡是本專案原本以 k3s / k8s + kustomize 部署時的 manifests。2026-09 改為 Docker Compose 部署
（`deploy/docker-compose.server.yml`）後停用，保留只為日後對照。決策理由、資源對應關係見 `docs/DEPLOY.md`。

## 注意

- CI 已不再使用：`.github/workflows/deploy.yml` 沒有任何 kubectl / kustomize 步驟。
- `main-service/monitor.k3s/` 與 `main-service/overlays/monitor-k3s/helm-values/` 原本含明文密碼與 token，
  已改為 `CHANGE_ME` / `CHANGE_ME_TOKEN` placeholder；歷史 commit 仍有原值，已列入通知原開發者輪替的清單。
- 已知與程式碼不符之處（改 compose 時已依程式碼修正，這裡的檔案不再修改）：
  - `websocket-deployment-patch.yaml` 的 `MAIN_API_URL` 應為 `MAIN_APP_URL`，且缺 `INTERNAL_API_KEY`
  - `pdf-service` 的 `CELERY_BROKER_URL` / `CELERY_RESULT_BACKEND` 程式碼不讀，只讀 `REDIS_URL`
  - `gradsystem` 的 512Mi 記憶體上限不足以跑 Puppeteer / Chromium
- `scripts/getenv.sh` 是當年從上游叢集匯出 secret 的開發者工具，與這裡的 manifests 一樣不再使用。

## 原本的部署流程（供對照）

GitHub Actions 在 ubuntu-latest 建映像推 Docker Hub（`chunchiehdev/gradsystem`、`chunchiehdev/websocket-server`），
再以 `kustomize edit set image` + `kubectl apply -k` 部署到兩個叢集（k3s、k8s），
Secret 由 CI 從單一 GitHub Secret 產生 `.secrets.env` 交給 kustomize `secretGenerator`。
Ingress 用 Traefik + cert-manager，`/socket.io` 轉 websocket、`/` 轉主程式。
