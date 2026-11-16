// src/lib/risk/regime.ts
// 시장 상태(레짐) 감지 — 상승/하락/횡보 × 변동성

export type TrendRegime = 'uptrend' | 'downtrend' | 'sideways';
export type VolRegime   = 'high_vol' | 'normal_vol' | 'low_vol';

export interface MarketRegime {
  trend: TrendRegime;
  volatility: VolRegime;
  label: string;
  trendScore: number;
  volPct: number;
  recommendation: string;
  allowEntry: boolean;
  /**
   * 판정할 만큼 봉이 있었는가.
   *
   * **false면 위의 trend·volatility는 의미가 없다.** 예전에는 이 값이
   * 없어서, 봉이 0개여도 '횡보 · 저변동 · 진입 허용'이 나왔다 — 시세
   * 조회가 실패하면 필터가 통째로 통과로 샜다는 뜻이다.
   */
  dataOk: boolean;
  /** 받은 봉 수 */
  bars: number;
  /** dataOk가 false인 이유 */
  dataReason: string;
  /**
   * **전략이 쓸 수 있는 관측값.** 판정이 아니라 재료다.
   *
   * 여기까지 계산해 놓고 `trend` 세 값만 밖으로 내보내고 있었다. 그래서
   * `planEntry`가 쓸 수 있는 것이 '상승·하락·횡보'뿐이었고, 무슨 전략을
   * 짜도 추세 추종의 변주밖에 안 나왔다 — 역추세도 돌파도 그리드도
   * 이 값들이 있어야 성립한다.
   *
   * 96행이 스스로 "횡보 — 반전매매 유리"라고 적어 두고도 반전매매를
   * 만들 재료를 안 넘기고 있었다.
   *
   * **`dataOk`가 false면 전부 null이다.** 못 잰 것을 0으로 적지 않는다 —
   * 0은 "변동성이 없다"는 뜻이고, 그 위에서 전략이 진입한다.
   */
  view: RegimeView;
}

/** 전략이 읽는 관측값. 판정하지 않는다. 못 잰 것은 null이다. */
export interface RegimeView {
  /** 마지막 종가 */
  price: number | null;
  ema20: number | null;
  ema60: number | null;
  /** 종가 기준 평균 변동폭(14) — 가격 단위 */
  atr: number | null;
  /**
   * 최근 창(현재 봉 **포함**)의 최고·최저 종가 — **박스**다.
   *
   * 역추세가 이것을 본다: 지금 가격이 박스의 어디에 있는지.
   */
  recentHigh: number | null;
  recentLow: number | null;
  /**
   * 같은 창에서 **현재 봉을 뺀** 최고·최저 종가 — **돌파선**이다.
   *
   * 돌파가 `recentHigh`를 보면 **영원히 발동하지 않는다.** recentHigh는
   * 현재 종가를 포함한 최댓값이므로 `price > recentHigh`가 될 수 없다.
   * 돌파는 "직전까지의 고점을 지금 넘었는가"이므로 창에서 현재 봉을
   * 빼야 성립한다. 둘을 한 값으로 합치면 두 전략 중 하나가 반드시 틀린다.
   */
  priorHigh: number | null;
  priorLow: number | null;
}

/** 돌파·박스를 재는 창. 바꾸면 전략의 뜻이 바뀌므로 한 곳에 둔다 */
export const REGIME_VIEW_WINDOW = 20;

const EMPTY_VIEW: RegimeView = {
  price: null, ema20: null, ema60: null, atr: null,
  recentHigh: null, recentLow: null, priorHigh: null, priorLow: null,
};

/**
 * 판정에 필요한 최소 봉 수.
 *
 * ema(60)이 60개를 요구한다. 그보다 적으면 ema60이 null이 되고 추세
 * 점수가 0으로 남아 **무조건 '횡보'**가 된다. 그 횡보는 관측이 아니라
 * 계산을 못 한 것이다.
 */
export const REGIME_MIN_BARS = 60;

function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values[values.length - period];
  for (let i = values.length - period + 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}
function atr(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 0;
  let sum = 0;
  for (let i = closes.length - period; i < closes.length; i++) sum += Math.abs(closes[i] - closes[i - 1]);
  return sum / period;
}

