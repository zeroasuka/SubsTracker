// @ts-check
/**
 * 認證相關測試
 * 覆蓋：登入成功/失敗、限流、登出、JWT 簽名與過期校驗
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
// @ts-ignore
import { env } from 'cloudflare:test';
import app from '../../src/app.js';
import { generateJWT, verifyJWT } from '../../src/core/auth.js';

async function clearKv() {
  const list = await env.SUBSCRIPTIONS_KV.list();
  await Promise.all(list.keys.map((k) => env.SUBSCRIPTIONS_KV.delete(k.name)));
}

async function seedAdmin() {
  await env.SUBSCRIPTIONS_KV.put(
    'config',
    JSON.stringify({
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'password',
      JWT_SECRET: 'test-secret-key'
    })
  );
}

beforeEach(clearKv);
afterEach(() => {
  vi.useRealTimers();
});

describe('POST /api/login', () => {
  it('正確憑據 → 200 + Set-Cookie token', async () => {
    await seedAdmin();
    const res = await app.request(
      '/api/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'password' })
      },
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(res.headers.get('Set-Cookie') || '').toMatch(/token=/);
    expect(res.headers.get('Set-Cookie') || '').toMatch(/HttpOnly/i);
  });

  it('錯誤密碼 → success=false', async () => {
    await seedAdmin();
    const res = await app.request(
      '/api/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'wrong' })
      },
      env
    );
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(String(body.message)).toMatch(/錯誤|嘗試/);
  });

  it('連續失敗 5 次後限流 429', async () => {
    await seedAdmin();
    for (let i = 0; i < 5; i++) {
      await app.request(
        '/api/login',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'CF-Connecting-IP': '1.2.3.4'
          },
          body: JSON.stringify({ username: 'admin', password: 'wrong' })
        },
        env
      );
    }
    const res = await app.request(
      '/api/login',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CF-Connecting-IP': '1.2.3.4'
        },
        body: JSON.stringify({ username: 'admin', password: 'password' })
      },
      env
    );
    expect(res.status).toBe(429);
  });
});

describe('GET /api/logout', () => {
  it('清除 cookie 並重定向', async () => {
    await seedAdmin();
    const res = await app.request('/api/logout', { method: 'GET' }, env);
    expect([302, 200].includes(res.status)).toBe(true);
    const setCookie = res.headers.get('Set-Cookie') || '';
    expect(setCookie).toMatch(/Max-Age=0|token=;/);
  });
});

describe('JWT 單元', () => {
  it('簽名正確可驗證', async () => {
    const token = await generateJWT('admin', 'sec');
    const payload = await verifyJWT(token, 'sec');
    expect(payload).toBeTruthy();
    expect(payload.username).toBe('admin');
  });

  it('錯誤金鑰驗證失敗', async () => {
    const token = await generateJWT('admin', 'sec');
    expect(await verifyJWT(token, 'other')).toBeNull();
  });

  it('過期 token 驗證失敗', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const token = await generateJWT('admin', 'sec');
    // 推進超過 24h
    vi.setSystemTime(new Date('2026-01-03T00:00:00Z'));
    expect(await verifyJWT(token, 'sec')).toBeNull();
  });

  it('篡改 payload 後簽名失敗', async () => {
    const token = await generateJWT('admin', 'sec');
    const parts = token.split('.');
    const fakePayload = btoa(JSON.stringify({ username: 'hacker', exp: 9999999999 }));
    const tampered = parts[0] + '.' + fakePayload + '.' + parts[2];
    expect(await verifyJWT(tampered, 'sec')).toBeNull();
  });
});

describe('受保護路由鑑權', () => {
  it('過期 cookie 訪問 /api/config → 401', async () => {
    await seedAdmin();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const token = await generateJWT('admin', 'test-secret-key');
    vi.setSystemTime(new Date('2026-01-03T00:00:00Z'));
    const res = await app.request(
      '/api/config',
      { headers: { Cookie: 'token=' + token } },
      env
    );
    expect(res.status).toBe(401);
  });
});
