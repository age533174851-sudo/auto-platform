// worker/src/exitMonitor.ts
//
// 비대칭 청산의 나머지 절반 — 트레일링 · 본전 이동 · 시간 청산.
//
// 손절과 분할 익절은 진입 시점에 거래소 주문으로 걸린다(exitPlan.ts).
// 그런데 트레일링은 "최고점에서 얼마나 물러났는지"를 계속 봐야 하고,
// 본전 이동은 조건 충족 시 기존 손절을 바꿔야 하며, 시간 청산은 경과
// 시간을 판단해야 한다. 셋 다 단일 주문으로 표현할 수 없어 감시가 필요하다.
//
// 상태를 DB에 쌓지 않는 이유
// ─────────────────────────
// highWaterR 같은 값을 테이블에 누적하면 워커가 죽거나 두 번 돌 때 값이
// 어긋난다. 대신 매 주기마다 진입 이후 캔들을 다시 읽어 최고점을 계산한다.
// 느리지만 재시작·중복 실행에 영향받지 않는다.
import { sb } from './supabase';

const R_TRAIL_START = 2;      // 이 R을 넘으면 트레일링 시작
const R_TRAIL_DIST = 1;       // 최고점에서 이만큼 R 물러나면 청산
const R_BREAK_EVEN = 1;       // 이 R 도달 시 손절을 본전으로

export interface ExitCheck {
  tradeId: string;
  symbol: string;
  action: 'NONE' | 'MOVE_STOP' | 'CLOSE';
  newStop?: number;
  reason: string;
  highWaterR: number;
}

/** 진입 이후 15분봉을 읽어 최고 도달 R을 계산한다. */
async function highWaterSince(
  symbol: string, sinceMs: number, entry: number, stop: number, isLong: boolean, testnet: boolean,
): Promise<{ highWaterR: number; lastPrice: number } | null> {
  try {
    const host = testnet ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com';
    const r = await fetch(
      `${host}/fapi/v1/klines?symbol=${symbol}&interval=15m&startTime=${sinceMs}&limit=500`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!r.ok) return null;
    const rows = await r.json();
    if (!Array.isArray(rows) || rows.length === 0) return null;

    const riskDist = Math.abs(entry - stop);
    if (riskDist <= 0) return null;

    let best = 0;
    let lastPrice = entry;
    for (const k of rows) {
      const high = parseFloat(k[2]), low = parseFloat(k[3]), close = parseFloat(k[4]);
      if (!Number.isFinite(high) || !Number.isFinite(low)) continue;
      const favorable = isLong ? high : low;
      const move = isLong ? favorable - entry : entry - favorable;
      const r2 = move / riskDist;
      if (r2 > best) best = r2;
      if (Number.isFinite(close)) lastPrice = close;
    }
    return { highWaterR: best, lastPrice };
  } catch { return null; }
}

/**
 * 열려 있는 계단식 거래를 점검해 필요한 조치를 계산한다.
 * 조치 실행은 호출자가 한다 — 이 함수는 판단만 하고 주문을 내지 않는다.
 */
export async function checkLadderExits(opts: {
  testnet: boolean;
  maxHoldMs?: number;      // 기본 5일
}): Promise<ExitCheck[]> {
  const maxHoldMs = opts.maxHoldMs ?? 5 * 24 * 60 * 60 * 1000;
  const out: ExitCheck[] = [];

  const { data: open } = await sb()
    .from('ladder_daily_trades')
    .select('id, symbol, side, entry_price, stop_loss, created_at, status')
    .eq('status', 'OPEN')
    .limit(50);

  if (!Array.isArray(open) || open.length === 0) return out;

  for (const t of open as any[]) {
    const entry = Number(t.entry_price);
    const stop = Number(t.stop_loss);
    const isLong = String(t.side).toUpperCase() === 'LONG';
    if (!entry || !stop) continue;

    const openedAt = new Date(t.created_at).getTime();
    const heldMs = Date.now() - openedAt;

    // ── 시간 청산 ──
    if (heldMs >= maxHoldMs) {
      out.push({
        tradeId: t.id, symbol: t.symbol, action: 'CLOSE', highWaterR: 0,
        reason: `최대 보유 기간(${Math.round(maxHoldMs / 86_400_000)}일) 초과 — 시간 청산`,
      });
      continue;
    }

    const hw = await highWaterSince(t.symbol, openedAt, entry, stop, isLong, opts.testnet);
    if (!hw) {
      out.push({ tradeId: t.id, symbol: t.symbol, action: 'NONE', highWaterR: 0, reason: '캔들 조회 실패 — 이번 주기 건너뜀' });
      continue;
    }

    const riskDist = Math.abs(entry - stop);
    let desiredStop = stop;
    let reason = '';

    // ── 본전 이동 ──
    if (hw.highWaterR >= R_BREAK_EVEN) {
      const be = entry;
      if (isLong ? be > desiredStop : be < desiredStop) { desiredStop = be; reason = `${R_BREAK_EVEN}R 도달 — 손절을 본전으로`; }
    }

    // ── 트레일링 ──
    if (hw.highWaterR >= R_TRAIL_START) {
      const trailR = hw.highWaterR - R_TRAIL_DIST;
      const trailPrice = isLong ? entry + riskDist * trailR : entry - riskDist * trailR;
      if (isLong ? trailPrice > desiredStop : trailPrice < desiredStop) {
        desiredStop = trailPrice;
        reason = `최고 ${hw.highWaterR.toFixed(2)}R — 트레일링 손절 ${trailR.toFixed(2)}R로 이동`;
      }
    }

    // 손절은 좁히기만 한다. 넓히는 방향이면 아무것도 하지 않는다.
    const improves = isLong ? desiredStop > stop : desiredStop < stop;
    if (!improves) {
      out.push({ tradeId: t.id, symbol: t.symbol, action: 'NONE', highWaterR: hw.highWaterR, reason: '이동 조건 미충족' });
      continue;
    }

    // 이미 현재가가 새 손절선을 지났으면 이동이 아니라 청산이다
    const passed = isLong ? hw.lastPrice <= desiredStop : hw.lastPrice >= desiredStop;
    out.push({
      tradeId: t.id, symbol: t.symbol,
      action: passed ? 'CLOSE' : 'MOVE_STOP',
      newStop: passed ? undefined : desiredStop,
      highWaterR: hw.highWaterR,
      reason: passed ? `${reason} — 현재가가 이미 그 선을 지나 즉시 청산` : reason,
    });
  }

  return out;
}

/** 점검 결과를 DB에 남긴다 (주문 실행과 분리 — 판단 이력을 잃지 않기 위함). */
export async function recordExitCheck(check: ExitCheck, executed: boolean, error?: string): Promise<void> {
  if (check.action === 'NONE') return;
  try {
    await sb().from('ladder_daily_trades').update({
      exit_reason: `${check.action}: ${check.reason}${executed ? '' : ` (실행 실패: ${error || '?'})`}`,
      ...(check.action === 'CLOSE' && executed ? { status: 'CLOSED', closed_at: new Date().toISOString() } : {}),
      ...(check.action === 'MOVE_STOP' && executed && check.newStop ? { stop_loss: check.newStop } : {}),
    }).eq('id', check.tradeId);
  } catch { /* 기록 실패가 주문을 되돌리지는 않는다 */ }
}
