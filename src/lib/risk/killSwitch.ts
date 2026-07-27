// src/lib/risk/killSwitch.ts
// Daily/Weekly/Monthly MDD 킬스위치 — 계좌 손실 제한 + 신규진입 차단
// 서버 영속(Supabase table: kill_switch_state) → webhook도 동일 상태 참조

export type KillAction = 'A' | 'B' | 'C' | 'D';  // A:신규차단 B:봇정지 C:오픈주문취소 D:전포지션종료

export interface KillSwitchConfig {
  enabled: boolean;
  dailyLimitPct: number;
  weeklyLimitPct: number;
  monthlyLimitPct: number;
  absLimitUsdt: number;     // 0 = 미사용
  actionMode: string;       // 예: 'BC' (B+C 기본)
}

export interface KillSwitchState extends KillSwitchConfig {
  active: boolean;
  triggeredAt: number | null;
  triggerReason: string | null;
  dailyStartEquity: number | null;   dailyStartAt: number | null;
  weeklyStartEquity: number | null;  weeklyStartAt: number | null;
  monthlyStartEquity: number | null; monthlyStartAt: number | null;
  noTable?: boolean;
}

export const DEFAULT_KILL: KillSwitchConfig = {
  enabled: true,
  dailyLimitPct: 5,
  weeklyLimitPct: 10,
  monthlyLimitPct: 20,
  absLimitUsdt: 0,
  actionMode: 'BC',
};

export interface KillSwitchStatus {
  config: KillSwitchConfig;
  active: boolean;
  level: 'ok' | 'warning' | 'active';
  triggeredAt: number | null;
  triggerReason: string | null;
  equity: number;
  daily:   { startEquity: number; drawdownPct: number; remainingPct: number };
  weekly:  { startEquity: number; drawdownPct: number; remainingPct: number };
  monthly: { startEquity: number; drawdownPct: number; remainingPct: number };
  absLoss: number;
  noTable?: boolean;
}

// USDT 기준 equity = wallet balance + unrealized PnL
export function computeUsdtEquity(balances: Array<{ asset: string; balance: number; unrealizedPnl: number }>): number {
  const u = balances.find(b => b.asset === 'USDT');
  if (u) return (u.balance || 0) + (u.unrealizedPnl || 0);
  // USDT 없으면 전체 합산 (근사)
  return balances.reduce((s, b) => s + (b.balance || 0) + (b.unrealizedPnl || 0), 0);
}

const DAY = 86400000;
function utcDayIdx(ts: number) { return Math.floor(ts / DAY); }
function utcMonthKey(ts: number) { const d = new Date(ts); return d.getUTCFullYear() * 12 + d.getUTCMonth(); }

// 기간 경계 넘었으면 스냅샷 롤오버 (새 baseline = 현재 equity)
export function rolloverSnapshots(state: KillSwitchState, equity: number, now: number): KillSwitchState {
  const s = { ...state };
  if (s.dailyStartAt == null || utcDayIdx(s.dailyStartAt) !== utcDayIdx(now)) { s.dailyStartEquity = equity; s.dailyStartAt = now; }
  if (s.weeklyStartAt == null || (now - s.weeklyStartAt) >= 7 * DAY) { s.weeklyStartEquity = equity; s.weeklyStartAt = now; }
  if (s.monthlyStartAt == null || utcMonthKey(s.monthlyStartAt) !== utcMonthKey(now)) { s.monthlyStartEquity = equity; s.monthlyStartAt = now; }
  return s;
}

function dd(start: number | null, equity: number): number {
  if (!start || start <= 0) return 0;
  return ((equity - start) / start) * 100;
}

