// src/lib/engine/holdEvidenceReader.ts
//
// **보유 연장 증거를 거래소에서 모은다. 판단은 하지 않는다.**
//
// 왜 라우트에 두지 않았는가
// ─────────────────────────
// 여기 있는 것은 조회 다섯 번과 단위 변환이다. 라우트 안의 for 루프에
// 인라인으로 두면 **시험되지 않는 자리에 단위 변환이 남는다** — 펀딩의
// 부호, 수수료의 왕복 배수, 명목에서 증거금으로 나누는 자리. 그 셋 중
// 하나만 틀려도 "지고 있는 자리를 이기고 있다"고 읽는다.
//
// ★ **판단하지 않는다.** 돌려주는 어떤 값도 "연장하라"를 뜻하지 않는다.
//   연장 여부는 `decideHoldExtension` 한 곳이 정한다.
//
// ★ **못 읽은 칸은 `null`이다.** 0으로 채우지 않는다 — 펀딩을 못 읽어
//   0으로 적으면 하루치 펀딩 비용이 장부에서 사라지고, 그만큼 순수익이
//   부풀어 연장 문턱을 넘는다. 그 null을 받은 판정이 닫는 쪽으로 떨어진다.
//
// ★ **주문을 내지 않는다.** 이 파일에는 주문을 낼 수단이 없다.

import type { HoldEvidence } from './holdExtension';
import { summarizeBars } from './holdExtension';
import { headroomPct } from './postEntryRisk';

export interface HoldEvidenceVenue {
  apiKey: string;
  apiSecret: string;
  testnet: boolean;
}

export interface HoldEvidenceRequest {
  venue: HoldEvidenceVenue;
  symbol: string;
  side: 'LONG' | 'SHORT';
  /** 진입(체결) 시각. 펀딩 합산 구간의 시작이다 */
  openedAtMs: number;
  nowMs: number;
  /** 추세를 볼 봉 간격. 기본 15분 */
  barInterval?: string;
}

/** 추세 봉이 이보다 오래 멈춰 있으면 추세를 정하지 않는다 (간격의 배수) */
export const BAR_STALENESS_INTERVALS = 2;

