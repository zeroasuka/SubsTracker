// @ts-check
/**
 * 訂閱倉庫 + 遷移單元測試
 *
 * 用 @cloudflare/vitest-pool-workers 提供的真實 KVNamespace 跑，
 * 不需要手寫 mock，直接 import { env } from 'cloudflare:test'。
 */
import { describe, it, expect, beforeEach } from 'vitest';
// @ts-ignore — vitest-pool-workers 注入的虛擬模組
import { env } from 'cloudflare:test';

import * as subRepo from '../../src/data/subscriptions.repo.js';
import {
  ensureMigrations,
  migrateSubscriptions,
  SCHEMA_VERSION,
  _resetMigrationCache,
  _getCachedSchemaVersion
} from '../../src/data/migrate.js';

/** 把 KV 清空（僅遍歷常見 KV key 字首） */
async function clearKv() {
  // KV.list 在 vitest-pool-workers 是真實實現
  const list = await env.SUBSCRIPTIONS_KV.list();
  await Promise.all(list.keys.map((k) => env.SUBSCRIPTIONS_KV.delete(k.name)));
}

beforeEach(async () => {
  await clearKv();
  _resetMigrationCache();
});

describe('subscriptions.repo', () => {
  it('listIds 空倉庫返回空陣列', async () => {
    expect(await subRepo.listIds(env)).toEqual([]);
    expect(await subRepo.listAll(env)).toEqual([]);
  });

  it('save 新訂閱 → 索引追加 + 單 Key 寫入', async () => {
    const sub = { id: 'a1', name: 'Netflix' };
    await subRepo.save(env, sub);

    expect(await subRepo.listIds(env)).toEqual(['a1']);
    expect(await subRepo.getById(env, 'a1')).toEqual(sub);
    expect(await subRepo.listAll(env)).toEqual([sub]);
  });

  it('save 已存在訂閱 → 僅更新 sub:{id}，索引不變', async () => {
    await subRepo.save(env, { id: 'a1', name: 'Old' });
    await subRepo.save(env, { id: 'a1', name: 'New' });

    expect(await subRepo.listIds(env)).toEqual(['a1']);
    expect((await subRepo.getById(env, 'a1')).name).toBe('New');
  });

  it('saveMany 批次寫入併合並索引', async () => {
    await subRepo.saveMany(env, [
      { id: 'b1', name: 'A' },
      { id: 'b2', name: 'B' },
      { id: 'b3', name: 'C' }
    ]);

    expect((await subRepo.listIds(env)).sort()).toEqual(['b1', 'b2', 'b3']);
    expect(await subRepo.listAll(env)).toHaveLength(3);
  });

  it('deleteById 移除單 Key 與索引', async () => {
    await subRepo.save(env, { id: 'c1', name: 'X' });
    await subRepo.save(env, { id: 'c2', name: 'Y' });

    expect(await subRepo.deleteById(env, 'c1')).toBe(true);
    expect(await subRepo.listIds(env)).toEqual(['c2']);
    expect(await subRepo.getById(env, 'c1')).toBeNull();
  });

  it('deleteById 不存在 → 返回 false 且清理懸空索引', async () => {
    await env.SUBSCRIPTIONS_KV.put('sub_index', JSON.stringify(['ghost']));
    expect(await subRepo.deleteById(env, 'ghost')).toBe(false);
    expect(await subRepo.listIds(env)).toEqual([]);
  });

  it('replaceAll 整體替換（遷移用）', async () => {
    await subRepo.save(env, { id: 'old1' });
    await subRepo.save(env, { id: 'old2' });

    await subRepo.replaceAll(env, [{ id: 'new1' }, { id: 'new2' }, { id: 'new3' }]);

    expect((await subRepo.listIds(env)).sort()).toEqual(['new1', 'new2', 'new3']);
    expect(await subRepo.getById(env, 'old1')).toBeNull();
    expect(await subRepo.getById(env, 'new2')).toEqual({ id: 'new2' });
  });

  it('save 缺少 id 拋異常', async () => {
    await expect(subRepo.save(env, /** @type {any} */ ({}))).rejects.toThrow();
    await expect(subRepo.save(env, /** @type {any} */ ({ id: '' }))).rejects.toThrow();
  });
});

describe('migrate.migrateSubscriptions', () => {
  it('舊 subscriptions 陣列 → 新 sub:{id} + sub_index + 備份', async () => {
    const old = [
      { id: 's1', name: 'Netflix' },
      { id: 's2', name: 'Spotify' },
      { id: 's3', name: 'AWS' }
    ];
    await env.SUBSCRIPTIONS_KV.put('subscriptions', JSON.stringify(old));

    await migrateSubscriptions(env);

    expect((await subRepo.listIds(env)).sort()).toEqual(['s1', 's2', 's3']);
    expect((await subRepo.getById(env, 's2')).name).toBe('Spotify');

    // 備份存在，原 Key 已刪
    expect(await env.SUBSCRIPTIONS_KV.get('subscriptions_v2_backup')).toBeTruthy();
    expect(await env.SUBSCRIPTIONS_KV.get('subscriptions')).toBeNull();
  });

  it('舊 subscriptions 不存在 → 僅寫空索引，不報錯', async () => {
    await migrateSubscriptions(env);
    expect(await subRepo.listIds(env)).toEqual([]);
    expect(await env.SUBSCRIPTIONS_KV.get('subscriptions_v2_backup')).toBeNull();
  });

  it('舊 subscriptions 是損壞 JSON → 按空處理不拋異常', async () => {
    await env.SUBSCRIPTIONS_KV.put('subscriptions', '{ this is not valid json');
    await migrateSubscriptions(env);
    expect(await subRepo.listIds(env)).toEqual([]);
  });
});