// 평가: 롤오버 + drawdown 계산 + active 판정
export function evaluate(state: KillSwitchState, equity: number, now: number): { state: KillSwitchState; status: KillSwitchStatus } {
  const rolled = rolloverSnapshots(state, equity, now);
  const dailyDD = dd(rolled.dailyStartEquity, equity);
  const weeklyDD = dd(rolled.weeklyStartEquity, equity);
  const monthlyDD = dd(rolled.monthlyStartEquity, equity);
  const absLoss = (rolled.dailyStartEquity || equity) - equity;  // 일일 시작 대비 손실액

  const reasons: string[] = [];
  if (rolled.enabled) {
    if (dailyDD <= -rolled.dailyLimitPct)     reasons.push(`일일 손실 ${dailyDD.toFixed(2)}% (한도 -${rolled.dailyLimitPct}%)`);
    if (weeklyDD <= -rolled.weeklyLimitPct)   reasons.push(`주간 손실 ${weeklyDD.toFixed(2)}% (한도 -${rolled.weeklyLimitPct}%)`);
    if (monthlyDD <= -rolled.monthlyLimitPct) reasons.push(`월간 손실 ${monthlyDD.toFixed(2)}% (한도 -${rolled.monthlyLimitPct}%)`);
    if (rolled.absLimitUsdt > 0 && absLoss >= rolled.absLimitUsdt) reasons.push(`절대 손실 ${absLoss.toFixed(2)} USDT (한도 ${rolled.absLimitUsdt})`);
  }
  // 한 번 active면 reset 전까지 유지 (래칭)
  const active = rolled.active || reasons.length > 0;
  const out = { ...rolled, active } as KillSwitchState;
  if (reasons.length > 0 && !rolled.triggeredAt) { out.triggeredAt = now; out.triggerReason = reasons.join(' · '); }
  if (rolled.active && rolled.triggerReason) { out.triggerReason = rolled.triggerReason; out.triggeredAt = rolled.triggeredAt; }

  // 경고 레벨: 한도의 80% 도달
  const warn = rolled.enabled && !active && (
    dailyDD <= -rolled.dailyLimitPct * 0.8 ||
    weeklyDD <= -rolled.weeklyLimitPct * 0.8 ||
    monthlyDD <= -rolled.monthlyLimitPct * 0.8
  );

  const status: KillSwitchStatus = {
    config: { enabled: rolled.enabled, dailyLimitPct: rolled.dailyLimitPct, weeklyLimitPct: rolled.weeklyLimitPct, monthlyLimitPct: rolled.monthlyLimitPct, absLimitUsdt: rolled.absLimitUsdt, actionMode: rolled.actionMode },
    active,
    level: active ? 'active' : warn ? 'warning' : 'ok',
    triggeredAt: out.triggeredAt ?? null,
    triggerReason: out.triggerReason ?? null,
    equity,
    daily:   { startEquity: rolled.dailyStartEquity || equity,   drawdownPct: dailyDD,   remainingPct: Math.max(0, rolled.dailyLimitPct + dailyDD) },
    weekly:  { startEquity: rolled.weeklyStartEquity || equity,  drawdownPct: weeklyDD,  remainingPct: Math.max(0, rolled.weeklyLimitPct + weeklyDD) },
    monthly: { startEquity: rolled.monthlyStartEquity || equity, drawdownPct: monthlyDD, remainingPct: Math.max(0, rolled.monthlyLimitPct + monthlyDD) },
    absLoss,
    noTable: state.noTable,
  };
  return { state: out, status };
}

// ── Supabase 영속 ──────────────────────────────────────────────
function rowToState(row: any): KillSwitchState {
  return {
    enabled: row.enabled !== false,
    dailyLimitPct: Number(row.daily_limit_pct ?? DEFAULT_KILL.dailyLimitPct),
    weeklyLimitPct: Number(row.weekly_limit_pct ?? DEFAULT_KILL.weeklyLimitPct),
    monthlyLimitPct: Number(row.monthly_limit_pct ?? DEFAULT_KILL.monthlyLimitPct),
    absLimitUsdt: Number(row.abs_limit_usdt ?? 0),
    actionMode: row.action_mode ?? DEFAULT_KILL.actionMode,
    active: !!row.active,
    triggeredAt: row.triggered_at ? new Date(row.triggered_at).getTime() : null,
    triggerReason: row.trigger_reason ?? null,
    dailyStartEquity: row.daily_start_equity != null ? Number(row.daily_start_equity) : null,
    dailyStartAt: row.daily_start_at ? new Date(row.daily_start_at).getTime() : null,
    weeklyStartEquity: row.weekly_start_equity != null ? Number(row.weekly_start_equity) : null,
    weeklyStartAt: row.weekly_start_at ? new Date(row.weekly_start_at).getTime() : null,
    monthlyStartEquity: row.monthly_start_equity != null ? Number(row.monthly_start_equity) : null,
    monthlyStartAt: row.monthly_start_at ? new Date(row.monthly_start_at).getTime() : null,
  };
}

