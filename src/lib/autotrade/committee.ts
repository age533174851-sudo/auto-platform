// src/lib/autotrade/committee.ts
// AI 투자위원회 — 5명의 전문 AI가 각자 관점에서 점수를 내고 합의로 최종 결정.
// "AI가 찍어서 샀다"가 아니라 "여러 관점이 합쳐진 설명 가능한 의사결정".
// AI는 매매를 직접 하지 않는다 → 편향(bias)을 산출해 검증된 전략에 전달.
import { detectRegime, type Regime } from './regime';
import { computeATRPct } from './dynamicSizing';

export type Vote = 'buy' | 'hold' | 'sell';

export interface MemberOpinion {
  id: string;
  name: string;
  role: string;
  icon: string;         // lucide 아이콘 이름
  color: string;
  vote: Vote;
  score: number;        // 0~100 확신도
  weight: number;       // 위원회 내 가중치
  rationale: string;    // 판단 근거 (설명 가능성)
}

export interface CommitteeInput {
  prices: number[];         // 최근 종가
  fearGreed?: number;       // 0~100
  strategyScore?: number;   // 대표 전략 점수 0~100
  macroBias?: number;       // -100~100 (거시 우호도, 옵션)
}

export interface CommitteeResult {
  members: MemberOpinion[];
  buyPct: number; holdPct: number; sellPct: number;
  decision: Vote;
  consensusStrength: number;   // 합의 강도 0~100 (의견 일치도)
  finalBias: number;           // -100(강한 매도) ~ +100(강한 매수)
  summary: string;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function voteFromBias(bias: number): Vote {
  if (bias >= 20) return 'buy';
  if (bias <= -20) return 'sell';
  return 'hold';
}

// ── 퀀트 AI: 기술적 국면 + 추세 강도 ──
function quantAI(input: CommitteeInput): MemberOpinion {
  const r = detectRegime(input.prices);
  let bias = 0, rationale = '';
  if (r.regime === 'TREND_UP') { bias = 40 + r.efficiency * 40; rationale = `상승 추세(ER ${(r.efficiency * 100).toFixed(0)}%) — 추세 추종 우호`; }
  else if (r.regime === 'TREND_DOWN') { bias = -(40 + r.efficiency * 40); rationale = `하락 추세(ER ${(r.efficiency * 100).toFixed(0)}%) — 매도/관망`; }
  else if (r.regime === 'RANGE') { bias = 0; rationale = '횡보 박스권 — 방향성 없음, 중립'; }
  else { bias = -15; rationale = '고변동성 — 리스크 확대, 신중'; }
  bias = clamp(bias, -100, 100);
  return { id: 'quant', name: '퀀트 AI', role: '기술적 분석·백테스트', icon: 'LineChart', color: '#0EA5E9',
    vote: voteFromBias(bias), score: Math.round(50 + Math.abs(bias) / 2), weight: 0.25, rationale };
}

// ── 시장심리 AI: Fear & Greed (역발상) ──
function sentimentAI(input: CommitteeInput): MemberOpinion {
  const fg = input.fearGreed ?? 50;
  // 역발상: 극단적 공포=매수 기회, 극단적 탐욕=경계
  let bias = 0, rationale = '';
  if (fg <= 25) { bias = 55; rationale = `극단적 공포(F&G ${fg}) — 역발상 매수 기회`; }
  else if (fg <= 45) { bias = 25; rationale = `공포(F&G ${fg}) — 저가 매수 우호`; }
  else if (fg <= 60) { bias = 0; rationale = `중립(F&G ${fg}) — 관망`; }
  else if (fg <= 80) { bias = -25; rationale = `탐욕(F&G ${fg}) — 과열 경계`; }
  else { bias = -50; rationale = `극단적 탐욕(F&G ${fg}) — 조정 위험, 차익실현`; }
  return { id: 'sentiment', name: '시장심리 AI', role: '뉴스·심리·F&G', icon: 'Users', color: '#EC4899',
    vote: voteFromBias(bias), score: Math.round(50 + Math.abs(bias) / 2), weight: 0.2, rationale };
}

// ── 거시경제 AI: 매크로 우호도 (금리/달러/VIX 종합, 옵션 입력) ──
function macroAI(input: CommitteeInput): MemberOpinion {
  // macroBias 미제공 시 변동성으로 근사 (고변동 = 매크로 불확실)
  const atrPct = computeATRPct(input.prices);
  const base = input.macroBias ?? clamp(30 - atrPct * 8, -60, 60);
  const rationale = input.macroBias != null
    ? `거시 우호도 ${base > 0 ? '+' : ''}${base.toFixed(0)} (금리·달러·VIX 종합)`
    : `변동성 ${atrPct.toFixed(1)}% 기반 매크로 추정 — ${base > 0 ? '안정적' : '불확실'}`;
  return { id: 'macro', name: '거시경제 AI', role: '금리·CPI·환율·VIX', icon: 'Globe', color: '#8B5CF6',
    vote: voteFromBias(base), score: Math.round(50 + Math.abs(base) / 2), weight: 0.2, rationale };
}

// ── 기업분석 AI: 전략 성과를 펀더멘털 대리지표로 (실배포 시 실적 데이터로 교체) ──
function fundamentalAI(input: CommitteeInput): MemberOpinion {
  const sc = input.strategyScore ?? 55;
  const bias = clamp((sc - 55) * 1.6, -60, 60);
  const rationale = `검증 전략 성과 ${sc}점 기반 — ${bias > 20 ? '우량' : bias < -20 ? '부진' : '보통'}`;
  return { id: 'fundamental', name: '기업분석 AI', role: '실적·재무·밸류에이션', icon: 'Building2', color: '#22C55E',
    vote: voteFromBias(bias), score: Math.round(50 + Math.abs(bias) / 2), weight: 0.2, rationale };
}

// ── 리스크 AI: 변동성/낙폭 관리 (항상 신중한 브레이크) ──
function riskAI(input: CommitteeInput): MemberOpinion {
  const atrPct = computeATRPct(input.prices);
  // 변동성 높으면 매도 편향(리스크 축소), 낮으면 소폭 매수 허용
  let bias = clamp(20 - atrPct * 10, -60, 30);
  const rationale = atrPct > 5
    ? `변동성 ${atrPct.toFixed(1)}% 과다 — 포지션 축소 권고`
    : atrPct < 2 ? `변동성 ${atrPct.toFixed(1)}% 안정 — 리스크 허용` : `변동성 ${atrPct.toFixed(1)}% 보통 — 표준 리스크`;
  return { id: 'risk', name: '리스크 AI', role: 'MDD·변동성·상관관계', icon: 'ShieldAlert', color: '#F59E0B',
    vote: voteFromBias(bias), score: Math.round(50 + Math.abs(bias) / 2), weight: 0.15, rationale };
}

export function convene(input: CommitteeInput): CommitteeResult {
  const members = [quantAI(input), sentimentAI(input), macroAI(input), fundamentalAI(input), riskAI(input)];

  // 가중 투표 집계
  let buyW = 0, holdW = 0, sellW = 0, biasSum = 0, wSum = 0;
  for (const m of members) {
    const conf = m.score / 100;
    const w = m.weight * conf;
    if (m.vote === 'buy') buyW += m.weight; else if (m.vote === 'sell') sellW += m.weight; else holdW += m.weight;
    // finalBias: 각 멤버의 방향×확신×가중
    const dir = m.vote === 'buy' ? 1 : m.vote === 'sell' ? -1 : 0;
    biasSum += dir * m.score * m.weight;
    wSum += m.weight;
  }
  const totalW = buyW + holdW + sellW || 1;
  const buyPct = Math.round((buyW / totalW) * 100);
  const sellPct = Math.round((sellW / totalW) * 100);
  const holdPct = 100 - buyPct - sellPct;
  const finalBias = Math.round(clamp(biasSum / (wSum || 1), -100, 100));
  const decision: Vote = buyPct >= 50 && buyPct >= sellPct ? 'buy' : sellPct >= 50 && sellPct > buyPct ? 'sell' : 'hold';

  // 합의 강도: 최다 의견 비중 (높을수록 의견 일치)
  const consensusStrength = Math.max(buyPct, holdPct, sellPct);
  const decLabel = decision === 'buy' ? '매수' : decision === 'sell' ? '매도' : '보유';
  const summary = `위원회 ${decLabel} 우세 (매수 ${buyPct}% · 보유 ${holdPct}% · 매도 ${sellPct}%), 합의 강도 ${consensusStrength}%`;

  return { members, buyPct, holdPct, sellPct, decision, consensusStrength, finalBias, summary };
}
