// src/lib/autotrade/decision.ts
// 설명가능한(XAI) 판단 엔진 — 가격 시계열로 지표를 계산해
// action(진입/대기/청산) + AI 신뢰도 + 시장상태 + "판단 이유"를 반환한다.
// 핵심: 아무것도 안 하는 이유(대기 사유)까지 투명하게 설명한다.

export interface DecisionReason { label: string; value: string; met: boolean }
export type DecisionAction = 'enter_long' | 'hold' | 'exit_tp' | 'exit_sl' | 'wait';
export type MarketState = '강세' | '약세' | '횡보' | '고변동성' | '저변동성';

export interface Decision {
  action: DecisionAction;
  confidence: number;          // 0~100
  marketState: MarketState;
  reasons: DecisionReason[];   // 각 판단 근거 (met = 충족)
  summary: string;             // 한 줄 요약
  recommendedStrategy: string; // 시장상태 기반 추천 전략
}

export interface DecideInput {
  prices: number[];            // 최근 가격 (오래된→최신)
  hasPosition: boolean;
  entryPrice?: number;
  side?: 'long' | 'short';
  tpPct: number;
  slPct: number;
  confThreshold: number;       // 이 신뢰도 이상만 진입 (예: 80)
}

// ── 지표 ──────────────────────────────────────────────
function ema(vals: number[], period: number): number {
  if (vals.length === 0) return 0;
  const k = 2 / (period + 1);
  let e = vals[0];
  for (let i = 1; i < vals.length; i++) e = vals[i] * k + e * (1 - k);
  return e;
}
function rsi(vals: number[], period = 14): number {
  if (vals.length < 2) return 50;
  let gain = 0, loss = 0, n = 0;
  for (let i = Math.max(1, vals.length - period); i < vals.length; i++) {
    const d = vals[i] - vals[i - 1];
    if (d >= 0) gain += d; else loss -= d;
    n++;
  }
  if (n === 0) return 50;
  const avgG = gain / n, avgL = loss / n;
  if (avgL === 0) return avgG === 0 ? 50 : 100;
  const rs = avgG / avgL;
  return 100 - 100 / (1 + rs);
}
function volatilityPct(vals: number[]): number {
  if (vals.length < 3) return 0;
  const rets: number[] = [];
  for (let i = 1; i < vals.length; i++) rets.push((vals[i] - vals[i - 1]) / vals[i - 1]);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const varc = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  return Math.sqrt(varc) * 100;
}

export function decide(input: DecideInput): Decision {
  const { prices, hasPosition, entryPrice, side = 'long', tpPct, slPct, confThreshold } = input;
  const price = prices[prices.length - 1] ?? 0;

  // ── 보유 중이면 청산 판단 우선 ──
  if (hasPosition && entryPrice && entryPrice > 0) {
    const dir = side === 'short' ? -1 : 1;
    const pnlPct = ((price - entryPrice) / entryPrice) * 100 * dir;
    if (pnlPct >= tpPct) return { action: 'exit_tp', confidence: 100, marketState: '강세', recommendedStrategy: '-',
      reasons: [{ label: '목표 수익 도달', value: `+${pnlPct.toFixed(2)}% ≥ ${tpPct}%`, met: true }],
      summary: `익절 조건 충족 (+${pnlPct.toFixed(2)}%)` };
    if (pnlPct <= -slPct) return { action: 'exit_sl', confidence: 100, marketState: '약세', recommendedStrategy: '-',
      reasons: [{ label: '손절선 도달', value: `${pnlPct.toFixed(2)}% ≤ -${slPct}%`, met: true }],
      summary: `손절 조건 충족 (${pnlPct.toFixed(2)}%)` };
    return { action: 'hold', confidence: 60, marketState: '횡보', recommendedStrategy: '-',
      reasons: [{ label: '보유 유지', value: `평가손익 ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% (익절 ${tpPct}%/손절 -${slPct}%)`, met: true }],
      summary: `보유중 · 평가손익 ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%` };
  }

  // ── 무포지션: 진입 판단 (지표 계산) ──
  const emaFast = ema(prices, 5);
  const emaSlow = ema(prices, 20);
  const rsiVal = rsi(prices, 14);
  const vol = volatilityPct(prices);
  const emaGapPct = emaSlow > 0 ? ((emaFast - emaSlow) / emaSlow) * 100 : 0;

  // 시장 상태
  let marketState: MarketState;
  if (vol > 0.35) marketState = '고변동성';
  else if (emaGapPct > 0.05) marketState = '강세';
  else if (emaGapPct < -0.05) marketState = '약세';
  else if (vol < 0.08) marketState = '저변동성';
  else marketState = '횡보';

  const recMap: Record<MarketState, string> = {
    '강세': '추세 추종 (EMA)', '약세': '방어 / 관망', '횡보': 'RSI 반전',
    '고변동성': '진입 축소 / 대기', '저변동성': 'DCA 적립',
  };

  // 진입 조건들 (가중 신뢰도)
  const emaBull = emaFast > emaSlow;
  const rsiOk = rsiVal >= 40 && rsiVal <= 70;      // 과매수/과매도 회피
  const volOk = vol <= 0.35;                         // 과도한 변동성 회피
  const trendStrength = Math.min(100, Math.abs(emaGapPct) * 400); // 추세 강도 점수

  const reasons: DecisionReason[] = [
    { label: 'EMA 교차', value: emaBull ? `상승 (5>20, +${emaGapPct.toFixed(2)}%)` : `하락/미교차 (${emaGapPct.toFixed(2)}%)`, met: emaBull },
    { label: 'RSI', value: `${rsiVal.toFixed(0)} ${rsiOk ? '(중립대)' : rsiVal > 70 ? '(과매수)' : '(약세)'}`, met: rsiOk },
    { label: '변동성', value: `${vol.toFixed(2)}% ${volOk ? '(안정)' : '(과열)'}`, met: volOk },
    { label: '추세 강도', value: `${trendStrength.toFixed(0)}점`, met: trendStrength >= 30 },
  ];

  // 신뢰도: EMA 40 + RSI 25 + 변동성 20 + 추세강도 15
  const confidence = Math.round(
    (emaBull ? 40 : 0) + (rsiOk ? 25 : 0) + (volOk ? 20 : 0) + (trendStrength >= 30 ? 15 : trendStrength * 0.15)
  );

  if (emaBull && confidence >= confThreshold) {
    return { action: 'enter_long', confidence, marketState, recommendedStrategy: recMap[marketState], reasons,
      summary: `진입 · 신뢰도 ${confidence}% · ${marketState}` };
  }

  // ── 대기: "왜 아무것도 안 하는지" 설명 ──
  const unmet = reasons.filter(r => !r.met).map(r => r.label);
  const waitReason = confidence < confThreshold
    ? `AI 신뢰도 부족 (${confidence}% < ${confThreshold}%)`
    : !emaBull ? 'EMA 상승 교차 없음'
    : '진입 조건 미충족';
  return { action: 'wait', confidence, marketState, recommendedStrategy: recMap[marketState], reasons,
    summary: `대기 · ${waitReason}${unmet.length ? ` (${unmet.join(', ')})` : ''}` };
}
