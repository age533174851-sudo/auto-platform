// src/test/fixtures/syntheticBars.ts
//
// **거래소 없이 전략 판단을 돌리기 위한 합성 봉 (#450).**
//
// 왜 `src/lib/` 가 아니라 `src/test/fixtures/` 인가
// ─────────────────────────────────────────────────
// 처음에 `src/lib/backtest/`에 뒀다가 `check-wiring`이 막았다:
//
//   ❌ 만들어 놓고 부르는 곳이 없는 판정 모듈: src/lib/backtest/syntheticBars.ts
//
// 그 검사가 옳다. `src/lib/**`의 모듈은 **운영 소비자**가 있어야 한다.
// 그리고 합성 봉은 운영에 들어가면 안 되는 것이다 — 지어낸 가격으로
// 실제 판단을 하게 되는 순간 이 파일은 사고가 된다. ALLOW 에 적는 것도
// 틀렸다: 그 목록은 "언젠가 배선할 빚"이고, 이것은 영원히 배선하지 않는다.
//
// 그래서 운영 코드가 아닌 곳에 둔다. 시험만 부른다.
//
// 왜 합성인가
// ───────────
// 실측 CSV 를 커밋하려면 ⓐ 데이터를 받아올 네트워크가 있어야 하고
// ⓑ 저장소에 수 MB 를 넣는 출처·용량 결정이 필요하다. 지금 이 저장소의
// 오프라인 검증에는 둘 다 없다(거래소 호스트가 닫혀 있다).
//
// 고정 시드 합성 봉은 둘 다 필요 없고 **완전히 결정적**이다. 그리고
// 여기서 잡으려는 것은 "실제 가격이 어땠나"가 아니라 **"이 체제에서
// 우리 전략이 어떤 판정을 내리나"**다 — 그건 합성으로 충분하다.
//
// **이 파일은 성적표를 만들지 않는다.** 합성 봉으로 계산한 손익은 아무
// 뜻이 없다. 판정(신호 유무·사유 코드)만 본다.
//
// 종목 이름보다 **체제**다
// ────────────────────────
// 'BTCUSDT'라는 문자열을 바꿔 봐도 전략은 같은 판단을 한다 — 전략이 보는
// 것은 이름이 아니라 봉이다. 그래서 종목을 흉내 내는 대신 **시장 성격**을
// 흉내 낸다. 가격대(10만 vs 0.00001)는 따로 축으로 둔다.

/**
 * `QUIET_INSIDE` 가 참조하는 최근 봉 수.
 *
 * `SCALP_DEFAULTS.lookback` 과 같은 값이어야 "안쪽"이 뜻을 갖는다.
 * **여기서 전략 설정을 import 하지 않는다** — 생성기가 전략에 의존하면
 * 전략을 바꾸는 날 생성기가 같이 흔들려서, 시험이 무엇을 보는지 알 수
 * 없게 된다. 대신 시험이 두 값이 같은지 확인한다.
 */
export const SCALP_LOOKBACK = 20;

