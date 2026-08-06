// src/lib/markets/trend.ts
//
// **상위 시간봉이 어느 쪽인가.**
//
// 왜 필요한가
// ───────────
// 숏 검사(shortGuard)가 "상위 시간봉이 상승이면 막는다"를 갖고 있는데,
// 그 값을 만들어 주는 곳이 없었다. 그래서 언제나 null로 넘어갔고,
// 그 검사는 **한 번도 돈 적이 없다.**
//
// 판정을 여기 한 곳에 두는 이유
// ─────────────────────────────
// 화면·자동매매·백테스트가 각자 "추세"를 정의하면 세 곳의 뜻이 달라진다.
// 그러면 "화면에는 하락인데 자동매매는 상승으로 봤다"가 되고, 그건
// 눈으로 못 잡는다.
//
// 애매한 것을 한쪽으로 밀지 않는다
// ────────────────────────────────
// EMA 위/아래로만 가르면 값이 선 위에서 흔들릴 때 추세가 매 봉 뒤집힌다.
// 그래서 **RANGE를 진짜 칸으로 둔다** — 위도 아래도 아닌 자리가 실제로
// 있고, 거기서 방향을 강제로 고르면 그 판정으로 주문이 나간다.

export type TrendDir = 'UP' | 'DOWN' | 'RANGE';

export interface TrendVerdict {
  dir: TrendDir | null;
  /** 왜 그렇게 봤는가 */
  reason: string;
  /** 기준선 대비 거리(%). 못 구하면 null */
  distancePct: number | null;
}

/** 지수이동평균. 값이 모자라면 null */
function emaLast(values: number[], period: number): number | null {
  const xs = values.filter(v => Number.isFinite(Number(v))).map(Number);
  if (xs.length < period) return null;
  const k = 2 / (period + 1);
  let prev = xs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < xs.length; i++) prev = xs[i] * k + prev * (1 - k);
  return prev;
}

/**
 * 종가 배열 → 추세.
 *
 * **봉이 모자라면 null이다.** 있는 것만으로 계산하면 기간이 짧아진
 * 평균이 나오는데, 그건 다른 지표이지 짧은 버전이 아니다.
 *
 * @param bandPct 기준선에서 이만큼 안이면 RANGE. 기본 0.5%
 */
export function trendOf(
  closes: number[] | null | undefined, period = 50, bandPct = 0.5,
): TrendVerdict {
  const xs = Array.isArray(closes) ? closes.filter(v => Number.isFinite(Number(v))).map(Number) : [];
  if (xs.length < period) {
    return { dir: null, distancePct: null,
      reason: `봉이 ${xs.length}개뿐입니다 (${period}개 필요) — 추세를 판정하지 않습니다` };
  }
  const ema = emaLast(xs, period);
  const last = xs[xs.length - 1];
  if (ema == null || !(ema > 0) || !(last > 0)) {
    return { dir: null, distancePct: null, reason: '기준선을 계산하지 못했습니다' };
  }

  const dist = (last - ema) / ema * 100;
  const band = Math.max(0, Number(bandPct) || 0);

  // 선 근처는 RANGE다. 여기서 방향을 강제로 고르면 값이 선 위에서
  // 흔들릴 때마다 추세가 뒤집히고, 그 판정으로 주문이 나간다.
  if (Math.abs(dist) <= band) {
    return { dir: 'RANGE', distancePct: dist,
      reason: `기준선에서 ${dist.toFixed(2)}% — 방향을 말하기 어렵습니다` };
  }
  return {
    dir: dist > 0 ? 'UP' : 'DOWN',
    distancePct: dist,
    reason: `${period}봉 기준선 ${dist > 0 ? '위' : '아래'} ${Math.abs(dist).toFixed(2)}%`,
  };
}