/**
 * 추세·변동성 판정 **한 벌**.
 *
 * `detectRegime`(봉 배열)과 `regimeFromSnapshot`(스냅샷) 둘 다 이 함수를
 * 쓴다. 전에는 `AutoTradeEngine.tsx`가 아래 계산식을 **복사해** 들고
 * 있었고, 그래서 detectRegime에 "봉이 모자라면 판정하지 않는다"를 넣었을
 * 때 복사본은 그 검사를 통째로 비껴갔다 — `allowEntry: true`가 상수로
 * 박혀 있었으므로 계산이 무엇이든 허용이었다.
 *
 * 같은 판단을 두 곳에 두면 언젠가 한쪽만 고쳐진다. 그래서 여기 한 곳이다.
 */
function classify(m: {
  price: number;
  ema20: number | null;
  ema60: number | null;
  /** 가격 단위 평균 변동폭. 못 쟀으면 null — 0으로 넘기지 않는다 */
  atrVal: number | null;
  bars: number;
  dataOk: boolean;
  dataReason: string;
  recentHigh: number | null;
  recentLow: number | null;
  priorHigh: number | null;
  priorLow: number | null;
}): MarketRegime {
  const volPct = m.atrVal != null && m.price > 0 ? (m.atrVal / m.price) * 100 : 0;

  let trend: TrendRegime = 'sideways';
  let trendScore = 0;
  if (m.ema20 != null && m.ema60 != null && m.ema60 !== 0 && m.price > 0) {
    const gap = ((m.ema20 - m.ema60) / m.ema60) * 100;
    const pricePos = ((m.price - m.ema60) / m.ema60) * 100;
    trendScore = Math.max(-100, Math.min(100, (gap * 8) + (pricePos * 2)));
    if (trendScore > 12) trend = 'uptrend';
    else if (trendScore < -12) trend = 'downtrend';
  }

  let volatility: VolRegime = 'normal_vol';
  if (volPct >= 4) volatility = 'high_vol';
  else if (volPct < 1.2) volatility = 'low_vol';

  const trendKr = trend === 'uptrend' ? '상승 추세' : trend === 'downtrend' ? '하락 추세' : '횡보';
  const volKr = volatility === 'high_vol' ? '고변동' : volatility === 'low_vol' ? '저변동' : '보통변동';
  const label = `${trendKr} · ${volKr}`;

  let recommendation = '', allowEntry = true;
  if (volatility === 'high_vol') { recommendation = '고변동 — 포지션 축소/관망 권장'; allowEntry = false; }
  else if (trend === 'downtrend') { recommendation = '하락 추세 — 롱 위험, 숏/관망'; allowEntry = false; }
  else if (trend === 'uptrend') { recommendation = '상승 추세 — 추세추종 유리'; allowEntry = true; }
  else { recommendation = '횡보 — 반전매매(RSI/볼밴) 유리'; allowEntry = true; }

  return {
    trend, volatility, label,
    trendScore: +trendScore.toFixed(1), volPct: +volPct.toFixed(2),
    recommendation, allowEntry,
    dataOk: m.dataOk, bars: m.bars, dataReason: m.dataReason,
    view: {
      price: m.price > 0 ? m.price : null,
      ema20: m.ema20, ema60: m.ema60,
      // atr()는 봉이 모자라면 0을 돌려준다. 그 0은 "변동 없음"이 아니라
      // "못 쟀다"다 — null로 바꿔서 전략이 0으로 나누거나 0폭 밴드를
      // 만들지 않게 한다.
      atr: m.atrVal != null && m.atrVal > 0 ? m.atrVal : null,
      recentHigh: m.recentHigh, recentLow: m.recentLow,
      priorHigh: m.priorHigh, priorLow: m.priorLow,
    },
  };
}

