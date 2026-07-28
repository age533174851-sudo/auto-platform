// src/lib/strategies/watchStore.ts
//
// 트레일링·예약 감시 대상의 저장소.
//
// 왜 signals 테이블인가
// ─────────────────────
// 전용 테이블(spot_watches)이 맞지만 마이그레이션을 적용할 수 없다.
// 그래서 기존 signals에 얹는다. 억지로 끼워 맞춘 것이 아니라 실제로 맞다:
//   signal_id   감시 하나의 고유 키
//   strategy_id 소유 전략 (전략 장부와 같은 기준)
//   symbol      대상 종목
//   status      ACTIVE / TRIGGERED / CANCELED
//   stop_loss   현재 손절선 — **컬럼이라 조회·정렬이 된다**
//   entry_price 시작가
//   raw_payload 나머지 상태(JSON)
//   source      'spot-watch' — 이 용도만 골라내는 표식
//
// stop_loss를 JSON이 아니라 컬럼에 두는 것이 중요하다. 트레일링의 핵심
// 값이라 나중에 "지금 손절선이 얼마인가"를 목록에서 바로 봐야 한다.
//
// 전용 테이블이 생기면 이 파일만 바꾸면 된다 — 감시 루프는 이 인터페이스만 안다.
import type { TrailingState } from './spotOrderPlan';

export const WATCH_SOURCE = 'spot-watch';

/**
 * 감시 확인 주기(분). .github/workflows/watch-tick.yml의 cron과 같아야 한다.
 *
 * **이 값이 곧 보호 수준이다.** 15분이면 최대 15분치 갭을 그대로 맞는다 —
 * 손절선이 100이어도 다음 확인 때 92면 92에 팔린다.
 * 그래서 화면이 이 값을 그대로 보여준다. 라우트에 두면 export 제약 때문에
 * 다른 곳에서 못 읽는다.
 */
export const CHECK_INTERVAL_MIN = 15;

export type WatchKind = 'TRAILING' | 'RESERVED';

export interface WatchPayload {
  kind: WatchKind;
  connectionId: string;
  /** 트레일링: 최고가 / 비율 */
  highWater?: number;
  trailPct?: number;
  /** 예약: 기준가 / 방향 */
  triggerPrice?: number;
  direction?: 'above' | 'below';
  /** 실행할 주문 */
  side: 'BUY' | 'SELL';
  qty?: number;
  quoteUsd?: number;
  /** 마지막으로 확인한 시각 — 화면이 "언제 봤는지"를 보여주려면 필요하다 */
  lastCheckedAt?: number;
}

export interface Watch {
  id: string;
  signalId: string;
  userId: string;
  strategyId: string;
  symbol: string;
  status: string;
  stopPrice: number | null;
  entryPrice: number | null;
  payload: WatchPayload;
}

function parsePayload(raw: any): WatchPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const kind = raw.kind;
  if (kind !== 'TRAILING' && kind !== 'RESERVED') return null;
  if (typeof raw.connectionId !== 'string' || !raw.connectionId) return null;
  if (raw.side !== 'BUY' && raw.side !== 'SELL') return null;
  return raw as WatchPayload;
}

/** 살아 있는 감시 목록. 해석할 수 없는 행은 건너뛴다 — 추측해서 주문하면 안 된다 */
export async function listActiveWatches(sb: any, userId?: string): Promise<Watch[]> {
  let q = sb.from('signals')
    .select('id, signal_id, user_id, strategy_id, symbol, status, stop_loss, entry_price, raw_payload')
    .eq('source', WATCH_SOURCE)
    .eq('status', 'ACTIVE')
    .limit(500);
  if (userId) q = q.eq('user_id', userId);

  const { data, error } = await q;
  if (error) throw new Error(`감시 목록을 읽지 못했습니다: ${error.message}`);

  const out: Watch[] = [];
  for (const r of (Array.isArray(data) ? data : [])) {
    const payload = parsePayload(r.raw_payload);
    if (!payload) continue;   // 깨진 행은 조용히 건너뛰되 주문은 안 낸다
    out.push({
      id: String(r.id),
      signalId: String(r.signal_id),
      userId: String(r.user_id),
      strategyId: String(r.strategy_id || 'manual'),
      symbol: String(r.symbol),
      status: String(r.status),
      stopPrice: r.stop_loss != null ? Number(r.stop_loss) : null,
      entryPrice: r.entry_price != null ? Number(r.entry_price) : null,
      payload,
    });
  }
  return out;
}

export interface CreateWatchArgs {
  userId: string;
  connectionId: string;
  strategyId: string;
  symbol: string;
  kind: WatchKind;
  side: 'BUY' | 'SELL';
  qty?: number;
  quoteUsd?: number;
  /** 트레일링 */
  trailing?: TrailingState;
  /** 예약 */
  triggerPrice?: number;
  direction?: 'above' | 'below';
  entryPrice?: number | null;
}

export async function createWatch(sb: any, a: CreateWatchArgs): Promise<{ ok: boolean; id?: string; message: string }> {
  const signalId = `watch-${a.kind}-${a.symbol}-${Date.now().toString(36)}`;
  const payload: WatchPayload = {
    kind: a.kind,
    connectionId: a.connectionId,
    side: a.side,
    qty: a.qty,
    quoteUsd: a.quoteUsd,
    ...(a.kind === 'TRAILING'
      ? { highWater: a.trailing?.highWater, trailPct: a.trailing?.trailPct }
      : { triggerPrice: a.triggerPrice, direction: a.direction }),
  };

  const { data, error } = await sb.from('signals').insert({
    signal_id: signalId,
    user_id: a.userId,
    strategy_id: a.strategyId,
    symbol: a.symbol,
    signal: a.side,
    source: WATCH_SOURCE,
    status: 'ACTIVE',
    stop_loss: a.kind === 'TRAILING' ? (a.trailing?.stopPrice ?? null) : (a.triggerPrice ?? null),
    entry_price: a.entryPrice ?? null,
    raw_payload: payload,
  }).select('id').single();

  if (error) return { ok: false, message: `감시 등록 실패: ${error.message}` };
  return { ok: true, id: data?.id, message: '감시를 등록했습니다' };
}

/** 손절선이 올라갔을 때. 상태만 갱신하고 주문은 내지 않는다 */
export async function updateWatchStop(
  sb: any, id: string, stopPrice: number, payload: WatchPayload,
): Promise<void> {
  await sb.from('signals').update({
    stop_loss: stopPrice,
    raw_payload: { ...payload, lastCheckedAt: Date.now() },
  }).eq('id', id);
}

/** 확인만 하고 아무것도 안 바뀌었을 때 — 마지막 확인 시각을 남긴다 */
export async function touchWatch(sb: any, id: string, payload: WatchPayload): Promise<void> {
  await sb.from('signals').update({
    raw_payload: { ...payload, lastCheckedAt: Date.now() },
  }).eq('id', id);
}

/**
 * 감시를 끝낸다.
 *
 * 발동해서 주문이 나갔든, 주문이 실패했든 **다시 활성으로 돌리지 않는다.**
 * 실패했다고 되살리면 다음 주기에 또 시도하고, 그 사이 가격이 더 내려가
 * 훨씬 나쁜 값에 팔린다. 실패는 사람이 보고 다시 걸어야 한다.
 */
export async function closeWatch(
  sb: any, id: string, status: 'TRIGGERED' | 'FAILED' | 'CANCELED', note: string,
): Promise<void> {
  await sb.from('signals').update({
    status,
    reject_reason: note.slice(0, 500),
  }).eq('id', id);
}