function stateToRow(userId: string, connectionId: string, s: KillSwitchState) {
  return {
    user_id: userId, connection_id: connectionId,
    enabled: s.enabled,
    daily_limit_pct: s.dailyLimitPct, weekly_limit_pct: s.weeklyLimitPct, monthly_limit_pct: s.monthlyLimitPct,
    abs_limit_usdt: s.absLimitUsdt, action_mode: s.actionMode,
    active: s.active,
    triggered_at: s.triggeredAt ? new Date(s.triggeredAt).toISOString() : null,
    trigger_reason: s.triggerReason,
    daily_start_equity: s.dailyStartEquity, daily_start_at: s.dailyStartAt ? new Date(s.dailyStartAt).toISOString() : null,
    weekly_start_equity: s.weeklyStartEquity, weekly_start_at: s.weeklyStartAt ? new Date(s.weeklyStartAt).toISOString() : null,
    monthly_start_equity: s.monthlyStartEquity, monthly_start_at: s.monthlyStartAt ? new Date(s.monthlyStartAt).toISOString() : null,
    updated_at: new Date().toISOString(),
  };
}

export async function loadKillSwitch(sb: any, userId: string, connectionId: string): Promise<KillSwitchState> {
  try {
    const { data, error } = await sb.from('kill_switch_state').select('*').eq('user_id', userId).eq('connection_id', connectionId).maybeSingle();
    if (error) return { ...DEFAULT_KILL, active: false, triggeredAt: null, triggerReason: null, dailyStartEquity: null, dailyStartAt: null, weeklyStartEquity: null, weeklyStartAt: null, monthlyStartEquity: null, monthlyStartAt: null, noTable: true } as KillSwitchState;
    if (!data) return { ...DEFAULT_KILL, active: false, triggeredAt: null, triggerReason: null, dailyStartEquity: null, dailyStartAt: null, weeklyStartEquity: null, weeklyStartAt: null, monthlyStartEquity: null, monthlyStartAt: null } as KillSwitchState;
    return rowToState(data);
  } catch {
    return { ...DEFAULT_KILL, active: false, triggeredAt: null, triggerReason: null, dailyStartEquity: null, dailyStartAt: null, weeklyStartEquity: null, weeklyStartAt: null, monthlyStartEquity: null, monthlyStartAt: null, noTable: true } as KillSwitchState;
  }
}

export async function saveKillSwitch(sb: any, userId: string, connectionId: string, s: KillSwitchState): Promise<boolean> {
  try {
    const { error } = await sb.from('kill_switch_state').upsert(stateToRow(userId, connectionId, s), { onConflict: 'user_id,connection_id' });
    return !error;
  } catch { return false; }
}

export async function logKillEvent(sb: any, userId: string, connectionId: string, ev: { reason: string; equity: number; drawdownPct: number; action: string; mode: string }) {
  try {
    await sb.from('kill_switch_log').insert({
      user_id: userId, connection_id: connectionId,
      at: new Date().toISOString(),
      reason: ev.reason, equity: ev.equity, drawdown_pct: ev.drawdownPct, action: ev.action, mode: ev.mode,
    });
  } catch { /* 로그 테이블 없어도 무시 */ }
}

// webhook용 빠른 확인 (connectionId만으로, active 여부) — 테이블 없거나 미설정이면 fail-open(false)
export async function isKillSwitchActive(sb: any, connectionId: string): Promise<{ active: boolean; reason: string | null }> {
  try {
    const { data, error } = await sb.from('kill_switch_state').select('active,trigger_reason').eq('connection_id', connectionId).limit(1).maybeSingle();
    if (error || !data) return { active: false, reason: null };
    return { active: !!data.active, reason: data.trigger_reason ?? null };
  } catch { return { active: false, reason: null }; }
}

