// src/lib/strategies/profileRisk.ts
// 프로필별(스캘핑/스윙) 리스크 상태를 완전히 격리해서 추적.
// 각 전략 계좌의 누적손익·최고자산(peak)·MDD·오늘 손실·킬스위치를 독립 관리.
// localStorage 키를 profileId로 네임스페이스 → 서로 간섭 없음.

import type { StrategyType } from './profiles';
import { getProfile } from './profiles';

export interface ProfileRiskState {
  profileId:    StrategyType;
  realizedPnL:  number;   // 누적 실현손익 (KRW)
  peakEquity:   number;   // 최고 자산 (MDD 계산용)
  equity:       number;   // 현재 자산 (시드 + 실현손익)
  maxDrawdown:  number;   // 최대 낙폭 (%, 양수)
  dayKey:       string;   // 오늘 날짜 (YYYY-MM-DD)
  dayStartEquity: number; // 오늘 시작 자산
  dayPnL:       number;   // 오늘 손익
  killed:       boolean;  // 프로필 킬스위치 발동 여부
  killedReason?: string;
  tradeCount:   number;
  winCount:     number;
}

const SEED = 10_000_000;   // 프로필당 모의 시드 (분리 계좌 가정)
const key = (id: StrategyType) => `tg_profile_risk_${id}_v1`;
const todayKey = () => new Date().toISOString().slice(0, 10);

function fresh(id: StrategyType): ProfileRiskState {
  return {
    profileId: id, realizedPnL: 0, peakEquity: SEED, equity: SEED,
    maxDrawdown: 0, dayKey: todayKey(), dayStartEquity: SEED, dayPnL: 0,
    killed: false, tradeCount: 0, winCount: 0,
  };
}

export function loadProfileRisk(id: StrategyType): ProfileRiskState {
  if (typeof window === 'undefined') return fresh(id);
  try {
    const raw = window.localStorage.getItem(key(id));
    if (!raw) return fresh(id);
    const s = JSON.parse(raw) as ProfileRiskState;
    // 날짜 바뀌면 일손익 리셋
    if (s.dayKey !== todayKey()) {
      s.dayKey = todayKey(); s.dayStartEquity = s.equity; s.dayPnL = 0;
      // 새 날에는 킬스위치 자동 해제 (일손실 기반이었다면)
      if (s.killed && s.killedReason?.includes('일손실')) { s.killed = false; s.killedReason = undefined; }
    }
    return s;
  } catch { return fresh(id); }
}

function save(s: ProfileRiskState) {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(key(s.profileId), JSON.stringify(s)); } catch {}
}

// 트레이드 청산 결과를 프로필 계좌에 반영 → MDD/일손실/킬스위치 갱신
export function recordProfileTrade(id: StrategyType, pnl: number): ProfileRiskState {
  const s = loadProfileRisk(id);
  s.realizedPnL += pnl;
  s.equity = SEED + s.realizedPnL;
  s.dayPnL = s.equity - s.dayStartEquity;
  s.tradeCount += 1;
  if (pnl > 0) s.winCount += 1;

  if (s.equity > s.peakEquity) s.peakEquity = s.equity;
  const dd = s.peakEquity > 0 ? (s.peakEquity - s.equity) / s.peakEquity * 100 : 0;
  if (dd > s.maxDrawdown) s.maxDrawdown = dd;

  // 일손실 한도 초과 → 이 프로필만 킬스위치 (다른 프로필은 영향 없음)
  const prof = getProfile(id);
  const dayLossPct = s.dayStartEquity > 0 ? (s.dayStartEquity - s.equity) / s.dayStartEquity * 100 : 0;
  if (dayLossPct >= prof.dailyLossLimitPct) {
    s.killed = true;
    s.killedReason = `일손실 한도 초과 (-${dayLossPct.toFixed(1)}% ≥ ${prof.dailyLossLimitPct}%)`;
  }
  save(s);
  return s;
}

// 신규 진입 가능 여부 (프로필 킬스위치 확인) — 다른 프로필과 독립
export function canProfileEnter(id: StrategyType): { allowed: boolean; reason?: string } {
  const s = loadProfileRisk(id);
  if (s.killed) return { allowed: false, reason: s.killedReason || '프로필 킬스위치 발동' };
  return { allowed: true };
}

export function resetProfileKill(id: StrategyType): ProfileRiskState {
  const s = loadProfileRisk(id);
  s.killed = false; s.killedReason = undefined;
  save(s);
  return s;
}

export function resetProfileRisk(id: StrategyType): ProfileRiskState {
  const s = fresh(id); save(s); return s;
}

export function winRate(s: ProfileRiskState): number {
  return s.tradeCount > 0 ? (s.winCount / s.tradeCount) * 100 : 0;
}
