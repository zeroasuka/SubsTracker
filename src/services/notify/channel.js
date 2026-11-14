// @ts-check
/**
 * 通知渠道統一適配器協議
 *
 * 所有渠道實現均遵循此 shape：
 *
 *   export const xxxChannel = {
 *     name: 'xxx',                        // 渠道名（必須與 ENABLED_NOTIFIERS / 配置 key 保持一致）
 *     validateConfig(config) { ... },     // 返回 { ok: true } 或 { ok: false, error: '...' }
 *     async send(payload, config) { ... },// 實際發送
 *     async test(config) { ... }          // 用配置發送一條測試通知
 *   };
 *
 * 這樣 dispatch / 通知日志 / 配置頁測試按鈕可以用同一份代碼處理 9 種渠道。
 *
 */

/**
 * @typedef {Object} ChannelPayload 通知內容載荷
 * @property {string} title 標題
 * @property {string} content 正文（Markdown 風格，由各渠道按需轉換）
 * @property {Object} [metadata] 元數據（tags、subscriptionId 等）
 */

/**
 * @typedef {Object} ChannelResult 渠道發送結果
 * @property {boolean} success 是否成功
 * @property {string} channel 渠道名
 * @property {string} [error] 失敗原因（HTTP 錯誤、API 拒絕等）
 * @property {any} [raw] 三方接口原始返回，便於排查
 */

/**
 * @typedef {Object} ValidateResult
 * @property {boolean} ok
 * @property {string} [error]
 */

/**
 * @typedef {Object} Channel
 * @property {string} name
 * @property {(config: any) => ValidateResult} validateConfig
 * @property {(payload: ChannelPayload, config: any) => Promise<ChannelResult>} send
 * @property {(config: any) => Promise<ChannelResult>} test
 */

/**
 * Telegram MarkdownV2 轉義。
 *
 * 修覆 #81：訂閱名包含 `_*[]()~`>#+-=|{}.!\\` 時 Telegram 會拒絕消息。
 * 注意：這個函數只用於發往 Telegram 的內容，不要污染其他渠道。
 *
 * @param {string} text
 * @returns {string}
 */
export function escapeMarkdownV2(text = '') {
  return String(text).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

/**
 * 把 commonContent 中的 Markdown 標記移除（用於純文本渠道）。
 *
 * @param {string} text
 * @returns {string}
 */
export function stripMarkdown(text = '') {
  return String(text).replace(/(\*\*|\*|##|#|`)/g, '');
}

/**
 * 構造統一的成功結果。
 *
 * @param {string} name
 * @param {any} [raw]
 * @returns {ChannelResult}
 */
export function ok(name, raw) {
  return { success: true, channel: name, raw };
}

/**
 * 構造統一的失敗結果。
 *
 * @param {string} name
 * @param {string} error
 * @param {any} [raw]
 * @returns {ChannelResult}
 */
export function fail(name, error, raw) {
  return { success: false, channel: name, error, raw };
}

/**
 * 把任意 error 轉字符串（兼容 fetch 拋出的 TypeError、Response 等）。
 *
 * @param {any} err
 * @returns {string}
 */
export function errorMessage(err) {
  if (!err) return 'unknown error';
  if (typeof err === 'string') return err;
  if (err.message) return String(err.message);
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