describe('migrate.migrateSchedulerLogs', () => {
  it('遷移舊 scheduler_status_history 到 sched_log:*', async () => {
    const v2History = [
      {
        lastRunAt: '2026-05-24T10:00:00.000Z',
        timezone: 'Asia/Shanghai',
        currentHour: '18',
        configuredHours: ['08', '18'],
        shouldNotifyThisHour: true,
        checkedSubscriptions: 5,
        expiringMatched: 2,
        dedupeSkipped: 1,
        sent: true,
        updatedSubscriptions: 1,
        reason: '已嘗試傳送'
      },
      {
        lastRunAt: '2026-05-24T09:00:00.000Z',
        timezone: 'Asia/Shanghai',
        currentHour: '17',
        configuredHours: ['08', '18'],
        shouldNotifyThisHour: false,
        sent: false,
        reason: '當前小時未在通知時段內'
      }
    ];
    await env.SUBSCRIPTIONS_KV.put('scheduler_status_history', JSON.stringify(v2History));

    const { migrateSchedulerLogs } = await import('../../src/data/migrate.js');
    await migrateSchedulerLogs(env);

    const list = await env.SUBSCRIPTIONS_KV.list({ prefix: 'sched_log:' });
    expect(list.keys.length).toBe(2);
  });
});

describe('migrate.ensureMigrations（編排器）', () => {
  it('初次執行 → 設定 schema_version 與 step 標記', async () => {
    await env.SUBSCRIPTIONS_KV.put(
      'subscriptions',
      JSON.stringify([{ id: 'x1', name: 'X', reminderUnit: 'day', reminderValue: 5 }])
    );

    const result = await ensureMigrations(env);

    expect(result.migrated).toBe(true);
    expect(result.ranSteps).toContain('subscriptions_v3');
    expect(result.ranSteps).toContain('reminder_rules_v3');
    expect(result.ranSteps).toContain('scheduler_logs_v3');
    expect(await env.SUBSCRIPTIONS_KV.get('schema_version')).toBe(SCHEMA_VERSION);
    expect(await env.SUBSCRIPTIONS_KV.get('migrate:subscriptions_v3')).toBe('done');
    expect(await env.SUBSCRIPTIONS_KV.get('migrate:reminder_rules_v3')).toBe('done');
    expect(await env.SUBSCRIPTIONS_KV.get('migrate:scheduler_logs_v3')).toBe('done');
    expect(_getCachedSchemaVersion()).toBe(SCHEMA_VERSION);

    // reminder rules 也已生成
    const rules = await env.SUBSCRIPTIONS_KV.get('reminder_rules:x1');
    expect(rules).toBeTruthy();
    const parsed = JSON.parse(/** @type {string} */ (rules));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].value).toBe(5);
  });

  it('schema_version 已就位 → 跳過，命中快取', async () => {
    await env.SUBSCRIPTIONS_KV.put('schema_version', SCHEMA_VERSION);

    const r1 = await ensureMigrations(env);
    expect(r1.migrated).toBe(false);
    expect(r1.reason).toBe('already_v3');

    const r2 = await ensureMigrations(env);
    expect(r2.reason).toBe('cached'); // 二次走記憶體快取
  });

  it('冪等：連續兩次執行結果一致', async () => {
    await env.SUBSCRIPTIONS_KV.put(
      'subscriptions',
      JSON.stringify([{ id: 'idem', name: 'A' }])
    );
    await ensureMigrations(env);
    _resetMigrationCache();

    // 第二次：schema_version 已就位，應直接跳過
    const r2 = await ensureMigrations(env);
    expect(r2.migrated).toBe(false);
    expect(r2.reason).toBe('already_v3');

    expect((await subRepo.listIds(env)).length).toBe(1);
  });

  it('鎖存在時 → 跳過，下次再試', async () => {
    await env.SUBSCRIPTIONS_KV.put('migration_lock', 'someone-else-running');

    const result = await ensureMigrations(env);
    expect(result.migrated).toBe(false);
    expect(result.reason).toBe('locked_elsewhere');

    // 沒設定 schema_version
    expect(await env.SUBSCRIPTIONS_KV.get('schema_version')).toBeNull();
  });

  it('遷移成功後會自動釋放鎖', async () => {
    await ensureMigrations(env);
    expect(await env.SUBSCRIPTIONS_KV.get('migration_lock')).toBeNull();
  });
});
