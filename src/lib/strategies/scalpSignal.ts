// src/lib/strategies/scalpSignal.ts
//
// **단타 진입 신호.** 분봉을 보고 지금 들어갈지 정한다.
//
// 이 파일이 지키는 것 하나
// ────────────────────────
// **목표가 왕복 비용보다 작으면 그 거래는 이길 수 없다.**
//
// 바이낸스 USDⓈ-M 테이커 수수료는 편도 0.05%, 왕복 0.1%다. 여기에
// 슬리피지가 붙는다. 1분봉에서 BTC는 보통 0.05~0.1% 움직인다 — 즉
// **1분봉 스캘핑은 방향을 100% 맞춰도 본전이다.** 이건 전략의 문제가
// 아니라 산수다.
//
// 그래서 이 모듈은 목표가 비용을 못 넘으면 **신호를 내지 않는다.**
// 좋은 자리를 놓치는 것보다, 이길 수 없는 자리에 들어가는 것이 나쁘다.
//
// 신호를 안 내는 것이 기본이다
// ────────────────────────────
// 대부분의 봉에서 null을 돌려준다. 단타 엔진의 실패는 보통 '신호를 못
// 찾아서'가 아니라 '아무 데나 신호를 내서'다. 조건을 못 확인하면 —
// 봉이 모자라거나, 거래량을 못 읽거나, 변동성이 0이거나 — **판단하지
// 않는다.** 모르는 것을 유리하게 읽지 않는다.
//
// 미래를 보지 않는다
// ──────────────────
// 마지막 봉은 **아직 안 끝났을 수 있다.** 그 봉의 고가·저가로 돌파를
// 판정하면, 백테스트에서는 맞고 실거래에서는 틀린다(그 시점에 그 값을
// 알 수 없었다). 그래서 돌파 기준선은 **직전 봉까지**로 만든다.

export interface Bars {
  highs: number[];
  lows: number[];
  closes: number[];
  volumes: number[];
}

export interface ScalpConfig {
  /** 돌파 기준이 되는 최근 봉 수 */
  lookback: number;
  /** 손절 = ATR × 이 값 */
  atrStopMult: number;
  /** 목표 = 손절 × 이 값 (손익비) */
  rewardRisk: number;
  /** 거래량이 평균의 이 배 이상이어야 한다 */
  volumeMult: number;
  /** 왕복 비용(%) — 수수료 + 슬리피지. 목표가 이보다 작으면 안 낸다 */
  roundTripCostPct: number;
  /** ATR 계산 기간 */
  atrPeriod: number;
}

/**
 * 기본값.
 *
 * `roundTripCostPct` 0.15는 왕복 수수료 0.1%에 슬리피지 0.05%를 더한
 * 값이다. **넉넉하게 잡는다** — 모자라게 잡으면 이길 수 없는 자리를
 * 이길 수 있다고 판정한다.
 */
export const SCALP_DEFAULTS: ScalpConfig = {
  lookback: 20,
  atrStopMult: 1.0,
  rewardRisk: 2,
  volumeMult: 1.3,
  roundTripCostPct: 0.15,
  atrPeriod: 14,
};

export type ScalpSide = 'LONG' | 'SHORT';

export interface ScalpSignal {
  side: ScalpSide;
  /** 기준가 (마지막 종가) */
  entry: number;
  stop: number;
  target: number;
  /** 손절 폭(%) — 주문 경로가 이 값을 쓴다 */
  stopPct: number;
  targetPct: number;
  atr: number;
  notes: string[];
}

export interface ScalpResult {
  /** 신호. **없으면 null이다 — 0이나 빈 객체가 아니다** */
  signal: ScalpSignal | null;
  /** 왜 안 냈는가. 신호가 있으면 빈 문자열 */
  reason: string;
}

const no = (reason: string): ScalpResult => ({ signal: null, reason });

/**
 * ATR(Average True Range).
 *
 * 변동성을 모르면 손절 폭을 정할 수 없다. **모르면 null이다** —
 * 0을 돌려주면 손절 폭이 0이 되고, 그건 진입 즉시 손절이다.
 */
