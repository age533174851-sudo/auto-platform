// src/lib/strategies/riskVeto.ts
// Risk Veto — 5v5 판정 위에 있는 심판.
//
// 왜 필요한가:
//   5개 축이 모두 LONG을 가리켜도, 진입하면 안 되는 상황이 있다.
//   FOMC 발표 30분 전에 100배로 들어가는 건 분석의 문제가 아니라 판단의 문제다.
//
// 원칙:
//   1. Veto는 진입을 "막기만" 한다. 없는 기회를 만들어내지 않는다.
//   2. 각 Veto는 독립적이다. 하나라도 걸리면 NO_TRADE.
//   3. NO_TRADE는 실패가 아니라 정상적인 결과다.
//   4. 사용자가 개별 Veto를 끌 수 있되, 끄면 그 위험을 감수한다는 걸 명시한다.

export type VetoCode =
  | 'HIGH_IMPACT_EVENT'      // 고영향 경제지표 임박 (차단)
  | 'MEDIUM_IMPACT_WARNING'  // 중간 영향 지표 (경고 전용)
  | 'CALENDAR_UNAVAILABLE'   // 경제 캘린더를 확인할 수 없음
  | 'VOLATILITY_DATA_MISSING' // 변동성 기준선을 계산할 수 없음
  | 'VOLATILITY_SPIKE'       // 변동성 급등
  | 'FUNDING_EXTREME'        // 펀딩비 극단 (청산 연쇄 위험)
  | 'LOW_LIQUIDITY'          // 거래량 급감
  | 'GAP_RISK'               // 직전 봉 갭 과대
  | 'RECENT_LIQUIDATION'     // 최근 청산 경험 (쿨다운)
  | 'CONSECUTIVE_LOSSES'     // 연속 손실
  | 'DATA_STALE';            // 데이터가 오래됨

export interface VetoRule {
  code: VetoCode;
  label: string;
  enabled: boolean;
  description: string;
}

export const DEFAULT_VETO_RULES: VetoRule[] = [
  { code: 'HIGH_IMPACT_EVENT', label: '고영향 지표 임박', enabled: true,
    description: 'FOMC·CPI 등 발표 전후에는 방향이 아니라 변동성이 지배합니다' },
  { code: 'MEDIUM_IMPACT_WARNING', label: '중간 지표 임박', enabled: true,
    description: '중간 영향 지표는 차단하지 않고 경고만 합니다' },
  { code: 'CALENDAR_UNAVAILABLE', label: '캘린더 확인 불가', enabled: true,
    description: '경제 일정을 확인할 수 없으면 고배율 진입을 막습니다 (fail-closed)' },
  { code: 'VOLATILITY_DATA_MISSING', label: '변동성 기준 없음', enabled: true,
    description: '변동성 기준선을 계산할 수 없으면 고배율 진입을 막습니다 (fail-closed)' },
  { code: 'VOLATILITY_SPIKE', label: '변동성 급등', enabled: true,
    description: '평소의 2배 이상 변동성에서는 손절이 무의미해집니다' },
  { code: 'FUNDING_EXTREME', label: '펀딩비 극단', enabled: true,
    description: '한쪽 쏠림이 심하면 청산 연쇄가 발생할 수 있습니다' },
  { code: 'LOW_LIQUIDITY', label: '유동성 부족', enabled: true,
    description: '거래량이 적으면 슬리피지가 손절 폭을 넘길 수 있습니다' },
  { code: 'GAP_RISK', label: '갭 위험', enabled: true,
    description: '직전 봉에 큰 갭이 있으면 손절이 건너뛰어질 수 있습니다' },
  { code: 'RECENT_LIQUIDATION', label: '청산 후 쿨다운', enabled: true,
    description: '청산 직후 재진입은 손실을 키우는 경우가 많습니다' },
  { code: 'CONSECUTIVE_LOSSES', label: '연속 손실', enabled: true,
    description: '연속으로 지고 있다면 시장이 전략과 맞지 않는 국면일 수 있습니다' },
  { code: 'DATA_STALE', label: '데이터 노후', enabled: true,
    description: '오래된 데이터로 판단하면 실제 시장과 어긋납니다' },
];

export interface VetoInput {
  // ── 진입하려는 방향 (펀딩 Veto가 방향을 고려하려면 필요) ──
  side?: 'LONG' | 'SHORT';

