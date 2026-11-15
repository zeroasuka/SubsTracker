// @ts-check
/**
 * 時區核心模組單元測試
 *
 * 覆蓋範圍：
 * - getNowInTimezone：注入式時間 + 各時區分量
 * - getTimezoneHourString：排程器通知時段判斷主路徑
 * - getDaysBetween：跨零點 / 跨夏令時 / #166 場景
 * - getTimezoneMidnightTimestamp：使用者 TZ 零點反推
 * - formatLocalDate：4 種格式
 * - 向後相容 wrapper：getCurrentTimeInTimezone / convertUTCToTimezone
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  MS_PER_DAY,
  MS_PER_HOUR,
  isValidTimezone,
  getTimezoneDateParts,
  getNowInTimezone,
  getTimezoneHourString,
  getDaysBetween,
  getTimezoneMidnightTimestamp,
  formatLocalDate,
  formatTimeInTimezone,
  formatBeijingTime,
  formatTimezoneDisplay,
  getTimezoneOffset,
  getCurrentTimeInTimezone,
  getTimestampInTimezone,
  convertUTCToTimezone,
  extractTimezone
} from '../../src/core/time.js';

describe('isValidTimezone', () => {
  it('合法 IANA 時區返回 true', () => {
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Asia/Shanghai')).toBe(true);
    expect(isValidTimezone('America/New_York')).toBe(true);
  });

  it('非法字串返回 false', () => {
    expect(isValidTimezone('FooBar/Baz')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
    expect(isValidTimezone(/** @type {any} */ (null))).toBe(false);
  });
});

describe('getTimezoneDateParts', () => {
  it('UTC 時區下 UTC 時刻分量正確', () => {
    const d = new Date('2026-05-24T03:30:45.000Z');
    expect(getTimezoneDateParts(d, 'UTC')).toEqual({
      year: 2026,
      month: 5,
      day: 24,
      hour: 3,
      minute: 30,
      second: 45
    });
  });

  it('Asia/Shanghai 比 UTC 快 8 小時（夏令時無影響）', () => {
    const d = new Date('2026-05-24T16:00:00.000Z'); // UTC 16:00 = 北京 24:00 = 5/25 00:00
    const parts = getTimezoneDateParts(d, 'Asia/Shanghai');
    expect(parts.year).toBe(2026);
    expect(parts.month).toBe(5);
    expect(parts.day).toBe(25);
    expect(parts.hour).toBe(0);
  });

  it('America/New_York 夏令時（5 月）差 4 小時', () => {
    const d = new Date('2026-05-24T16:00:00.000Z'); // UTC 16:00 = NYC 12:00 (DST)
    const parts = getTimezoneDateParts(d, 'America/New_York');
    expect(parts.day).toBe(24);
    expect(parts.hour).toBe(12);
  });

  it('America/New_York 冬令時（1 月）差 5 小時', () => {
    const d = new Date('2026-01-15T16:00:00.000Z'); // UTC 16:00 = NYC 11:00 (no DST)
    const parts = getTimezoneDateParts(d, 'America/New_York');
    expect(parts.day).toBe(15);
    expect(parts.hour).toBe(11);
  });

  it('非法時區回退 UTC 不拋異常', () => {
    const d = new Date('2026-05-24T03:30:45.000Z');
    const parts = getTimezoneDateParts(d, 'Foo/Bar');
    expect(parts.year).toBe(2026);
    expect(parts.hour).toBe(3); // 走兜底路徑
  });
});

