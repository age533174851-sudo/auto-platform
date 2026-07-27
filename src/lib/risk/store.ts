// src/lib/risk/store.ts
// 글로벌 리스크 설정 (사용자 책임 · 경고+동의+기록 방식)
//
// 설계 원칙:
// - 기본은 안전. 사용자가 명시적으로 OFF하거나 모드를 바꿔야 위험해짐.
// - 강제 차단보다 "경고 + 동의 + 기록" — 사용자 선택권 우선.
// - "제한 없음" 모드는 UI에 빨간색 위험 표시 + 자동매매 실행 전 1회 확인 필수.

export type RiskMode = 'safe' | 'standard' | 'aggressive' | 'unlimited';

export interface RiskSettings {
  mode:                  RiskMode;
  safetyEnabled:         boolean;   // 안전장치 마스터 스위치
  // 한도값 — null = 제한 없음
  dailyMaxLossKRW:       number | null;
  maxDrawdownPct:        number | null;
  maxLeverage:           number;
  maxOpenPositions:      number;
  consecutiveLossLimit:  number;
  cooldownMinutes:       number;
  killSwitchEnabled:     boolean;
  // 메타
  updatedAt:             number;
  acknowledgedUnsafe?:   number;     // unlimited 모드 동의 시각
}

export interface RiskHistoryEntry {
  id:        string;
  at:        number;
  field:     string;     // e.g. "maxLeverage" or "mode"
  fromVal:   string;
  toVal:     string;
  modeAt:    RiskMode;
}

// ── 4단계 프리셋 ──────────────────────────────────────────────
export const RISK_PRESETS: Record<RiskMode, Omit<RiskSettings, 'updatedAt'|'acknowledgedUnsafe'>> = {
  safe: {
    mode: 'safe',
    safetyEnabled:        true,
    dailyMaxLossKRW:      100_000,
    maxDrawdownPct:       5,
    maxLeverage:          2,
    maxOpenPositions:     2,
    consecutiveLossLimit: 2,
    cooldownMinutes:      120,
    killSwitchEnabled:    true,
  },
  standard: {
    mode: 'standard',
    safetyEnabled:        true,
    dailyMaxLossKRW:      1_000_000,
    maxDrawdownPct:       15,
    maxLeverage:          10,
    maxOpenPositions:     5,
    consecutiveLossLimit: 3,
    cooldownMinutes:      60,
    killSwitchEnabled:    true,
  },
  aggressive: {
    mode: 'aggressive',
    safetyEnabled:        true,
    dailyMaxLossKRW:      5_000_000,
    maxDrawdownPct:       30,
    maxLeverage:          25,
    maxOpenPositions:     10,
    consecutiveLossLimit: 5,
    cooldownMinutes:      30,
    killSwitchEnabled:    true,
  },
  unlimited: {
    mode: 'unlimited',
    safetyEnabled:        false,
    dailyMaxLossKRW:      null,
    maxDrawdownPct:       null,
    maxLeverage:          125,
    maxOpenPositions:     20,
    consecutiveLossLimit: 10,
    cooldownMinutes:      5,
    killSwitchEnabled:    true,    // kill switch는 사용자가 끄지 않는 한 항상 ON 기본
  },
};

export const MODE_LABEL: Record<RiskMode, { label: string; sub: string; color: string }> = {
  safe:       { label: '안전 모드',  sub: '소액 / 저레버리지 / 강한 보호', color: '#10B981' },
  standard:   { label: '기본 모드',  sub: '일반 사용자 권장 설정',          color: '#60A5FA' },
  aggressive: { label: '고위험 모드', sub: '큰 변동성 감내 가능 사용자',     color: '#F59E0B' },
  unlimited:  { label: '제한 없음',   sub: '사용자 전적 책임 · 권장 안 함',  color: '#EF4444' },
};

const SETTINGS_KEY = 'tg_risk_settings_v1';
const HISTORY_KEY  = 'tg_risk_history_v1';
const HISTORY_MAX  = 50;

