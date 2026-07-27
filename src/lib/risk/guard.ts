// src/lib/risk/guard.ts
// 자동매매 엔진의 안전 가드
//
// 시그널 발생 → paperBuy/Sell 직전에 호출
// 한도 도달 시 활성 전략 전체 disable + 로그

import { loadSettings } from './store';
import type { ExecutionLog } from '@/lib/autotrade/types';

const TODAY_PNL_KEY    = 'tg_today_pnl_v1';        // { date: 'YYYY-MM-DD', pnl: number }
const CONSEC_LOSSES_KEY = 'tg_consec_losses_v1';   // number
const COOLDOWN_UNTIL_KEY = 'tg_autotrade_cooldown_until_v1';  // timestamp

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// ─── 오늘의 PnL 추적 ─────────────────────────────────────────
interface TodayPnL { date: string; pnl: number; trades: number; }

export function getTodayPnL(): TodayPnL {
  if (typeof window === 'undefined') return { date: todayStr(), pnl: 0, trades: 0 };
  try {
    const raw = window.localStorage.getItem(TODAY_PNL_KEY);
    if (!raw) return { date: todayStr(), pnl: 0, trades: 0 };
    const parsed = JSON.parse(raw);
    if (parsed?.date === todayStr()) {
      return {
        date:   parsed.date,
        pnl:    typeof parsed.pnl    === 'number' ? parsed.pnl    : 0,
        trades: typeof parsed.trades === 'number' ? parsed.trades : 0,
      };
    }
    // 날짜 바뀌었으면 리셋
    return { date: todayStr(), pnl: 0, trades: 0 };
  } catch { return { date: todayStr(), pnl: 0, trades: 0 }; }
}

export function recordTradePnL(pnl: number): TodayPnL {
  if (typeof window === 'undefined') return { date: todayStr(), pnl: 0, trades: 0 };
  const cur = getTodayPnL();
  const next: TodayPnL = {
    date:   todayStr(),
    pnl:    cur.pnl + pnl,
    trades: cur.trades + 1,
  };
  try { window.localStorage.setItem(TODAY_PNL_KEY, JSON.stringify(next)); } catch {}
  return next;
}

export function resetTodayPnL(): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(TODAY_PNL_KEY, JSON.stringify({ date: todayStr(), pnl: 0, trades: 0 })); } catch {}
}

// ─── 연속 손실 카운터 ────────────────────────────────────────
export function getConsecutiveLosses(): number {
  if (typeof window === 'undefined') return 0;
  try {
    const raw = window.localStorage.getItem(CONSEC_LOSSES_KEY);
    return raw ? Math.max(0, parseInt(raw, 10)) : 0;
  } catch { return 0; }
}

export function recordTradeResult(pnl: number): number {
  if (typeof window === 'undefined') return 0;
  const cur = getConsecutiveLosses();
  const next = pnl < 0 ? cur + 1 : 0;        // 손실이면 +1, 익절이면 리셋
  try { window.localStorage.setItem(CONSEC_LOSSES_KEY, String(next)); } catch {}
  return next;
}

// ─── 쿨다운 ──────────────────────────────────────────────────
export function getCooldownUntil(): number {
  if (typeof window === 'undefined') return 0;
  try {
    const raw = window.localStorage.getItem(COOLDOWN_UNTIL_KEY);
    return raw ? parseInt(raw, 10) : 0;
  } catch { return 0; }
}

export function setCooldown(minutes: number): number {
  if (typeof window === 'undefined') return 0;
  const until = Date.now() + minutes * 60_000;
  try { window.localStorage.setItem(COOLDOWN_UNTIL_KEY, String(until)); } catch {}
  return until;
}

export function clearCooldown(): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.removeItem(COOLDOWN_UNTIL_KEY); } catch {}
}

// ─── 가드 체크 — 시그널 평가 전 호출 ─────────────────────
export interface GuardResult {
  pass:        boolean;
  reason?:     string;
  shouldDisable: boolean;
  // 추가 정보
  todayPnL:    number;
  todayLimit:  number | null;
  consecutive: number;
  consecutiveLimit: number;
  cooldownUntil: number;
}

export function checkRiskGuard(): GuardResult {
  const settings  = loadSettings();
  const today     = getTodayPnL();
  const consec    = getConsecutiveLosses();
  const cooldownU = getCooldownUntil();

  const base: Omit<GuardResult,'pass'|'shouldDisable'|'reason'> = {
    todayPnL:    today.pnl,
    todayLimit:  settings.dailyMaxLossKRW,
    consecutive: consec,
    consecutiveLimit: settings.consecutiveLossLimit,
    cooldownUntil: cooldownU,
  };

  // 안전장치 OFF면 가드 통과 (사용자 책임)
  if (!settings.safetyEnabled) {
    return { ...base, pass: true, shouldDisable: false };
  }

  // 쿨다운 중
  if (cooldownU > Date.now()) {
    const min = Math.ceil((cooldownU - Date.now()) / 60_000);
    return {
      ...base,
      pass: false,
      shouldDisable: false,    // 쿨다운은 자동매매 전체 disable이 아니라 일시정지
      reason: `쿨다운 중 (${min}분 남음)`,
    };
  }

  // 일일 손실 한도
  if (settings.dailyMaxLossKRW != null && today.pnl <= -settings.dailyMaxLossKRW) {
    return {
      ...base,
      pass: false,
      shouldDisable: true,
      reason: `일일 손실 한도 도달 (오늘 ${Math.floor(today.pnl).toLocaleString('ko-KR')}원 / 한도 -${settings.dailyMaxLossKRW.toLocaleString('ko-KR')}원)`,
    };
  }

  // 연속 손실 한도
  if (consec >= settings.consecutiveLossLimit) {
    // 연속 손실은 쿨다운 시작 (전체 disable 아님)
    setCooldown(settings.cooldownMinutes);
    return {
      ...base,
      pass: false,
      shouldDisable: false,
      reason: `연속 ${consec}회 손실 — ${settings.cooldownMinutes}분 쿨다운 시작`,
      cooldownUntil: Date.now() + settings.cooldownMinutes * 60_000,
    };
  }

  return { ...base, pass: true, shouldDisable: false };
}

// ─── 일일 한도 도달 시: 활성 전략 모두 비활성화 ────────────
export async function autoDisableAllStrategies(reason: string): Promise<void> {
  if (typeof window === 'undefined') return;
  try {
    const { listStrategies, toggleEnabled } = await import('@/lib/strategies/store');
    const active = listStrategies().filter(s => s.enabled);
    active.forEach(s => toggleEnabled(s.id, false));

    // 알림
    if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification('TRAIGO — 자동매매 정지', {
          body: reason,
          icon: '/icon-192.png',
        });
      } catch {}
    }
  } catch { /* best-effort */ }
}
