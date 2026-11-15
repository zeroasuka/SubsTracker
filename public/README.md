# public/

Workers Assets 靜態資源目錄。客戶端 JS / CSS / 獨立 HTML 頁面放在這裡，
由 wrangler 自動打包並通過 ASSETS binding 服務到根路徑下：

- `public/js/lib/*.js`  → 瀏覽器訪問 `/js/lib/<name>.js`
- `public/js/pages/*.js` → 瀏覽器訪問 `/js/pages/<name>.js`
- `public/css/*.css`    → 瀏覽器訪問 `/css/<name>.css`

注意事項：

- 既有頁面（`adminPage.html` / `configPage.html` 等）由 `src/views/` 下的
  text-import 提供，瀏覽器側無須改動。新功能的客戶端 JS 優先放進本目錄，
  避免汙染已有 HTML。
- 不要把敏感資訊放進 `public/`（公網可讀）。
