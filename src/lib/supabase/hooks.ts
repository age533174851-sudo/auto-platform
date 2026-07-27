// src/lib/supabase/hooks.ts
// Client-side persistence: localStorage fallback → Supabase when logged in.
// 'use client' — never import server.ts or admin.ts here.
'use client';

import { getSupabaseClient, getClientUserId } from './client';

// ─── localStorage keys ───────────────────────────────────────
const KEY = {
  watchlist:  'tg_watchlist_v2',
  portfolio:  'tg_portfolio_v1',
  strategies: 'tg_strategies_v1',
  alerts:     'tg_alerts_v1',
  orders:     'tg_orders_v1',
  pnl:        'tg_pnl_v1',
  backtest:   'tg_backtest_v1',
} as const;

// ─── Tiny helpers ────────────────────────────────────────────
function lsGet<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; }
  catch { return fallback; }
}
function lsSet(key: string, val: unknown) {
  if (typeof window === 'undefined') return;
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

// ═══════════════════════════════════════════════════════════════
// 1. PROFILES
// ═══════════════════════════════════════════════════════════════
export async function loadProfile(): Promise<Record<string, unknown> | null> {
  const uid = await getClientUserId();
  const sb  = getSupabaseClient();
  if (!sb || !uid) return null;
  const { data } = await sb.from('profiles').select('*').eq('id', uid).single();
  return data ?? null;
}

export async function upsertProfile(updates: {
  display_name?: string;
  avatar_url?: string;
}): Promise<void> {
  const uid = await getClientUserId();
  const sb  = getSupabaseClient();
  if (!sb || !uid) return;
  await sb.from('profiles').upsert({ id: uid, ...updates, updated_at: new Date().toISOString() });
}

// ═══════════════════════════════════════════════════════════════
// 2. WATCHLISTS
// ═══════════════════════════════════════════════════════════════
export async function loadWatchlist(): Promise<any[]> {
  const uid = await getClientUserId();
  if (uid) {
    try {
      const token = await getAccessToken();
      const res = await fetch('/api/watchlist/sync', {
        headers: buildHeaders(token, uid),
      });
      if (res.ok) {
        const { items } = await res.json();
        lsSet(KEY.watchlist, items); // keep local copy in sync
        return items || [];
      }
    } catch {}
  }
  return lsGet<any[]>(KEY.watchlist, []);
}

export async function addToWatchlist(item: {
  symbol: string; nameKr: string; sym: string;
  clr: string; cat: string; exchange: string; tv?: string;
}): Promise<void> {
  // Optimistic local update
  const wl = lsGet<any[]>(KEY.watchlist, []);
  if (!wl.some(w => w.id === item.symbol)) {
    wl.unshift({ id: item.symbol, nameKr: item.nameKr, sym: item.sym,
                 clr: item.clr, cat: item.cat, exchange: item.exchange,
                 tv: item.tv, addedAt: new Date().toISOString() });
    lsSet(KEY.watchlist, wl);
  }
  const uid = await getClientUserId();
  if (!uid) return;
  try {
    const token = await getAccessToken();
    await fetch('/api/watchlist/sync', {
      method: 'POST',
      headers: buildHeaders(token, uid),
      body: JSON.stringify({
        action: 'add', symbol: item.symbol, nameKr: item.nameKr,
        symbolTicker: item.sym, color: item.clr, category: item.cat,
        exchange: item.exchange, tvSymbol: item.tv,
      }),
    });
  } catch {}
}

export async function removeFromWatchlist(symbol: string): Promise<void> {
  const wl = lsGet<any[]>(KEY.watchlist, []);
  lsSet(KEY.watchlist, wl.filter(w => w.id !== symbol));
  const uid = await getClientUserId();
  if (!uid) return;
  try {
    const token = await getAccessToken();
    await fetch('/api/watchlist/sync', {
      method: 'POST',
      headers: buildHeaders(token, uid),
      body: JSON.stringify({ action: 'remove', symbol }),
    });
  } catch {}
}

export async function syncWatchlistOnLogin(userId: string): Promise<void> {
  const wl = lsGet<any[]>(KEY.watchlist, []);
  if (!wl.length) return;
  try {
    const token = await getAccessToken();
    await fetch('/api/watchlist/sync', {
      method: 'POST',
      headers: buildHeaders(token, userId),
      body: JSON.stringify({ action: 'bulk_sync', items: wl }),
    });
  } catch {}
}

// ═══════════════════════════════════════════════════════════════
// 3. PORTFOLIOS + PORTFOLIO_POSITIONS
// ═══════════════════════════════════════════════════════════════
export async function loadPortfolio(): Promise<{ positions: any[] }> {
  const uid = await getClientUserId();
  const sb  = getSupabaseClient();
  if (sb && uid) {
    try {
      const { data } = await sb
        .from('portfolio_positions')
        .select('*')
        .eq('user_id', uid)
        .order('created_at', { ascending: false });
      const positions = data || [];
      lsSet(KEY.portfolio, positions);
      return { positions };
    } catch {}
  }
  return { positions: lsGet<any[]>(KEY.portfolio, []) };
}

export async function savePortfolioPosition(pos: {
  asset_id: string; name_kr: string; symbol: string; color: string;
  type: string; avg_price: number; quantity: number; invested: number;
  target_price: number; stop_price: number; leverage?: number; note?: string;
}): Promise<void> {
  const uid = await getClientUserId();
  const sb  = getSupabaseClient();
  // localStorage first
  const saved = lsGet<any[]>(KEY.portfolio, []);
  saved.unshift({ ...pos, id: 'local-' + Date.now(), user_id: uid });
  lsSet(KEY.portfolio, saved);
  if (!sb || !uid) return;
  try {
    await sb.from('portfolio_positions').insert({ ...pos, user_id: uid });
  } catch {}
}

export async function deletePortfolioPosition(id: string): Promise<void> {
  const saved = lsGet<any[]>(KEY.portfolio, []);
  lsSet(KEY.portfolio, saved.filter(p => p.id !== id));
  const uid = await getClientUserId();
  const sb  = getSupabaseClient();
  if (!sb || !uid) return;
  try { await sb.from('portfolio_positions').delete().eq('id', id).eq('user_id', uid); } catch {}
}

// ═══════════════════════════════════════════════════════════════
// 4. TRADING STRATEGIES
// ═══════════════════════════════════════════════════════════════
export async function loadStrategies(): Promise<any[]> {
  const uid = await getClientUserId();
  if (uid) {
    try {
      const token = await getAccessToken();
      const res = await fetch('/api/strategies', { headers: buildHeaders(token, uid) });
      if (res.ok) {
        const { strategies } = await res.json();
        lsSet(KEY.strategies, strategies);
        return strategies || [];
      }
    } catch {}
  }
  return lsGet<any[]>(KEY.strategies, []);
}

export async function saveStrategy(strategy: any): Promise<any | null> {
  const uid = await getClientUserId();
  if (uid) {
    try {
      const token = await getAccessToken();
      const res = await fetch('/api/strategies', {
        method: 'POST',
        headers: buildHeaders(token, uid),
        body: JSON.stringify({ action: 'save', ...strategy }),
      });
      if (res.ok) return (await res.json()).strategy ?? null;
    } catch {}
  }
  const saved = { ...strategy, id: 'local-' + Date.now().toString(36), created_at: new Date().toISOString() };
  const strats = lsGet<any[]>(KEY.strategies, []);
  lsSet(KEY.strategies, [saved, ...strats]);
  return saved;
}

export async function updateStrategy(id: string, updates: any): Promise<void> {
  const strats = lsGet<any[]>(KEY.strategies, []);
  const idx = strats.findIndex(s => s.id === id);
  if (idx >= 0) lsSet(KEY.strategies, strats.map((s, i) => i === idx ? { ...s, ...updates } : s));
  const uid = await getClientUserId();
  if (!uid) return;
  try {
    const token = await getAccessToken();
    await fetch('/api/strategies', {
      method: 'POST',
      headers: buildHeaders(token, uid),
      body: JSON.stringify({ action: 'update', id, ...updates }),
    });
  } catch {}
}

export async function deleteStrategy(id: string): Promise<void> {
  lsSet(KEY.strategies, lsGet<any[]>(KEY.strategies, []).filter(s => s.id !== id));
  const uid = await getClientUserId();
  if (!uid) return;
  try {
    const token = await getAccessToken();
    await fetch('/api/strategies', {
      method: 'POST',
      headers: buildHeaders(token, uid),
      body: JSON.stringify({ action: 'delete', id }),
    });
  } catch {}
}

// ═══════════════════════════════════════════════════════════════
// 5. EXCHANGE CONNECTIONS (read-only on client — no secrets)
// ═══════════════════════════════════════════════════════════════
export async function loadExchangeConnections(): Promise<any[]> {
  const uid = await getClientUserId();
  if (!uid) return [];
  try {
    const token = await getAccessToken();
    const res = await fetch('/api/exchange?action=list', { headers: buildHeaders(token, uid) });
    if (res.ok) return (await res.json()).connections || [];
  } catch {}
  return [];
}

// ═══════════════════════════════════════════════════════════════
// 6. TRADE ORDERS
// ═══════════════════════════════════════════════════════════════
export async function loadOrders(): Promise<any[]> {
  const uid = await getClientUserId();
  const sb  = getSupabaseClient();
  if (sb && uid) {
    try {
      const { data } = await sb
        .from('trade_orders')
        .select('id,symbol,name_kr,side,price,quantity,amount,leverage,fee,slippage,status,pnl,pnl_pct,mode,note,emotion,opened_at,closed_at')
        .eq('user_id', uid)
        .order('opened_at', { ascending: false })
        .limit(200);
      const orders = data || [];
      lsSet(KEY.orders, orders);
      return orders;
    } catch {}
  }
  return lsGet<any[]>(KEY.orders, []);
}

export async function saveOrder(order: any): Promise<void> {
  const uid = await getClientUserId();
  const sb  = getSupabaseClient();
  // Optimistic local update
  const orders = lsGet<any[]>(KEY.orders, []);
  orders.unshift(order);
  if (orders.length > 500) orders.length = 500;
  lsSet(KEY.orders, orders);
  if (!sb || !uid) return;
  try {
    await sb.from('trade_orders').insert({
      user_id:    uid,
      exchange_id: order.exchangeId ?? null,
      symbol:     order.assetId ?? order.symbol,
      name_kr:    order.nameKr,
      side:       order.side,
      price:      order.price,
      quantity:   order.quantity ?? order.qty ?? 0,
      amount:     order.amount,
      leverage:   order.leverage,
      fee:        order.fee,
      slippage:   order.slippage,
      status:     order.status,
      pnl:        order.pnl,
      pnl_pct:    order.pnlPct,
      mode:       order.mode ?? 'paper',
      note:       order.note ?? null,
      emotion:    order.emotion ?? null,
      opened_at:  order.openedAt ?? new Date().toISOString(),
      closed_at:  order.closedAt ?? null,
    });
  } catch {}
}

// ═══════════════════════════════════════════════════════════════
// 7. PNL REPORTS
// ═══════════════════════════════════════════════════════════════
export async function loadPnlReports(): Promise<any[]> {
  const uid = await getClientUserId();
  const sb  = getSupabaseClient();
  if (sb && uid) {
    try {
      const { data } = await sb
        .from('pnl_reports')
        .select('*')
        .eq('user_id', uid)
        .order('period', { ascending: false });
      return data || [];
    } catch {}
  }
  return lsGet<any[]>(KEY.pnl, []);
}

export async function upsertPnlReport(report: {
  period: string; realized_pnl: number; unrealized_pnl: number;
  total_fee: number; trade_count: number; win_count: number;
  loss_count: number; win_rate: number; best_trade: number;
  worst_trade: number; tax_estimate: number;
}): Promise<void> {
  const uid = await getClientUserId();
  const sb  = getSupabaseClient();
  const pnls = lsGet<any[]>(KEY.pnl, []);
  const idx = pnls.findIndex(p => p.period === report.period);
  if (idx >= 0) pnls[idx] = { ...pnls[idx], ...report };
  else pnls.unshift(report);
  lsSet(KEY.pnl, pnls);
  if (!sb || !uid) return;
  try {
    await sb.from('pnl_reports').upsert({ ...report, user_id: uid }, { onConflict: 'user_id,period' });
  } catch {}
}

// ═══════════════════════════════════════════════════════════════
// 8. ALERTS
// ═══════════════════════════════════════════════════════════════
export async function loadAlerts(): Promise<any[]> {
  const uid = await getClientUserId();
  const sb  = getSupabaseClient();
  if (sb && uid) {
    try {
      const { data } = await sb
        .from('alerts')
        .select('id,asset_id,name_kr,condition,value,active,triggered_at,created_at')
        .eq('user_id', uid)
        .order('created_at', { ascending: false });
      const alerts = data || [];
      lsSet(KEY.alerts, alerts);
      return alerts;
    } catch {}
  }
  return lsGet<any[]>(KEY.alerts, []);
}

export async function saveAlert(alert: {
  assetId: string; nameKr: string; condition: 'above' | 'below'; value: number;
}): Promise<void> {
  const uid = await getClientUserId();
  const sb  = getSupabaseClient();
  const local = { ...alert, id: 'local-' + Date.now(), active: true };
  const alerts = lsGet<any[]>(KEY.alerts, []);
  lsSet(KEY.alerts, [local, ...alerts]);
  if (!sb || !uid) return;
  try {
    await sb.from('alerts').insert({
      user_id: uid, asset_id: alert.assetId, name_kr: alert.nameKr,
      condition: alert.condition, value: alert.value, active: true,
    });
  } catch {}
}

export async function updateAlert(id: string, updates: { active?: boolean }): Promise<void> {
  const alerts = lsGet<any[]>(KEY.alerts, []);
  lsSet(KEY.alerts, alerts.map(a => a.id === id ? { ...a, ...updates } : a));
  const uid = await getClientUserId();
  const sb  = getSupabaseClient();
  if (!sb || !uid) return;
  try { await sb.from('alerts').update(updates).eq('id', id).eq('user_id', uid); } catch {}
}

export async function deleteAlert(id: string): Promise<void> {
  lsSet(KEY.alerts, lsGet<any[]>(KEY.alerts, []).filter(a => a.id !== id));
  const uid = await getClientUserId();
  const sb  = getSupabaseClient();
  if (!sb || !uid) return;
  try { await sb.from('alerts').delete().eq('id', id).eq('user_id', uid); } catch {}
}

// ═══════════════════════════════════════════════════════════════
// 9. BACKTEST RESULTS
// ═══════════════════════════════════════════════════════════════
export async function loadBacktestResults(): Promise<any[]> {
  const uid = await getClientUserId();
  const sb  = getSupabaseClient();
  if (sb && uid) {
    try {
      const { data } = await sb
        .from('backtest_results')
        .select('id,strategy_name,asset,timeframe,start_date,end_date,total_trades,win_rate,total_pnl,max_drawdown,sharpe_ratio,params,created_at')
        .eq('user_id', uid)
        .order('created_at', { ascending: false })
        .limit(50);
      return data || [];
    } catch {}
  }
  return lsGet<any[]>(KEY.backtest, []);
}

export async function saveBacktestResult(result: {
  strategy_id?: string; strategy_name: string; asset: string;
  timeframe: string; start_date: string; end_date: string;
  total_trades: number; win_rate: number; total_pnl: number;
  max_drawdown: number; sharpe_ratio?: number;
  params: Record<string, unknown>; equity_curve: unknown[];
}): Promise<void> {
  const uid = await getClientUserId();
  const sb  = getSupabaseClient();
  const saved = lsGet<any[]>(KEY.backtest, []);
  saved.unshift({ ...result, id: 'local-' + Date.now() });
  lsSet(KEY.backtest, saved.slice(0, 50));
  if (!sb || !uid) return;
  try { await sb.from('backtest_results').insert({ ...result, user_id: uid }); } catch {}
}

// ═══════════════════════════════════════════════════════════════
// 10. AUDIT LOGS  (insert-only from client)
// ═══════════════════════════════════════════════════════════════
export async function logClientAudit(action: string, detail: Record<string, unknown>): Promise<void> {
  const uid = await getClientUserId();
  const sb  = getSupabaseClient();
  if (!sb || !uid) return;
  try {
    await sb.from('audit_logs').insert({ actor_id: uid, action, details: detail, result: 'client' });
  } catch {}
}

// ═══════════════════════════════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════════════════════════════
export async function checkSupabaseHealth(): Promise<{
  status: 'ok' | 'error' | 'unconfigured';
  connected: boolean;
  latencyMs: number | null;
  message: string;
  env: Record<string, boolean>;
}> {
  try {
    const res = await fetch('/api/supabase/health');
    const data = await res.json();
    return {
      status: data.status === 'ok' ? 'ok' : data.status === 'unconfigured' ? 'unconfigured' : 'error',
      connected: !!data.connected,
      latencyMs: data.latencyMs ?? null,
      message: data.message || '',
      env: data.env || {},
    };
  } catch {
    return { status: 'error', connected: false, latencyMs: null, message: '헬스 체크 실패', env: {} };
  }
}

// ═══════════════════════════════════════════════════════════════
// Internal helpers
// ═══════════════════════════════════════════════════════════════
async function getAccessToken(): Promise<string | null> {
  const sb = getSupabaseClient();
  if (!sb) return null;
  try {
    const { data } = await sb.auth.getSession();
    return data.session?.access_token ?? null;
  } catch { return null; }
}

function buildHeaders(
  token: string | null,
  userId: string | null
): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) h['Authorization'] = `Bearer ${token}`;
  if (userId) h['x-user-id'] = userId;
  return h;
}