  // ── 경제 이벤트 ──
  // upcomingEvents는 UTC 타임스탬프로 계산된 것만 넣어야 한다.
  // 정적 MM-DD 데이터를 변환해 넣으면 실제 발표 시각과 어긋난다.
  upcomingEvents?: { event: string; impact: 'low' | 'medium' | 'high'; hoursUntil: number }[];
  eventWindowHours?: number;        // 이 시간 이내면 veto (기본 4)
  // 캘린더를 실제로 확인했는가. false면 CALENDAR_UNAVAILABLE로 차단(fail-closed).
  calendarAvailable?: boolean;
  calendarReason?: string;
  // 이 배율 이상에서만 캘린더 미확인을 차단한다 (저배율은 관대하게)
  calendarRequiredAboveLeverage?: number;   // 기본 5
  currentLeverage?: number;

  // 변동성
  currentAtrPct?: number;
  baselineAtrPct?: number;          // 평소 변동성 (rolling median 권장)
  volSpikeMultiple?: number;        // 기본 2.0
  // 기준선을 계산할 수 있었는가. false면 고배율에서 차단(fail-closed).
  volatilityDataAvailable?: boolean;
  volatilityReason?: string;
  volatilityRequiredAboveLeverage?: number;   // 기본 5

  // 파생
  fundingRate?: number;             // %
  fundingExtremeThreshold?: number; // 기본 0.08%

  // 유동성
  currentVolume?: number;
  avgVolume?: number;
  lowLiquidityRatio?: number;       // 기본 0.4 (평균의 40% 미만)

  // 갭
  gapPct?: number;                  // 직전 종가 대비 시가 갭 %
  maxGapPct?: number;               // 기본 3%

  // 계좌 상태
  hoursSinceLiquidation?: number;
  liquidationCooldownHours?: number;   // 기본 24
  consecutiveLosses?: number;
  maxConsecutiveLosses?: number;       // 기본 4

  // 데이터 신선도
  dataAgeMinutes?: number;
  maxDataAgeMinutes?: number;          // 기본 60
}

export interface VetoHit {
  code: VetoCode;
  label: string;
  reason: string;
  severity: 'block' | 'warn';
}

export interface VetoResult {
  vetoed: boolean;
  hits: VetoHit[];
  warnings: VetoHit[];
  checkedCount: number;
  summary: string;
}

