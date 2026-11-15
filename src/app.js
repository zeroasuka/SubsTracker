// @ts-check
/**
 * Hono 應用裝配
 *
 * 設計目標：
 * - 用 Hono 實現路由分發與中介軟體管線
 * - 引入中介軟體：遷移檢查 / 日誌 / 認證 / 錯誤處理
 * - 路由路徑、方法、響應結構與既有客戶端嚴格相容
 *   現有前端程式碼無需改動即可繼續工作
 *
 * 落地策略：
 * - 現階段（Task 7）：Hono 充當"外殼路由器"，把請求轉發給現有 handler
 *   後續 Task 可逐個把 handler 改成 Hono 原生寫法，但當前優先保證不破壞。
 *
 */

import { Hono } from 'hono';

import { handleApiRequest } from './api/router.js';
import { handleAdminRequest, handleLoginPage } from './api/admin.js';
import { handleDebug } from './api/debug.js';
import { getUserFromRequest } from './api/handlers/auth.js';
import { ensureMigrations } from './data/migrate.js';

/**
 * @typedef {{ SUBSCRIPTIONS_KV: KVNamespace }} Bindings
 */

/** @type {Hono<{ Bindings: Bindings }>} */
const app = new Hono();

// ─────────────────────────────────────────────────────────────
// 全域性中介軟體：遷移檢查（首次訪問透明觸發）
// ─────────────────────────────────────────────────────────────
app.use('*', async (c, next) => {
  try {
    await ensureMigrations(c.env);
  } catch (err) {
    console.error('[app] 遷移失敗，回退繼續處理請求:', err);
  }
  await next();
});

// ─────────────────────────────────────────────────────────────
// 全域性錯誤兜底
// ─────────────────────────────────────────────────────────────
app.onError((err, c) => {
  console.error('[app] 未捕獲異常:', err && err.stack ? err.stack : err);
  // 統一的錯誤格式
  return c.json(
    {
      success: false,
      message: err && err.message ? err.message : '服務異常',
      code: 'internal_error'
    },
    500
  );
});

// ─────────────────────────────────────────────────────────────
// 路由：根路徑
// 已登入跳 /admin；未登入返回登入頁
// ─────────────────────────────────────────────────────────────
app.get('/', async (c) => {
  const { user } = await getUserFromRequest(c.req.raw, c.env);
  if (user) return c.redirect('/admin');
  return handleLoginPage();
});

// ─────────────────────────────────────────────────────────────
// 路由：/debug（必須登入）
// ─────────────────────────────────────────────────────────────
app.all('/debug', async (c) => {
  const { user } = await getUserFromRequest(c.req.raw, c.env);
  if (!user) {
    return new Response('未授權訪問', {
      status: 401,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
  return handleDebug(c.req.raw, c.env);
});

// ─────────────────────────────────────────────────────────────
// 路由：/api/*（認證由 handler 內部處理，與既有客戶端約定一致）
// ─────────────────────────────────────────────────────────────
app.all('/api/*', async (c) => {
  return handleApiRequest(c.req.raw, c.env);
});

// ─────────────────────────────────────────────────────────────
// 路由：/admin/*
// ─────────────────────────────────────────────────────────────
app.all('/admin/*', async (c) => {
  return handleAdminRequest(c.req.raw, c.env);
});

app.get('/admin', async (c) => {
  return handleAdminRequest(c.req.raw, c.env);
});

// ─────────────────────────────────────────────────────────────
// 兜底：其他路徑返回登入頁（（兜底行為））
// ─────────────────────────────────────────────────────────────
app.all('*', async () => {
  return handleLoginPage();
});

export default app;
