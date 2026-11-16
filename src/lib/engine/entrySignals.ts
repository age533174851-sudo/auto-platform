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
import { type Bar, lastBar, priorAvgVolume, body, inZone } from '../risk/bars';

export type EntrySignalId =
  | 'trend-follow' | 'mean-revert' | 'breakout'
  // ── 봉(고가·저가·거래량)을 보는 것들 ──
  // 종가만으로는 표현할 수 없어서 지금까지 만들 수 없던 쪽이다.
  | 'volume-breakout' | 'liquidity-sweep' | 'fvg-fill' | 'order-block';

export const ENTRY_SIGNAL_IDS: readonly EntrySignalId[] =
  ['trend-follow', 'mean-revert', 'breakout',
    'volume-breakout', 'liquidity-sweep', 'fvg-fill', 'order-block'] as const;

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
  'volume-breakout': '거래량 확인 돌파',
  'liquidity-sweep': '유동성 사냥(전저점 회수)',
  'fvg-fill': '공정가치 갭 되메움',
  'order-block': '오더블록 되돌림',
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
  /**
   * 국면 판정에 쓴 봉 전체. **못 받았으면 null** — 빈 배열이 아니다.
   *
   * 종가만 있는 호출자(daily-ladder)는 여기에 null을 준다. 종가로
   * 고가·저가를 지어내지 않는다 — 지어내면 봉이 필요한 전략이 거짓
   * 신호를 낸다.
   */
  bars?: Bar[] | null;
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


// ══════════════════════════════════════════════════════════════════
//  봉을 보는 전략들
//
//  여기부터는 고가·저가·거래량이 있어야 표현되는 것들이다. 종가만으로는
//  "전저점을 깼다가 되돌아왔다"도 "급등 전 마지막 음봉"도 말할 수 없다.
//  봉이 없으면 **방향을 내지 않는다** — 종가로 고가를 지어내지 않는다.
// ══════════════════════════════════════════════════════════════════

/** 거래량이 평소의 몇 배는 되어야 돌파로 인정하는가 */
export const VOLUME_BREAKOUT_MULT = 1.5;
/** 평소 거래량을 재는 창 (지금 봉은 빼고 센다) */
export const VOLUME_LOOKBACK = 20;
/**
 * 유동성 사냥으로 인정할 종가 위치. 0.5 = 봉 범위의 위쪽 절반에서 닫혀야
 * 롱이다. 깼다가 **되돌렸다**는 것이 핵심이고, 되돌리지 못한 채 바닥에서
 * 닫힌 봉은 사냥이 아니라 그냥 하락이다.
 */
export const SWEEP_CLOSE_POS = 0.5;
/** 갭·오더블록을 찾아볼 범위(봉 수) */
export const ZONE_LOOKBACK = 20;
/** 이보다 좁은 갭은 무시한다 (ATR 배수). 먼지 같은 갭에 들어가지 않는다 */
export const FVG_MIN_ATR = 0.25;
/** 오더블록으로 인정할 다음 봉의 밀어붙임 크기 (ATR 배수) */
export const ORDER_BLOCK_IMPULSE_ATR = 1;

/** 봉이 필요한 전략의 공통 입구. 없으면 무엇이 없는지 적는다 */
function needBars(i: SignalInput, min: number): { bars: Bar[] } | { fail: SignalVerdict } {
  const bars = i.bars;
  if (!bars) return { fail: { side: null, reason: '봉(고가·저가·거래량)을 받지 못했습니다' } };
  if (bars.length < min) {
    return { fail: { side: null, reason: `봉이 ${bars.length}개뿐입니다 — ${min}개가 필요합니다` } };
  }
  return { bars };
}

/**
 * 돌파인데 **거래량이 따라왔는가**까지 본다.
 *
 * 돌파가 자주 실패하는 이유는 세력이 전고점 위의 손절을 긁고 되돌리기
 * 때문이다. 거래량이 평소와 같은 돌파는 긁은 것일 때가 많다. 돌파 판단
 * 자체는 `breakout`을 **그대로 부른다** — 두 벌로 만들면 언젠가 갈린다.
 */
