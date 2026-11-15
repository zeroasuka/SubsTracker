// @ts-check
/**
 * 訂閱倉庫
 *
 * ── 設計動機 ────────────────────────────────────────────────
 * 早期實現把所有訂閱塞在一個 KV key（'subscriptions'）裡，每次讀寫整陣列，
 * 併發編輯會丟資料，且數量大時效能下降。
 *
 * 改為：
 *   sub_index = JSON 陣列 [id1, id2, ...]    ← 用於快速列舉
 *   sub:{id}  = JSON 物件                     ← 單訂閱完整資料
 *
 * 單訂閱 CRUD 不再觸碰整陣列，僅寫 sub:{id}（修改）或 sub_index+sub:{id}（新增/刪除）。
 *
 * ── 併發安全說明 ────────────────────────────────────────────
 * KV 不支援事務，sub_index 的"讀-改-寫"在併發下仍可能丟更新。
 * 真實使用場景（單使用者、操作稀疏）下風險可接受。
 * 資料本體在 sub:{id}，即使索引漏更新也可以通過 KV.list 修復。
 *
 */

const KEY_INDEX = 'sub_index';
const KEY_PREFIX = 'sub:';

/**
 * 讀取訂閱 ID 列表（索引）。
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @returns {Promise<string[]>}
 */
export async function listIds(env) {
  const raw = await env.SUBSCRIPTIONS_KV.get(KEY_INDEX);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * 寫回訂閱 ID 列表（索引）。
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @param {string[]} ids
 */
async function writeIds(env, ids) {
  // 去重保序
  const seen = new Set();
  const deduped = [];
  for (const id of ids) {
    if (typeof id === 'string' && !seen.has(id)) {
      seen.add(id);
      deduped.push(id);
    }
  }
  await env.SUBSCRIPTIONS_KV.put(KEY_INDEX, JSON.stringify(deduped));
}

/**
 * 根據 ID 讀取單條訂閱。
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @param {string} id
 * @returns {Promise<Object|null>}
 */
export async function getById(env, id) {
  if (!id) return null;
  const raw = await env.SUBSCRIPTIONS_KV.get(KEY_PREFIX + id);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error('[sub-repo] 反序列化失敗:', id, err);
    return null;
  }
}

/**
 * 一次性讀取所有訂閱（按索引順序）。
 *
 * 實現：先讀索引，再 Promise.all 併發拿單個訂閱；缺失的項被過濾。
 * 對 N 數十量級仍亞秒級。N 上千時建議分批或改用分頁介面。
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @returns {Promise<Object[]>}
 */
export async function listAll(env) {
  const ids = await listIds(env);
  if (ids.length === 0) return [];
  const items = await Promise.all(ids.map((id) => getById(env, id)));
  // @ts-ignore — 過濾 null
  return items.filter((it) => it != null);
}

/**
 * 儲存（建立或更新）一條訂閱。
 *
 * - 若 ID 不在索引中：寫 sub:{id} 並 append 到索引
 * - 若 ID 已存在：僅寫 sub:{id}（不動索引，避免不必要的 RPC）
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @param {Object} subscription 必須包含 string 型別的 id
 * @returns {Promise<Object>} 寫入後的物件
 */
export async function save(env, subscription) {
  if (!subscription || typeof subscription.id !== 'string' || subscription.id === '') {
    throw new Error('訂閱缺少有效 id');
  }
  await env.SUBSCRIPTIONS_KV.put(
    KEY_PREFIX + subscription.id,
    JSON.stringify(subscription)
  );

  const ids = await listIds(env);
  if (!ids.includes(subscription.id)) {
    ids.push(subscription.id);
    await writeIds(env, ids);
  }
  return subscription;
}

/**
 * 批次儲存訂閱（用於自動續訂一次更新多條等場景）。
 *
 * 順序保留；併發寫入單條，最後統一寫一次索引。
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @param {Object[]} subs
 */
export async function saveMany(env, subs) {
  if (!Array.isArray(subs) || subs.length === 0) return;
  await Promise.all(
    subs.map((s) => env.SUBSCRIPTIONS_KV.put(KEY_PREFIX + s.id, JSON.stringify(s)))
  );
  const idsExisting = await listIds(env);
  const set = new Set(idsExisting);
  for (const s of subs) {
    if (typeof s.id === 'string') set.add(s.id);
  }
  if (set.size !== idsExisting.length) {
    await writeIds(env, Array.from(set));
  }
}

/**
 * 刪除一條訂閱（同時從索引中移除）。
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @param {string} id
 * @returns {Promise<boolean>} true 表示確實存在並已刪除
 */
export async function deleteById(env, id) {
  if (!id) return false;
  const before = await env.SUBSCRIPTIONS_KV.get(KEY_PREFIX + id);
  if (!before) {
    // 索引裡可能仍有殘留，順手清掉
    const ids = await listIds(env);
    if (ids.includes(id)) {
      await writeIds(env, ids.filter((x) => x !== id));
    }
    return false;
  }
  await env.SUBSCRIPTIONS_KV.delete(KEY_PREFIX + id);
  const ids = await listIds(env);
  if (ids.includes(id)) {
    await writeIds(env, ids.filter((x) => x !== id));
  }
  return true;
}

/**
 * 整個倉庫覆蓋（用於遷移、匯入等場景）。
 *
 * 流程：先清舊的 sub:{id}（按當前索引），再寫新資料。
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @param {Object[]} subs
 */
export async function replaceAll(env, subs) {
  const oldIds = await listIds(env);
  await Promise.all(
    oldIds.map((id) => env.SUBSCRIPTIONS_KV.delete(KEY_PREFIX + id))
  );
  if (Array.isArray(subs) && subs.length > 0) {
    await Promise.all(
      subs.map((s) =>
        env.SUBSCRIPTIONS_KV.put(KEY_PREFIX + s.id, JSON.stringify(s))
      )
    );
    await writeIds(env, subs.map((s) => s.id));
  } else {
    await writeIds(env, []);
  }
}