export function evaluateVeto(input: VetoInput, rules: VetoRule[] = DEFAULT_VETO_RULES): VetoResult {
  const enabled = new Set(rules.filter(r => r.enabled).map(r => r.code));
  const label = (c: VetoCode) => rules.find(r => r.code === c)?.label ?? c;
  const hits: VetoHit[] = [];
  const warnings: VetoHit[] = [];
  let checked = 0;

  const push = (code: VetoCode, reason: string, severity: 'block' | 'warn' = 'block') => {
    const hit = { code, label: label(code), reason, severity };
    (severity === 'block' ? hits : warnings).push(hit);
  };

  // ⓪ 캘린더 확인 가능 여부 — fail-closed
  //    경제 일정을 모르는 상태에서 고배율 진입은 눈 감고 뛰는 것과 같다.
  if (enabled.has('CALENDAR_UNAVAILABLE')) {
    checked++;
    const lev = input.currentLeverage ?? 1;
    const threshold = input.calendarRequiredAboveLeverage ?? 5;
    if (input.calendarAvailable === false) {
      if (lev >= threshold) {
        push('CALENDAR_UNAVAILABLE',
          `경제 일정을 확인할 수 없습니다${input.calendarReason ? ` (${input.calendarReason})` : ''} — ${lev}배 진입은 차단합니다`);
      } else {
        push('CALENDAR_UNAVAILABLE',
          `경제 일정 미확인 — ${lev}배는 허용하되 주의가 필요합니다`, 'warn');
      }
    }
  }

  // ① 고영향 경제 이벤트 (차단)
  if (enabled.has('HIGH_IMPACT_EVENT') && input.upcomingEvents) {
    checked++;
    const win = input.eventWindowHours ?? 4;
    const near = input.upcomingEvents.filter(e => e.impact === 'high' && Math.abs(e.hoursUntil) <= win);
    if (near.length) {
      const e = near[0];
      const when = e.hoursUntil >= 0 ? `${e.hoursUntil.toFixed(1)}시간 후` : `${Math.abs(e.hoursUntil).toFixed(1)}시간 전 발표됨`;
      push('HIGH_IMPACT_EVENT', `${e.event} (${when}) — 발표 전후 ${win}시간은 진입하지 않습니다`);
    }
  }

  // ①-b 중간 영향 지표 (경고 전용 — 별도 코드로 분리해 로그 분석이 명확하게)
  if (enabled.has('MEDIUM_IMPACT_WARNING') && input.upcomingEvents) {
    checked++;
    const mid = input.upcomingEvents.filter(e => e.impact === 'medium' && Math.abs(e.hoursUntil) <= 2);
    if (mid.length) {
      push('MEDIUM_IMPACT_WARNING', `${mid[0].event} 임박 — 변동성 확대 가능`, 'warn');
    }
  }

  // ①-c 변동성 기준선 부재 — fail-closed
  if (enabled.has('VOLATILITY_DATA_MISSING')) {
    checked++;
    const lev = input.currentLeverage ?? 1;
    const th = input.volatilityRequiredAboveLeverage ?? 5;
    if (input.volatilityDataAvailable === false) {
      if (lev >= th) {
        push('VOLATILITY_DATA_MISSING',
          `변동성 기준선을 계산할 수 없습니다${input.volatilityReason ? ` (${input.volatilityReason})` : ''} — ${lev}배 진입은 차단합니다`);
      } else {
        push('VOLATILITY_DATA_MISSING',
          `변동성 기준선 없음 — ${lev}배는 허용하되 주의가 필요합니다`, 'warn');
      }
    }
  }

  // ② 변동성 급등
  if (enabled.has('VOLATILITY_SPIKE') && input.currentAtrPct != null && input.baselineAtrPct != null) {
    checked++;
    const mult = input.volSpikeMultiple ?? 2.0;
    if (input.baselineAtrPct > 0) {
      const ratio = input.currentAtrPct / input.baselineAtrPct;
      if (ratio >= mult) {
        push('VOLATILITY_SPIKE', `변동성이 평소의 ${ratio.toFixed(1)}배 (ATR ${input.currentAtrPct.toFixed(2)}% vs 평소 ${input.baselineAtrPct.toFixed(2)}%)`);
      } else if (ratio >= mult * 0.75) {
        push('VOLATILITY_SPIKE', `변동성 ${ratio.toFixed(1)}배 — 포지션 축소 권장`, 'warn');
      }
    }
  }

  // ③ 펀딩비 극단 — 진입 방향을 고려한다
  //    +펀딩 극단 = 롱 과밀 → LONG 진입은 위험(차단), SHORT 진입은 오히려 유리(경고만)
  if (enabled.has('FUNDING_EXTREME') && input.fundingRate != null) {
    checked++;
    const th = input.fundingExtremeThreshold ?? 0.08;
    const f = input.fundingRate;
    if (Math.abs(f) >= th) {
      const crowdedSide = f > 0 ? 'LONG' : 'SHORT';
      const fStr = `${f >= 0 ? '+' : ''}${f.toFixed(4)}%`;
      if (input.side == null) {
        // 방향을 모르면 보수적으로 차단
        push('FUNDING_EXTREME', `펀딩비 ${fStr} — ${crowdedSide === 'LONG' ? '롱' : '숏'} 과밀, 청산 연쇄 위험`);
      } else if (input.side === crowdedSide) {
        // 과밀한 쪽으로 들어가려 함 → 차단
        push('FUNDING_EXTREME',
          `펀딩비 ${fStr}로 ${crowdedSide === 'LONG' ? '롱' : '숏'}이 과밀한데 같은 방향 진입 — 청산 연쇄에 휩쓸릴 위험`);
      } else {
        // 반대 방향 → 오히려 유리한 정보, 경고만
        push('FUNDING_EXTREME',
          `펀딩비 ${fStr} (${crowdedSide === 'LONG' ? '롱' : '숏'} 과밀) — 반대 방향이라 스퀴즈 수혜 가능하나 변동성 주의`, 'warn');
      }
    }
  }

  // ④ 유동성 부족
  if (enabled.has('LOW_LIQUIDITY') && input.currentVolume != null && input.avgVolume != null) {
    checked++;
    const ratio = input.avgVolume > 0 ? input.currentVolume / input.avgVolume : 1;
    const th = input.lowLiquidityRatio ?? 0.4;
    if (ratio < th) {
      push('LOW_LIQUIDITY', `거래량이 평균의 ${(ratio * 100).toFixed(0)}% — 슬리피지가 손절 폭을 넘길 수 있습니다`);
    }
  }

  // ⑤ 갭 위험
  if (enabled.has('GAP_RISK') && input.gapPct != null) {
    checked++;
    const th = input.maxGapPct ?? 3;
    if (Math.abs(input.gapPct) >= th) {
      push('GAP_RISK', `직전 봉 갭 ${input.gapPct >= 0 ? '+' : ''}${input.gapPct.toFixed(2)}% — 손절이 건너뛰어질 수 있습니다`);
    }
  }

  // ⑥ 청산 후 쿨다운
  if (enabled.has('RECENT_LIQUIDATION') && input.hoursSinceLiquidation != null) {
    checked++;
    const cd = input.liquidationCooldownHours ?? 24;
    if (input.hoursSinceLiquidation < cd) {
      push('RECENT_LIQUIDATION', `${input.hoursSinceLiquidation.toFixed(1)}시간 전 청산 — ${cd}시간 쿨다운 중`);
    }
  }

  // ⑦ 연속 손실
  if (enabled.has('CONSECUTIVE_LOSSES') && input.consecutiveLosses != null) {
    checked++;
    const max = input.maxConsecutiveLosses ?? 4;
    if (input.consecutiveLosses >= max) {
      push('CONSECUTIVE_LOSSES', `연속 ${input.consecutiveLosses}회 손실 — 시장이 전략과 맞지 않는 국면일 수 있습니다`);
    } else if (input.consecutiveLosses >= max - 1) {
      push('CONSECUTIVE_LOSSES', `연속 ${input.consecutiveLosses}회 손실 — 다음 손실 시 중단됩니다`, 'warn');
    }
  }

  // ⑧ 데이터 노후
  if (enabled.has('DATA_STALE') && input.dataAgeMinutes != null) {
    checked++;
    const max = input.maxDataAgeMinutes ?? 60;
    if (input.dataAgeMinutes > max) {
      push('DATA_STALE', `데이터가 ${input.dataAgeMinutes.toFixed(0)}분 전 것 — 현재 시장과 어긋날 수 있습니다`);
    }
  }

  const vetoed = hits.length > 0;
  const summary = vetoed
    ? `${hits.length}개 조건에서 진입 차단: ${hits.map(h => h.label).join(', ')}`
    : warnings.length
      ? `진입 가능하지만 주의 ${warnings.length}건: ${warnings.map(w => w.label).join(', ')}`
      : `${checked}개 위험 조건 통과 — 진입 가능`;

  return { vetoed, hits, warnings, checkedCount: checked, summary };
}