export function atr(b: Bars, period = 14): number | null {
  const n = b.closes.length;
  if (n < period + 1) return null;
  if (b.highs.length !== n || b.lows.length !== n) return null;

  const trs: number[] = [];
  for (let i = n - period; i < n; i++) {
    const h = b.highs[i], l = b.lows[i], pc = b.closes[i - 1];
    if (![h, l, pc].every(Number.isFinite)) return null;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  if (trs.length < period) return null;
  const v = trs.reduce((a, x) => a + x, 0) / trs.length;
  // 변동성이 0이면 손절 폭도 0이다. 그건 판단 불가이지 '안전'이 아니다.
  return v > 0 ? v : null;
}

/**
 * 지금 들어갈 자리인가.
 *
 * @param bars 완결된 봉들. **마지막 봉이 진행 중이면 그 봉도 넣되,
 *             돌파 기준선은 직전 봉까지로 만든다**(미래 참조 방지).
 */
export function scalpSignal(
  bars: Bars | null | undefined,
  cfg: ScalpConfig = SCALP_DEFAULTS,
): ScalpResult {
  if (!bars) return no('봉 데이터가 없습니다');
  const { highs, lows, closes, volumes } = bars;
  const n = closes?.length ?? 0;

  const need = Math.max(cfg.lookback, cfg.atrPeriod) + 2;
  if (n < need) return no(`봉이 모자랍니다 (${n}개 · 최소 ${need}개 필요)`);
  if (highs.length !== n || lows.length !== n) return no('고가·저가 개수가 종가와 다릅니다');

  const price = closes[n - 1];
  if (!Number.isFinite(price) || price <= 0) return no('현재가를 읽지 못했습니다');

  const a = atr(bars, cfg.atrPeriod);
  if (a == null) return no('변동성(ATR)을 계산하지 못했습니다');

  // ── 돌파 기준선: **직전 봉까지** ──
  //
  // 마지막 봉을 포함하면 그 봉의 고가로 그 봉의 돌파를 판정하게 된다.
  // 언제나 참이고, 실거래에서는 그 값을 그 시점에 알 수 없다.
  const from = n - 1 - cfg.lookback;
  const to = n - 1;                       // 마지막 봉 제외
  if (from < 0) return no('돌파 기준을 만들 봉이 모자랍니다');

  let hh = -Infinity, ll = Infinity;
  for (let i = from; i < to; i++) {
    if (!Number.isFinite(highs[i]) || !Number.isFinite(lows[i])) {
      return no('기준 구간에 읽지 못한 봉이 있습니다');
    }
    if (highs[i] > hh) hh = highs[i];
    if (lows[i] < ll) ll = lows[i];
  }
  if (!Number.isFinite(hh) || !Number.isFinite(ll)) return no('돌파 기준을 만들지 못했습니다');

  // ── 방향 ──
  //
  // **돌파를 먼저 본다.** 거래량을 먼저 보면, 돌파도 없는 봉에서
  // '거래량이 부족합니다'가 나온다 — 그건 "돌파는 났는데 거래량이 약하다"로
  // 읽힌다. 대부분의 봉은 그냥 돌파가 없는 것이고, 그렇게 말해야 한다.
  let side: ScalpSide;
  if (price > hh) side = 'LONG';
  else if (price < ll) side = 'SHORT';
  else return no(`돌파 없음 (${ll.toFixed(2)} ~ ${hh.toFixed(2)} 안)`);

  // ── 거래량 확인 ──
  //
  // 거래량 없는 돌파는 대개 되돌아온다. **못 읽으면 통과시키지 않는다** —
  // 확인 못 한 조건을 만족한 것으로 세면 그 조건은 없는 것과 같다.
  const vNow = volumes?.[n - 1];
  const vSlice = volumes?.slice(from, to);
  if (!Number.isFinite(vNow) || !vSlice || vSlice.length === 0) {
    return no('거래량을 확인하지 못했습니다');
  }
  const vAvg = vSlice.reduce((s, x) => s + (Number.isFinite(x) ? x : 0), 0) / vSlice.length;
  if (!(vAvg > 0)) return no('평균 거래량이 0입니다');
  if (vNow < vAvg * cfg.volumeMult) {
    return no(`돌파했지만 거래량이 부족합니다 (평균의 ${(vNow / vAvg).toFixed(2)}배 · ${cfg.volumeMult}배 필요)`);
  }

  const stopDist = a * cfg.atrStopMult;
  if (!(stopDist > 0)) return no('손절 폭을 계산하지 못했습니다');

  const stop = side === 'LONG' ? price - stopDist : price + stopDist;
  if (stop <= 0) return no('손절가가 0 이하입니다');

  const targetDist = stopDist * cfg.rewardRisk;
  const target = side === 'LONG' ? price + targetDist : price - targetDist;

  const stopPct = (stopDist / price) * 100;
  const targetPct = (targetDist / price) * 100;

  // ── **이길 수 있는 자리인가** ──
  //
  // 목표가 왕복 비용보다 작으면 방향을 맞춰도 진다. 이 검사가 없으면
  // 분봉이 짧아질수록 신호가 늘어나는데, 그 신호들이 전부 마이너스다.
  if (targetPct <= cfg.roundTripCostPct) {
    return no(
      `목표 ${targetPct.toFixed(3)}%가 왕복 비용 ${cfg.roundTripCostPct}%보다 작습니다 — `
      + '방향을 맞춰도 집니다. 더 큰 봉을 쓰거나 목표를 늘리세요');
  }

  const notes: string[] = [
    `${cfg.lookback}봉 ${side === 'LONG' ? '고점' : '저점'} 돌파`,
    `거래량 평균의 ${(vNow / vAvg).toFixed(2)}배`,
    `ATR ${a.toFixed(2)} · 손절 ${stopPct.toFixed(3)}% · 목표 ${targetPct.toFixed(3)}%`,
    `왕복 비용 ${cfg.roundTripCostPct}% 차감 후 기대 ${(targetPct - cfg.roundTripCostPct).toFixed(3)}%`,
  ];

  return {
    signal: { side, entry: price, stop, target, stopPct, targetPct, atr: a, notes },
    reason: '',
  };
}

/**
 * 이 봉 주기가 단타로 쓸 만한가.
 *
 * 짧을수록 봉의 움직임이 작아지고, 왕복 비용은 그대로다. 어느 선 아래로는
 * **구조적으로** 이길 수 없다 — 전략을 아무리 잘 만들어도 그렇다.
 *
 * 화면이 이 판정을 그대로 적는다. 사용자가 1분봉을 고르면 왜 안 되는지
 * 숫자로 보여야 한다.
 */
/**
 * 이 비용에서 **실제로 돌릴 수 있는** 주기만 고른다.
 *
 * 왜 필요한가
 * ───────────
 * 레지스트리는 scalp의 `supportedIntervals`를 `[1, 5, 15, 60]`로 내려보냈다.
 * 그런데 라우트는 `timeframeVerdict`로 막는다 — 기본 왕복 비용 0.15%에서는
 * 1·5·15분이 전부 `timeframe_unusable`이라 **화면에서 고를 수는 있는데
 * 실행하면 409로 끝났다.**
 *
 * 목록을 두 곳에 적으면 한쪽만 바뀐다. **고를 수 있는 것과 돌릴 수 있는
 * 것을 같은 함수가 정한다.**
 *
 * 전부 걸러지면 **빈 배열을 주지 않는다** — 그러면 예약을 아예 만들 수
 * 없고, 사용자는 왜인지 알 수 없다. 그때는 가장 긴 후보 하나를 남기고
 * 라우트가 이유를 말한다.
 */
export function usableIntervals(
  candidates: number[], roundTripCostPct = SCALP_DEFAULTS.roundTripCostPct,
): number[] {
  const list = (Array.isArray(candidates) ? candidates : [])
    .map(Number).filter(n => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  if (list.length === 0) return [];
  const usable = list.filter(m => timeframeVerdict(m, roundTripCostPct).usable);
  return usable.length > 0 ? usable : [list[list.length - 1]];
}

export function timeframeVerdict(
  intervalMin: number, roundTripCostPct = SCALP_DEFAULTS.roundTripCostPct,
): { usable: boolean; typicalMovePct: number; text: string } {
  // BTC의 대략적인 봉당 움직임. 정확한 값이 아니라 **자릿수**를 보려는 것이다.
  // 시장에 따라 달라지므로 이 값을 매매 판단에 쓰지 않는다 — 오직
  // '이 주기가 비용을 넘길 수 있는가'만 본다.
  const m = Number(intervalMin);
  const typical =
    m <= 1 ? 0.06 :
    m <= 5 ? 0.15 :
    m <= 15 ? 0.28 :
    m <= 60 ? 0.55 :
    m <= 240 ? 1.1 : 2.2;

  const usable = typical > roundTripCostPct * 3;
  return {
    usable,
    typicalMovePct: typical,
    text: usable
      ? `${m}분봉은 보통 ${typical}% 움직입니다 — 왕복 비용 ${roundTripCostPct}%의 `
        + `${(typical / roundTripCostPct).toFixed(1)}배라 쓸 만합니다.`
      : `${m}분봉은 보통 ${typical}%밖에 안 움직입니다 — 왕복 비용 ${roundTripCostPct}%가 `
        + `그 움직임의 ${(roundTripCostPct / typical * 100).toFixed(0)}%입니다. `
        + '방향을 맞춰도 수수료로 잃습니다.',
  };
}
