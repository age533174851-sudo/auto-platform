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

import { highWaterOf, barFromBinance, barFromGate, gateContractOf, type Bar } from './highWater';

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

/**
 * 진입 이후 15분봉으로 최고 도달 R을 계산한다.
 *
 * **어느 거래소인지 묻는다.** 예전에는 호스트가
 * `testnet ? demo-fapi.binance : fapi.binance`로 고정이라, Gate에서 연
 * 포지션도 바이낸스에 물었다. 심볼 표기까지 달라서(`BTCUSDT` ↔
 * `BTC_USDT`) 조회가 실패했고, 그 실패는 `null` → "캔들 조회 실패 —
 * 이번 주기 건너뜀"으로 끝났다. **매 주기 조용히 반복되므로 Gate
 * 포지션의 트레일링은 영원히 안 돌았다.**
 *
 * R 계산은 `highWater.ts`에 있다 — 망을 안 타고 확인할 수 있어야 한다.
 */
export async function highWaterSince(
  symbol: string, sinceMs: number, entry: number, stop: number, isLong: boolean, testnet: boolean,
  exchange: 'binance' | 'gate' = 'binance',
): Promise<{ highWaterR: number; lastPrice: number } | null> {
  try {
    let bars: Bar[] = [];

    if (exchange === 'gate') {
      const { getCandlesGateFutures } = await import('../exchanges/gateFutures');
      const rows = await getCandlesGateFutures(
        gateContractOf(symbol), Math.floor(sinceMs / 1000),
        { interval: '15m', limit: 500, testnet },
      );
      bars = rows.map(barFromGate).filter(Boolean) as Bar[];
    } else {
      const host = testnet ? 'https://demo-fapi.binance.com' : 'https://fapi.binance.com';
      const r = await fetch(
        `${host}/fapi/v1/klines?symbol=${symbol}&interval=15m&startTime=${sinceMs}&limit=500`,
        { signal: AbortSignal.timeout(10_000) },
      );
      if (!r.ok) return null;
      const rows = await r.json();
      if (!Array.isArray(rows)) return null;
      bars = rows.map(barFromBinance).filter(Boolean) as Bar[];
    }

    return highWaterOf({ bars, entry, stop, isLong });
  } catch { return null; }
}

/**
 * 열려 있는 계단식 거래를 점검해 필요한 조치를 계산한다.
 * 판단만 한다 — 주문은 내지 않는다.
 */
