// src/lib/engine/entrySignals.ts
//
// **방향을 정하는 일**만 떼어낸 곳. 크기·손절·익절은 여기서 정하지 않는다.
//
// 왜 떼어내는가
// ─────────────
// `planEntry`에는 규칙이 하나 박혀 있었다 — "추세 방향으로만 들어간다".
// 그래서 전략을 몇 개 만들든 전부 추세 추종의 변주였고, 역추세·돌파는
// 아예 표현할 수 없었다. 방향 결정이 수량 계산과 한 함수에 엉켜 있었기
// 때문이다.
//
// 떼어내면서 **수량·손절·익절은 공유한 채로 둔다.** 그래야 성적표가
// 비교 가능해진다 — 전략마다 사이징이 다르면 어느 쪽이 좋았는지가 아니라
// 어느 쪽이 더 크게 걸었는지를 보는 것이 된다.
//
// 모르는 것은 진입하지 않는다
// ───────────────────────────
// `view`의 값은 못 쟀을 때 null이다. null을 0으로 바꿔 계산하면 "전고점
// 0을 돌파"·"폭 0인 박스의 바닥"이 되어 **무조건 진입**이 된다. 그래서
// 여기서는 필요한 값이 하나라도 비면 방향을 내지 않고, 무엇이 없었는지를
// 적는다.

import type { RegimeView, TrendRegime } from '../risk/regime';

export type EntrySignalId = 'trend-follow' | 'mean-revert' | 'breakout';

export const ENTRY_SIGNAL_IDS: readonly EntrySignalId[] =
  ['trend-follow', 'mean-revert', 'breakout'] as const;

/**
 * 기본값은 지금 돌고 있는 그 전략이다.
 *
 * `paper-auto-v1`의 기록(진입 3건)이 앞으로 만드는 모든 전략의 비교
 * 기준이다. 기본값을 바꾸면 그 기준이 조용히 다른 기계의 기록이 된다.
 */
export const DEFAULT_ENTRY_SIGNAL: EntrySignalId = 'trend-follow';

export const ENTRY_SIGNAL_LABEL: Record<EntrySignalId, string> = {
  'trend-follow': '추세 추종',
  'mean-revert': '역추세(박스 양끝)',
  'breakout': '돌파',
};

/** 박스 양끝으로 볼 구간. 0.2 = 아래 20% / 위 20% */
export const MEAN_REVERT_EDGE = 0.2;
/**
 * 박스가 ATR의 몇 배는 되어야 역추세를 한다.
 *
 * 박스 폭이 평균 변동폭만 한 곳에서 "바닥에서 산다"는 것은 잡음 한 번에
 * 손절된다는 뜻이다. 신호가 아니라 수수료 지불이다.
 */
export const MEAN_REVERT_MIN_BOX_ATR = 2;
/**
 * 돌파로 인정할 여유. 전고점을 ATR의 이만큼 **넘겨야** 돌파다.
 *
 * 0으로 두면 전고점에 닿기만 해도 돌파가 되고, 그 자리는 거짓 돌파가
 * 가장 많이 나는 자리다.
 */
export const BREAKOUT_BUFFER_ATR = 0.25;

export interface SignalInput {
  /** 국면이 알려준 추세 방향 */
  trend: TrendRegime | null;
  /** 국면이 함께 준 관측값. 없으면 방향을 내지 않는다 */
  view: RegimeView | null | undefined;
  markPrice: number | null | undefined;
}

