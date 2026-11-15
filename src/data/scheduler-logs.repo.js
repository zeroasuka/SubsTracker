// @ts-check
/**
 * 排程器執行日誌倉庫
 *
 * 用途：每次 Cron `scheduled` 觸發都寫一條聚合日誌，包含本次執行的：
 *   - 起止時間、使用者時區、是否在通知時段
 *   - 檢查的訂閱總數 / 命中提醒規則數 / 去重跳過數
 *   - 自動續訂條數 / 通知傳送統計
 *   - 錯誤（如有）
 *
 * 配合 notification-logs（細粒度）形成"鏈路日誌"：
 *   sched_log:{isoUtc}                  ← 一次排程的總覽
 *   notify_log:{ymdh}:{sub}:{rule}:{ch} ← 該排程發出的每條通知
 *
 * Key 規則：sched_log:{ISO_UTC}（如 sched_log:2026-05-24T17:00:00.000Z）
 *   ISO 字典序 == 時間序，便於 list 倒序讀取。
 *
 * 預設 TTL：30 天。
 *
 */

const PREFIX = 'sched_log:';
const DEFAULT_TTL_SEC = 30 * 24 * 3600;

/**
 * @typedef {Object} SchedulerLogEntry
 * @property {string} key 完整 KV key
 * @property {string} startedAt ISO
 * @property {string} finishedAt ISO
 * @property {string} timezone 排程生效時區
 * @property {string} currentHour 使用者 TZ 下的當前小時（"HH"）
 * @property {string[]} configuredHours 通知時段配置（使用者 TZ 小時）
 * @property {boolean} inWindow 是否在通知時段內
 * @property {number} checkedCount 檢查訂閱數
 * @property {number} matchedCount 命中規則的（訂閱×規則）對數
 * @property {number} dedupedCount 因去重跳過數
 * @property {number} sentCount 實際傳送通知數
 * @property {number} autoRenewedCount 自動續訂訂閱數
 * @property {string} status 'ok' | 'skipped' | 'error'
 * @property {string} [reason] 跳過原因或錯誤摘要
 * @property {any} [extra] 附加資訊（可選）
 */

/**
 * 寫入一條排程日誌。
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @param {Omit<SchedulerLogEntry, 'key'>} entry
 * @param {{ ttlSec?: number }} [opts]
 * @returns {Promise<SchedulerLogEntry>}
 */
export async function writeLog(env, entry, opts = {}) {
  const key = PREFIX + (entry.startedAt || new Date().toISOString());
  const stored = {
    startedAt: entry.startedAt || new Date().toISOString(),
    finishedAt: entry.finishedAt || new Date().toISOString(),
    timezone: entry.timezone || 'UTC',
    currentHour: entry.currentHour || '00',
    configuredHours: entry.configuredHours || [],
    inWindow: !!entry.inWindow,
    checkedCount: entry.checkedCount || 0,
    matchedCount: entry.matchedCount || 0,
    dedupedCount: entry.dedupedCount || 0,
    sentCount: entry.sentCount || 0,
    autoRenewedCount: entry.autoRenewedCount || 0,
    status: entry.status || 'ok',
    reason: entry.reason,
    extra: entry.extra
  };
  await env.SUBSCRIPTIONS_KV.put(key, JSON.stringify(stored), {
    expirationTtl: Math.max(60, opts.ttlSec || DEFAULT_TTL_SEC)
  });
  return { key, ...stored };
}

/**
 * 取最近 N 條排程日誌（按時間倒序）。
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @param {number} [limit=20]
 * @returns {Promise<SchedulerLogEntry[]>}
 */
export async function getRecent(env, limit = 20) {
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 20));

  // KV.list 預設升序；想要倒序需要拉全後排序
  const allKeys = [];
  let cursor;
  do {
    const res = await env.SUBSCRIPTIONS_KV.list({
      prefix: PREFIX,
      cursor,
      limit: 1000
    });
    for (const k of res.keys) allKeys.push(k.name);
    cursor = res.list_complete ? undefined : res.cursor;
  } while (cursor && allKeys.length < 5000);

  allKeys.sort((a, b) => b.localeCompare(a));
  const top = allKeys.slice(0, safeLimit);
  const items = await Promise.all(
    top.map(async (key) => {
      const raw = await env.SUBSCRIPTIONS_KV.get(key);
      if (!raw) return null;
      try {
        return { key, ...JSON.parse(raw) };
      } catch {
        return null;
      }
    })
  );
  // @ts-ignore - 過濾 null
  return items.filter((x) => x != null);
}