function volumeBreakout(i: SignalInput): SignalVerdict {
  const base = breakout(i);
  if (!base.side) return base;
  const got = needBars(i, VOLUME_LOOKBACK + 1);
  if ('fail' in got) return got.fail;
  const last = lastBar(got.bars)!;
  const avg = priorAvgVolume(got.bars, VOLUME_LOOKBACK);
  if (avg == null) return { side: null, reason: '평소 거래량을 재지 못했습니다' };
  const mult = last.volume / avg;
  if (mult < VOLUME_BREAKOUT_MULT) {
    return { side: null,
      reason: `${base.reason} — 그러나 거래량이 평소의 ${mult.toFixed(2)}배뿐입니다 `
        + `(${VOLUME_BREAKOUT_MULT}배 필요) — 긁고 되돌릴 자리입니다` };
  }
  return { side: base.side, reason: `${base.reason} · 거래량 평소의 ${mult.toFixed(2)}배` };
}

/**
 * 전저점을 **깼다가 되돌린** 봉에서 반대로 들어간다 (유동성 사냥).
 *
 * 개미 손절이 몰린 전저점 아래를 잠깐 찍고 물량을 삼킨 뒤 위로 가는 모양.
 * 핵심은 **되돌렸다**는 것이다 — 깨고 그대로 바닥에서 닫은 봉은 사냥이
 * 아니라 그냥 하락이고, 그 자리에 롱으로 들어가면 추세에 맞서는 것이다.
 */
function liquiditySweep(i: SignalInput): SignalVerdict {
  const gone = missing(i, ['priorHigh', 'priorLow']);
  if (gone) return { side: null, reason: gone };
  const got = needBars(i, 1);
  if ('fail' in got) return got.fail;
  const b = lastBar(got.bars)!;
  const range = b.high - b.low;
  if (!(range > 0)) return { side: null, reason: '마지막 봉의 폭이 0입니다' };
  const pos = (b.close - b.low) / range;
  const hi = i.view!.priorHigh!, lo = i.view!.priorLow!;

  if (b.low < lo && b.close > lo && pos >= SWEEP_CLOSE_POS) {
    return { side: 'LONG',
      reason: `전저점 ${lo.toFixed(2)}을 ${b.low.toFixed(2)}까지 깼다가 ${b.close.toFixed(2)}로 회수 `
        + `(봉 위쪽 ${(pos * 100).toFixed(0)}%) — LONG 진입` };
  }
  if (b.high > hi && b.close < hi && pos <= 1 - SWEEP_CLOSE_POS) {
    return { side: 'SHORT',
      reason: `전고점 ${hi.toFixed(2)}을 ${b.high.toFixed(2)}까지 넘었다가 ${b.close.toFixed(2)}로 되밀림 `
        + `(봉 아래쪽 ${((1 - pos) * 100).toFixed(0)}%) — SHORT 진입` };
  }
  return { side: null, reason: '전고점·전저점을 깼다가 회수한 봉이 아닙니다' };
}

/**
 * 공정가치 갭(FVG)으로 가격이 돌아왔을 때 들어간다.
 *
 * 세 봉 중 가운데가 급하게 움직여 **1번 봉 고가와 3번 봉 저가 사이에
 * 거래가 없던 구간**이 생기면 그게 갭이다. 가격이 그 빈 칸을 메우러
 * 돌아오는 경향에 건다.
 *
 * 이미 메워진 갭은 쓰지 않는다 — 메워졌다는 것은 그 자리가 더 이상
 * 비어 있지 않다는 뜻이고, 남은 것은 모양뿐이다.
 */
