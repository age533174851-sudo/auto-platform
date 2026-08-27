// src/lib/engine/tradingPipeline.ts
// 실제 주문 파이프라인 — 부품들을 실행 경로로 연결한다.
//
//   Supabase econ_events
//        ↓ loadCalendar()
//   upcomingFromCalendar()
//        ↓
//   5v5 판정 (evaluateBattle)
//        ↓ evaluateVeto()  ← 캘린더 + 변동성 median + 펀딩 + 계좌 상태
//   BLOCK / PASS
//        ↓
//   Risk Manager (planPosition)
//        ↓
//   Order
//
// 이 모듈이 없으면 각 부품은 만들어져 있어도 실제로는 호출되지 않는다.
import { evaluateBattle, type BattleInput, type BattleResult } from '../strategies/dailyBattle';
import { evaluateVeto, type VetoInput, type VetoResult, type VetoRule } from '../strategies/riskVeto';
import { computeAtrBaseline } from '../strategies/volatilityBaseline';
import { buildExpansionGate } from '../strategies/expansionMode';
import { openLadderGate, releaseReservation, type LadderGateResult } from '../strategies/ladderGate';
import { loadCalendar, upcomingFromCalendar } from '../calendar/econCalendar';
import { planPosition, type PositionPlan, type RiskConfig } from './riskManager';
import type { StandardSignal } from './signalGateway';

export interface PipelineInput {
  symbol: string;
  // 일봉 데이터
  dailyCloses: number[];
  dailyHighs: number[];
  dailyLows: number[];
  dailyVolumes?: number[];
  // 시장 상태
  fearGreed?: number;
  fundingRate?: number;
  oiChangePct?: number;
  priceChangePct24h?: number;
  currentVolume?: number;
  avgVolume?: number;
  gapPct?: number;
  // 계좌 상태
  hoursSinceLiquidation?: number;
  consecutiveLosses?: number;
  dataAgeMinutes?: number;
  // 설정
  minMargin?: number;
  vetoRules?: VetoRule[];
  riskConfig: RiskConfig;
  strategyId?: string;
  bucket?: string;

  // ── 계단식 전략 게이트 ──
  // userId가 주어지면 하루 1회 제한과 사이클 상태를 DB에서 강제한다.
  // 주지 않으면 이 게이트를 건너뛴다 (기존 호출자 호환).
  userId?: string | null;
  /**
   * **이 진입이 나가는 연결.** 장부에 남겨야 청산 감시가 같은 계좌를
   * 다시 찾을 수 있다. 안 주면 감시는 활성 연결이 하나뿐일 때만 손댄다.
   */
  connectionId?: string | null;
  /** 거래소에서 조회한 확정 잔고. 계단 판정의 기준이 된다. */
  realizedEquity?: number;
  /** true면 게이트를 통과해도 예약만 하고 되돌린다 (미리보기·백테스트용) */
  ladderDryRun?: boolean;
}

export interface PipelineResult {
  stage: 'calendar' | 'battle' | 'veto' | 'risk' | 'approved';
  approved: boolean;

  // 각 단계 결과 (전부 보존 — 왜 막혔는지 추적 가능하게)
  calendar: {
    available: boolean;
    eventCount: number;
    upcomingHighImpact: number;
    reason?: string;
  };
  volatility: {
    currentAtrPct: number;
    baselineAtrPct: number;
    ratio: number;
    method: string;
    note: string;
  };
  battle: BattleResult | null;
  veto: VetoResult | null;
  plan: PositionPlan | null;
  /** 계단식 게이트 결과. userId를 주지 않으면 null (게이트를 건너뛴 것). */
  ladder?: LadderGateResult | null;

  reason: string;
  blockedBy?: string;
}

/**
 * 전체 파이프라인 실행.
 * DB 접근이 필요하므로 sb(Supabase admin client)를 받는다.
 */