export function detectRegime(closes: number[]): MarketRegime {
  const list = Array.isArray(closes) ? closes.filter(c => Number.isFinite(c) && c > 0) : [];
  const bars = list.length;
  if (bars < REGIME_MIN_BARS) {
    // 계산하지 않는다. 여기서 '횡보'를 돌려주면 그 값이 그대로 진입 허용이
    // 되고, 시세를 못 받은 것과 실제 횡보장이 구분되지 않는다.
    return {
      trend: 'sideways', volatility: 'normal_vol',
      label: '판정 불가', trendScore: 0, volPct: 0,
      recommendation: `봉이 ${bars}개뿐입니다 (최소 ${REGIME_MIN_BARS}개 필요) — 국면을 판정할 수 없습니다`,
      allowEntry: false,
      dataOk: false, bars,
      dataReason: `봉 ${bars}/${REGIME_MIN_BARS}개`,
      // 못 잰 것을 0으로 적지 않는다. 0은 "변동성 없음"으로 읽힌다.
      view: EMPTY_VIEW,
    };
  }
  // 돌파·박스는 "최근 창의 끝"을 봐야 성립한다. 창은 가진 봉 수로 자른다 —
  // 지금은 60개를 요구하니 20개가 모자랄 수 없지만, 창 상수가 바뀌어도
  // 빈 배열이 나오지 않게 봉 수로 자른다.
  const win = list.slice(-Math.min(REGIME_VIEW_WINDOW, bars));
  // 돌파선은 현재 봉을 뺀 창이다. 자세한 이유는 RegimeView.priorHigh 주석.
  const prior = win.slice(0, -1);
  return classify({
    price: list[list.length - 1] || 0,
    ema20: ema(list, 20),
    ema60: ema(list, 60),
    atrVal: atr(list, 14),
    bars, dataOk: true, dataReason: '',
    recentHigh: win.length ? Math.max(...win) : null,
    recentLow: win.length ? Math.min(...win) : null,
    priorHigh: prior.length ? Math.max(...prior) : null,
    priorLow: prior.length ? Math.min(...prior) : null,
  });
}

/**
 * 봉 배열이 없고 지표 스냅샷만 있는 화면을 위한 입구.
 *
 * `AutoTradeEngine`은 봉을 들고 있지 않고 ema20·ema60·atr 스냅샷만 갖고
 * 있다. 그래도 **판정식을 복사하지 않는다** — 같은 `classify`를 부른다.
 *
 * `recentHigh`·`recentLow`는 **null이다.** 봉 창이 없으니 못 잰 것이고,
 * 못 잰 것을 값으로 적으면 돌파 전략이 그 숫자를 돌파선으로 쓴다.
 */
export function regimeFromSnapshot(s: {
  price: number;
  ema20: number | null | undefined;
  ema60: number | null | undefined;
  atr: number | null | undefined;
}): MarketRegime {
  const ema20 = Number.isFinite(s.ema20 as number) ? (s.ema20 as number) : null;
  const ema60 = Number.isFinite(s.ema60 as number) ? (s.ema60 as number) : null;
  const atrVal = Number.isFinite(s.atr as number) ? (s.atr as number) : null;
  const price = Number.isFinite(s.price) ? s.price : 0;
  // 스냅샷이 실제로 계산된 것일 때만 dataOk를 켠다. 하나라도 비면
  // regimeAllowsEntry가 통과가 아니라 차단으로 읽는다.
  const dataOk = ema20 != null && ema60 != null && ema60 !== 0 && price > 0;
  return classify({
    price, ema20, ema60, atrVal,
    bars: 0, dataOk,
    dataReason: dataOk ? '스냅샷 기반 판정 (봉 배열 없음)' : '스냅샷에 ema20·ema60·가격이 없습니다',
    recentHigh: null, recentLow: null, priorHigh: null, priorLow: null,
  });
}

export function regimeAllowsEntry(
  regime: MarketRegime, action: 'buy' | 'sell',
  marketFilter?: 'any' | 'trend_only' | 'range_only' | 'avoid_highvol',
): { allowed: boolean; reason: string } {
  // 판정하지 못한 것을 허용으로 읽지 않는다.
  if (!regime.dataOk) {
    return { allowed: false, reason: `국면을 판정하지 못했습니다 (${regime.dataReason})` };
  }
  if (regime.volatility === 'high_vol') return { allowed: false, reason: `고변동장 진입 차단 (변동성 ${regime.volPct}%)` };
  if (regime.trend === 'downtrend' && action === 'buy') return { allowed: false, reason: '하락 추세에서 롱 진입 차단' };
  if (regime.trend === 'uptrend' && action === 'sell') return { allowed: false, reason: '상승 추세에서 숏 진입 차단' };
  if (marketFilter === 'trend_only' && regime.trend === 'sideways') return { allowed: false, reason: '추세장 전용 — 횡보장 차단' };
  if (marketFilter === 'range_only' && regime.trend !== 'sideways') return { allowed: false, reason: '횡보장 전용 — 추세장 차단' };
  return { allowed: true, reason: `${regime.label} — 진입 허용` };
}