function fvgFill(i: SignalInput): SignalVerdict {
  const gone = missing(i, ['atr']);
  if (gone) return { side: null, reason: gone };
  const got = needBars(i, 3);
  if ('fail' in got) return got.fail;
  const bars = got.bars;
  const price = num(i.markPrice) ?? num(i.view!.price);
  if (price == null || price <= 0) return { side: null, reason: '시세를 확인하지 못했습니다' };
  const minGap = i.view!.atr! * FVG_MIN_ATR;

  const from = Math.max(2, bars.length - ZONE_LOOKBACK);
  for (let k = bars.length - 1; k >= from; k--) {
    const a = bars[k - 2], c = bars[k];
    // 위로 생긴 갭: [a.high, c.low]
    if (c.low - a.high >= minGap) {
      // 뒤 봉이 갭 바닥 아래로 내려갔으면 메워진 것이다.
      const filled = bars.slice(k + 1).some(x => x.low <= a.high);
      if (!filled && inZone(price, a.high, c.low)) {
        return { side: 'LONG',
          reason: `위로 난 공정가치 갭 ${a.high.toFixed(2)}~${c.low.toFixed(2)}에 가격이 돌아왔습니다 — LONG 진입` };
      }
    }
    // 아래로 생긴 갭: [c.high, a.low]
    if (a.low - c.high >= minGap) {
      const filled = bars.slice(k + 1).some(x => x.high >= a.low);
      if (!filled && inZone(price, c.high, a.low)) {
        return { side: 'SHORT',
          reason: `아래로 난 공정가치 갭 ${c.high.toFixed(2)}~${a.low.toFixed(2)}에 가격이 돌아왔습니다 — SHORT 진입` };
      }
    }
  }
  return { side: null, reason: '되메울 공정가치 갭이 없습니다' };
}

/**
 * 오더블록으로 가격이 돌아왔을 때 들어간다.
 *
 * 큰 자금이 들어와 추세를 꺾은 자리에는 **밀어붙이기 직전의 반대색 봉**이
 * 남는다. 그 봉의 몸통을 매물대로 보고, 가격이 거기로 돌아오면 같은
 * 방향으로 붙는다.
 *
 * 블록이 이미 깨졌으면(뒤 봉이 몸통 바깥으로 닫았으면) 쓰지 않는다 —
 * 깨진 자리를 지지라고 부르면 그건 그냥 추세를 거스르는 것이다.
 */
function orderBlock(i: SignalInput): SignalVerdict {
  const gone = missing(i, ['atr']);
  if (gone) return { side: null, reason: gone };
  const got = needBars(i, 3);
  if ('fail' in got) return got.fail;
  const bars = got.bars;
  const price = num(i.markPrice) ?? num(i.view!.price);
  if (price == null || price <= 0) return { side: null, reason: '시세를 확인하지 못했습니다' };
  const impulse = i.view!.atr! * ORDER_BLOCK_IMPULSE_ATR;

  const from = Math.max(0, bars.length - ZONE_LOOKBACK);
  for (let k = bars.length - 2; k >= from; k--) {
    const ob = bars[k], next = bars[k + 1];
    const z = body(ob);
    // 상승 오더블록: 음봉 다음에 그 고가를 ATR 이상 넘겨 닫은 봉
    if (ob.close < ob.open && next.close - ob.high >= impulse) {
      const broken = bars.slice(k + 2).some(x => x.close < z.lo);
      if (!broken && inZone(price, z.lo, z.hi)) {
        return { side: 'LONG',
          reason: `상승 오더블록 ${z.lo.toFixed(2)}~${z.hi.toFixed(2)}에 가격이 돌아왔습니다 — LONG 진입` };
      }
    }
    // 하락 오더블록: 양봉 다음에 그 저가를 ATR 이상 밑돌아 닫은 봉
    if (ob.close > ob.open && ob.low - next.close >= impulse) {
      const broken = bars.slice(k + 2).some(x => x.close > z.hi);
      if (!broken && inZone(price, z.lo, z.hi)) {
        return { side: 'SHORT',
          reason: `하락 오더블록 ${z.lo.toFixed(2)}~${z.hi.toFixed(2)}에 가격이 돌아왔습니다 — SHORT 진입` };
      }
    }
  }
  return { side: null, reason: '되돌아갈 오더블록이 없습니다' };
}

const SIGNALS: Record<EntrySignalId, (i: SignalInput) => SignalVerdict> = {
  'trend-follow': trendFollow,
  'mean-revert': meanRevert,
  'breakout': breakout,
  'volume-breakout': volumeBreakout,
  'liquidity-sweep': liquiditySweep,
  'fvg-fill': fvgFill,
  'order-block': orderBlock,
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
