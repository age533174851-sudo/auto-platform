// src/lib/signals/signalPath.ts
//
// **신호 시점의 가격 경로**를 만든다. 장부 계산에 먹일 것.
//
// 왜 별도로 두는가
// ────────────────
// simulatePair는 `PricePoint[]`를 받는다. 그 배열을 어떻게 만드느냐에
// 따라 성적이 통째로 달라지는데, 그 변환이 라우트 안에 흩어져 있으면
// 테스트가 안 붙는다. 그리고 여기서 조용히 틀리면 **엔진이 아무리
// 정확해도 결과는 틀린다.**
//
// 여기서 잘못될 수 있는 것들
// ──────────────────────────
//  1) 최신 봉으로 대신 채우기 — 몇 달 전 발언을 오늘 가격으로 채점한다
//  2) 봉의 종가만 쓰기 — 손절은 **꼬리**에 닿는다. 종가만 보면 닿은 적
//     없는 것이 되고, 성적은 언제나 좋아진다
//  3) 구간이 모자란데 있는 데까지만 돌리기 — 최대 보유시간을 못 채운
//     거래가 '시간 청산'으로 기록된다
//  4) 미완성 봉 포함 — 아직 안 끝난 봉의 고가·저가로 손절을 판정한다
//
// 종가만 쓰지 않는다
// ──────────────────
// 봉 하나를 점 하나로 접으면 그 봉 안에서 손절에 닿았는지 알 수 없다.
// 그래서 봉 하나를 **네 점**으로 편다: 시가 → (나쁜 쪽 극단) → (좋은 쪽
// 극단) → 종가.
//
// 순서가 중요하다. 고가와 저가 중 무엇이 먼저였는지는 OHLC만으로 알 수
// 없으므로 **나쁜 쪽을 먼저 놓는다.** 롱이면 저가가 먼저, 숏이면 고가가
// 먼저다. 모르는 것을 유리하게 읽으면 그 성적표는 검증이 아니라 희망이다.
//
// 그런데 방향마다 순서가 다르면 순방향·역방향 두 다리가 **다른 경로**를
// 보게 되고, 그러면 비교가 성립하지 않는다. 그래서 방향을 받지 않고
// 언제나 같은 순서(저가 → 고가)로 편다 — 롱에게는 나쁜 쪽이 먼저이고
// 숏에게는 좋은 쪽이 먼저다. 한쪽에만 유리하지 않게 하려면 두 다리가
// 같은 배열을 보는 것이 먼저다.

import type { PricePoint } from './creatorEdge';

