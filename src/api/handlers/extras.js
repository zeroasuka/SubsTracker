// @ts-check
/**
 * 提醒規則 / 通知日志 / 調度日志 路由
 *
 * 接口表（路徑前綴 /api）：
 *   GET    /subscriptions/:id/reminders           列出某訂閱的提醒規則
 *   POST   /subscriptions/:id/reminders           新增一條規則
 *   PUT    /subscriptions/:id/reminders/:ruleId   更新一條規則
 *   DELETE /subscriptions/:id/reminders/:ruleId   刪除一條規則
 *
 *   GET    /notification-logs?subId=&channel=&status=&since=&limit=
 *                                                 查詢通知日志
 *   GET    /scheduler-logs?limit=N                查詢調度執行日志
 *
 * 鑒權：與既有客戶端約定一致——需要登錄（cookie token），由 router.js 在 routes 之前
 * 統一校驗。本文件被 router.js 調用，不再單獨校驗。
 *
 */

import * as remindersRepo from '../../data/reminders.repo.js';
import * as notifyLogsRepo from '../../data/notification-logs.repo.js';
import * as schedLogsRepo from '../../data/scheduler-logs.repo.js';
import { getCategories, addCategory } from '../../data/categories.js';
import { getNextFireTime } from '../../services/notify/reminder-engine.js';

export const VERSION = '3.0.0';

/** 標準 JSON 響應 */
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * 規則變更後同步訂閱上的 legacy 提醒字段，保證列表展示一致。
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @param {string} subId
 * @param {import('../../data/reminders.repo.js').ReminderRule[]} [rules]
 */
async function syncLegacyAfterRulesChange(env, subId, rules) {
  try {
    const { syncLegacyReminderFields } = await import('../../data/subscriptions.js');
    const list = rules || (await remindersRepo.listForSubscription(env, subId));
    await syncLegacyReminderFields(env, subId, list);
  } catch (err) {
    console.error('[reminders] 同步 legacy 字段失敗:', err);
  }
}

/**
 * 處理提醒規則 / 通知日志 / 調度日志相關的 新 API。
 * 返回 null 表示路徑不匹配，由調用方繼續轉給下一組路由。
 *
 * @param {Request} request
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @param {string} path 已剝離 /api 前綴的路徑
 */
export async function handleExtraRoutes(request, env, path) {
  const method = request.method;

  // /subscriptions/:id/reminders[/:ruleId]
  const remMatch = path.match(/^\/subscriptions\/([^/]+)\/reminders(?:\/([^/]+))?\/?$/);
  if (remMatch) {
    const [, subId, ruleId] = remMatch;
    return handleReminderRoute(request, env, method, subId, ruleId);
  }

  // /subscriptions/:id/next-reminder
  const nrMatch = path.match(/^\/subscriptions\/([^/]+)\/next-reminder\/?$/);
  if (nrMatch && method === 'GET') {
    const [, subId] = nrMatch;
    const { getSubscription } = await import('../../data/subscriptions.js');
    const sub = await getSubscription(subId, env);
    if (!sub) return json({ success: false, message: '訂閱不存在' }, 404);
    const rules = await remindersRepo.listForSubscription(env, subId);
    const nowIso = new Date().toISOString();
    const times = rules
      .map((r) => ({ ruleId: r.id, type: r.type, value: r.value, unit: r.unit, nextFireTime: getNextFireTime(r, sub.expiryDate, nowIso) }))
      .filter((t) => t.nextFireTime !== null)
      .sort((a, b) => new Date(a.nextFireTime).getTime() - new Date(b.nextFireTime).getTime());
    return json({ success: true, nextReminder: times[0] || null, allUpcoming: times });
  }

  // /notification-logs
  if (path === '/notification-logs' && method === 'GET') {
    return handleNotifyLogsList(request, env);
  }

  // /scheduler-logs
  if (path === '/scheduler-logs' && method === 'GET') {
    return handleSchedLogsList(request, env);
  }

  // /version
  if (path === '/version' && method === 'GET') {
    return json({ success: true, version: VERSION });
  }

  // /categories
  if (path === '/categories') {
    if (method === 'GET') {
      return json({ success: true, categories: await getCategories(env) });
    }
    if (method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ success: false, message: '請求體不是合法 JSON' }, 400); }
      const name = body && body.name;
      if (!name || !name.trim()) return json({ success: false, message: '分類名不能為空' }, 400);
      await addCategory(env, name);
      return json({ success: true });
    }
  }

  return null;
}

