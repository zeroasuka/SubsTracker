// @ts-check
/**
 * 自動資料遷移
 *
 * ── 設計原則 ────────────────────────────────────────────────
 * 1. **冪等**：每個 step 多次執行結果一致，且 `migrate:{step.id}=done` 標記跳過。
 * 2. **可重入安全**：通過 `migration_lock` Key（60s TTL）防止 Cron 與請求併發觸發。
 *    最壞情況是其中一方放棄遷移，另一方完成；不會雙寫。
 * 3. **可累加**：後續 Task 在 `MIGRATION_STEPS` 數組裡追加 step，不影響已執行的步驟。
 * 4. **資料安全**：舊 `subscriptions` 單 Key 在遷移成功後改名為
 *    `subscriptions_v2_backup`（7 天 TTL）保留作回滾備份。
 *
 * ── KV 標記一覽 ─────────────────────────────────────────────
 *   schema_version           = 'v3'        ← 資料 schema 版本標識，置上後每次請求秒過
 *   migrate:subscriptions_v3 = 'done'      ← 每個 step 自己的標記
 *   migration_lock           = ISO 時間戳   ← TTL 60s 的悲觀鎖
 *
 */

import * as subRepo from './subscriptions.repo.js';
import * as remindersRepo from './reminders.repo.js';
import * as schedulerLogsRepo from './scheduler-logs.repo.js';

/** 當前 schema 版本字串 */
export const SCHEMA_VERSION = 'v3';

const KEY_SCHEMA_VERSION = 'schema_version';
const KEY_MIGRATION_LOCK = 'migration_lock';
const LOCK_TTL_SEC = 60;
const BACKUP_TTL_SEC = 7 * 24 * 3600;

/**
 * @typedef {Object} MigrationStep
 * @property {string} id 唯一標識，用於冪等標記
 * @property {string} description 中文描述
 * @property {(env: any) => Promise<void>} run 執行體
 */

/** 當前所有 遷移步驟（後續 Task 追加） */
export const MIGRATION_STEPS = [
  {
    id: 'subscriptions_v3',
    description: '把單 Key subscriptions 拆成 sub:{id} + sub_index',
    run: migrateSubscriptions
  },
  {
    id: 'reminder_rules_v3',
    description: '把訂閱自帶的 reminderUnit/reminderValue 轉成 reminder_rules:{subId}',
    run: migrateReminderRules
  },
  {
    id: 'scheduler_logs_v3',
    description: '把舊 scheduler_status_history 合併到 sched_log:{iso}',
    run: migrateSchedulerLogs
  }
];

/**
 * 已執行遷移的記憶體快取（避免每次請求都查一次 KV）。
 * 同一 isolate 內只查一次。
 */
let cachedSchemaVersion = /** @type {string|null} */ (null);

/**
 * 入口：確保所有遷移步驟已執行完成。
 *
 * 呼叫方式：在 Worker fetch / scheduled 入口處第一行呼叫一次。
 * 已遷移過的請求幾乎零開銷（命中記憶體快取或 1 次 KV.get）。
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @returns {Promise<{ migrated: boolean, reason?: string, ranSteps?: string[] }>}
 */
export async function ensureMigrations(env) {
  if (cachedSchemaVersion === SCHEMA_VERSION) {
    return { migrated: false, reason: 'cached' };
  }

  const current = await env.SUBSCRIPTIONS_KV.get(KEY_SCHEMA_VERSION);
  if (current === SCHEMA_VERSION) {
    cachedSchemaVersion = SCHEMA_VERSION;
    return { migrated: false, reason: 'already_v3' };
  }

  // 嘗試加鎖
  const acquired = await tryAcquireLock(env);
  if (!acquired) {
    return { migrated: false, reason: 'locked_elsewhere' };
  }

  const ranSteps = [];
  try {
    for (const step of MIGRATION_STEPS) {
      const doneFlag = await env.SUBSCRIPTIONS_KV.get(`migrate:${step.id}`);
      if (doneFlag === 'done') continue;

      console.log(`[migrate] 開始執行: ${step.id} - ${step.description}`);
      await step.run(env);
      await env.SUBSCRIPTIONS_KV.put(`migrate:${step.id}`, 'done');
      console.log(`[migrate] 完成: ${step.id}`);
      ranSteps.push(step.id);
    }
    await env.SUBSCRIPTIONS_KV.put(KEY_SCHEMA_VERSION, SCHEMA_VERSION);
    cachedSchemaVersion = SCHEMA_VERSION;
    return { migrated: true, ranSteps };
  } catch (err) {
    console.error('[migrate] 執行失敗，本次不會標記完成，下次請求會重試:', err);
    throw err;
  } finally {
    await releaseLock(env);
  }
}

/**
 * 測試用：清除記憶體快取，強制下次重新檢查 schema_version。
 */
export function _resetMigrationCache() {
  cachedSchemaVersion = null;
}

/**
 * 測試用：檢查記憶體快取狀態。
 */
export function _getCachedSchemaVersion() {
  return cachedSchemaVersion;
}

// ─────────────────────────────────────────────────────────────
// 鎖 helper
// ─────────────────────────────────────────────────────────────

/**
 * 試圖獲取遷移鎖。
 * KV 沒有 CAS，只能"先讀後寫"——存在小視窗競態，足夠大多數場景。
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @returns {Promise<boolean>}
 */