// ── 분산 lock (Vercel ↔ Worker 동시 Close All 방지) ─────────────
// lease 방식: expires_at 지나면 탈취 가능. .select()로 실제 갱신 행 수 확인해 race 차단.
export async function acquireLock(sb: any, name: string, holder: string, ttlSec = 60): Promise<boolean> {
  const now = Date.now();
  const expires = new Date(now + ttlSec * 1000).toISOString();
  try {
    const { data: cur } = await sb.from('worker_lock').select('*').eq('name', name).maybeSingle();
    if (!cur) {
      const { error } = await sb.from('worker_lock').insert({ name, holder, expires_at: expires, acquired_at: new Date(now).toISOString() });
      return !error;   // 동시 insert면 PK 충돌로 한쪽만 성공
    }
    const expired = new Date(cur.expires_at).getTime() < now;
    if (cur.holder === holder || expired) {
      // 직전 expires_at과 일치할 때만 갱신(낙관적 락) → 동시 탈취 차단
      const { data: upd } = await sb.from('worker_lock')
        .update({ holder, expires_at: expires, acquired_at: new Date(now).toISOString() })
        .eq('name', name).eq('expires_at', cur.expires_at).select();
      return Array.isArray(upd) && upd.length > 0;
    }
    return false;  // 타인이 유효하게 보유 중
  } catch { return false; }
}

export async function releaseLock(sb: any, name: string, holder: string): Promise<void> {
  try { await sb.from('worker_lock').update({ holder: null, expires_at: new Date(0).toISOString() }).eq('name', name).eq('holder', holder); } catch {}
}

// ── 발동 시 C/D 자동 실행 (순서 엄수: Cancel All → Close All) ────────
export interface KillExecResult {
  cancel: { ran: boolean; success: boolean; count?: number; results?: any[] } | null;
  close:  { ran: boolean; success: boolean; remaining?: number; retries?: number } | null;
}
export async function executeKillActions(
  sb: any, userId: string, connectionId: string,
  opts: { key: string; secret: string; testnet: boolean; actionMode: string },
): Promise<KillExecResult> {
  const { cancelAllOpenOrders, closeAllPositions } = await import('@/lib/exchanges/binanceFutures');
  const mode = (opts.actionMode || '').toUpperCase();
  const doClose = mode.includes('D');
  const doCancel = mode.includes('C') || doClose;   // 종료하려면 반드시 취소가 선행
  const modeLbl = opts.testnet ? 'TESTNET' : 'LIVE';
  const out: KillExecResult = { cancel: null, close: null };

  // 3) Cancel All Open Orders (최대 5회 재시도)
  if (doCancel) {
    let cancel: any = null;
    for (let i = 1; i <= 5; i++) {
      cancel = await cancelAllOpenOrders(opts.key, opts.secret, opts.testnet);
      if (cancel.success) break;
      if (i < 5) await new Promise(r => setTimeout(r, 3000));
    }
    out.cancel = { ran: true, success: !!cancel?.success, count: cancel?.count, results: cancel?.results };
    await logKillEvent(sb, userId, connectionId, { reason: cancel?.success ? '오픈주문 전체 취소 성공' : '오픈주문 취소 일부 실패 — 거래소 직접 확인 필요', equity: 0, drawdownPct: 0, action: 'CANCEL_ALL', mode: modeLbl });
  }

  // 4) Close All Positions (D 옵션, 취소 이후에만)
  if (doClose) {
    const close = await closeAllPositions(opts.key, opts.secret, opts.testnet, 5);
    out.close = { ran: true, success: close.success, remaining: close.remaining, retries: close.retries };
    await logKillEvent(sb, userId, connectionId, { reason: close.success ? '전체 포지션 종료 성공' : `포지션 ${close.remaining}개 잔존 — 거래소 직접 확인 필요`, equity: 0, drawdownPct: 0, action: 'CLOSE_ALL', mode: modeLbl });
  }
  return out;
}

// ── Reconciliation: 발동 후 실제 거래소에 잔여가 있는지 재확인 ─────────
export async function reconcile(
  sb: any, userId: string, connectionId: string,
  opts: { key: string; secret: string; testnet: boolean; expectClosed: boolean },
): Promise<{ positions: number; orders: number; clean: boolean }> {
  const { countOpen } = await import('@/lib/exchanges/binanceFutures');
  const c = await countOpen(opts.key, opts.secret, opts.testnet);
  const clean = opts.expectClosed ? (c.positions === 0 && c.orders === 0) : (c.orders === 0);
  if (!clean) {
    await logKillEvent(sb, userId, connectionId, { reason: `재확인: 포지션 ${c.positions} · 미체결 ${c.orders} 잔존`, equity: 0, drawdownPct: 0, action: 'RECONCILE_WARN', mode: opts.testnet ? 'TESTNET' : 'LIVE' });
  }
  return { ...c, clean };
}
