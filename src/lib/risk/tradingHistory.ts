// src/lib/risk/tradingHistory.ts
//
// **과매매 게이트가 볼 사실을 모은다.**
//
// `conviction.ts`의 `overtradingGate`는 순수 판정이다 — 오늘 몇 번
// 들어갔는가, 이 종목에 마지막으로 들어간 것이 언제인가. 그런데 그
// 값을 **아무도 채워 주지 않아서 게이트가 한 번도 안 돌았다.**
// 엔진은 있는데 배선이 없는, 이 저장소에서 가장 자주 나는 고장이다.
//
// 어디서 읽는가
// ─────────────
// 우리 `live_orders`에서 읽는다. 거래소 체결 내역이 아니라 **우리가
// 낸 주문**이다. 두 가지 이유가 있다.
//
//  · 거래소 내역에는 사용자가 앱에서 손으로 낸 거래도 섞인다. 과매매
//    게이트가 막으려는 것은 **이 앱을 통한 반복 진입**이다
//  · 거래소 내역은 체결 기준이라 "냈지만 거부된 주문"이 안 잡힌다.
//    다섯 번 눌러 다섯 번 거부된 것도 과매매다
//
// 무엇을 안 읽는가
// ────────────────
// **연패 횟수와 마지막 손실 시각은 여기서 안 만든다.** `live_orders`에는
// 손익이 없다. 주문 가격과 손절가로 추정할 수는 있지만, 그건 추정이고
// 추정으로 사람을 막으면 왜 막혔는지 설명할 수 없다.
//
// 연패 잠금은 이미 다른 경로가 본다(`lossStreakCheck` — 거래소 손익
// 원장을 읽는다). 같은 판정을 두 곳에서 하면 언젠가 서로 다른 답을 낸다.
//
// 기본은 꺼져 있다
// ────────────────
// 정책을 환경변수로만 켠다. 기본값으로 하루 진입 상한을 넣으면, 아무
// 설정도 안 한 사용자가 어느 날 갑자기 "오늘 진입 5/5회를 다 썼습니다"로
// 막힌다. **아직 아무도 정하지 않은 규율을 강제하는 것은 규율이 아니다.**

import type { OvertradingPolicy, TradingHistory } from './conviction';

/** 실제로 거래소로 나간 것으로 볼 상태 */
const WENT_OUT = new Set(['SENT', 'ACKED', 'FILLED', 'RECONCILED', 'UNKNOWN']);

export interface OrderRowLike {
  symbol?: any;
  side?: any;
  reduce_only?: any;
  status?: any;
  created_at?: any;
}

