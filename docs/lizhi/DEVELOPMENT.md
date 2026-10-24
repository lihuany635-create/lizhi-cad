# LiZhi CAD｜自有 CADCraft Fork 開發與驗收

- 本倉庫是 [CADCraft](https://github.com/storytold/cadcraft) 的**獨立修改版**，不是 ArtCraft 官方發行。原始作者：© 2026 ArtCraft Team and CADCraft contributors。
- 來源：`storytold/cadcraft`，固定開發基線 `v0.12.0` / `bad1073fdf10a521949f6b542837b564719d0023`。
- 原始 Fork：`lihuany635-create/lizhi-cad`；本輪工作：`feature/lizhi-native-mcp-v0120`。
- 使用方式目標：一般 ChatGPT 對話使用已發布 CAD App → 經本人授權與沙盒隔離 → **原生** CADCraft MCP → 自有 Rust CAD 引擎 → 私人圖面版本。使用 CAD 不需要 ChatGPT Work。
- 2026-10-24：本分支修改的是 Rust MCP 安全控制；**尚未部署遠端服務或正式連接 ChatGPT CAD App**。

## 重新編譯與測試

建議 Rust 1.95（以實際 CI 設定為準），從本 Fork 工作分支：

```bash
cargo test --locked --package cadcraft-mcp --lib
cargo build --locked --release --package cadcraft-cli
node scripts/lizhi-native-mcp-smoke.cjs "$PWD/target/release/cadcraft-cli" "$PWD/cad-evidence/full"
node scripts/lizhi-native-mcp-smoke.cjs "$PWD/target/release/cadcraft-cli" "$PWD/cad-evidence/readonly" --readonly
```

由 [Fork 專屬 GitHub Actions](../../.github/workflows/lizhi-native-mcp-ci.yml) 在乾淨 Linux runner 上執行，實際結果以該 GitHub workflow 的 commit/結論/圖檔證據為準。

## 原生 MCP 權限保護的第一步

現有 `cadcraft-cli mcp` 是 stdio JSON-RPC；**沒有內建 ChatGPT 帳號 OAuth**。

- 原本不帶 `LIZHI_CAD_MCP_READ_ONLY`：保留 CADCraft 正常繪圖、修改、開啟與儲存能力（可信本機使用）。
- `LIZHI_CAD_MCP_READ_ONLY=1` 啟動的 stdio MCP：`tools/list` 僅列 `list_commands`、`inspect_drawing`、`query_entities`、`find_text`、`render`；`render` 不列出輸出 `path`，若硬傳 `path` 仍會在 dispatch 階段拒絕；繪圖、檔案操作及 GUI 點擊也會拒絕。
- **安全性界線**：這是某個受信任 process 的只讀開關，**不是每位 ChatGPT 使用者的認證或 drawingId ACL**。不可單獨將 stdio 或桌面控制埠暴露到 Internet。寫入模式需後續可信身份驗證、明確使用者授權、沙盒檔案路徑／會話隔離、版本衝突防護和指令限制。

## 商標、授權與發布前檢核

- 複製原碼時保留 `LICENSE-MIT`、`LICENSE-APACHE`、`NOTICE`、`ATTRIBUTION.md`、第三方著作權；`acadrust` 包含 MPL-2.0 的依賴義務，應獨立核對。
- 根據上游 `docs/brand/LICENSE-brand.txt`，**ArtCraft Marks 不是 MIT/Apache 開源素材**；本修改分支已將 8 個 `docs/brand/artcraft-logo*/artcraft-mark*` 圖檔從 HEAD 刪除，保留原商標授權文字以供稽核；README 亦改為獨立 Fork 描述。
- 發布前仍需檢查**桌面包裝、app icon、UI、文案、網頁與所有第三方依賴**，確認沒有讓使用者誤以為由 ArtCraft 官方製作、背書或提供服務。
- 本 Fork `main` 是原上游複製基準；品牌/原生 MCP 修改僅在開發分支，尚未合併、發布或替換上游官方應用。

## 下一步

1. 完成這個 Fork 原始碼編譯、原生 stdio MCP「繪圖」與「唯讀阻擋」CI，保留真實 DXF/PNG 與測試記錄。
2. 測桌面 egui 與 WebAssembly 網頁版可編譯／運行，調整自有 CAD UI 品牌及產品標識。
3. 確認使用者已發布的 ChatGPT CAD App 的實際 ID、遠端 MCP 連線方式／權限。
4. 增加安全遠端 session bridge、本人 OAuth、drawing ACL、原生圖面保存及版本。
5. 再驗收個人 Windows 電腦關機仍能透過一般 ChatGPT 繪圖；評估免費按需 GitHub Actions 或獨立 Worker。不得用 CI 成功替代關機遠端使用驗收。
6. 接入立之雲端庫工程中心，保持既有正式 DB/Finance/main 不受影響。

此文件是工程開發紀錄，不能用來冒充正式軟體上線或 ChatGPT App 連線成功。