export interface Bar {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface PathResult {
  path: PricePoint[];
  /** 못 만들었으면 이유. 비어 있으면 정상 */
  error: string;
  /** 요청한 구간을 다 덮었는가. false면 최대 보유시간을 못 채운다 */
  covers: boolean;
  /** 실제로 덮은 마지막 시각 */
  lastMs: number | null;
}

/**
 * 봉 배열 → 가격 경로.
 *
 * 봉 하나를 네 점으로 편다. 한 봉 안의 순서를 모르므로 **저가를 먼저**
 * 놓는다 — 방향에 따라 순서를 바꾸면 두 다리가 다른 경로를 보게 되고,
 * 그러면 순방향·역방향 비교 자체가 성립하지 않는다.
 *
 * 점의 시각은 봉 안에서 고르게 나눈다. 전부 openTime으로 두면 같은 시각에
 * 네 점이 쌓여, 최대 보유시간 판정이 봉 단위로 뭉뚝해진다.
 */
export function barsToPath(
  bars: Bar[] | null | undefined, intervalMs: number,
): PricePoint[] {
  const out: PricePoint[] = [];
  const step = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 0;
  for (const b of Array.isArray(bars) ? bars : []) {
    if (!b) continue;
    const t = Number(b.openTime);
    const o = Number(b.open), h = Number(b.high), l = Number(b.low), c = Number(b.close);
    if (!Number.isFinite(t)) continue;
    // 넷 중 하나라도 못 읽으면 그 봉은 **건너뛴다.** 종가로 채우면
    // 그 봉에서는 아무 일도 안 일어난 것이 되고, 손절이 있었어도 사라진다.
    if (![o, h, l, c].every(Number.isFinite)) continue;
    if (!(h >= l)) continue;
    const q = step > 0 ? step / 4 : 0;
    out.push({ t, price: o });
    out.push({ t: t + q, price: l });
    out.push({ t: t + q * 2, price: h });
    out.push({ t: t + q * 3, price: c });
  }
  return out;
}

/**
 * 신호 하나에 필요한 구간을 계산한다.
 *
 * 시작은 발언 시각, 끝은 발언 + 지연 + 최대 보유시간. 여기에 여유를
 * 한 봉 더 준다 — 경계에 딱 맞추면 마지막 봉이 잘려 시간 청산이
 * 한 봉 일찍 일어난다.
 */
export function windowFor(
  saidAtMs: number, delaySec: number, maxHoldSec: number, intervalMs: number,
): { startMs: number; endMs: number } | null {
  const s = Number(saidAtMs);
  if (!Number.isFinite(s) || s <= 0) return null;
  const d = Number.isFinite(Number(delaySec)) ? Number(delaySec) : 0;
  const h = Number.isFinite(Number(maxHoldSec)) ? Number(maxHoldSec) : 0;
  const pad = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 0;
  return {
    // 발언 시각이 봉 중간이면 그 봉이 통째로 빠질 수 있다. 한 봉 앞에서 시작한다.
    startMs: s - pad,
    endMs: s + (d + h) * 1000 + pad,
  };
}

/**
 * 경로가 이 신호를 끝까지 채점할 수 있는가.
 *
 * **모자라면 그렇다고 말한다.** 있는 데까지만 돌리면 최대 보유시간을
 * 못 채운 거래가 '시간 청산'으로 기록되고, 그 거래의 손익은 실제로
 * 일어난 적 없는 시점의 가격이다. 그런 행이 섞이면 표본 수는 늘어나는데
 * 표본의 뜻은 흐려진다 — 가장 나쁜 조합이다.
 */
export function pathCovers(
  path: PricePoint[] | null | undefined,
  saidAtMs: number, delaySec: number, maxHoldSec: number,
): { covers: boolean; lastMs: number | null; reason: string } {
  const rows = Array.isArray(path) ? path : [];
  if (rows.length === 0) return { covers: false, lastMs: null, reason: '가격 경로가 비어 있습니다' };
  let last = -Infinity;
  for (const p of rows) if (Number(p?.t) > last) last = Number(p.t);
  if (!Number.isFinite(last)) return { covers: false, lastMs: null, reason: '가격 경로의 시각을 읽지 못했습니다' };

  const need = Number(saidAtMs) + (Number(delaySec) + Number(maxHoldSec)) * 1000;
  if (last >= need) return { covers: true, lastMs: last, reason: '' };

  const shortSec = Math.round((need - last) / 1000);
  return {
    covers: false, lastMs: last,
    reason: `최대 보유시간까지 ${shortSec}초가 모자랍니다 — 있는 데까지만 돌리면 `
          + '일어난 적 없는 시점의 가격으로 청산한 것이 됩니다',
  };
}

/**
 * 봉 → 경로 + 덮개 검사를 한 번에.
 *
 * 라우트가 이 셋을 따로 부르면 하나를 빠뜨리고, 이 저장소에서 가장 자주
 * 반복된 실패가 정확히 그 모양("만들어 놓고 배선을 안 함")이다.
 */
export function buildSignalPath(
  bars: Bar[] | null | undefined,
  opts: { saidAtMs: number; delaySec: number; maxHoldSec: number; intervalMs: number },
): PathResult {
  const path = barsToPath(bars, opts.intervalMs);
  if (path.length === 0) {
    return { path: [], error: '가격 봉을 읽지 못했습니다', covers: false, lastMs: null };
  }
  const c = pathCovers(path, opts.saidAtMs, opts.delaySec, opts.maxHoldSec);
  return { path, error: c.covers ? '' : c.reason, covers: c.covers, lastMs: c.lastMs };
}