/**
 * @param {Request} request
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @param {string} method
 * @param {string} subId
 * @param {string} [ruleId]
 */
async function handleReminderRoute(request, env, method, subId, ruleId) {
  // GET /subscriptions/:id/reminders
  if (method === 'GET' && !ruleId) {
    const list = await remindersRepo.listForSubscription(env, subId);
    return json({ success: true, rules: list });
  }

  // POST /subscriptions/:id/reminders
  if (method === 'POST' && !ruleId) {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ success: false, message: '請求體不是合法 JSON' }, 400);
    }
    if (body && body.preset === true) {
      // 一次性應用智能預設（覆蓋現有規則）
      const presets = remindersRepo.defaultPresetRules();
      await remindersRepo.replaceForSubscription(env, subId, presets);
      await syncLegacyAfterRulesChange(env, subId);
      return json({ success: true, rules: presets });
    }
    const rule = await remindersRepo.addRule(env, subId, body || {});
    await syncLegacyAfterRulesChange(env, subId);
    return json({ success: true, rule });
  }

  // PUT /subscriptions/:id/reminders（不帶 ruleId）→ 整體替換規則列表
  if (method === 'PUT' && !ruleId) {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ success: false, message: '請求體不是合法 JSON' }, 400);
    }
    const rules = Array.isArray(body && body.rules) ? body.rules : [];
    await remindersRepo.replaceForSubscription(env, subId, rules);
    const saved = await remindersRepo.listForSubscription(env, subId);
    await syncLegacyAfterRulesChange(env, subId, saved);
    return json({ success: true, rules: saved });
  }

  // PUT /subscriptions/:id/reminders/:ruleId
  if (method === 'PUT' && ruleId) {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ success: false, message: '請求體不是合法 JSON' }, 400);
    }
    const updated = await remindersRepo.updateRule(env, subId, ruleId, body || {});
    if (!updated) return json({ success: false, message: '規則不存在' }, 404);
    await syncLegacyAfterRulesChange(env, subId);
    return json({ success: true, rule: updated });
  }

  // DELETE /subscriptions/:id/reminders/:ruleId
  if (method === 'DELETE' && ruleId) {
    const ok = await remindersRepo.deleteRule(env, subId, ruleId);
    if (!ok) return json({ success: false, message: '規則不存在' }, 404);
    await syncLegacyAfterRulesChange(env, subId);
    return json({ success: true });
  }

  return json({ success: false, message: 'Method Not Allowed' }, 405);
}

/**
 * GET /api/notification-logs?subId=&channel=&status=&since=&limit=
 *
 * @param {Request} request
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 */
async function handleNotifyLogsList(request, env) {
  const url = new URL(request.url);
  const filter = {
    subId: url.searchParams.get('subId') || undefined,
    channel: url.searchParams.get('channel') || undefined,
    status:
      /** @type {'success'|'failed'|undefined} */
      (url.searchParams.get('status') || undefined),
    since: url.searchParams.get('since') || undefined,
    until: url.searchParams.get('until') || undefined,
    limit: Number(url.searchParams.get('limit') || 100)
  };
  const logs = await notifyLogsRepo.query(env, filter);
  return json({ success: true, logs });
}

/**
 * GET /api/scheduler-logs?limit=N
 *
 * @param {Request} request
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 */
async function handleSchedLogsList(request, env) {
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get('limit') || 20);
  const logs = await schedLogsRepo.getRecent(env, limit);
  return json({ success: true, logs });
}