export async function runTradingPipeline(sb: any, input: PipelineInput): Promise<PipelineResult> {
  // ── ① 경제 캘린더 로드 ──
  const { events, status } = await loadCalendar(sb);
  const upcoming = status.available ? upcomingFromCalendar(events, Date.now(), 24) : [];
  const highImpactNear = upcoming.filter(e => e.impact === 'high' && Math.abs(e.hoursUntil) <= 4).length;

  const calendarInfo = {
    available: status.available,
    eventCount: status.eventCount,
    upcomingHighImpact: highImpactNear,
    reason: status.reason,
  };

  // ── ② 변동성 기준선 (rolling median) ──
  const vol = computeAtrBaseline(input.dailyHighs, input.dailyLows, input.dailyCloses, { lookbackDays: 40 });
  const volatilityInfo = {
    currentAtrPct: vol.currentAtrPct,
    baselineAtrPct: vol.baselineAtrPct,
    ratio: vol.ratio,
    method: vol.method,
    note: vol.note,
  };

  const base = (stage: PipelineResult['stage'], reason: string, blockedBy?: string): PipelineResult => ({
    stage, approved: false,
    calendar: calendarInfo, volatility: volatilityInfo,
    battle: null, veto: null, plan: null,
    reason, blockedBy,
  });

  // ── ③ 5v5 판정 (Veto 없이 먼저 방향을 정한다) ──
  const battleInput: BattleInput = {
    dailyCloses: input.dailyCloses,
    dailyHighs: input.dailyHighs,
    dailyLows: input.dailyLows,
    dailyVolumes: input.dailyVolumes,
    fearGreed: input.fearGreed,
    fundingRate: input.fundingRate,
    openInterestChangePct: input.oiChangePct,
  };

  // 파생 실데이터가 있으면 주입
  if (input.fundingRate != null || input.oiChangePct != null) {
    try {
      const { analyzeDerivatives } = await import('../derivatives');
      const sig = analyzeDerivatives({
        symbol: input.symbol,
        fundingRate: input.fundingRate ?? null,
        nextFundingTime: null,
        openInterest: null, openInterestValue: null,
        oiChangePct24h: input.oiChangePct ?? null,
        priceChangePct24h: input.priceChangePct24h ?? null,
        markPrice: input.dailyCloses[input.dailyCloses.length - 1] ?? null,
        source: 'binance', fetchedAt: Date.now(),
      });
      battleInput.derivativesSignal = {
        longConfirmation: sig.longConfirmation,
        shortConfirmation: sig.shortConfirmation,
        patternLabel: sig.patternLabel,
        crowdingNote: sig.crowdingNote,
        reliability: sig.reliability,
      };
    } catch { /* 파생 없이 진행 */ }
  }

  const preBattle = evaluateBattle(battleInput, { minMargin: input.minMargin ?? 12 });

  if (preBattle.side === 'NO_TRADE') {
    const r = base('battle', preBattle.reason);
    r.battle = preBattle;
    return r;
  }

  // ── ④ Risk Veto (방향이 정해진 뒤 — 펀딩 Veto가 방향을 고려하려면 필요) ──
  const vetoInput: VetoInput = {
    side: preBattle.side,
    upcomingEvents: upcoming,
    calendarAvailable: status.available,
    calendarReason: status.reason,
    currentLeverage: input.riskConfig.maxLeverage,
    // ATR 기준선이 없으면 변동성 Veto가 검사되지 않는다 → 고배율에서는 fail-closed
    currentAtrPct: vol.method === 'median' ? vol.currentAtrPct : undefined,
    baselineAtrPct: vol.method === 'median' ? vol.baselineAtrPct : undefined,
    volatilityDataAvailable: vol.method === 'median',
    volatilityReason: vol.method === 'median' ? undefined : vol.note,
    volatilityRequiredAboveLeverage: 5,
    fundingRate: input.fundingRate,
    currentVolume: input.currentVolume,
    avgVolume: input.avgVolume,
    gapPct: input.gapPct,
    hoursSinceLiquidation: input.hoursSinceLiquidation,
    consecutiveLosses: input.consecutiveLosses,
    dataAgeMinutes: input.dataAgeMinutes,
  };

  // evaluateBattle을 Veto와 함께 다시 호출 — 판정과 Veto를 한 결과에 담기 위해
  const battle = evaluateBattle(battleInput, {
    minMargin: input.minMargin ?? 12,
    veto: vetoInput,
    vetoRules: input.vetoRules,
  });

  if (battle.side === 'NO_TRADE' && battle.veto?.vetoed) {
    const r = base('veto', battle.reason, battle.veto.hits.map(h => h.code).join(','));
    r.battle = battle;
    r.veto = battle.veto;
    return r;
  }

  // ── ⑤ Risk Manager ──
  const lastClose = input.dailyCloses[input.dailyCloses.length - 1];
  const stopPct = battle.suggestedStopPct ?? 1.5;
  const isLong = battle.side === 'LONG';
  const signal: StandardSignal = {
    strategyId: input.strategyId ?? 'daily-5v5',
    symbol: input.symbol,
    signal: battle.side as 'LONG' | 'SHORT',
    confidence: battle.confidence / 100,
    entryPrice: lastClose,
    stopLoss: isLong ? lastClose * (1 - stopPct / 100) : lastClose * (1 + stopPct / 100),
    takeProfit: battle.suggestedTpPct
      ? (isLong ? lastClose * (1 + battle.suggestedTpPct / 100) : lastClose * (1 - battle.suggestedTpPct / 100))
      : undefined,
    timeframe: '1d',
    timestamp: Date.now(),
    bucket: (input.bucket as any) ?? 'swing',
  };

  // ── Expansion Mode 게이트 ──
  // ②에서 이미 계산한 ATR 기준선을 재사용한다. 평가에 실패하면 result가
  // null로 오고, Risk Manager가 일반 모드 상한으로 제한한다(fail-closed).
  const expansionGate = buildExpansionGate({
    currentAtrPct: vol.method === 'median' ? vol.currentAtrPct : undefined,
    baselineAtrPct: vol.method === 'median' ? vol.baselineAtrPct : undefined,
    dailyHighs: input.dailyHighs,
    dailyLows: input.dailyLows,
    dailyCloses: input.dailyCloses,
    currentVolume: input.currentVolume,
    avgVolume: input.avgVolume,
    fundingRate: input.fundingRate,
    oiChangePct: input.oiChangePct,
  }, {
    userMaxLeverage: input.riskConfig.maxLeverage,
    normalMaxLeverage: input.riskConfig.normalMaxLeverage,
  });

  // ── 계단식 게이트 ──
  // 하루 1회 예약과 사이클 상태를 DB에서 확보한다. 예약은 Risk Manager보다
  // 먼저 잡는다 — 주문이 나간 뒤에 예약하면 그 사이에 두 번째 신호가 통과할
  // 수 있다. 대신 이후 단계에서 거부되면 반드시 예약을 되돌린다.
  let ladder: LadderGateResult | null = null;
  if (input.userId) {
    ladder = await openLadderGate(sb, {
      userId: input.userId,
      strategyId: input.strategyId,
      symbol: input.symbol,
      side: battle.side === 'SHORT' ? 'SHORT' : 'LONG',
      // **어느 계좌에서 여는지를 장부에 남긴다.** 안 남기면 청산 감시가
      // "그 사용자의 활성 연결 첫 줄"로 손절을 옮긴다 — 연결이 둘이면
      // Gate 포지션의 주문이 바이낸스로 나간다.
      connectionId: input.connectionId ?? null,
      realizedEquity: input.realizedEquity,
    });

    if (!ladder.allowed) {
      const r = base('risk', ladder.reason ?? '계단식 규칙 위반', ladder.rejectCode);
      r.battle = battle;
      r.veto = battle.veto ?? null;
      r.ladder = ladder;
      return r;
    }
  }

  const plan = planPosition(signal, {
    ...input.riskConfig,
    expansion: expansionGate.result,
    // 계단식 1회 증거금을 상한으로 넘긴다 (고정값이 아니라 상한)
    maxMargin: ladder?.margin ?? input.riskConfig.maxMargin,
  });

  if (!plan.approved || input.ladderDryRun) {
    // 진입하지 않으므로 오늘의 슬롯을 돌려준다. 이걸 빼먹으면 주문이 나가지
    // 않았는데도 그 날 하루가 소진된다.
    await releaseReservation(sb, ladder?.reservationId);
    if (!plan.approved) {
      const r = base('risk', plan.rejectReason ?? '위험 규칙 위반', plan.rejectCode);
      r.battle = battle;
      r.veto = battle.veto ?? null;
      r.plan = plan;
      r.ladder = ladder;
      return r;
    }
  }

  return {
    stage: 'approved', approved: true,
    calendar: calendarInfo, volatility: volatilityInfo,
    battle, veto: battle.veto ?? null, plan,
    reason: `${battle.side} 진입 승인 — ${plan.leverage}배 · 증거금 $${plan.requiredMargin.toFixed(0)} · 손절 ${plan.stopDistancePct.toFixed(2)}%`,
  };
}