const num = (v: any): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** 시각을 ms로. 못 읽으면 null — 0으로 두면 1970년이 되어 쿨다운이 늘 지나 있다 */
export function timeOf(v: any): number | null {
  if (v == null || v === '') return null;
  const n = num(v);
  if (n != null) return n;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

/** UTC 하루의 시작. 손실 한도와 같은 기준을 쓴다 — 날짜 경계가 둘이면 안 된다 */
export function utcDayStart(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * 주문 목록 → 과매매 게이트가 볼 사실.
 *
 * **순수 함수다.** 저장소를 안 읽으므로 "거부된 주문도 세는가",
 * "청산은 진입으로 안 세는가"에 테스트를 붙일 수 있다.
 */
export function historyFromOrders(
  rows: OrderRowLike[] | null | undefined,
  opts: { nowMs: number; symbol?: string | null },
): TradingHistory {
  const now = opts.nowMs;
  const dayStart = utcDayStart(now);
  const sym = String(opts.symbol ?? '').trim().toUpperCase();

  let entriesToday = 0;
  let lastEntryOnSymbolMs: number | null = null;

  for (const r of Array.isArray(rows) ? rows : []) {
    // **청산은 진입이 아니다.** 과매매는 들어가는 쪽의 문제다. 나가는
    // 것을 세면 손절을 걸 때마다 상한이 줄어든다.
    if (r?.reduce_only === true) continue;
    // 기록만 하고 안 나간 것(INTENT)과 거부된 것(REJECTED·FAILED)은
    // 뺀다. 거부는 거래소가 이미 막은 것이라 사용자가 다시 시도할 수
    // 있어야 한다 — 여기서 또 세면 두 번 벌하는 것이 된다.
    if (!WENT_OUT.has(String(r?.status ?? '').toUpperCase())) continue;

    const t = timeOf(r?.created_at);
    if (t == null) continue;

    if (t >= dayStart && t <= now) entriesToday++;

    if (sym && String(r?.symbol ?? '').toUpperCase() === sym) {
      if (lastEntryOnSymbolMs == null || t > lastEntryOnSymbolMs) lastEntryOnSymbolMs = t;
    }
  }

  return {
    nowMs: now,
    entriesToday,
    lastEntryOnSymbolMs,
    // 손익이 없으므로 모른다. **0으로 두지 않는다** — 0은 '연패 없음'이고
    // 그건 확인한 사실이 아니다. 연패는 lossStreakCheck가 본다.
    lastLossMs: null,
    consecutiveLosses: null,
  };
}

/**
 * 환경변수에서 정책을 읽는다.
 *
 * **아무것도 안 정했으면 아무것도 막지 않는다.** 값이 하나도 없으면
 * null을 주고, 그러면 이 검사는 목록에 나오지도 않는다.
 */
export function overtradingPolicyOf(
  env: (k: string) => string | undefined = k => process.env[k],
): OvertradingPolicy | null {
  const read = (k: string): number | null => {
    const v = num(env(k));
    return v != null && v > 0 ? v : null;
  };
  const p: OvertradingPolicy = {
    maxEntriesPerDay: read('OVERTRADE_MAX_ENTRIES_PER_DAY'),
    sameSymbolCooldownMin: read('OVERTRADE_SYMBOL_COOLDOWN_MIN'),
    afterLossCooldownMin: read('OVERTRADE_AFTER_LOSS_COOLDOWN_MIN'),
    // 연패 상한은 여기서 안 읽는다 — lossStreakCheck가 이미 본다.
    // 두 곳에서 같은 판정을 하면 언젠가 서로 다른 답을 낸다.
    maxConsecutiveLosses: null,
  };
  const on = p.maxEntriesPerDay != null || p.sameSymbolCooldownMin != null
    || p.afterLossCooldownMin != null;
  return on ? p : null;
}

export interface HistoryRead {
  /** 실제로 읽었는가. false면 **정책이 켜져 있을 때 막아야 한다** */
  known: boolean;
  history: TradingHistory;
  reason: string;
}

/**
 * 이 사용자의 최근 주문에서 사실을 모은다.
 *
 * **못 읽은 것을 '진입 0회'로 만들지 않는다.** 0으로 채우면 조회가
 * 흔들릴 때마다 하루 상한이 통째로 열린다 — 검사를 켜 놓고 안 거는 것과
 * 같다. known:false로 돌려주고 그 판단은 부르는 쪽이 한다.
 */
export async function collectTradingHistory(
  sb: any,
  args: { userId: string; connectionId?: string | null; symbol?: string | null; nowMs?: number },
): Promise<HistoryRead> {
  const now = args.nowMs ?? Date.now();
  const empty = historyFromOrders([], { nowMs: now, symbol: args.symbol });

  if (!sb || !args.userId) {
    return { known: false, history: empty, reason: '사용자를 확인하지 못했습니다' };
  }
  try {
    // 하루치면 충분하다. 종목 쿨다운도 분 단위라 하루를 넘지 않는다.
    const since = new Date(utcDayStart(now)).toISOString();
    let q = (sb.from('live_orders') as any)
      .select('symbol, side, reduce_only, status, created_at')
      .eq('user_id', args.userId)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(500);
    // **계좌를 가린다.** 테스트넷에서 스무 번 눌러 본 것이 실전 상한을
    // 깎으면, 연습이 실전을 막는 것이 된다.
    if (args.connectionId) q = q.eq('connection_id', args.connectionId);

    const { data, error } = await q;
    if (error) {
      return { known: false, history: empty, reason: `주문 이력을 읽지 못했습니다 (${error.message})` };
    }
    return {
      known: true,
      history: historyFromOrders(data, { nowMs: now, symbol: args.symbol }),
      reason: '',
    };
  } catch (e: any) {
    return { known: false, history: empty, reason: `주문 이력 조회 실패 (${e?.message || e})` };
  }
}