export interface SignalVerdict {
  /** null이면 들어가지 않는다 */
  side: 'LONG' | 'SHORT' | null;
  /** 들어가는 이유 또는 들어가지 않는 이유. 로그에 그대로 남는다 */
  reason: string;
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** 쓸 값이 다 있는지. 없으면 무엇이 없었는지 적는다 */
function missing(i: SignalInput, keys: (keyof RegimeView)[]): string | null {
  if (!i.view) return '국면 관측값이 없습니다';
  const gone = keys.filter(k => num(i.view![k]) == null);
  return gone.length ? `관측값이 없습니다: ${gone.join(', ')}` : null;
}

/** 추세 방향으로만 들어간다 — 지금까지 돌던 그 규칙, 글자까지 그대로 */
function trendFollow(i: SignalInput): SignalVerdict {
  if (!i.trend || i.trend === 'sideways') {
    return { side: null, reason: '횡보장 — 추세 방향이 없어 진입하지 않습니다' };
  }
  const side: 'LONG' | 'SHORT' = i.trend === 'uptrend' ? 'LONG' : 'SHORT';
  return { side, reason: `${i.trend === 'uptrend' ? '상승' : '하락'} 추세 — ${side} 진입` };
}

/**
 * 박스 아래끝에서 롱, 위끝에서 숏.
 *
 * **횡보장에서만 한다.** 추세장에서 역추세로 들어가는 것은 전략이 아니라
 * 추세에 맞서는 것이고, 손절이 가장 멀 때 가장 자주 닿는다.
 */
function meanRevert(i: SignalInput): SignalVerdict {
  if (!i.trend) return { side: null, reason: '추세를 판정하지 못해 역추세를 하지 않습니다' };
  if (i.trend !== 'sideways') {
    return { side: null, reason: `${i.trend === 'uptrend' ? '상승' : '하락'} 추세 — 역추세는 들어가지 않습니다` };
  }
  const gone = missing(i, ['recentHigh', 'recentLow', 'atr']);
  if (gone) return { side: null, reason: gone };

  const price = num(i.markPrice) ?? num(i.view!.price);
  if (price == null || price <= 0) return { side: null, reason: '시세를 확인하지 못했습니다' };

  const high = i.view!.recentHigh!, low = i.view!.recentLow!, atr = i.view!.atr!;
  const box = high - low;
  if (!(box > 0)) return { side: null, reason: '박스 폭이 0입니다' };
  if (box < atr * MEAN_REVERT_MIN_BOX_ATR) {
    return { side: null,
      reason: `박스(${box.toFixed(2)})가 ATR의 ${MEAN_REVERT_MIN_BOX_ATR}배(${(atr * MEAN_REVERT_MIN_BOX_ATR).toFixed(2)})보다 좁습니다 — 손절이 잡음 안에 들어갑니다` };
  }
  const pos = (price - low) / box;
  if (pos <= MEAN_REVERT_EDGE) {
    return { side: 'LONG', reason: `박스 아래 ${(pos * 100).toFixed(0)}% — 반등 기대 LONG 진입` };
  }
  if (pos >= 1 - MEAN_REVERT_EDGE) {
    return { side: 'SHORT', reason: `박스 위 ${(pos * 100).toFixed(0)}% — 되돌림 기대 SHORT 진입` };
  }
  return { side: null, reason: `박스 가운데 ${(pos * 100).toFixed(0)}% — 끝이 아니라 들어가지 않습니다` };
}

/**
 * 직전 창의 고점을 지금 넘었으면 롱, 저점을 깼으면 숏.
 *
 * `priorHigh`를 본다 — `recentHigh`는 현재 종가를 포함하므로 그것으로는
 * 돌파가 **영원히 발동하지 않는다.**
 */
function breakout(i: SignalInput): SignalVerdict {
  const gone = missing(i, ['priorHigh', 'priorLow', 'atr']);
  if (gone) return { side: null, reason: gone };

  const price = num(i.markPrice) ?? num(i.view!.price);
  if (price == null || price <= 0) return { side: null, reason: '시세를 확인하지 못했습니다' };

  const hi = i.view!.priorHigh!, lo = i.view!.priorLow!, atr = i.view!.atr!;
  const pad = atr * BREAKOUT_BUFFER_ATR;
  if (price > hi + pad) {
    return { side: 'LONG', reason: `직전 고점 ${hi.toFixed(2)} 상향 돌파 (여유 ${pad.toFixed(2)}) — LONG 진입` };
  }
  if (price < lo - pad) {
    return { side: 'SHORT', reason: `직전 저점 ${lo.toFixed(2)} 하향 이탈 (여유 ${pad.toFixed(2)}) — SHORT 진입` };
  }
  return { side: null,
    reason: `돌파 아님 — 현재 ${price.toFixed(2)}, 돌파선 ${(hi + pad).toFixed(2)} / ${(lo - pad).toFixed(2)}` };
}

const SIGNALS: Record<EntrySignalId, (i: SignalInput) => SignalVerdict> = {
  'trend-follow': trendFollow,
  'mean-revert': meanRevert,
  'breakout': breakout,
};

/**
 * 이 전략은 지금 어느 방향으로 들어가는가.
 *
 * 모르는 id는 **기본 전략으로 떨어뜨리지 않는다.** 떨어뜨리면 오타 하나로
 * 다른 전략이 돌면서 그 전략의 성적표에 기록된다.
 */
export function entrySignal(id: EntrySignalId, i: SignalInput): SignalVerdict {
  const fn = SIGNALS[id];
  if (!fn) return { side: null, reason: `알 수 없는 진입 전략입니다: ${String(id)}` };
  return fn(i);
}

/** 바깥에서 온 전략 이름. 아는 값만 통과시킨다 */
export function parseEntrySignal(raw: unknown): EntrySignalId | null {
  const v = String(raw ?? '').trim().toLowerCase();
  return (ENTRY_SIGNAL_IDS as readonly string[]).includes(v) ? (v as EntrySignalId) : null;
}
