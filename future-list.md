# 未來清單 (Future List)

## 前言

這份文件是本專案的**未來工作中央帳本**。任何「目前刻意不做、但未來可能要做」的項目都進這裡，不要散落在各個計畫文件末端。格式與同機部署的 SDL 專案 `future-list.md` 一致。

**使用規則**

1. 新增未來項目時**優先加到此檔**；其他文件最多用一行「詳見 `future-list.md` F00X」引用
2. 每個項目照下方欄位填寫；無法填寫的欄位明確寫「—」，不要跳過
3. 狀態變更時**保留舊狀態歷史**（在狀態欄位用「`backlog → scheduled (2026-05-01)`」格式）
4. 做完的項目**不要刪除**，狀態改為 `done` 並保留
5. ID 一旦指派就永久綁定，新項目遞增（F001, F002...），**不重用**

---

## 欄位定義

| 欄位 | 必填 | 說明 |
|---|---|---|
| **ID** | ✅ | 全局唯一識別碼，格式 F###，遞增分配，**不重用** |
| **標題** | ✅ | 一句話描述項目 |
| **類別** | ✅ | Backend / Frontend / DevOps / Data / Education / Research / Security |
| **狀態** | ✅ | `backlog` / `evaluating` / `scheduled` / `done` / `dropped` |
| **優先級** | ✅ | `P0`（最高，若觸發條件成立立刻做）/ `P1` / `P2` / `P3`（最低，長期理想） |
| **建立日期** | ✅ | YYYY-MM-DD |
| **提案來源** | ✅ | 哪個 PR、commit、文件章節、對話中提出 |
| **為什麼現在不做** | ✅ | 刻意延後的原因。這是**最核心的欄位**，避免重複討論「為什麼不做」 |
| **觸發條件** | ✅ | 什麼訊號出現才值得動手。沒有這條等於無限延後 |
| **怎麼做** | ✅ | 實作路徑草稿，讓接手者不用從零開始想 |
| **估計工作量** | ✅ | `S`（<4 小時）/ `M`（0.5-1 天）/ `L`（>1 天，需拆成 PR）/ `XL`（需另開 spec） |
| **依賴 / 前置條件** | 選填 | 需要另一個項目先完成、DB migration、外部系統等 |
| **風險 / 副作用** | 選填 | 做了會影響什麼、回滾難度、有沒有不可逆操作 |
| **替代方案** | 選填 | 若不做此項、是否有輕量替代 |
| **相關檔案** | 選填 | 具體檔案路徑，讓查找起點明確 |

---

## 項目清單

### F001: 自建 pdf-service 映像，取代 Docker Hub mirror

- **類別**：DevOps
- **狀態**：`backlog`
- **優先級**：P2
- **建立日期**：2026-09-07
- **提案來源**：部署到 192.168.30.111 的第零步評估與第一步計畫（見 `docs/DEPLOY.md`）
- **為什麼現在不做**：
  - pdf-service（FastAPI + Celery + MarkItDown）的原始碼不在本 repo。原本以為要向原開發者索取，盤點後發現上游 `chunchiehdev/grading-pdf` 是公開 repo，Docker Hub 的 `master` tag 對應其 HEAD commit `68e454e`（2025-05-30）
  - 目前以部署上線為優先，先沿用已驗證可用的映像：CI 的 `mirror-pdf` job 以 digest 從 Docker Hub 複製到 `ghcr.io/richie1129/grading-pdf`，compose 以 digest 釘死，不依賴上游 tag 存活
  - 自建需要先審視其 Dockerfile 與 Python 相依（python 3.10、markitdown[all]、celery），並做一次 PDF 回歸，不是幾分鐘的事
- **觸發條件**（任一成立）：
  - 上游映像被刪除或 Docker Hub 拉取失敗（mirror job 失敗）
  - 需要升級 Python / markitdown / celery 修安全漏洞
  - 需要改 pdf-service 行為（檔案大小上限、輸出格式、逾時）
- **怎麼做**：
  1. fork `chunchiehdev/grading-pdf` 到 `Richie1129/grading-pdf`（或以 git subtree 收進本 repo 的 `services/pdf/`）
  2. 加 workflow 用 GITHUB_TOKEN build 並推到 `ghcr.io/richie1129/grading-pdf:<sha>`；Dockerfile 順便加非 root 使用者，compose 就不需要 `user:` 覆寫
  3. 改 `deploy/docker-compose.server.yml` 的 `pdf-api` / `pdf-worker` 映像來源為 tag，移除 `deploy.yml` 的 `mirror-pdf` job 與 `PDF_DIGEST`
  4. 用既有的 PDF 作業做回歸，比對解析結果與 `uploaded-file` 的 parse status
- **估計工作量**：`M`
- **依賴 / 前置條件**：ghcr 推送權限；上游 repo 仍可存取（若已不可存取，從 mirror 映像的 `/app` 反推原始碼亦可，pyproject 與 app/ 都在映像內）
- **風險 / 副作用**：markitdown 新版輸出格式若改變，主程式收到的 Markdown 可能不同，影響評分上下文；需回歸
- **替代方案**：維持 mirror，只在上游更新時手動改 digest
- **相關檔案**：`deploy/docker-compose.server.yml`、`.github/workflows/deploy.yml`、`app/services/pdf-parser.server.ts`

---
