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

import { MONITORED_STATUSES } from '../strategies/entryLedger';

export const R_TRAIL_START = 2;   // 이 R을 넘으면 트레일링 시작
export const R_TRAIL_DIST  = 1;   // 최고점에서 이만큼 R 물러나면 청산
export const R_BREAK_EVEN  = 1;   // 이 R 도달 시 손절을 본전으로

export interface ExitDecision {
  tradeId: string;
  userId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  /**
   * **이 포지션이 있는 연결.** 없으면 065 이전에 만들어진 줄이다.
   *
   * 부르는 쪽은 이 값이 있으면 그 연결로만 조회·주문하고, 없으면
   * 예전처럼 사용자 단위로 찾되 **그 사실을 기록에 남긴다** —
   * 추측한 것과 아는 것은 다르다.
   */
  connectionId: string | null;
  action: 'NONE' | 'MOVE_STOP' | 'CLOSE';
  newStop?: number;
  currentStop: number;
  entryPrice: number;
  highWaterR: number;
  lastPrice: number;
  reason: string;
}

/** 진입 이후 최고 도달 R을 계산할 때 쓰는 봉 간격 */
export const HIGH_WATER_INTERVAL = '15m';

/**
 * 봉에서 최고 도달 R과 마지막 가격을 뽑는다.
 *
 * **순수 함수다.** 네트워크 없이 값으로 확인할 수 있어야 한다 — 여기가
 * 틀리면 트레일링이 엉뚱한 자리에서 출발하거나 아예 안 움직인다.
 */
export function highWaterOf(i: {
  highs: number[]; lows: number[]; closes: number[];
  entry: number; stop: number; isLong: boolean;
}): { highWaterR: number; lastPrice: number } | null {
  const riskDist = Math.abs(i.entry - i.stop);
  if (!(riskDist > 0)) return null;
  const n = Math.min(i.highs.length, i.lows.length, i.closes.length);
  if (n === 0) return null;

  let best = 0;
  let lastPrice = i.entry;
  for (let k = 0; k < n; k += 1) {
    const high = Number(i.highs[k]), low = Number(i.lows[k]), close = Number(i.closes[k]);
    if (!Number.isFinite(high) || !Number.isFinite(low)) continue;
    const favorable = i.isLong ? high : low;
    const move = i.isLong ? favorable - i.entry : i.entry - favorable;
    const r2 = move / riskDist;
    if (r2 > best) best = r2;
    if (Number.isFinite(close)) lastPrice = close;
  }
  return { highWaterR: best, lastPrice };
}

/**
 * 진입 이후 15분봉으로 최고 도달 R을 계산한다.
 *
 * **거래소를 가리지 않는다.**
 * 예전에는 여기서 바이낸스 선물 주소를 직접 조립했다:
 *
 *     const host = testnet ? 'https://demo-fapi.binance.com' : 'https://fapi.binance.com';
 *     fetch(`${host}/fapi/v1/klines?symbol=${symbol}...`)
 *
 * 그래서 **Gate에서 연 포지션의 R을 바이낸스 15분봉으로 계산했다.**
 * Gate 심볼(`BTC_USDT`)을 그대로 바이낸스에 물어보므로 대개 400이 나고,
 * 그러면 `null` → "캔들 조회 실패 — 이번 주기 건너뜀"이 매 주기 반복된다.
 * 즉 Gate 포지션은 **트레일링도 본전 이동도 한 번도 못 받았다.**
 * 그리고 그 사유는 조용해서 아무도 안 봤다.
 *
 * 봉을 읽는 자리는 이미 하나 있다(`venueBars.fetchVenueBars`) — Gate의
 * 초 단위 시각, 계약 이름, 간격 이름을 전부 처리한다. 여기에 주소를 또
 * 적을 이유가 없다.
 *
 * **진행 중인 봉을 남긴다.** 지금 봉에서 찍은 고가도 실제로 도달한
 * 가격이다. 그걸 버리면 트레일링이 최대 한 봉(15분)만큼 늦어지고,
 * 그 사이에 되돌아오면 이익을 그냥 반납한다. 신호 판정과 반대 이유다.
 */