export function getDefaultSettings(): RiskSettings {
  return { ...RISK_PRESETS.standard, updatedAt: Date.now() };
}

export function loadSettings(): RiskSettings {
  if (typeof window === 'undefined') return getDefaultSettings();
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return getDefaultSettings();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return getDefaultSettings();
    // 부분 누락 필드 채워주기 (기본 모드 기준)
    return { ...getDefaultSettings(), ...parsed };
  } catch { return getDefaultSettings(); }
}

export function saveSettings(s: RiskSettings): RiskSettings {
  if (typeof window === 'undefined') return s;
  const next = { ...s, updatedAt: Date.now() };
  try { window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch {}
  return next;
}

export function applyPreset(mode: RiskMode, prev: RiskSettings): { next: RiskSettings; entries: RiskHistoryEntry[] } {
  const presetBase = RISK_PRESETS[mode];
  const next: RiskSettings = {
    ...presetBase,
    updatedAt: Date.now(),
    acknowledgedUnsafe: mode === 'unlimited' ? Date.now() : undefined,
  };
  const entries = diffEntries(prev, next, prev.mode);
  return { next, entries };
}

// 두 설정 사이의 차이를 히스토리 항목으로 만든다
export function diffEntries(prev: RiskSettings, next: RiskSettings, modeAt: RiskMode): RiskHistoryEntry[] {
  const fields: Array<keyof RiskSettings> = [
    'mode','safetyEnabled','dailyMaxLossKRW','maxDrawdownPct','maxLeverage',
    'maxOpenPositions','consecutiveLossLimit','cooldownMinutes','killSwitchEnabled',
  ];
  const out: RiskHistoryEntry[] = [];
  for (const f of fields) {
    const a = String(prev[f] ?? '');
    const b = String(next[f] ?? '');
    if (a !== b) {
      out.push({
        id:      `${Date.now()}-${f}`,
        at:      Date.now(),
        field:   String(f),
        fromVal: a === 'null' ? '제한 없음' : a,
        toVal:   b === 'null' ? '제한 없음' : b,
        modeAt,
      });
    }
  }
  return out;
}

export function loadHistory(): RiskHistoryEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(-HISTORY_MAX) : [];
  } catch { return []; }
}

export function appendHistory(entries: RiskHistoryEntry[]): void {
  if (typeof window === 'undefined' || entries.length === 0) return;
  try {
    const cur = loadHistory();
    const next = [...cur, ...entries].slice(-HISTORY_MAX);
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {}
}

// 안전한 값 클램프 (현실적 상한)
export function clampSetting(s: RiskSettings): RiskSettings {
  return {
    ...s,
    maxLeverage:          Math.max(1,   Math.min(125, Number(s.maxLeverage) || 1)),
    maxOpenPositions:     Math.max(1,   Math.min(50,  Number(s.maxOpenPositions) || 1)),
    consecutiveLossLimit: Math.max(1,   Math.min(20,  Number(s.consecutiveLossLimit) || 1)),
    cooldownMinutes:      Math.max(0,   Math.min(1440, Number(s.cooldownMinutes) || 0)),
    dailyMaxLossKRW:      s.dailyMaxLossKRW === null ? null
                          : Math.max(1, Number(s.dailyMaxLossKRW) || 100_000),
    maxDrawdownPct:       s.maxDrawdownPct === null ? null
                          : Math.max(0.5, Math.min(100, Number(s.maxDrawdownPct) || 15)),
  };
}

// 라벨 (변경이력 표시용)
export const FIELD_LABEL: Record<string, string> = {
  mode:                 '모드',
  safetyEnabled:        '안전장치',
  dailyMaxLossKRW:      '일일 최대 손실',
  maxDrawdownPct:       '최대 드로다운',
  maxLeverage:          '최대 레버리지',
  maxOpenPositions:     '최대 동시 거래',
  consecutiveLossLimit: '연속 손실 한도',
  cooldownMinutes:      '쿨다운 시간',
  killSwitchEnabled:    '긴급정지 활성',
};
