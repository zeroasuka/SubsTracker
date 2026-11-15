import { handleLogin, handleLogout, getUserFromRequest } from './handlers/auth.js';
import { handleGetConfig, handleUpdateConfig } from './handlers/config.js';
import { handleDashboardStats } from './handlers/dashboard.js';
import { handleThirdPartyNotify } from './handlers/notify.js';
import { handleSubscriptions } from './handlers/subscriptions.js';
import { getConfig } from '../data/config.js';
import { handleTestNotification } from './handlers/test-notification.js';
import { handleExtraRoutes } from "./handlers/extras.js";

async function handleApiRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.slice(4);
  const method = request.method;

  const config = await getConfig(env);

  if (path === '/login' && method === 'POST') {
    return handleLogin(request, env);
  }

  if (path === '/logout' && (method === 'GET' || method === 'POST')) {
    return handleLogout();
  }

  // 第三方通知 API 使用獨立 token 鑒權，必須在 JWT 門禁之前放行
  if (path.startsWith('/notify/')) {
    const thirdPartyResponse = await handleThirdPartyNotify(request, env, config, url);
    if (thirdPartyResponse) return thirdPartyResponse;
  }

  const { user } = await getUserFromRequest(request, env);
  if (!user && path !== '/login') {
    return new Response(
      JSON.stringify({ success: false, message: '未授權訪問' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (path === '/config') {
    if (method === 'GET') return handleGetConfig(env);
    if (method === 'POST') return handleUpdateConfig(request, env);
  }

  if (path === '/dashboard/stats' && method === 'GET') {
    return handleDashboardStats(env, config);
  }

  if (path === '/test-notification' && method === 'POST') {
    return handleTestNotification(request, env);
  }

  // 備份 / 恢覆
  if (path === '/backup' && method === 'GET') {
    const { handleExportBackup } = await import('./handlers/backup.js');
    return handleExportBackup(request, env);
  }
  if (path === '/restore' && method === 'POST') {
    const { handleImportBackup } = await import('./handlers/backup.js');
    return handleImportBackup(request, env);
  }

  // 新增路由：提醒規則 / 通知日誌 / 排程日誌（提醒規則 / 通知日誌 / 排程日誌）
  const extraResponse = await handleExtraRoutes(request, env, path);
  if (extraResponse) return extraResponse;

  const subscriptionResponse = await handleSubscriptions(request, env, path);
  if (subscriptionResponse) return subscriptionResponse;

  const thirdPartyResponse = await handleThirdPartyNotify(request, env, config, url);
  if (thirdPartyResponse) return thirdPartyResponse;

  return new Response(
    JSON.stringify({ success: false, message: '未找到請求的資源' }),
    { status: 404, headers: { 'Content-Type': 'application/json' } }
  );
}

export { handleApiRequest };
