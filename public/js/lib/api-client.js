/**
 * 簡易 API 客戶端
 *
 * 用法（瀏覽器全域性）：
 *   <script src="/js/lib/api-client.js"></script>
 *   const r = await ApiClient.get('/api/notification-logs');
 *
 * 所有方法都返回解析後的 JSON；HTTP 非 2xx 會丟擲含 status / body 的 Error。
 * 自動帶 Cookie（憑著站內 SameSite=Strict 的 token）。
 */
(function (root) {
  'use strict';

  async function request(method, url, body) {
    /** @type {RequestInit} */
    const init = {
      method,
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(url, init);
    let data = null;
    try {
      data = await res.json();
    } catch {
      // 非 JSON 響應，保留 null
    }
    if (res.status === 401) {
      try {
        if (typeof window !== 'undefined' && window.location && !String(window.location.pathname || '').match(/^\/?$/)) {
          window.location.href = '/';
        }
      } catch (_) { /* ignore */ }
      const err = new Error((data && data.message) || '未授權訪問');
      // @ts-ignore
      err.status = 401;
      // @ts-ignore
      err.body = data;
      throw err;
    }
    if (!res.ok) {
      const err = new Error((data && data.message) || ('HTTP ' + res.status));
      // @ts-ignore
      err.status = res.status;
      // @ts-ignore
      err.body = data;
      throw err;
    }
    return data;
  }

  /**
   * 簡易查詢字串構造（None / undefined 欄位過濾掉）。
   *
   * @param {Record<string, any>} params
   * @returns {string}
   */
  function qs(params) {
    if (!params) return '';
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      usp.append(k, String(v));
    }
    const s = usp.toString();
    return s ? '?' + s : '';
  }

  root.ApiClient = {
    get: (url, params) => request('GET', url + qs(params)),
    post: (url, body) => request('POST', url, body),
    put: (url, body) => request('PUT', url, body),
    delete: (url) => request('DELETE', url),
    qs
  };
})(typeof window !== 'undefined' ? window : globalThis);
