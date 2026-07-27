// src/lib/strategies/ruleEngine.ts
// 규칙 엔진 — AI/신호는 "방향·국면"만, 리스크 파라미터는 여기서 소유·강제한다.
// buildOrder(signal, profile, equity): 프로필 한도 안에서 clamp된 안전한 주문 스펙 생성.
// 핵심 원칙: 레버리지 상한 clamp, 수량은 riskPercent로 산출, SL 필수, isolated 강제(스캘핑).

import type { StrategyProfile, MarginMode, OrderType } from './profiles';

// AI/외부 신호가 낼 수 있는 것 — 방향·국면·신뢰도·(선택)희망 레버리지뿐. 가격/수량/SL 없음.
export interface Signal {
  bias: 'long' | 'short' | 'flat';
  confidence?: number;          // 0~1
  desiredLeverage?: number;     // AI가 제안(참고용) — 절대 그대로 안 씀, clamp 대상
  desiredMarginMode?: MarginMode;
  aiSource?: string;            // 'claude' | 'gpt' | 'gemini' | 'grok' | 'rule' 등
}

export interface OrderSpec {
  side: 'long' | 'short';
  leverage: number;             // clamp된 최종 레버리지
  marginMode: MarginMode;       // 프로필 허용값 내
  orderType: OrderType;
  notionalKRW: number;          // 명목 규모 (= 증거금 × 레버리지)
  marginKRW: number;            // 실제 투입 증거금
  quantityHint: number;         // 참고 수량 (가격 있으면 notional/price)
  takeProfitPct: number;
  stopLossPct: number;          // 항상 > 0 보장
  timeoutSec: number;
  maxHoldSec: number;
  clamps: string[];             // 어떤 값이 왜 제한됐는지 기록 (투명성/감사)
}

export interface BuildOrderInput {
  signal: Signal;
  profile: StrategyProfile;
  equityKRW: number;            // 이 전략 계좌의 가용 자산
  price?: number;               // 있으면 수량까지 계산
}

export type BuildOrderResult =
  | { ok: true; order: OrderSpec }
  | { ok: false; reason: string };

const clampNum = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

export function buildOrder(input: BuildOrderInput): BuildOrderResult {
  const { signal, profile, equityKRW, price } = input;
  const clamps: string[] = [];

  if (signal.bias === 'flat') return { ok: false, reason: '신호 flat — 진입 안 함' };
  if (!(equityKRW > 0))       return { ok: false, reason: '가용 자산 없음' };

  // 1) 레버리지: AI 제안이 있어도 프로필 상한으로 clamp
  let leverage = signal.desiredLeverage ?? profile.leverage;
  if (leverage > profile.maxLeverage) {
    clamps.push(`레버리지 ${leverage}→${profile.maxLeverage}x (프로필 상한)`);
    leverage = profile.maxLeverage;
  }
  if (leverage < 1) { clamps.push(`레버리지 ${leverage}→1x (최소)`); leverage = 1; }
  leverage = Math.floor(leverage);

  // 2) 마진 모드: 프로필 허용 목록 내에서만. 미허용이면 기본값으로 강제
  let marginMode: MarginMode = signal.desiredMarginMode ?? profile.marginModes[0];
  if (!profile.marginModes.includes(marginMode)) {
    clamps.push(`마진모드 ${marginMode}→${profile.marginModes[0]} (프로필 미허용)`);
    marginMode = profile.marginModes[0];
  }

  // 3) 투입 증거금: riskPercent 기반. 손절 도달 시 손실이 자산의 riskPercent% 이내가 되도록.
  //    손실 ≈ margin × leverage × (stopLossPct/100). 이게 equity × (riskPercent/100) 이하가 되게 margin 산출.
  const riskKRW = equityKRW * (profile.riskPercentPerTrade / 100);
  const lossPerMarginUnit = leverage * (profile.stopLossPct / 100);   // 증거금 1원당 예상 손실
  let marginKRW = lossPerMarginUnit > 0 ? riskKRW / lossPerMarginUnit : equityKRW * 0.01;

  // 4) 명목/증거금 상한: 전략 배정 자산(maxPortfolioPct) 초과 금지
  const maxMargin = equityKRW * (profile.maxPortfolioPct / 100);
  if (marginKRW > maxMargin) {
    clamps.push(`증거금 상한 적용 (전략 배정 ${profile.maxPortfolioPct}%)`);
    marginKRW = maxMargin;
  }
  if (marginKRW <= 0) return { ok: false, reason: '산출 증거금 0' };

  const notionalKRW = marginKRW * leverage;

  // 5) 손절 필수 — 0이면 진입 거부 (AI가 SL 빼먹어도 엔진이 막음)
  const stopLossPct = profile.stopLossPct;
  if (!(stopLossPct > 0)) return { ok: false, reason: '손절(SL)이 설정되지 않음 — 진입 금지' };

  const order: OrderSpec = {
    side: signal.bias,
    leverage,
    marginMode,
    orderType: profile.orderType,
    notionalKRW: Math.round(notionalKRW),
    marginKRW: Math.round(marginKRW),
    quantityHint: price && price > 0 ? notionalKRW / price : 0,
    takeProfitPct: profile.takeProfitPct,
    stopLossPct,
    timeoutSec: profile.timeoutSec,
    maxHoldSec: profile.maxHoldSec,
    clamps,
  };
  return { ok: true, order };
}