describe('getNowInTimezone（業務主入口）', () => {
  it('注入特定時刻：UTC 0 點 + Asia/Shanghai → 北京 8 點', () => {
    const fixed = new Date('2026-05-24T00:00:00.000Z');
    const now = getNowInTimezone('Asia/Shanghai', fixed);
    expect(now.utc.toISOString()).toBe('2026-05-24T00:00:00.000Z');
    expect(now.parts).toEqual({ year: 2026, month: 5, day: 24, hour: 8, minute: 0, second: 0 });
    expect(now.hourString).toBe('08');
    expect(now.isoLocal).toBe('2026-05-24T08:00:00');
    expect(now.timezone).toBe('Asia/Shanghai');
  });

  it('UTC 23:30 + Asia/Shanghai → 次日 07:30', () => {
    const fixed = new Date('2026-05-24T23:30:00.000Z');
    const now = getNowInTimezone('Asia/Shanghai', fixed);
    expect(now.parts.day).toBe(25);
    expect(now.hourString).toBe('07');
  });

  it('未注入時間時取 new Date()', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-12-31T16:00:00.000Z'));
    try {
      const now = getNowInTimezone('Asia/Shanghai');
      expect(now.parts.year).toBe(2027);
      expect(now.parts.month).toBe(1);
      expect(now.parts.day).toBe(1);
      expect(now.hourString).toBe('00');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('getTimezoneHourString（排程器通知時段比對）', () => {
  it('始終返回兩位字串', () => {
    const d = new Date('2026-05-24T01:00:00.000Z');
    expect(getTimezoneHourString(d, 'UTC')).toBe('01');
    expect(getTimezoneHourString(d, 'Asia/Shanghai')).toBe('09');
  });

  it('00 / 23 邊界', () => {
    expect(getTimezoneHourString(new Date('2026-05-24T00:00:00Z'), 'UTC')).toBe('00');
    expect(getTimezoneHourString(new Date('2026-05-24T23:00:00Z'), 'UTC')).toBe('23');
  });
});

describe('getTimezoneMidnightTimestamp', () => {
  it('UTC 時區下：等價 Date.UTC(y,m-1,d)', () => {
    const ts = getTimezoneMidnightTimestamp(new Date('2026-05-24T15:00:00Z'), 'UTC');
    expect(ts).toBe(Date.UTC(2026, 4, 24));
  });

  it('Asia/Shanghai：北京零點 = UTC 前一天 16:00', () => {
    const ts = getTimezoneMidnightTimestamp(new Date('2026-05-24T15:00:00Z'), 'Asia/Shanghai');
    expect(new Date(ts).toISOString()).toBe('2026-05-23T16:00:00.000Z');
  });

  it('Asia/Shanghai 跨 UTC 日界（UTC 18:00 → 北京次日 02:00 → 當日零點 = 當日 UTC 16:00）', () => {
    const ts = getTimezoneMidnightTimestamp(new Date('2026-05-24T18:00:00Z'), 'Asia/Shanghai');
    expect(new Date(ts).toISOString()).toBe('2026-05-24T16:00:00.000Z');
  });
});

describe('getDaysBetween（剩餘天數計算 / #166 修復）', () => {
  it('同一 UTC 日的不同時刻 → 0 天', () => {
    expect(
      getDaysBetween('2026-05-24T01:00:00Z', '2026-05-24T23:59:00Z', 'UTC')
    ).toBe(0);
  });

  it('跨 UTC 日 → 1 天', () => {
    expect(
      getDaysBetween('2026-05-24T23:30:00Z', '2026-05-25T00:30:00Z', 'UTC')
    ).toBe(1);
  });

  it('Asia/Shanghai：UTC 17:00 與 UTC 23:00 同一北京日 → 0 天', () => {
    expect(
      getDaysBetween('2026-05-24T17:00:00Z', '2026-05-24T23:00:00Z', 'Asia/Shanghai')
    ).toBe(0);
  });

  it('Asia/Shanghai：UTC 15:00 與 UTC 17:00 跨北京日 → 1 天', () => {
    // UTC 15:00 = 北京 23:00 (5/24)
    // UTC 17:00 = 北京 01:00 (5/25)
    expect(
      getDaysBetween('2026-05-24T15:00:00Z', '2026-05-24T17:00:00Z', 'Asia/Shanghai')
    ).toBe(1);
  });

  it('#166 場景：UTC 凌晨 02:00（北京 10:00）建立訂閱，期望"今天"是北京 5/24 而非 UTC 5/24', () => {
    // 使用者在北京時間 2026-05-24 10:00 建立訂閱，開始日期取"今日"
    // 此時 UTC 是 2026-05-24 02:00
    const utcNow = new Date('2026-05-24T02:00:00Z');
    const userTzNow = getNowInTimezone('Asia/Shanghai', utcNow);
    expect(userTzNow.parts.day).toBe(24);
    expect(userTzNow.parts.hour).toBe(10);

    // 選一個明顯落在北京 5/27 中段的到期時刻（北京 5/27 14:00 = UTC 06:00）
    const expiry = new Date('2026-05-27T06:00:00Z');
    expect(getDaysBetween(utcNow, expiry, 'Asia/Shanghai')).toBe(3);
  });

  it('#166 邊界場景：UTC 23:30（北京次日 07:30）建立訂閱，"今日"應是次日北京日期', () => {
    const utcNow = new Date('2026-05-23T23:30:00Z');
    const userTzNow = getNowInTimezone('Asia/Shanghai', utcNow);
    expect(userTzNow.parts.day).toBe(24); // 北京 5/24
    expect(userTzNow.parts.hour).toBe(7);
  });

  it('to 早於 from 時返回負數', () => {
    expect(
      getDaysBetween('2026-05-25T00:00:00Z', '2026-05-23T00:00:00Z', 'UTC')
    ).toBe(-2);
  });
});

describe('formatLocalDate', () => {
  const utcInstant = '2026-05-24T03:30:45.000Z';

  it('format=date 返回本地日期', () => {
    const s = formatLocalDate(utcInstant, 'Asia/Shanghai', 'date');
    expect(s).toContain('2026');
    expect(s).toContain('05'); // 11:30 北京 5/24
  });

  it('format=datetime 包含時分秒', () => {
    const s = formatLocalDate(utcInstant, 'Asia/Shanghai', 'datetime');
    expect(s).toContain('11');
    expect(s).toContain('30');
  });

  it('format=isoLocal 返回 YYYY-MM-DDTHH:mm:ss 無時區字尾', () => {
    const s = formatLocalDate(utcInstant, 'Asia/Shanghai', 'isoLocal');
    expect(s).toBe('2026-05-24T11:30:45');
  });

  it('無效輸入返回空串', () => {
    expect(formatLocalDate('not a date', 'UTC', 'date')).toBe('');
  });

  it('formatTimeInTimezone 與 formatLocalDate 等價（相容老呼叫）', () => {
    expect(formatTimeInTimezone(utcInstant, 'UTC', 'isoLocal')).toBe('2026-05-24T03:30:45');
  });

  it('formatBeijingTime 走 Asia/Shanghai', () => {
    expect(formatBeijingTime(utcInstant, 'isoLocal')).toBe('2026-05-24T11:30:45');
  });
});

describe('getTimezoneOffset & formatTimezoneDisplay', () => {
  it('UTC 偏移 0', () => {
    expect(getTimezoneOffset('UTC')).toBe(0);
  });

  it('Asia/Shanghai 偏移 +8', () => {
    expect(getTimezoneOffset('Asia/Shanghai')).toBe(8);
  });

  it('formatTimezoneDisplay 包含中文名 + 偏移', () => {
    const s = formatTimezoneDisplay('Asia/Shanghai');
    expect(s).toContain('中國');
    expect(s).toContain('+8');
  });
});

describe('extractTimezone', () => {
  it('?timezone=Asia/Tokyo 優先順序最高', () => {
    const req = new Request('https://x/?timezone=Asia/Tokyo', {
      headers: { 'X-Timezone': 'UTC', 'Accept-Language': 'en-US' }
    });
    expect(extractTimezone(req)).toBe('Asia/Tokyo');
  });

  it('Header X-Timezone 次之', () => {
    const req = new Request('https://x/', {
      headers: { 'X-Timezone': 'Asia/Tokyo', 'Accept-Language': 'en-US' }
    });
    expect(extractTimezone(req)).toBe('Asia/Tokyo');
  });

  it('Accept-Language zh → Asia/Shanghai', () => {
    const req = new Request('https://x/', { headers: { 'Accept-Language': 'zh-CN' } });
    expect(extractTimezone(req)).toBe('Asia/Shanghai');
  });

  it('無任何提示 → UTC', () => {
    expect(extractTimezone(new Request('https://x/'))).toBe('UTC');
  });

  it('非法 ?timezone 被忽略，回退到 Header / Accept-Language', () => {
    const req = new Request('https://x/?timezone=Foo/Bar', {
      headers: { 'Accept-Language': 'zh' }
    });
    expect(extractTimezone(req)).toBe('Asia/Shanghai');
  });
});

describe('向後相容 wrapper', () => {
  it('getCurrentTimeInTimezone 返回 Date 例項（UTC 時刻）', () => {
    const d = getCurrentTimeInTimezone('Asia/Shanghai');
    expect(d).toBeInstanceOf(Date);
    expect(Math.abs(d.getTime() - Date.now())).toBeLessThan(1000);
  });

  it('getTimestampInTimezone 返回數字時間戳', () => {
    const t = getTimestampInTimezone('UTC');
    expect(typeof t).toBe('number');
    expect(Math.abs(t - Date.now())).toBeLessThan(1000);
  });

  it('convertUTCToTimezone 返回的 Date 與原始相同 UTC 時刻', () => {
    const orig = new Date('2026-05-24T03:30:00Z');
    const converted = convertUTCToTimezone(orig, 'Asia/Shanghai');
    expect(converted.getTime()).toBe(orig.getTime());
    expect(converted).not.toBe(orig); // 複製
  });
});

describe('常量', () => {
  it('MS_PER_HOUR 與 MS_PER_DAY', () => {
    expect(MS_PER_HOUR).toBe(3600_000);
    expect(MS_PER_DAY).toBe(86_400_000);
  });
});
