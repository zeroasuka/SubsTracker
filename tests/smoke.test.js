// @ts-check
/**
 * Smoke 測試 —— 僅驗證測試基礎設施本身能跑起來，不耦合業務程式碼。
 *
 * 後續 Task 會替換/擴充套件這裡的內容；現在保持最簡單：
 *   - 能 import vitest API
 *   - 能 import Cloudflare Workers env
 *   - 能跑一個 Hono 例項
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';

describe('smoke', () => {
  it('vitest 跑得起來', () => {
    expect(1 + 1).toBe(2);
  });

  it('Hono 可以例項化並響應請求', async () => {
    const app = new Hono();
    app.get('/', (c) => c.text('ok'));

    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });
});
