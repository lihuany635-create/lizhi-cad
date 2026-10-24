# 立之 CAD｜參照「立之圖書館」的本機優先架構 v2.1

決策：2026-10-25。此文件**取代**早期「獨立雲端 CAD Worker／PostgreSQL 永久儲存／電腦關機仍可遠端直接繪圖」產品方向。**禁止在沒有使用者另行批准前新增雲端 CAD 運算服務。**

## 一、來源調查（實際閱讀既有立之圖書館原始碼）

參考 GitHub 倉庫 [lizhi-cloud-web](https://github.com/lihuany635-create/lizhi-cloud-web) `main`：
- `library/library-computer.js`：Chrome／Edge `showDirectoryPicker()` 讀使用者明確選取的電腦資料夾；`IndexedDB` 保留裝置授權 handle，只掃描索引，**不預設上傳電腦原檔**。
- `library/library-device.js`：手機與桌面裝置透過 File System Access API 管理使用者選擇的資料夾；裝置憑證／檔案 handle 留在此裝置。
- `library/library-store.js`：館藏來源 `cloud|device|computer`；原檔在手機／電腦時讀本機檔，不能因為雲端有文字摘錄就假裝有電腦原檔。
- `supabase/functions/library-mcp/index.ts`、`library/MCP.md`：ChatGPT 授權的 HTTPS Streamable MCP + Supabase OAuth 2.1 JWT / RLS；`status/list/search/get_excerpt` **僅查索引／已同步摘錄**，不下載私人原檔，也不能改本機檔案。
- `library/ARCHITECTURE_V2.md`：Windows Library Host 是尚未完成的後續設計，不能說它已能遠端讀取斷線電腦的原檔。
- 查詢現有圖書館 MCP `status` 時遭回覆「請求額度無法驗證」；**不據此宣稱正式 MCP 即時服務可用**，但 GitHub 程式與文件架構已核實。

**關鍵區別：圖書館並非完全零雲端。** 它的索引、OAuth、MCP 入口採既有 Supabase。使用者的要求是 **「將獨立雲端 CAD 引擎／雲端 CAD 服務從本 CAD 計畫去除」**，不是授權我們直接破壞正在使用的圖書館服務或現有 Supabase。CAD 若要從 ChatGPT（非本機）讀到同步狀態，仍需要一個能連線的已授權 MCP 入口；此入口不應執行 CAD 幾何運算。

## 二、正式架構（本機優先；沒有新雲端 CAD 運算環境）

```text
ChatGPT 一般對話（不使用 ChatGPT Work）
       |
       | 已授權的 MCP：查詢圖面索引／排程待執行指令
       v
沿用「圖書館式」安全介接思路（身份、RLS、授權、最小工具）
       | 只傳有限 metadata / 指令草稿（若使用者啟用同步）
       v
使用者開啟「立之 CAD」網站／桌面程式
       |
       +-- WebAssembly CADCraft Rust 引擎，在使用者瀏覽器本機執行幾何編輯
       +-- 桌面 CADCraft 本機引擎與原生 stdio MCP
       +-- 由使用者選取 DXF 資料夾，原圖留在裝置並可人工匯出／備份
       +-- 預覽 SVG／PNG、圖元資訊、版次（明確同意才同步摘要）
```

沒有雲端 CAD worker、遠端 Rust CLI 排程執行器、為 CAD 新建的 PostgreSQL 長期圖面資料庫、S3 圖面存放或要求電腦關機仍要由雲端代理即時編修。GitHub Actions **只用於原始碼編譯、測試、發布候選包**。

### 本機 CAD 編輯（真實效果）

- 網頁打開時，使用已經建置完成的 CADCraft WebAssembly UI 畫圖、開啟 DXF、儲存 DXF。
- 將圖面與版本放在使用者明確選定的裝置資料夾；只有使用者操作授權時才可讀寫。
- 沿用圖書館的 File System Access API／IndexedDB 本機授權 handle 方式；支援沒有 `showDirectoryPicker` 的瀏覽器採檔案匯入、下載備援。
- 在瀏覽器關閉、裝置離線或電腦關機時，**不可聲稱 ChatGPT 能直接操作該裝置 CAD 引擎**。已同步的索引可以讓 ChatGPT 看狀態，但原生圖面與新幾何修改須在裝置開啟、被授權、具可用執行階段時才能進行。

### ChatGPT MCP（權限與資料最小化）

- 原生 Rust `cadcraft-cli mcp` 保留在自有 Fork；桌面程式啟動時可以由受信任本機 connector 使用，不將 stdio／本機桌面控制埠暴露至公網。
- 用和圖書館類似的 **OAuth 認證、限流、工具列表、RLS 與遠端只讀索引** 來整合 ChatGPT；圖書館現有 `library-mcp` 是**唯讀**，不可假定改寫成 CAD 工具就具有修改權。
- 如需要跨對話提出編輯需求，可建立 **受限的 CAD 指令草稿／待執行佇列**：ChatGPT 可在 MCP 上產生「下次裝置上線後執行」的提案，裝置連線後經權限檢查／使用者確認才在本機執行，執行結果與修訂版號按使用者選擇同步。
- 不傳 DXF 原檔或本機完整路徑到 MCP；僅有限 drawingId、檔名、版次、預覽或經同意的索引資料。所有文字回傳都視為不可信輸入。
- 既有 Supabase OAuth 可能與其他業務表 RLS 共用，正式擴充前必須參照 `docs/OAUTH_MCP_SECURITY_REVIEW_20261023.md` 檢查第三方 OAuth client 直接取用其他資料表的問題。**不能為了 CAD 改動正式 OAuth Server、資料庫政策或新增寫入工具而跳過授權與風險審核。**

## 三、新版 P0～P8 階段

| 階段 | 新目標 | 現況 |
|---|---|---|
| P0 | 核對圖書館 local-file + OAuth MCP 模式、CAD 編輯權限，移除 cloud-first 偏誤 | GitHub 實際查核完成，調整計畫中 |
| P1 | 自有完整 CADCraft Rust Fork | 已完成 |
| P2 | CADCraft 網頁 WASM／桌面本機程式，裝置資料夾 DXF 開啟、編輯、保存與版本 | Fork 可編譯、Chromium 真實矩形及 DXF roundtrip 已通過；裝置資料夾仍需實作 |
| P3 | 原生 CADCraft MCP 與本機受限操作工具；必要的最薄「圖書館式」遠端索引 MCP | Native MCP 20/20、受限模式與 loopback HTTP PoC 已通過；ChatGPT OAuth 仍未整合 |
| P4 | 確認／建立 ChatGPT CAD App，接圖面索引與受權本機操作／離線待辦，不要求 CAD 公開網站已存在 | 未完成 |
| P5 | 本機 DXF 版次、資料夾授權與索引／選擇性同步（**不要求新的雲端圖面 DB**） | 本機版控、PostgreSQL staging 測試通過；正式本機裝置資料夾 UX 未完成 |
| P6 | 電腦／手機離線行為、授權中止、下次開啟後安全續作驗收（**不要求關機遠端繪圖**） | 待實作 |
| P7 | 與立之雲端庫工程中心同一圖面與工作紀錄整合 | 待實作 |
| P8 | 自有 CAD 發布、裝置／瀏覽器／ChatGPT MCP 整體回歸 | 待實作 |

## 四、明確移出產品主線的內容（留檔，不要把已做測試刪掉）

- 刪除原 P6「個人電腦完全關機，手機 ChatGPT 仍可讓遠端 Rust 幫忙繪圖」作為驗收門檻。
- 不再規劃租用雲端 CAD 伺服器／VM／GPU、持續存在的雲端 CADCraft worker、由 GitHub Actions 提供即時 CAD 工作。
- 不再要求 PostgreSQL/S3 保存 DXF 原檔作為產品條件；過去 P5 `Postgres 9/9`、SQL RLS/CAS 真實 CI **保留歷史技術成果，但不列為新方案部署進度**。
- `services/lizhi-cad-mcp-dev` 的 loopback HTTP PoC 及本機版控可重用；不得直接把 dev Bearer token gateway 公開。
- 官方圖書館的 OAuth/MCP 是現有可參照架構，**不是已經有可讓 ChatGPT 直接寫 CAD 的工具**。

## 五、下一輪必做（優先不需使用者授權的項目）

1. 給 CAD 網頁版加入「選擇本機資料夾／重新授權／儲存 DXF 與版次」的功能；對不支援的裝置採 import/download。
2. CI／Playwright 驗真實檔案開啟、矩形、CAD 測量、檔案存回所選資料夾、再次載入、版本復原及權限拒絕。
3. 繼續修補原生 MCP 的本機安全範圍，清楚列出可執行與不可執行工具；設計 ChatGPT 對話的草稿／待辦工具，不允許任意本機 OS 路徑。
4. 查核或建立實際 ChatGPT CAD App 身分／授權（如需要對話跨裝置索引，延用既有圖書館認證思路），先在隔離測試環境，正式上線另需使用者同意。
5. 每次結果登記立之雲端庫工作台；不修改 main、正式 Supabase、正式網站與使用者真實圖面。

**目前目標已更新：沒有獨立雲端 CAD 執行器，也不再以關機即時繪圖作為完成標準。**