/**
 * @deprecated 실거래에 사용하지 마세요.
 *
 * 이 함수는 'MM-DD' + 'HH:mm' 형식을 현재 연도 + UTC로 가정해 변환합니다.
 * 세 가지 문제가 있습니다:
 *   1. 연도가 없어 실제 일정과 다를 수 있음 (2026 CPI가 그 날짜라는 보장 없음)
 *   2. 시간대 미정의 — 21:30이 KST면 UTC 해석 시 9시간 오차
 *   3. 연말 경계 — 12/31에 01-02 이벤트를 보면 1년 전으로 계산
 *
 * Risk Veto에는 @/lib/calendar/econCalendar 의 upcomingFromCalendar()를 쓰세요.
 * 이 함수는 UI 데모 표시용으로만 남깁니다.
 */
export function toUpcomingEvents(
  events: { date: string; time: string; event: string; impact: string }[],
  now: Date = new Date(),
  year?: number
): { event: string; impact: 'low' | 'medium' | 'high'; hoursUntil: number }[] {
  const y = year ?? now.getUTCFullYear();
  const out: { event: string; impact: 'low' | 'medium' | 'high'; hoursUntil: number }[] = [];

  for (const e of events) {
    const m = /^(\d{2})-(\d{2})$/.exec(e.date || '');
    const tm = /^(\d{2}):(\d{2})$/.exec(e.time || '');
    if (!m || !tm) continue;
    const dt = Date.UTC(y, Number(m[1]) - 1, Number(m[2]), Number(tm[1]), Number(tm[2]));
    const hoursUntil = (dt - now.getTime()) / 3600000;
    // ±24시간 이내만
    if (Math.abs(hoursUntil) > 24) continue;
    const impact = (['low', 'medium', 'high'].includes(e.impact) ? e.impact : 'low') as 'low' | 'medium' | 'high';
    out.push({ event: e.event, impact, hoursUntil });
  }
  return out.sort((a, b) => Math.abs(a.hoursUntil) - Math.abs(b.hoursUntil));
}
