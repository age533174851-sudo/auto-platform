// ─────────────────────────────────────────────────────────────
// src/lib/supabase/hooks.ts
// Client-side data sync: localStorage (unauthenticated) ↔ Supabase (authenticated)
// Import only from client components ('use client')
// ─────────────────────────────────────────────────────────────
'use client';

import { getSupabaseClient, getClientUserId } from './client';

// ─────────────────────────────────────────────────────────────
// WATCHLIST
// ─────────────────────────────────────────────────────────────
const WL_KEY = 'tg_watchlist_v2';

/** Load watchlist: Supabase if logged in, localStorage otherwise */
export async function loadWatchlist(): Promise<any[]> {
  const uid = await getClientUserId();

  if (uid) {
    try {
      const res = await fetch('/api/watchlist/sync', {
        headers: { 'x-user-id': uid },
      });
      if (res.ok) {
        const { items } = await res.json();
        return items || [];
      }
    } catch {}
  }

  // Fallback: localStorage
  try {
    return JSON.parse(localStorage.getItem(WL_KEY) || '[]');
  } catch { return []; }
}

/** Add to watchlist */
export async function addToWatchlist(item: {
  symbol: string; nameKr: string; sym: string;
  clr: string; cat: string; exchange: string; tv?: string;
}): Promise<void> {
  const uid = await getClientUserId();

  // Always update localStorage first for instant UI
  try {
    const wl: any[] = JSON.parse(localStorage.getItem(WL_KEY) || '[]');
    if (!wl.some(w => w.id === item.symbol)) {
      wl.unshift({ id: item.symbol, nameKr: item.nameKr, sym: item.sym,
                   clr: item.clr, cat: item.cat, exchange: item.exchange,
                   tv: item.tv, addedAt: new Date().toISOString() });
      localStorage.setItem(WL_KEY, JSON.stringify(wl));
    }
  } catch {}

  // Sync to Supabase if logged in
  if (uid) {
    try {
      await fetch('/api/watchlist/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': uid },
        body: JSON.stringify({
          action: 'add', symbol: item.symbol, nameKr: item.nameKr,
          symbolTicker: item.sym, color: item.clr, category: item.cat,
          exchange: item.exchange, tvSymbol: item.tv,
        }),
      });
    } catch {}
  }
}

/** Remove from watchlist */
export async function removeFromWatchlist(symbol: string): Promise<void> {
  const uid = await getClientUserId();

  try {
    const wl: any[] = JSON.parse(localStorage.getItem(WL_KEY) || '[]');
    localStorage.setItem(WL_KEY, JSON.stringify(wl.filter(w => w.id !== symbol)));
  } catch {}

  if (uid) {
    try {
      await fetch('/api/watchlist/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': uid },
        body: JSON.stringify({ action: 'remove', symbol }),
      });
    } catch {}
  }
}

/** On login: push localStorage watchlist to Supabase */
export async function syncWatchlistOnLogin(userId: string): Promise<void> {
  try {
    const wl: any[] = JSON.parse(localStorage.getItem(WL_KEY) || '[]');
    if (wl.length === 0) return;
    await fetch('/api/watchlist/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
      body: JSON.stringify({ action: 'bulk_sync', items: wl }),
    });
  } catch {}
}

// ─────────────────────────────────────────────────────────────
// TRADING STRATEGIES
// ─────────────────────────────────────────────────────────────
const STRAT_KEY = 'tg_strategies_v1';

export async function loadStrategies(): Promise<any[]> {
  const uid = await getClientUserId();

  if (uid) {
    try {
      const res = await fetch('/api/strategies', { headers: { 'x-user-id': uid } });
      if (res.ok) {
        const { strategies } = await res.json();
        return strategies || [];
      }
    } catch {}
  }

  try {
    return JSON.parse(localStorage.getItem(STRAT_KEY) || '[]');
  } catch { return []; }
}

export async function saveStrategy(strategy: any): Promise<any | null> {
  const uid = await getClientUserId();

  if (uid) {
    try {
      const res = await fetch('/api/strategies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': uid },
        body: JSON.stringify({ action: 'save', ...strategy }),
      });
      if (res.ok) {
        const { strategy: saved } = await res.json();
        return saved;
      }
    } catch {}
  }

  // localStorage fallback
  try {
    const strats: any[] = JSON.parse(localStorage.getItem(STRAT_KEY) || '[]');
    const saved = { ...strategy, id: 'local-' + Date.now().toString(36), created_at: new Date().toISOString() };
    strats.unshift(saved);
    localStorage.setItem(STRAT_KEY, JSON.stringify(strats));
    return saved;
  } catch { return null; }
}

export async function updateStrategy(id: string, updates: any): Promise<void> {
  const uid = await getClientUserId();

  if (uid) {
    try {
      await fetch('/api/strategies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': uid },
        body: JSON.stringify({ action: 'update', id, ...updates }),
      });
      return;
    } catch {}
  }

  try {
    const strats: any[] = JSON.parse(localStorage.getItem(STRAT_KEY) || '[]');
    const idx = strats.findIndex(s => s.id === id);
    if (idx >= 0) { strats[idx] = { ...strats[idx], ...updates }; localStorage.setItem(STRAT_KEY, JSON.stringify(strats)); }
  } catch {}
}

