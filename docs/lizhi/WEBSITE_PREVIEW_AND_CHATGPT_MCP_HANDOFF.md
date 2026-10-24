# 立之 CAD｜網站尚未建立：網頁上線與 ChatGPT 原生 MCP 接入交接

修訂：2026-10-24
開發分支：`feature/lizhi-native-mcp-v0120`。
狀態：**沒有 CAD 網站／網址**；此文件不是已發布通知。

## 實際擁有什麼

1. `lihuany635-create/lizhi-cad` 是完整 CADCraft Rust 原始碼 Fork（上游 v0.12.0 基線），不是成品網站。
2. 網頁原始碼 `apps/cadcraft-web` 內含 CAD 引擎與 egui WebAssembly。已改頁面標題「立之 CAD」。`trunk build --release` 成功，在 [GitHub Actions 40106567649](https://github.com/lihuany635-create/lizhi-cad/actions/runs/40106567649) 存有 HTML、JS、WASM 候選包（GitHub artifact 非永久存放）。
3. `cargo build --release --package cadcraft` 產生 Linux 桌面候選執行檔；上述 Action desktop 與 Web job 均成功。**不代表網頁/桌面真正 UI E2E 測試已通過。**
4. GitHub Actions 40105514912 驗證 Rust 原生 MCP 19/19 tests、實際繪圖/修改/PNG/DXF 及新增唯讀拒絕；但沒有 HTTPS 遠端 MCP，也未綁 ChatGPT App。
5. 未將任何網頁部署成 GitHub Pages/Sites，沒有公開或私人 preview URL，沒有正式 CAD App 被修改、沒有持久圖面後端。

## 必須分清的三種執行環境

- **互動式 CAD 網頁**：目前能由 Rust 編譯到 WASM，使用者開網站後由**自己手機或電腦瀏覽器**執行繪圖。它不能直接讓關機中的本機電腦替 ChatGPT 執行工作。
- **遠端原生 CADCraft MCP**：ChatGPT 使用者授權後，遠端 Linux 執行器透過受保護的 MCP 進行 headless 繪圖；必須有 session/drawing ACL、圖面保存和版本管理。不可直接將 stdio、TCP desktop control 或任意檔案路徑對網際網路開放。
- **ChatGPT CAD App**：ChatGPT 中的使用者操作入口，需接到 HTTPS MCP 或已發布可存取的 App 後端；**不是單有 WASM 網站就會自動出現在 ChatGPT 對話**。

## 接下來做的網站階段（P2 分支工作）

A. 在隔離開發分支持續驗證 `trunk build --release` 與 desktop binary；從實際瀏覽器開啟 `dist/web/index.html` 的 HTTP 預覽，檢查 Canvas 能載入，畫線、畫矩形、存取 DXF、重新開啟。需要真實互動測試證據才列 UI PASS。

B. 選一個**不影響立之雲端庫正式站**的測試網址，例如公開 GitHub Pages（靜態入口和程式碼可被任何人讀取）或支持私人存取的 Hosting；依需求再確定公開／私人策略，不能憑空認定已公開。

C. 主機端只放靜態 HTML/JS/WASM；沒有明確授權不可加入 OAuth 金鑰、service-role token 或使用者私人 CAD 圖檔。使用者圖面先只保留在瀏覽器記憶體／授權本機檔案操作；日後另接私人儲存。

D. 完成部署後由真實手機／桌面開啟，驗證各主要操作、效能、失敗回報。取得真正的 HTTPS 網址後，才能請使用者驗收網站；若部署平台需要登入、網域、付費或公開權限決定，只在那個操作門檻再詢問使用者。

## 接下來做的 ChatGPT MCP 階段（P3～P6）

1. 清查使用者是否已有 ChatGPT CAD App；**網站尚未存在，不可要求現成網站連結**。若已有 App，更新其連線；若沒有，才建立新的 CAD App。
2. 給獨立 Linux CADCraft fork 引擎加最薄可信的遠端 MCP endpoint，保留原生工具語意；在後端實作身分 OAuth、scope、ACL、session sandbox、命令配額。
3. 實際對話中驗證 `new_drawing` → `command_line` / `execute` → `inspect_drawing` → `render` → `save`；檢驗重試和圖面修訂。
4. 圖面存雲端版本後，在使用者電腦關機時仍由 ChatGPT 驅動遠端 worker；GitHub Actions 按需執行可評估，但需有可靠觸發／持久儲存，不能只靠 workflow artifacts。
5. 工作台 P2 網站、P3 遠端 MCP、P4 ChatGPT App、P5 保存、P6 PC 關機各自驗收，不能因一個 build SUCCESS 就宣布產品完成。

## 重要限制

不要修改 Fork `main`、既有立之雲端庫正式 Site、Finance、正式 Supabase。未經同意不要發布公開網站、開通付費資源或把私人圖面投入公共 CI。

網站未上線之前，不再要求使用者提供 CAD 網站 URL。