export async function decideExits(
  sb: any,
  opts: {
    /**
     * 어느 망의 시세로 판단할 것인가 — **기본값일 뿐이다.**
     *
     * 실제로는 그 포지션을 들고 있는 연결이 정한다. 아래 testnetFor를
     * 넘기면 거래마다 그 연결의 is_testnet을 따른다.
     */
    testnet: boolean;
    /**
     * 이 사용자의 포지션이 어느 망에 있는가.
     *
     * **이게 없어서 사고가 날 뻔했다.** 예전에는 환경변수 하나(LADDER_MODE)로
     * 전부 정했다. 진입은 연결을 따라 실계좌로 나가는데 청산 감시는
     * 테스트넷 시세로 판단하게 되고, 그러면 트레일링도 시간 청산도
     * 실제 포지션에 닿지 않는다. **못 여는 것은 불편이고 못 닫는 것은 사고다.**
     */
    testnetFor?: (userId: string) => Promise<boolean | null>;
    maxHoldMs?: number; limit?: number;
    /**
     * 심볼별로 **거래소에 지금 걸려 있는** 손절가.
     *
     * DB의 stop_loss는 **진입 시점 값**이고 1R을 정의한다. 예전에는 손절을
     * 옮길 때마다 그 값을 덮어썼는데, 그러면 다음 주기에 1R이 커지고
     * highWaterR이 작아져서 **트레일링이 한 번 움직인 뒤 멈춘다.**
     * 첫 이동은 일어나므로 화면에서는 동작하는 것처럼 보였다.
     *
     * 그래서 진입 손절은 DB가, 지금 걸린 손절은 거래소가 갖는다.
     * 못 읽은 심볼은 진입 손절을 그대로 쓴다.
     */
    /**
     * 지금 거래소에 걸려 있는 손절가.
     *
     * **방향을 같이 넘긴다.** 반대 방향을 닫는 조건부 주문은 남의 것이거나
     * 옛 포지션의 고아라, 그걸 이 포지션의 손절로 읽으면 트레일링이
     * 엉뚱한 값에서 출발한다.
     */
    liveStopFor?: (userId: string, symbol: string, side?: 'LONG' | 'SHORT') => Promise<number | null>;
    /** 트레일링 설정. 없으면 기본값 */
    cfg?: Partial<import('./trailPlan').TrailConfig>;
    /**
     * 이 사용자 것만 본다. 화면이 "내 포지션이 지금 어떤 상태인가"를
     * 물을 때 쓴다 — 크론은 안 넘기고 전부 본다.
     *
     * 판정을 화면 쪽에 다시 적지 않으려고 여기에 거르개를 둔다. 규칙이
     * 두 벌이 되면 화면이 말하는 것과 실제로 손절을 옮기는 것이 갈린다.
     */
    userId?: string | null;
    /**
     * **이 거래가 열린 계좌.**
     *
     * 예전에는 이런 것이 없었고, 부르는 쪽이 `user_id`로 활성 연결
     * 첫 줄을 골랐다. 바이낸스·Gate를 둘 다 연결해 두면 Gate 포지션의
     * 트레일링을 바이낸스 봉으로 계산하고 손절 이동도 바이낸스로 나간다.
     *
     * 못 고르면 `null`이고, 그때는 **손대지 않는다.**
     */
    venueFor?: (t: { userId: string; connectionId: string | null })
      => Promise<import('./tradeVenue').VenueVerdict>;
  },
): Promise<ExitDecision[]> {
  const maxHoldMs = opts.maxHoldMs ?? 5 * 24 * 60 * 60 * 1000;
  const out: ExitDecision[] = [];

  let q = sb
    .from('ladder_daily_trades')
    .select('id, user_id, symbol, side, entry_price, stop_loss, created_at, connection_id')
    .eq('status', 'OPEN');
  if (opts.userId) q = q.eq('user_id', opts.userId);
  const { data: open } = await q.limit(opts.limit ?? 25);

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

    // ── 이 거래가 열린 계좌를 먼저 고른다 ──
    //
    // **거래를 보고 고른다.** 예전에는 이 자리가 없어서 부르는 쪽이
    // `user_id`로 활성 연결 첫 줄을 썼다 — 연결이 둘이면 Gate 포지션의
    // 손절 이동이 바이낸스로 나간다.
    //
    // 못 고르면 손대지 않는다. 시간 청산은 위에서 이미 처리했으므로
    // 여기서 멈추는 것은 트레일링·본전이동뿐이고, **엉뚱한 계좌에
    // 주문을 내는 것보다 이번 주기를 거르는 쪽이 낫다.**
    let tnet = opts.testnet;
    let venueEx: 'binance' | 'gate' = 'binance';
    let venueNote = '';
    if (opts.venueFor) {
      const v = await opts.venueFor({
        userId: String(t.user_id),
        connectionId: t.connection_id == null ? null : String(t.connection_id),
      });
      if (!v.actionable || !v.connection) {
        out.push({ ...common, action: 'NONE', highWaterR: 0, lastPrice: entry,
          reason: `계좌를 고르지 못해 건너뜁니다 (${v.code}) — ${v.reason}` });
        continue;
      }
      tnet = v.connection.testnet;
      venueEx = v.connection.exchange ?? 'binance';
      if (v.code !== 'OWNED') venueNote = ` (${v.reason})`;
    } else if (opts.testnetFor) {
      // 예전 호출부 호환. 거래소는 모르므로 바이낸스로 남는다.
      const r = await opts.testnetFor(String(t.user_id));
      if (r == null) venueNote = ' (이 거래의 연결을 못 읽어 기본 망으로 조회했습니다)';
      else tnet = r;
    }

    // **봉을 그 거래소에서 가져온다.** 예전에는 언제나 바이낸스였다.
    const hw = await highWaterSince(t.symbol, openedAt, entry, stop, isLong, tnet, venueEx);
    if (!hw) {
      out.push({ ...common, action: 'NONE', highWaterR: 0, lastPrice: entry,
        reason: `캔들 조회 실패(${venueEx}) — 이번 주기 건너뜀${venueNote}` });
      continue;
    }

    // 판정은 순수 함수가 한다 (trailPlan.ts — 테스트가 붙어 있다).
    // 여기서 계산을 다시 적으면 두 벌이 되고, 그중 한쪽만 고쳐진다.
    const { planTrail } = await import('./trailPlan');
    let liveStop: number | null = null;
    try { liveStop = (await opts.liveStopFor?.(t.user_id, String(t.symbol), side)) ?? null; }
    catch { liveStop = null; }   // 못 읽으면 진입 손절을 그대로 쓴다
    const v = planTrail({
      side,
      entryPrice: entry,
      initialStop: stop,                        // 1R의 기준. 절대 안 바뀐다
      currentStop: liveStop ?? stop,             // 거래소에 지금 걸린 것
      highWaterR: hw.highWaterR,
      lastPrice: hw.lastPrice,
      cfg: opts.cfg,
    });

    out.push({
      ...common,
      currentStop: liveStop ?? stop,
      action: v.action,
      newStop: v.newStop,
      highWaterR: hw.highWaterR,
      lastPrice: hw.lastPrice,
      reason: v.reason,
    });
  }

  return out;
}
