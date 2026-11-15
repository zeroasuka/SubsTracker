// @ts-check
/**
 * API 路由相容性 smoke 測試
 *
 * 驗證 Hono 應用與既有客戶端的路由響應嚴格相容：
 * - 未授權時返回 401 + 同樣的錯誤結構
 * - 公開端點（登入頁、登入介面）行為一致
 * - 4xx/5xx 錯誤格式與既有約定一致
 */
import { describe, it, expect, beforeEach } from 'vitest';
// @ts-ignore
import { env } from 'cloudflare:test';
import app from '../../src/app.js';

async function clearKv() {
  const list = await env.SUBSCRIPTIONS_KV.list();
  await Promise.all(list.keys.map((k) => env.SUBSCRIPTIONS_KV.delete(k.name)));
}

beforeEach(clearKv);

describe('Hono app 路由相容', () => {
  it('GET / 未登入返回登入頁 HTML', async () => {
    const res = await app.request('/', {}, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<!DOCTYPE html');
  });

  it('GET /admin 未登入跳回 / (302)', async () => {
    const res = await app.request('/admin', {}, env);
    expect([302, 200].includes(res.status)).toBe(true);
  });

  it('GET /api/subscriptions 未登入返回 401 + 標準錯誤體', async () => {
    const res = await app.request('/api/subscriptions', {}, env);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(typeof json.message).toBe('string');
  });

  it('POST /api/login 缺少 body → 400/401', async () => {
    const res = await app.request('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json'
    }, env);
    expect([400, 401].includes(res.status)).toBe(true);
    const json = await res.json();
    expect(json.success).toBe(false);
  });

  it('POST /api/login 正確憑據 → success + Set-Cookie', async () => {
    // 配置預設管理員
    await env.SUBSCRIPTIONS_KV.put(
      'config',
      JSON.stringify({ ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'password', JWT_SECRET: 'k' })
    );
    const res = await app.request('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'password' })
    }, env);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(res.headers.get('Set-Cookie') || '').toContain('token=');
  });

  it('GET /debug 未登入返回 401', async () => {
    const res = await app.request('/debug', {}, env);
    expect(res.status).toBe(401);
  });

  it('GET /api/未知端點 → 404 + 標準錯誤體', async () => {
    // 先登入拿 cookie
    await env.SUBSCRIPTIONS_KV.put(
      'config',
      JSON.stringify({ ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'password', JWT_SECRET: 'k' })
    );
    const loginRes = await app.request('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'password' })
    }, env);
    const cookie = loginRes.headers.get('Set-Cookie')?.split(';')[0] || '';

    const res = await app.request('/api/non-existent-route', {
      headers: { Cookie: cookie }
    }, env);
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.success).toBe(false);
  });

  it('未匹配路徑走兜底 → 返回登入頁', async () => {
    const res = await app.request('/random/path/xyz', {}, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<!DOCTYPE html');
  });
});