export async function deleteStrategy(id: string): Promise<void> {
  const uid = await getClientUserId();

  if (uid) {
    try {
      await fetch('/api/strategies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': uid },
        body: JSON.stringify({ action: 'delete', id }),
      });
      return;
    } catch {}
  }

  try {
    const strats: any[] = JSON.parse(localStorage.getItem(STRAT_KEY) || '[]');
    localStorage.setItem(STRAT_KEY, JSON.stringify(strats.filter(s => s.id !== id)));
  } catch {}
}

// ─────────────────────────────────────────────────────────────
// ALERTS
// ─────────────────────────────────────────────────────────────
const ALERT_KEY = 'tg_alerts_v1';

export async function loadAlerts(): Promise<any[]> {
  const uid = await getClientUserId();
  const sb = getSupabaseClient();

  if (sb && uid) {
    try {
      const { data } = await sb.from('alerts').select('*').eq('user_id', uid)
        .order('created_at', { ascending: false });
      return data || [];
    } catch {}
  }

  try { return JSON.parse(localStorage.getItem(ALERT_KEY) || '[]'); }
  catch { return []; }
}

export async function saveAlert(alert: {
  assetId: string; nameKr: string; condition: 'above'|'below'; value: number;
}): Promise<void> {
  const uid = await getClientUserId();
  const sb = getSupabaseClient();

  // Always update localStorage
  try {
    const alerts: any[] = JSON.parse(localStorage.getItem(ALERT_KEY) || '[]');
    alerts.unshift({ ...alert, id: 'local-' + Date.now(), active: true });
    localStorage.setItem(ALERT_KEY, JSON.stringify(alerts));
  } catch {}

  if (sb && uid) {
    try {
      await sb.from('alerts').insert({
        user_id:  uid,
        asset_id: alert.assetId,
        name_kr:  alert.nameKr,
        condition: alert.condition,
        value:    alert.value,
        active:   true,
      });
    } catch {}
  }
}

export async function deleteAlert(alertId: string): Promise<void> {
  const uid = await getClientUserId();
  const sb = getSupabaseClient();

  try {
    const alerts: any[] = JSON.parse(localStorage.getItem(ALERT_KEY) || '[]');
    localStorage.setItem(ALERT_KEY, JSON.stringify(alerts.filter(a => a.id !== alertId)));
  } catch {}

  if (sb && uid) {
    try { await sb.from('alerts').delete().eq('id', alertId).eq('user_id', uid); }
    catch {}
  }
}

// ─────────────────────────────────────────────────────────────
// TRADE ORDERS (history)
// ─────────────────────────────────────────────────────────────
const ORDER_KEY = 'tg_orders_v1';

export async function loadOrders(): Promise<any[]> {
  const uid = await getClientUserId();
  const sb = getSupabaseClient();

  if (sb && uid) {
    try {
      const { data } = await sb.from('trade_orders').select('*').eq('user_id', uid)
        .order('opened_at', { ascending: false }).limit(200);
      return data || [];
    } catch {}
  }

  try { return JSON.parse(localStorage.getItem(ORDER_KEY) || '[]'); }
  catch { return []; }
}

export async function saveOrder(order: any): Promise<void> {
  const uid = await getClientUserId();
  const sb = getSupabaseClient();

  try {
    const orders: any[] = JSON.parse(localStorage.getItem(ORDER_KEY) || '[]');
    orders.unshift(order);
    if (orders.length > 500) orders.length = 500;
    localStorage.setItem(ORDER_KEY, JSON.stringify(orders));
  } catch {}

  if (sb && uid) {
    try {
      await sb.from('trade_orders').insert({
        user_id:    uid,
        exchange_id: order.exchangeId || null,
        symbol:     order.assetId || order.symbol,
        name_kr:    order.nameKr,
        side:       order.side,
        price:      order.price,
        quantity:   order.quantity || order.qty || 0,
        amount:     order.amount,
        leverage:   order.leverage,
        fee:        order.fee,
        slippage:   order.slippage,
        status:     order.status,
        pnl:        order.pnl,
        pnl_pct:    order.pnlPct,
        mode:       order.mode || 'paper',
        note:       order.note || null,
        emotion:    order.emotion || null,
        opened_at:  order.openedAt || new Date().toISOString(),
        closed_at:  order.closedAt || null,
      });
    } catch {}
  }
}

// ─────────────────────────────────────────────────────────────
// HEALTH CHECK (client-side)
// ─────────────────────────────────────────────────────────────
export async function checkSupabaseHealth(): Promise<{
  status: 'ok'|'error'|'unconfigured';
  latencyMs: number | null;
  message: string;
}> {
  try {
    const res = await fetch('/api/supabase/health');
    const data = await res.json();
    return {
      status: data.status === 'ok' ? 'ok' : data.status === 'unconfigured' ? 'unconfigured' : 'error',
      latencyMs: data.latencyMs ?? null,
      message: data.message || '',
    };
  } catch {
    return { status: 'error', latencyMs: null, message: '헬스 체크 실패' };
  }
}
