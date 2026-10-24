# LiZhi CAD native MCP — loopback-only HTTP developer harness

**僅供隔離開發／自動化測試，嚴禁對公網發布。** 這個 Node 程式不是另一套 CAD 引擎，而是薄型 HTTP→原生 `cadcraft-cli mcp` JSON-RPC 轉接器，每個 MCP session 啟動一份**本 Fork 自原始碼編譯的 CADCraft Rust CLI**，畫圖、查詢及渲染都由原生 Rust 執行。

程式：`server.cjs`；真實 E2E：`dev-http-smoke.cjs`；自動化驗收：`.github/workflows/lizhi-native-mcp-ci.yml`。

## 本地試跑（只綁 127.0.0.1）

從 Fork 分支編譯：

```bash
cargo build --locked --release --package cadcraft-cli
node services/lizhi-cad-mcp-dev/dev-http-smoke.cjs "$PWD/target/release/cadcraft-cli" cad-evidence/http-dev
```

手動啟動（測試金鑰由本機安全產生，不得提交）：

```bash
export LIZHI_CAD_CLI="$PWD/target/release/cadcraft-cli"
export LIZHI_CAD_MCP_DEV_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
node services/lizhi-cad-mcp-dev/server.cjs
```

啟動後會輸出本機 URL。所有 `POST /mcp`、`DELETE /mcp` 呼叫都必須送 `Authorization: Bearer <本機測試金鑰>`。絕不可把測試金鑰放入瀏覽器源碼、ChatGPT 提示詞或 GitHub 公開檔案。

## 已實作的「隔離測試用」護欄

- HTTP 僅 `127.0.0.1`，明確比對 `Host` 與 `Origin`，拒絕外站 Origin，拒絕無效 Bearer；`GET /mcp` 回 405（此原型不支援 SSE）。
- 可選 2 個獨立 MCP sessions；每 session 是獨立 native Rust CLI 進程，`Mcp-Session-Id` 為 24 bytes 隨機數；`DELETE` 撤銷。
- 原生 MCP 強制 `LIZHI_CAD_MCP_GEOMETRY_ONLY=1`：只允許 `execute` 的明確幾何指令白名單、`new_drawing`、讀圖查詢與預覽；不開放 `command_line`、`script`、`open`、`save`、桌面點擊；`render(path)` 拒絕，預覽邊長上限 4096。
- 逐 request JSON 64 KiB 上限、原生請求逾時、5 分鐘無活動清理、同 session 排隊以防 response ID 競爭；不記錄金鑰、圖面或用戶資料。
- 只在暫存目錄執行，結束時回收。沒有正式使用者檔案與秘密金鑰，沒有正式雲端持久保存；可選的 P5 測試版只支援本機資料夾。


## P5 測試用 DXF 版本保存（不代表正式雲端儲存）

新增 `drawing-store.cjs` 與 `drawing-mcp-integration-test.cjs`，使用本機**服務端專用目錄**保存不可變 ASCII DXF 檔及 SHA-256 驗證 metadata：

- 受信任服務端配置的 `ownerId`，加上 `drawingId` 作存取命名空間；**不得讓 ChatGPT 輸入或選擇 ownerId**。
- 透過 `expectedRevision` 樂觀鎖拒絕過期提交；同一 Node 進程內排隊防止並行覆蓋。
- `LIZHI_CAD_MCP_GEOMETRY_ONLY=1` 仍是 native MCP 預設。額外的 `lizhi_internal_snapshot_save/open` **不出現在 tools/list**，只接受每個 Rust 進程專用的 256-bit capability；檔案路徑只從進程環境變數取得，且限固定沙盒檔 `native-snapshot.dxf`，不接受來自 ChatGPT 的路徑。
- 可選啟用 `storeRoot/ownerId` 的 loopback dev Gateway 才會宣告四個版本工具：
  - `lizhi_create_drawing({drawingId})`
  - `lizhi_save_revision({expectedRevision})`
  - `lizhi_open_revision({drawingId,revision?})`
  - `lizhi_list_revisions({drawingId})`
- 單進程／本機資料夾版控不是分散式事務，沒有 OAuth／永久雲端備份／多主機鎖，也不支援 DWG 或二進位 DXF 保存承諾。

以下為開發環境**測試**方式；目錄與 token 不可放在公開 GitHub：

```bash
node services/lizhi-cad-mcp-dev/drawing-store-test.cjs
node services/lizhi-cad-mcp-dev/drawing-mcp-integration-test.cjs "$PWD/target/release/cadcraft-cli" cad-evidence/revisions
```

啟動帶持久版控的本機閘道時，可額外設置 `LIZHI_CAD_MCP_DEV_STORE`（本機絕對目錄）及 `LIZHI_CAD_MCP_DEV_OWNER`（受信任服務端定義的 ownerId）。絕不可把此開發者 token 橋接器直接放在網際網路。

## 為什麼現在還不能在 ChatGPT 直接連接？

這不是可在網際網路使用的遠端 MCP 服務，既沒有 OAuth 2.1 PKCE 授權伺服器，也沒有依使用者／drawingId 的權限隔離和持久圖面服務。它**只用來證明 Streamable HTTP 可轉發原生 CADCraft MCP 而不另造繪圖引擎**。

真正可接 ChatGPT 的產品還必須：
1. 在獨立私人雲端部署受信任的 HTTPS 入口、OAuth 授權碼＋PKCE、完整 JWT issuer/audience/scope 驗證；絕不可將固定 developer Bearer Token 當成使用者 OAuth。
2. 每位使用者與每張圖隔離 session、儲存、工具權限；僅由後端代表經驗證的 drawingId 進行原生 `open/save`，不可讓模型自行指定作業系統檔案路徑。
3. 有可持久保存 DXF／版本與工作佇列的雲端環境。PC 關機時仍可畫圖是一個獨立完整驗收。
4. 確認 ChatGPT 帳戶／工作區目前支援的 MCP App 建立與**寫入權限**，並在一般對話驗證。現階段未有遠端 HTTPS、正式 App、OAuth 或 ChatGPT 實際 tool invocation。

原生 MCP headless stdio 的保護是必要但非充分條件；一切正式上線要通過資安、安全性及個人資料測試，使用者授權後再部署。