/** 결정적 난수 (LCG). `Math.random()`을 쓰면 시험이 흔들린다 */
function lcg(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

export interface SynthBars {
  highs: number[];
  lows: number[];
  closes: number[];
  volumes: number[];
}

export type Regime =
  /** 변동성 ≈ 0. 돌파가 안 나는 것이 정상이다 */
  | 'FLAT'
  /** 완만한 상승. 돌파는 나지만 목표가 왕복 비용을 못 넘을 수 있다 */
  | 'LOW_VOL_TREND'
  /** 변동성은 큰데 방향이 없다 */
  | 'HIGH_VOL_RANGE'
  /** 마지막 봉이 거래량과 함께 위로 크게 — 돌파가 나야 한다 */
  | 'BREAKOUT_UP'
  /** 마지막 봉이 아래로 크게 */
  | 'BREAKOUT_DOWN'
  /** 돌파는 났는데 거래량이 평균 이하 */
  | 'BREAKOUT_NO_VOLUME'
  /** 갭 급락 */
  | 'GAP_DOWN'
  /** 거래량이 전부 0 */
  | 'ZERO_VOLUME'
  /**
   * 변동성은 있는데 마지막 봉이 최근 고/저 **안쪽**에서 닫힌다.
   *
   * 이 체제가 `NO_BREAKOUT` 을 만든다 — 운영 장부가 실제로 보여 준
   * 코드다. 거래량은 넉넉히 줘서 **거래량 관문이 먼저 걸리지 않게** 한다.
   * 그래야 "돌파가 없었다"와 "돌파했는데 거래량이 모자랐다"가 갈린다.
   */
  | 'QUIET_INSIDE';

export interface SynthOptions {
  regime: Regime;
  /** 봉 개수. 기본 60 — `SCALP_DEFAULTS`(lookback 20 · atrPeriod 14)에 넉넉하다 */
  n?: number;
  /** 가격대. BTC 10만 · DOGE 0.12 · SHIB 0.000012 처럼 자리수를 바꿔 본다 */
  basePrice?: number;
  /** 같은 시드면 같은 봉이다 */
  seed?: number;
}

/**
 * 한 체제의 봉을 만든다. **같은 입력에 같은 출력이다.**
 *
 * 가격이 0 이하로 내려가지 않게 바닥을 둔다 — 음수 가격은 어떤 체제도
 * 아니고, 그걸로 나는 실패는 전략의 결함이 아니라 생성기의 결함이다.
 */
export function syntheticBars(o: SynthOptions): SynthBars {
  const n = Math.max(2, Math.floor(o.n ?? 60));
  const base = o.basePrice ?? 100;
  const rnd = lcg(o.seed ?? 20261106);
  const floor = base * 1e-6;

  const highs: number[] = [], lows: number[] = [], closes: number[] = [], volumes: number[] = [];
  let px = base;

  // 체제마다 '한 봉의 흔들림'과 '추세 기울기'가 다르다
  const wiggle =
    o.regime === 'FLAT' ? 0
    : o.regime === 'LOW_VOL_TREND' ? 0.0005
    : o.regime === 'HIGH_VOL_RANGE' ? 0.02
    : o.regime === 'QUIET_INSIDE' ? 0.004
    : 0.003;
  const drift = o.regime === 'LOW_VOL_TREND' ? 0.0004 : 0;

  for (let i = 0; i < n; i += 1) {
    const last = i === n - 1;
    const r = rnd() - 0.5;
    px = Math.max(floor, px * (1 + drift + r * wiggle * 2));

    let hi = px * (1 + Math.abs(r) * wiggle + (wiggle === 0 ? 0 : 1e-6));
    let lo = Math.max(floor, px * (1 - Math.abs(r) * wiggle - (wiggle === 0 ? 0 : 1e-6)));
    let cl = px;
    // 평균 거래량 — 마지막 봉의 배수를 판정하려면 기준이 있어야 한다
    let vol = 100 + rnd() * 10;

    if (last) {
      if (o.regime === 'BREAKOUT_UP' || o.regime === 'BREAKOUT_NO_VOLUME') {
        cl = px * 1.05; hi = cl * 1.001; lo = px * 0.999;
        vol = o.regime === 'BREAKOUT_UP' ? 1000 : 10;   // 평균 ~105 대비
      } else if (o.regime === 'BREAKOUT_DOWN') {
        cl = Math.max(floor, px * 0.95); lo = cl * 0.999; hi = px * 1.001;
        vol = 1000;
      } else if (o.regime === 'GAP_DOWN') {
        cl = Math.max(floor, px * 0.8); lo = cl * 0.999; hi = px * 1.001;
        vol = 1000;
      }
    }
    if (last && o.regime === 'QUIET_INSIDE') {
      // 최근 20봉의 고가보다 **확실히 낮게** 닫는다 → 돌파가 아니다.
      // 거래량은 평균의 몇 배로 줘서 거래량 관문을 먼저 걸리지 않게 한다.
      const recentHigh = Math.max(...highs.slice(-SCALP_LOOKBACK));
      const recentLow = Math.min(...lows.slice(-SCALP_LOOKBACK));
      cl = (recentHigh + recentLow) / 2;
      hi = cl * 1.0005; lo = cl * 0.9995;
      vol = 1000;
    }
    if (o.regime === 'ZERO_VOLUME') vol = 0;

    highs.push(hi); lows.push(lo); closes.push(cl); volumes.push(vol);
  }
  return { highs, lows, closes, volumes };
}

/** 모든 체제. 시험이 전수로 돈다 */
export const REGIMES: Regime[] = [
  'FLAT', 'LOW_VOL_TREND', 'HIGH_VOL_RANGE', 'BREAKOUT_UP', 'BREAKOUT_DOWN',
  'BREAKOUT_NO_VOLUME', 'GAP_DOWN', 'ZERO_VOLUME', 'QUIET_INSIDE',
];

/** 가격대 축 — 자리수가 판정을 바꾸는지 본다 */
export const PRICE_SCALES: Array<{ name: string; basePrice: number }> = [
  { name: 'BTC급 (10만)', basePrice: 100_000 },
  { name: 'ETH급 (3500)', basePrice: 3_500 },
  { name: 'DOGE급 (0.12)', basePrice: 0.12 },
  { name: 'SHIB급 (0.000012)', basePrice: 0.000012 },
];