/** 파이프라인 결과를 사람이 읽는 요약으로 */
export function describePipeline(r: PipelineResult): string[] {
  const lines: string[] = [];
  lines.push(`① 캘린더: ${r.calendar.available ? `${r.calendar.eventCount}건 로드 · 임박 고영향 ${r.calendar.upcomingHighImpact}건` : `사용 불가 (${r.calendar.reason ?? '이유 불명'})`}`);
  lines.push(`② 변동성: ${r.volatility.note}`);
  if (r.battle) {
    lines.push(`③ 5v5: LONG ${r.battle.longTotal.toFixed(0)} : ${r.battle.shortTotal.toFixed(0)} SHORT → ${r.battle.side}`);
  }
  if (r.veto) {
    lines.push(`④ Veto: ${r.veto.summary}`);
  }
  if (r.plan) {
    lines.push(r.plan.approved
      ? `⑤ Risk Manager: 승인 — ${r.plan.leverage}배, 수량 ${r.plan.quantity.toFixed(6)}`
      : `⑤ Risk Manager: 거부 — ${r.plan.rejectReason}`);
  }
  lines.push(`결과: ${r.approved ? '✅ 주문 진행' : `🚫 ${r.stage} 단계에서 중단`}`);
  return lines;
}

// ═══════════════════════════════════════════════════════════
// 외부 신호(TradingView 등)용 Veto 게이트
//
// 웹훅으로 들어오는 신호는 방향이 이미 정해져 있어 5v5 판정이 필요 없다.
// 하지만 Risk Veto는 반드시 통과해야 한다 — 그러지 않으면
// 외부 신호가 FOMC 30분 전에 100배 주문을 넣는 우회로가 된다.
// ═══════════════════════════════════════════════════════════

