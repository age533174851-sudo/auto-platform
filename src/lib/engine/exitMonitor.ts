// src/lib/engine/exitMonitor.ts
//
// 비대칭 청산의 나머지 절반 — 트레일링 · 본전 이동 · 시간 청산.
//
// 손절과 분할 익절은 진입 시점에 거래소 주문으로 걸린다(exitPlan.ts).
// 그런데 트레일링은 "최고점에서 얼마나 물러났는지"를 계속 봐야 하고,
// 본전 이동은 조건 충족 시 기존 손절을 바꿔야 하며, 시간 청산은 경과
// 시간을 판단해야 한다. 셋 다 단일 주문으로 표현할 수 없어 감시가 필요하다.
//
// 왜 워커가 아니라 Vercel인가
// ──────────────────────────
// Railway 워커는 Binance가 IP 지역을 차단해 주문이 나가지 않는다
// (jobs 테이블에 "Service unavailable from a restricted location" 기록).
// Vercel은 vercel.json의 regions가 hnd1(도쿄)이라 정상 연결된다.
// 그래서 감시를 Vercel Cron으로 옮겼다.
//
// 상태를 DB에 쌓지 않는 이유
// ─────────────────────────
// highWaterR 같은 값을 테이블에 누적하면 실행이 겹치거나 건너뛸 때 값이
// 어긋난다. 대신 매번 진입 이후 캔들을 다시 읽어 최고점을 계산한다.
// 느리지만 중복 실행·누락에 영향받지 않는다.

export const R_TRAIL_START = 2;   // 이 R을 넘으면 트레일링 시작
export const R_TRAIL_DIST  = 1;   // 최고점에서 이만큼 R 물러나면 청산
export const R_BREAK_EVEN  = 1;   // 이 R 도달 시 손절을 본전으로

export interface ExitDecision {
  tradeId: string;
  userId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  action: 'NONE' | 'MOVE_STOP' | 'CLOSE';
  newStop?: number;
  currentStop: number;
  entryPrice: number;
  highWaterR: number;
  lastPrice: number;
  reason: string;
}

/** 진입 이후 15분봉으로 최고 도달 R을 계산한다. */
export async function highWaterSince(
  symbol: string, sinceMs: number, entry: number, stop: number, isLong: boolean, testnet: boolean,
): Promise<{ highWaterR: number; lastPrice: number } | null> {
  const host = testnet ? 'https://demo-fapi.binance.com' : 'https://fapi.binance.com';
  try {
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
 * 판단만 한다 — 주문은 내지 않는다.
 */
export async function decideExits(
  sb: any,
  opts: { testnet: boolean; maxHoldMs?: number; limit?: number } ,
): Promise<ExitDecision[]> {
  const maxHoldMs = opts.maxHoldMs ?? 5 * 24 * 60 * 60 * 1000;
  const out: ExitDecision[] = [];

  const { data: open } = await sb
    .from('ladder_daily_trades')
    .select('id, user_id, symbol, side, entry_price, stop_loss, created_at')
    .eq('status', 'OPEN')
    .limit(opts.limit ?? 25);

  if (!Array.isArray(open) || open.length === 0) return out;

  for (const t of open as any[]) {
    const entry = Number(t.entry_price);
    const stop  = Number(t.stop_loss);
    const side: 'LONG' | 'SHORT' = String(t.side).toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG';
    const isLong = side === 'LONG';
    if (!entry || !stop) continue;

    const openedAt = new Date(t.created_at).getTime();
    const common = {
      tradeId: t.id, userId: t.user_id, symbol: t.symbol, side,
      currentStop: stop, entryPrice: entry,
    };

    // ── 시간 청산 ──
    if (Date.now() - openedAt >= maxHoldMs) {
      out.push({
        ...common, action: 'CLOSE', highWaterR: 0, lastPrice: entry,
        reason: `최대 보유 기간(${Math.round(maxHoldMs / 86_400_000)}일) 초과 — 시간 청산`,
      });
      continue;
    }

    const hw = await highWaterSince(t.symbol, openedAt, entry, stop, isLong, opts.testnet);
    if (!hw) {
      out.push({ ...common, action: 'NONE', highWaterR: 0, lastPrice: entry, reason: '캔들 조회 실패 — 이번 주기 건너뜀' });
      continue;
    }

    const riskDist = Math.abs(entry - stop);
    let desiredStop = stop;
    let reason = '';

    // ── 본전 이동 ──
    if (hw.highWaterR >= R_BREAK_EVEN) {
      if (isLong ? entry > desiredStop : entry < desiredStop) {
        desiredStop = entry;
        reason = `${R_BREAK_EVEN}R 도달 — 손절을 본전으로`;
      }
    }

    // ── 트레일링 ──
    if (hw.highWaterR >= R_TRAIL_START) {
      const trailR = hw.highWaterR - R_TRAIL_DIST;
      const trailPrice = isLong ? entry + riskDist * trailR : entry - riskDist * trailR;
      if (isLong ? trailPrice > desiredStop : trailPrice < desiredStop) {
        desiredStop = trailPrice;
        reason = `최고 ${hw.highWaterR.toFixed(2)}R — 트레일링 손절을 ${trailR.toFixed(2)}R로 이동`;
      }
    }

    // 손절은 좁히기만 한다
    const improves = isLong ? desiredStop > stop : desiredStop < stop;
    if (!improves) {
      out.push({ ...common, action: 'NONE', highWaterR: hw.highWaterR, lastPrice: hw.lastPrice, reason: '이동 조건 미충족' });
      continue;
    }

    // 현재가가 이미 새 손절선을 지났으면 이동이 아니라 청산이다
    const passed = isLong ? hw.lastPrice <= desiredStop : hw.lastPrice >= desiredStop;
    out.push({
      ...common,
      action: passed ? 'CLOSE' : 'MOVE_STOP',
      newStop: passed ? undefined : desiredStop,
      highWaterR: hw.highWaterR,
      lastPrice: hw.lastPrice,
      reason: passed ? `${reason} — 현재가가 이미 그 선을 지나 즉시 청산` : reason,
    });
  }

  return out;
}
