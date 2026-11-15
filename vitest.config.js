// @ts-check
/**
 * Vitest 配置檔案
 *
 * 用 @cloudflare/vitest-pool-workers 把單測跑在真實的 workerd 執行時裡，
 * 這樣 KV / fetch / crypto.subtle 等 Cloudflare 平臺 API 不需要 mock 即可工作。
 *
 * 用法：
 *   npm test          # 跑一次（CI）
 *   npm run test:watch # watch 模式
 */
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  // 讓 vite 把 .html 當作文字字串 import（與 wrangler 生產環境的 text loader 行為一致）
  assetsInclude: ['**/*.html'],
  test: {
    include: ['tests/**/*.test.js'],
    poolOptions: {
      workers: {
        miniflare: {
          compatibilityDate: '2024-09-23',
          compatibilityFlags: ['nodejs_compat'],
          kvNamespaces: ['SUBSCRIPTIONS_KV']
        },
        // 讓生產環境用的 .html 文字 import 在測試中也能工作
        wrangler: {
          configPath: './wrangler.toml'
        }
      }
    }
  }
});