export interface SignalVetoInput {
  side: 'LONG' | 'SHORT';
  symbol: string;
  leverage: number;
  // 가격 히스토리 (있으면 변동성 기준선 계산)
  dailyHighs?: number[];
  dailyLows?: number[];
  dailyCloses?: number[];
  // 시장 상태
  fundingRate?: number;
  currentVolume?: number;
  avgVolume?: number;
  gapPct?: number;
  // 계좌 상태
  hoursSinceLiquidation?: number;
  consecutiveLosses?: number;
  dataAgeMinutes?: number;
  vetoRules?: VetoRule[];
}

export interface SignalVetoResult {
  allowed: boolean;
  veto: VetoResult;
  calendar: { available: boolean; eventCount: number; reason?: string };
  volatility: { available: boolean; currentAtrPct?: number; baselineAtrPct?: number; note: string };
  blockedBy?: string;
  reason: string;
}

/**
 * 외부 신호에 Risk Veto를 적용한다.
 * 웹훅 → 주문 경로에서 반드시 호출되어야 한다.
 */
export async function applyVetoToSignal(sb: any, input: SignalVetoInput): Promise<SignalVetoResult> {
  // ① 캘린더
  const { events, status } = await loadCalendar(sb);
  const upcoming = status.available ? upcomingFromCalendar(events, Date.now(), 24) : [];

  // ② 변동성 기준선 (가격 히스토리가 있을 때만)
  let volAvailable = false;
  let currentAtrPct: number | undefined;
  let baselineAtrPct: number | undefined;
  let volNote = '가격 히스토리가 제공되지 않아 변동성 기준선을 계산할 수 없습니다';

  if (input.dailyHighs?.length && input.dailyLows?.length && input.dailyCloses?.length) {
    const vol = computeAtrBaseline(input.dailyHighs, input.dailyLows, input.dailyCloses, { lookbackDays: 40 });
    volNote = vol.note;
    if (vol.method === 'median') {
      volAvailable = true;
      currentAtrPct = vol.currentAtrPct;
      baselineAtrPct = vol.baselineAtrPct;
    }
  }

  // ③ Veto
  const veto = evaluateVeto({
    side: input.side,
    upcomingEvents: upcoming,
    calendarAvailable: status.available,
    calendarReason: status.reason,
    currentLeverage: input.leverage,
    currentAtrPct, baselineAtrPct,
    volatilityDataAvailable: volAvailable,
    volatilityReason: volAvailable ? undefined : volNote,
    volatilityRequiredAboveLeverage: 5,
    fundingRate: input.fundingRate,
    currentVolume: input.currentVolume,
    avgVolume: input.avgVolume,
    gapPct: input.gapPct,
    hoursSinceLiquidation: input.hoursSinceLiquidation,
    consecutiveLosses: input.consecutiveLosses,
    dataAgeMinutes: input.dataAgeMinutes,
  }, input.vetoRules);

  return {
    allowed: !veto.vetoed,
    veto,
    calendar: { available: status.available, eventCount: status.eventCount, reason: status.reason },
    volatility: { available: volAvailable, currentAtrPct, baselineAtrPct, note: volNote },
    blockedBy: veto.vetoed ? veto.hits.map(h => h.code).join(',') : undefined,
    reason: veto.vetoed
      ? `외부 신호(${input.side})가 위험 규칙에 의해 차단됨 — ${veto.hits.map(h => h.label).join(', ')}`
      : `Veto ${veto.checkedCount}개 조건 통과`,
  };
}