async function tryAcquireLock(env) {
  const existing = await env.SUBSCRIPTIONS_KV.get(KEY_MIGRATION_LOCK);
  if (existing) return false;
  await env.SUBSCRIPTIONS_KV.put(KEY_MIGRATION_LOCK, new Date().toISOString(), {
    expirationTtl: LOCK_TTL_SEC
  });
  return true;
}

async function releaseLock(env) {
  try {
    await env.SUBSCRIPTIONS_KV.delete(KEY_MIGRATION_LOCK);
  } catch (err) {
    console.warn('[migrate] 釋放鎖失敗（TTL 60s 後會自動釋放）:', err);
  }
}

// ─────────────────────────────────────────────────────────────
// 各 step 實現
// ─────────────────────────────────────────────────────────────

/**
 * 遷移：舊 `subscriptions`（JSON 陣列）→ `sub:{id}` 多 Key + `sub_index`。
 *
 * - 讀 `subscriptions`，逐條寫 `sub:{id}`，構建索引並寫 `sub_index`
 * - 舊 `subscriptions` 改名為 `subscriptions_v2_backup`（7 天 TTL）後刪除
 * - 舊資料為空或缺失：僅寫一個空索引，schema_version 仍寫入
 *
 * 冪等性：
 *   - 若 sub_index 已寫過且 sub:{id} 已存在，重複執行會覆蓋（值相同，影響僅 KV 寫次數）
 *   - 若舊 subscriptions 已被改名，第二次讀到 null 視為已遷移，跳過
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 */
export async function migrateSubscriptions(env) {
  const oldRaw = await env.SUBSCRIPTIONS_KV.get('subscriptions');

  /** @type {any[]} */
  let oldSubs = [];
  if (oldRaw) {
    try {
      const parsed = JSON.parse(oldRaw);
      oldSubs = Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      console.error('[migrate:subscriptions_v3] 舊資料 JSON 解析失敗，按空處理:', err);
      oldSubs = [];
    }
  }

  // 寫入新結構（即使 oldSubs 為空也要寫 sub_index 佔位）
  if (oldSubs.length > 0) {
    await subRepo.replaceAll(env, oldSubs);
  } else {
    // 現有索引可能已有值（來自第二次執行），不要覆蓋
    const existing = await subRepo.listIds(env);
    if (existing.length === 0) {
      await env.SUBSCRIPTIONS_KV.put('sub_index', '[]');
    }
  }

  // 備份舊資料並刪除原 Key
  if (oldRaw) {
    await env.SUBSCRIPTIONS_KV.put('subscriptions_v2_backup', oldRaw, {
      expirationTtl: BACKUP_TTL_SEC
    });
    await env.SUBSCRIPTIONS_KV.delete('subscriptions');
  }

  console.log(`[migrate:subscriptions_v3] 已遷移 ${oldSubs.length} 條訂閱`);
}

/**
 * 遷移：根據每個訂閱的 reminderUnit/reminderValue 生成 1 條等價 before_expiry 規則。
 *
 * 僅對沒有 reminder_rules:{subId} 的訂閱寫入；如果使用者在新版本中已手動設定規則，
 * 不會被覆蓋。
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 */
export async function migrateReminderRules(env) {
  const subs = await subRepo.listAll(env);
  let count = 0;
  for (const sub of subs) {
    const existing = await remindersRepo.listForSubscription(env, sub.id);
    if (existing.length > 0) continue;
    const rule = remindersRepo.legacyFieldToRule(sub);
    await remindersRepo.replaceForSubscription(env, sub.id, [rule]);
    count++;
  }
  console.log(`[migrate:reminder_rules_v3] 已為 ${count} 個訂閱生成預設提醒規則`);
}

/**
 * 遷移：把舊 scheduler_status_history（早期版本最多保留 20 條排程狀態）轉寫到 sched_log:{iso}。
 *
 * 僅作歷史記錄的最佳努力遷移，結構差異較大，主要保留時間線索。
 * 舊 Key 遷移完保留作回滾備份（讓 KV TTL 自然過期清理）。
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 */
export async function migrateSchedulerLogs(env) {
  const histRaw = await env.SUBSCRIPTIONS_KV.get('scheduler_status_history');
  if (!histRaw) return;
  /** @type {any[]} */
  let history = [];
  try {
    const parsed = JSON.parse(histRaw);
    history = Array.isArray(parsed) ? parsed : [];
  } catch {
    history = [];
  }

  let count = 0;
  for (const item of history) {
    const startedAt = item.lastRunAt || new Date().toISOString();
    await schedulerLogsRepo.writeLog(
      env,
      {
        startedAt,
        finishedAt: startedAt,
        timezone: item.timezone || 'UTC',
        currentHour: item.currentHour || '00',
        configuredHours: Array.isArray(item.configuredHours) ? item.configuredHours : [],
        inWindow: !!item.shouldNotifyThisHour,
        checkedCount: item.checkedSubscriptions || 0,
        matchedCount: item.expiringMatched || 0,
        dedupedCount: item.dedupeSkipped || 0,
        sentCount: item.sent ? 1 : 0,
        autoRenewedCount: item.updatedSubscriptions || 0,
        status: item.errorStack ? 'error' : item.sent ? 'ok' : 'skipped',
        reason: item.reason || (item.errorStack ? 'legacy_error' : undefined),
        extra: { migratedFromV2: true }
      },
      { ttlSec: 7 * 24 * 3600 }
    );
    count++;
  }
  console.log(`[migrate:scheduler_logs_v3] 已遷移 ${count} 條歷史排程記錄`);
}
