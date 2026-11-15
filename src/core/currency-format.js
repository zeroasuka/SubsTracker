// @ts-check
/**
 * 貨幣格式化共享工具
 *
 * 早期版本曾在不同程式碼路徑（新增表單 / 列表 / 通知正文 / 歷史 / 第三方觸發）
 * 中重覆定義了 currencySymbols，且偶爾預設回退 ¥（CNY 符號）造成幣種與展示不一致。
 *
 * 統一使用本模組：
 *   formatAmount(123.45, 'USD')   → '$123.45'
 *   formatAmount(123.45, 'JPY')   → 'JP¥123.45'   （JPY 與 CNY 同符號但加字首以避免歧義）
 *   formatAmount(null, 'USD')     → ''
 *
 */

/**
 * 幣種 → 符號（字首）對映。
 * JPY 故意使用 'JP¥' 字首以避免與 CNY 的 ¥ 混淆。
 */
export const CURRENCY_SYMBOLS = {
  CNY: '¥',
  USD: '$',
  HKD: 'HK$',
  TWD: 'NT$',
  JPY: 'JP¥',
  EUR: '€',
  GBP: '£',
  KRW: '₩',
  TRY: '₺'
};

/**
 * 取幣種符號，未知幣種回退到幣種程式碼本身。
 *
 * @param {string} [currency='CNY']
 * @returns {string}
 */
export function getCurrencySymbol(currency = 'CNY') {
  const code = String(currency || 'CNY').toUpperCase();
  return CURRENCY_SYMBOLS[code] || code + ' ';
}

/**
 * 格式化金額字串，amount 為空時返回空串。
 *
 * @param {number|string|null|undefined} amount
 * @param {string} [currency='CNY']
 * @param {{ withDecimal?: boolean }} [opts]
 * @returns {string}
 */
export function formatAmount(amount, currency = 'CNY', opts = {}) {
  if (amount === null || amount === undefined || amount === '') return '';
  const n = Number(amount);
  if (Number.isNaN(n)) return '';
  const sym = getCurrencySymbol(currency);
  const fixed = opts.withDecimal === false ? String(Math.round(n)) : n.toFixed(2);
  return sym + fixed;
}