export async function highWaterSince(
  symbol: string, sinceMs: number, entry: number, stop: number, isLong: boolean,
  venue: { exchange: 'binance' | 'gate'; testnet: boolean },
  nowMs?: number,
): Promise<{ highWaterR: number; lastPrice: number } | null> {
  try {
    const { fetchVenueBars } = await import('../markets/venueBars');
    const r = await fetchVenueBars({
      exchange: venue.exchange,
      symbol,
      interval: HIGH_WATER_INTERVAL,
      limit: 500,
      testnet: venue.testnet,
      startTimeMs: sinceMs,
      // **최고가는 아직 안 끝난 봉에도 있다.**
      includeIncomplete: true,
      nowMs,
    });
    if (!r.bars) return null;
    return highWaterOf({
      highs: r.bars.highs, lows: r.bars.lows, closes: r.bars.closes,
      entry, stop, isLong,
    });
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
    /**
     * 이 거래가 **어느 거래소**에 있는가.
     *
     * 이게 없으면 시세를 바이낸스에 물어본다. Gate 포지션이면 계약 이름이
     * 달라 조회가 실패하고, 그 실패가 매 주기 "캔들 조회 실패"로 남는다 —
     * 즉 **Gate 포지션은 트레일링을 한 번도 못 받는다.**
     *
     * 못 알아내면 null이다. 그때는 바이낸스로 조회하되 **그 사실을
     * 사유에 적는다** — 추측한 것과 아는 것은 다르다.
     */
    venueFor?: (i: { userId: string; connectionId: string | null })
      => Promise<{ exchange: 'binance' | 'gate'; testnet: boolean } | null>;
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
    liveStopFor?: (
      userId: string, symbol: string, side?: 'LONG' | 'SHORT',
      /** 이 거래의 연결. 있으면 **그 연결로만** 읽는다 */
      connectionId?: string | null,
    ) => Promise<number | null>;
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
  },
): Promise<ExitDecision[]> {
  const maxHoldMs = opts.maxHoldMs ?? 5 * 24 * 60 * 60 * 1000;
  const out: ExitDecision[] = [];

  let q = sb
    .from('ladder_daily_trades')
    .select('id, user_id, symbol, side, entry_price, stop_loss, created_at, connection_id')
    // ── `OPEN` 하나만 보지 않는다 ──
    //
    // 보호 없는 포지션(`UNPROTECTED`)과 나갔는지 모르는 주문
    // (`RECONCILE_REQUIRED`)이야말로 **가장 먼저 봐야 할 것들이다.**
    // 여기서 빼면 그 둘은 아무도 안 보는 상태로 남는다.
    //
    // 상태 목록은 entryLedger가 갖는다 — 두 곳에 적으면 갈린다.
    .in('status', MONITORED_STATUSES);
  if (opts.userId) q = q.eq('user_id', opts.userId);
  const { data: open } = await q.limit(opts.limit ?? 25);

  if (!Array.isArray(open) || open.length === 0) return out;

  for (const t of open as any[]) {
    const entry = Number(t.entry_price);
    const stop  = Number(t.stop_loss);
    const side: 'LONG' | 'SHORT' = String(t.side).toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG';
    const isLong = side === 'LONG';
    const openedAt = new Date(t.created_at).getTime();
    const common = {
      tradeId: t.id, userId: t.user_id, symbol: t.symbol, side,
      connectionId: String(t.connection_id ?? '').trim() || null,
      currentStop: stop || 0, entryPrice: entry || 0,
    };

    // ── 시간 청산이 손절가 검사보다 앞이다 ──
    //
    // **예전에는 반대였다.** `if (!entry || !stop) continue;`가 먼저 있고
    // 시간 청산이 그 뒤였다. 그런데 진입 경로가 `stop_loss`를 안 적고
    // 있었으므로(065 이전) 열린 거래 전부가 첫 줄에서 빠졌다 —
    // **5일 강제 청산조차 한 번도 안 돌았다.**
    //
    // 시간 청산은 1R이 필요 없다. 필요한 것은 언제 열렸는가 하나뿐이고,
    // 그건 장부에 있다. 손절가를 모른다고 **못 닫을 이유가 없다.**
    // 못 여는 것은 불편이고 못 닫는 것은 사고다.
    if (Number.isFinite(openedAt) && Date.now() - openedAt >= maxHoldMs) {
      out.push({
        ...common, action: 'CLOSE', highWaterR: 0, lastPrice: entry || 0,
        reason: `최대 보유 기간(${Math.round(maxHoldMs / 86_400_000)}일) 초과 — 시간 청산`,
      });
      continue;
    }

    // ── 손절가·진입가가 없는 줄 ──
    //
    // 판단은 안 한다 — 1R을 모르면 트레일링을 계산할 수 없다.
    // 다만 **조용히 빼지는 않는다.** 예전에는 여기서 `continue`였고,
    // 그래서 응답의 `checked`가 0이 되어 "볼 것이 없었다"로 읽혔다.
    // 안 본 것과 이상 없는 것은 다르다.
    if (!entry || !stop) {
      out.push({
        ...common, action: 'NONE', highWaterR: 0, lastPrice: entry || 0,
        reason: !entry
          ? '진입가가 장부에 없어 판단할 수 없습니다 — 0이라는 뜻이 아닙니다'
          : '손절가가 장부에 없어 1R을 정할 수 없습니다 — 트레일링·본전이동을 계산하지 못합니다. '
            + '시간 청산과 포지션 점검은 그대로 돕니다',
      });
      continue;
    }

    // 이 거래가 실제로 어느 망·어느 거래소에 있는가. 못 알아내면
    // 기본값을 쓰되, 그건 '모르는 것'이므로 아래 사유에 적힌다.
    let tnet = opts.testnet;
    let tnetKnown = true;
    let exchange: 'binance' | 'gate' = 'binance';
    let venueKnown = false;

    if (opts.venueFor) {
      const v = await opts.venueFor({ userId: String(t.user_id), connectionId: common.connectionId });
      if (v) { exchange = v.exchange; tnet = v.testnet; venueKnown = true; tnetKnown = true; }
      else { tnetKnown = false; }
    }
    // venueFor가 없거나 못 읽었으면 예전 경로로 망만 물어본다 —
    // 갑자기 동작이 바뀌지 않게 한다.
    if (!venueKnown && opts.testnetFor) {
      const r = await opts.testnetFor(String(t.user_id));
      if (r == null) tnetKnown = false; else { tnet = r; tnetKnown = true; }
    }

    const hw = await highWaterSince(
      t.symbol, openedAt, entry, stop, isLong, { exchange, testnet: tnet });
    if (!hw) {
      out.push({ ...common, action: 'NONE', highWaterR: 0, lastPrice: entry,
        reason: '캔들 조회 실패 — 이번 주기 건너뜀'
          + (venueKnown ? ` (${exchange})` : '')
          + (tnetKnown ? '' : ' (이 거래의 연결을 못 읽어 기본 망으로 조회했습니다)')
          + (venueKnown ? '' : ' (거래소를 못 읽어 바이낸스 시세로 조회했습니다 — '
              + 'Gate 포지션이면 이 조회는 계속 실패합니다)') });
      continue;
    }

    // 판정은 순수 함수가 한다 (trailPlan.ts — 테스트가 붙어 있다).
    // 여기서 계산을 다시 적으면 두 벌이 되고, 그중 한쪽만 고쳐진다.
    const { planTrail } = await import('./trailPlan');
    let liveStop: number | null = null;
    try {
      liveStop = (await opts.liveStopFor?.(
        t.user_id, String(t.symbol), side, common.connectionId)) ?? null;
    }
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
