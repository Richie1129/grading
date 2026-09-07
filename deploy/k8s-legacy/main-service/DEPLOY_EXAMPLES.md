# Kustomize secretGenerator 部署指南

## 運作原理

```mermaid
graph LR
    A[GitHub Secret] -->|CI 產生| B[.secrets.env]
    B -->|Kustomize 讀取| C[secretGenerator]
    C -->|產生帶 Hash 的| D[gradsystem-secret-xxx-8h488h9b9g]
    D -->|Hash 改變| E[Deployment 自動更新]
```

| 特性 | 說明 |
|------|------|
| **自動 Hash** | Secret 名稱自動加上內容 Hash |
| **自動 Rollout** | Hash 改變時觸發 Pod 更新 |
| **GitOps 友好** | `.secrets.env` 不進 git |

---

## 目前採用方式：存入 Github Secret

把 **整個 `.secrets.env` 內容** 存成單一 GitHub Secret，CI 一行產生檔案。

### GitHub Secrets 設定

| Secret 名稱 | 用途 |
|-------------|------|
| `DEV_K3S_ENV_FILE` | dev-k3s 的完整環境變數 |
| `PROD_K3S_ENV_FILE` | prod-k3s 的完整環境變數 |
| `DEV_K8S_ENV_FILE` | dev-k8s (Mars) 的完整環境變數 |
| `PROD_K8S_ENV_FILE` | prod-k8s (Mars) 的完整環境變數 |

### `.secrets.env` 內容範例

```properties
DATABASE_URL=postgresql://user:pass@db:5432/db
REDIS_PASSWORD=your-redis-password
MINIO_ROOT_PASSWORD=your-minio-password
AUTH_SECRET=your-auth-secret
GEMINI_API_KEY=your-gemini-key
# ... 其他變數
```

### CI 核心邏輯

```bash
# 1. 產生 .secrets.env
printf "%s" "${{ secrets.PROD_K3S_ENV_FILE }}" > $OVERLAY/.secrets.env

# 2. 部署
kubectl apply -k $OVERLAY

# 3. 清理
rm -f $OVERLAY/.secrets.env
```

### 優點

- 新增變數只需編輯 GitHub Secret，不用改 `deploy.yml`
- 不管多少變數，CI 都只有一行
- `.secrets.env` 不會進入 git

### 缺點

- 每次新增變數，都要更新 GitHub Secret 且要連帶將之前設定的重新貼回去一次，不然會覆蓋原先的設定。
