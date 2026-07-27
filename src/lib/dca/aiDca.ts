// src/lib/dca/aiDca.ts
// AI DCA — 공포·탐욕 지수(F&G)에 따라 적립액을 자동 스케일.
// 평소(중립) 기본액, 공포일수록 증액(최대), 탐욕일수록 감액.
export interface DcaTier { max: number; mult: number; label: string; color: string }

// 기본 배수 구간 (F&G 0~100). max 이하이면 해당 배수.
export const DEFAULT_TIERS: DcaTier[] = [
  { max: 20,  mult: 3.0,  label: '극단적 공포', color: '#EF4444' },
  { max: 40,  mult: 1.75, label: '공포',        color: '#F59E0B' },
  { max: 60,  mult: 1.0,  label: '중립',        color: '#64748B' },
  { max: 80,  mult: 0.5,  label: '탐욕',        color: '#10B981' },
  { max: 100, mult: 0.25, label: '극단적 탐욕', color: '#22C55E' },
];

const CFG_KEY = 'tg_ai_dca_cfg_v1';

export interface AiDcaConfig {
  baseAmount: number;      // 평소(중립) 1회 적립액
  frequency: 'daily' | 'weekly' | 'monthly';
  symbol: string;
  tiers: DcaTier[];
}

export const DEFAULT_CFG: AiDcaConfig = {
  baseAmount: 100000,
  frequency: 'weekly',
  symbol: 'BTC',
  tiers: DEFAULT_TIERS,
};

export function loadAiDcaCfg(): AiDcaConfig {
  if (typeof window === 'undefined') return DEFAULT_CFG;
  try {
    const raw = window.localStorage.getItem(CFG_KEY);
    if (raw) { const p = JSON.parse(raw); return { ...DEFAULT_CFG, ...p, tiers: Array.isArray(p.tiers) && p.tiers.length ? p.tiers : DEFAULT_TIERS }; }
  } catch {}
  return DEFAULT_CFG;
}

export function saveAiDcaCfg(cfg: AiDcaConfig) {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch {}
}

// 현재 F&G에 해당하는 구간 반환
export function tierForFng(fng: number, tiers: DcaTier[] = DEFAULT_TIERS): DcaTier {
  for (const t of tiers) if (fng <= t.max) return t;
  return tiers[tiers.length - 1];
}

// 이번 회차 매수액 = 기본액 × 배수 (100원 단위 반올림)
export function computeBuyAmount(baseAmount: number, fng: number, tiers: DcaTier[] = DEFAULT_TIERS): number {
  const t = tierForFng(fng, tiers);
  return Math.round((baseAmount * t.mult) / 100) * 100;
}

export const FREQ_LABEL: Record<string, string> = { daily: '매일', weekly: '매주', monthly: '매월' };
