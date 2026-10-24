# 立之 CAD｜原生 MCP × 圖面版本與 PostgreSQL 接線紀錄（2026-10-25）

## 此階段正確狀態

目前進行 P3／P5：**自有完整 CADCraft Rust Fork 原生繪圖引擎＋受限幾何 MCP**，並提供兩種測試用版本儲存：

1. 本機不可變 ASCII DXF store，`services/lizhi-cad-mcp-dev/drawing-store.cjs`，經 GitHub CI [40112732996](https://github.com/lihuany635-create/lizhi-cad/actions/runs/40112732996) 13/13 本機版控、SHA-256、越權／symlink 防護測試 PASS。
2. 與 source-built 真正原生 CADCraft MCP 結合的本機 http developer gateway： [40113867779](https://github.com/lihuany635-create/lizhi-cad/actions/runs/40113867779) 在 20/20 Rust、13/13 store、9/9 真實原生 DXF 建圖／三版修訂／跨會話重開／服務重啟 PASS。
3. PostgreSQL 16 `services/lizhi-cad-mcp-dev/postgres/001_revision_store_staging.sql`：存 `drawing_heads` 與 `drawing_revisions`，以 PostgreSQL 交易、row lock、FORCE RLS、BYTEA DXF（8 MiB 上限）、SHA256、`expectedRevision` CAS 保證同資料庫內原子版本提交。 [40115092331](https://github.com/lihuany635-create/lizhi-cad/actions/runs/40115092331) 已完成 CI PASS（包含 2 條不同連線爭奪同一版本、1 成功 1 衝突、不同程序讀回）。
4. PostgreSQL 真實 CADCraft MCP 接線：`postgres/adapter.cjs` + `server.cjs` + `drawing-mcp-integration-test.cjs`，正在 [40115490002](https://github.com/lihuany635-create/lizhi-cad/actions/runs/40115490002) 使用臨時 PG16、Rust source-built CLI 和真實 HTTP JSON-RPC 驗收。**成功以前不可宣稱已通過**。

## 原生工具和隱藏存檔能力

- MCP 對正常使用者僅開放 `execute`（受限幾何命令）、`inspect_drawing`、`query_entities`、`render` 等允許工具。
- 若啟用 `DrawingStore` 或 `PostgresDrawingStore`，developer gateway 另外提供 `lizhi_create_drawing`、`lizhi_save_revision`、`lizhi_open_revision`、`lizhi_list_revisions`，但**不**提供原生 `open`／`save` 任意路徑工具。
- 真正 DXF 儲存／重新開啟由 Rust 原生 MCP 隱藏 `lizhi_internal_snapshot_save/open` 完成；每進程 256-bit capability、固定工作沙盒 `native-snapshot.dxf`，一般 tool list 不宣告此能力，無法由模型指定路徑。
- 目前 gateway **只**綁定 `127.0.0.1` 且用測試 Bearer 權杖；沒有 OAuth，也沒有正式可讓 ChatGPT 遠端連線的 HTTPS endpoint。
- PostgreSQL adapter 的 `ownerId` 必須由受信任伺服器的**已驗證身份**注入，不接受來自 ChatGPT 的自由輸入。資料庫自訂 GUC `lizhi_cad.owner_id` 可被有任意 SQL 權限的 client 篡改，故 **Postgres runtime role 絕不可發給瀏覽器或使用者**；正式多租戶端點需驗證 OAuth 2.1 bearer、scope/audience，並使用適當資料庫角色與 RLS 安全稽核。

## 目前尚未完成的正式產品功能

- **沒有 CAD 網站已上線**；只有來源建置成功的 HTML/JS/WASM 與 Chromium 真實繪圖測試結果。
- **沒有 ChatGPT CAD App 已連接此遠端 MCP**；使用 CAD 時不要求使用 ChatGPT Work，但目前尚不可從一般對話呼叫。
- **沒有正式 Supabase migration 已套用**；所有 PG 測試使用 GitHub Actions 的短暫 PostgreSQL 16 容器，不碰立之雲端庫正式 DB。
- **沒有 PC 關機仍可繪圖的雲端 E2E**；CI 跑過不是使用者可重複、可授權的長期服務。
- **沒有真實使用者跨帳號權限／JWT 驗證**；單個 developer Bearer token 與測試 RLS 不是 production OAuth。
- **沒有正式備份／多區域容災**；PostgreSQL BYTEA 是測試選項，未評估正式儲存成本和可擴充性。

## 正確下一步

1. 取得 PostgreSQL + Native MCP CI 真實結果，若失敗就讀日誌修正，不可只把 run URL 當 PASS。
2. 以 staging 實作真正的 OAuth 2.1 授權、user/drawing ACL、HTTPS remote MCP；避免正式環境直接對外開放 Node developer gateway。
3. 決定 CAD 預覽網站私人或公開部署方式，正式部署前測試完整 WASM UI 以及手機／桌面。
4. 以獨立雲端引擎完成 PC 關機 E2E，再將版次與圖面讀寫接入立之雲端庫工程中心。

目前修改僅位於 `lihuany635-create/lizhi-cad` 的 `feature/lizhi-native-mcp-v0120`，**未合併 main**，未使用正式站、付費主機或真實私人工程圖。