const num = (v: unknown): number | null => {
  if (v == null || typeof v === 'boolean') return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * 연장 판정에 필요한 관측을 모은다.
 *
 * 돌려주는 값은 **언제나 객체다.** `null`을 돌려주지 않는 이유: 어느 칸이
 * 비었는지가 판정 사유에 적혀야 운영자가 "무엇을 못 읽어서 닫혔는지"를
 * 볼 수 있다. 통째로 null이면 그 정보가 사라진다.
 */
export async function readHoldEvidence(
  req: HoldEvidenceRequest,
): Promise<HoldEvidence> {
  const { venue, symbol, side } = req;
  const interval = req.barInterval ?? '15m';

  const bf = await import('@/lib/exchanges/binanceFutures');
  const { fetchVenueBars, intervalMs } = await import('@/lib/markets/venueBars');

  // ── ① 마크가 — 시각이 붙은 관측이어야 한다 ──
  //
  // `positionRisk.markPrice`를 쓰지 않는다. 그 값에는 "언제의 가격인가"가
  // 없어서 신선도를 물을 수 없다.
  const snap = await bf.readMarketSnapshot(symbol, venue.testnet).catch(() => null);
  const markPrice = num(snap?.snapshot?.markPrice);
  const markAt = num(snap?.snapshot?.stamps.receivedAtMs);

  // ── ② 포지션 — 진입가·배율·청산가 ──
  const rr = await bf.getSymbolPositionRiskEx(
    venue.apiKey, venue.apiSecret, symbol, venue.testnet).catch(() => null);
  const entryPrice = num(rr?.risk?.entryPrice);
  const leverage = num(rr?.risk?.leverage);
  const liqPrice = num(rr?.risk?.liquidationPrice);
  const qty = num(rr?.risk?.positionAmt);
  const riskAt = num(rr?.provenance?.positionRiskReceivedAtMs);

  // ── ③ 수수료 — **왕복이다.** 들어갈 때와 나올 때 둘 다 낸다 ──
  //
  // 진입은 이미 냈고 종료는 아직 안 냈지만, "지금 닫으면 남는 것"을
  // 물으므로 둘을 함께 센다.
  const cr = await bf.getCommissionRate(
    venue.apiKey, venue.apiSecret, symbol, venue.testnet).catch(() => null);
  const taker = num(cr?.rate?.takerRate);
  const roundTripFeeRate = taker == null ? null : taker * 2;

  // ── ④ 펀딩 — **낸 것은 양수다** ──
  //
  // 거래소 income은 **받은 쪽이 양수**다(펀딩을 냈으면 음수). 부호를
  // 뒤집어 "낸 비용"으로 적는다. 뒤집지 않으면 비용이 수익으로 더해진다.
  const income = await bf.getFuturesIncome(
    venue.apiKey, venue.apiSecret, venue.testnet,
    { startTime: Math.floor(req.openedAtMs), limit: 1000 }).catch(() => null);
  let fundingPaidQuote: number | null = null;
  if (Array.isArray(income)) {
    let sum = 0;
    let usable = true;
    for (const row of income) {
      if (String(row?.incomeType) !== 'FUNDING') continue;
      if (String(row?.symbol ?? '').toUpperCase() !== symbol.toUpperCase()) continue;
      const v = num(row?.income);
      // 한 줄이라도 못 읽으면 합계가 **틀린 값**이다. 부분합을 적지 않는다.
      if (v == null) { usable = false; break; }
      sum += v;
    }
    // 비어 있는 배열은 "펀딩이 없었다"는 **사실**이다. 조회 실패와 다르다.
    if (usable) fundingPaidQuote = -sum;
  }

  // ── ⑤ 봉 — 추세·변동성·고점 ──
  //
  // 진입 이후만 본다. 고점은 "이 포지션이 도달했던 최고"여야 한다 —
  // 진입 전 가격을 섞으면 열지도 않았던 수익을 반납했다고 적는다.
  const step = intervalMs(interval);
  const bars = await fetchVenueBars({
    exchange: 'binance', symbol, interval, limit: 200,
    testnet: venue.testnet, nowMs: req.nowMs,
    startTimeMs: Math.floor(req.openedAtMs),
  }).catch(() => null);

  const rows = bars?.bars == null ? [] : bars.bars.closes.map((c, k) => ({
    high: bars.bars!.highs[k], low: bars.bars!.lows[k], close: c,
    openTime: bars.bars!.openTimes[k],
  }));
  // **멈춘 봉으로 추세를 말하지 않는다.** 마지막 봉이 너무 오래되면
  // 응답은 성공이지만 그 추세는 지금의 것이 아니다.
  const lastOpen = rows.length > 0 ? num(rows[rows.length - 1].openTime) : null;
  const barsFresh = step != null && lastOpen != null
    && (req.nowMs - lastOpen) <= step * (BAR_STALENESS_INTERVALS + 1);
  const trend = barsFresh ? summarizeBars(rows, side)
    : { ok: false, trendAlive: null, atrPct: null, bestPrice: null, reason: '' };

  // ── 관측 시각은 **가장 오래된 것**이다 ──
  //
  // 셋 중 하나가 1분 전 값이면 이 증거 묶음은 1분 전 것이다. 가장 최근
  // 시각을 적으면 신선도 검사가 가장 낡은 칸을 못 본다.
  //
  // ★ 봉 시각은 넣지 않는다. 15분봉은 정의상 최근 15분을 못 보고, 그것을
  //   신선도 위반으로 적으면 연장이 영원히 일어나지 않는다. 봉의 신선도는
  //   위 `barsFresh`가 따로 본다.
  const stamps = [markAt, riskAt].filter((x): x is number => x != null);
  const observedAtMs = stamps.length === 2 ? Math.min(...stamps) : null;

  return {
    observedAtMs,
    entryPrice,
    markPrice,
    leverage,
    roundTripFeeRate,
    fundingPaidQuote,
    notionalAtEntryQuote: entryPrice != null && qty != null && entryPrice > 0
      ? entryPrice * Math.abs(qty) : null,
    bestPrice: trend.bestPrice,
    // 거리 계산은 `postEntryRisk`의 정본을 쓴다. 부호 판단을 다시 적지 않는다.
    liquidationHeadroomPct: markPrice != null && liqPrice != null
      ? headroomPct(side, markPrice, liqPrice) : null,
    trendAlive: trend.trendAlive,
    atrPct: trend.atrPct,
  };
}
