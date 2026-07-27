// src/lib/autotrade/allocation.ts
// AI 자산배분 — 투자위원회 bias를 받아 장기/단기/현금 비중을 자동 조정.
// 강세(bias+) → 공격적(장기·단기↑, 현금↓), 약세/폭락위험(bias−) → 방어적(현금↑).
// "AI는 매매하지 않는다" 원칙: 배분 목표만 제시, 실제 이동은 검증된 전략이 수행.

export interface AllocInput {
  totalAsset: number;      // 총 자산 (원)
  committeeBias: number;   // -100 ~ +100 (위원회 finalBias)
  consensus: number;       // 0~100 (합의 강도)
  crashRisk?: boolean;     // 폭락 위험 플래그 (옵션)
}

export interface AllocBucket { key: 'long' | 'short' | 'cash'; label: string; pct: number; amount: number; color: string; desc: string }

export interface AllocResult {
  buckets: AllocBucket[];
  stance: '공격적' | '중립적' | '방어적';
  stanceColor: string;
  rationale: string;
  shift: string;           // 기준(60/30/10) 대비 변화 설명
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// 기준(중립) 배분: 장기 60 / 단기 30 / 현금 10
const BASE = { long: 60, short: 30, cash: 10 };

export function computeAllocation(input: AllocInput): AllocResult {
  const { totalAsset, committeeBias, consensus, crashRisk } = input;

  // bias를 -1~+1로 정규화하고 합의 강도로 스케일 (합의 약하면 조정 폭 축소)
  const b = clamp(committeeBias / 100, -1, 1) * clamp(consensus / 100, 0.3, 1);

  // 강세일수록 장기·단기↑ 현금↓, 약세일수록 반대
  let long = BASE.long + b * 12;      // 최대 ±12%p
  let short = BASE.short + b * 10;    // 최대 ±10%p
  let cash = 100 - long - short;

  // 폭락 위험 시 방어 강화 (현금 +10, 단기 −)
  if (crashRisk) { cash += 12; short -= 8; long -= 4; }

  // 하한/상한 클램프
  long = clamp(long, 30, 75);
  short = clamp(short, 5, 45);
  cash = clamp(100 - long - short, 5, 40);
  // 재정규화 (합 100)
  const sum = long + short + cash;
  long = Math.round((long / sum) * 100);
  short = Math.round((short / sum) * 100);
  cash = 100 - long - short;

  const stance: AllocResult['stance'] = committeeBias >= 25 ? '공격적' : committeeBias <= -25 ? '방어적' : '중립적';
  const stanceColor = stance === '공격적' ? '#22C55E' : stance === '방어적' ? '#EF4444' : '#64748B';

  const buckets: AllocBucket[] = [
    { key: 'long', label: '장기 투자', pct: long, amount: Math.round(totalAsset * long / 100), color: '#0EA5E9', desc: '우량주·ETF·코인 현물 (핵심 자산)' },
    { key: 'short', label: '단기 매매', pct: short, amount: Math.round(totalAsset * short / 100), color: '#F59E0B', desc: '자동매매 전략 운용 자금' },
    { key: 'cash', label: '현금', pct: cash, amount: Math.round(totalAsset * cash / 100), color: '#64748B', desc: '대기 자금 (기회·방어)' },
  ];

  const rationale = crashRisk
    ? `폭락 위험 감지 — 현금 비중을 높여 방어합니다.`
    : committeeBias >= 25
      ? `위원회 강세(bias +${committeeBias}) — 장기·단기 비중을 높여 공격적으로 운용합니다.`
      : committeeBias <= -25
        ? `위원회 약세(bias ${committeeBias}) — 현금 비중을 높여 리스크를 줄입니다.`
        : `위원회 중립 — 기준 배분(장기 60 / 단기 30 / 현금 10)을 유지합니다.`;

  const dLong = long - BASE.long, dShort = short - BASE.short, dCash = cash - BASE.cash;
  const fmt = (d: number) => d === 0 ? '±0' : d > 0 ? `+${d}` : `${d}`;
  const shift = `기준 대비 장기 ${fmt(dLong)}%p · 단기 ${fmt(dShort)}%p · 현금 ${fmt(dCash)}%p`;

  return { buckets, stance, stanceColor, rationale, shift };
}

// 현재 배분 → 목표 배분 리밸런싱 이동액 계산
export interface RebalanceMove { key: string; label: string; from: number; to: number; deltaAmount: number; action: 'buy' | 'sell' | 'hold' }

export function planRebalance(current: { long: number; short: number; cash: number }, target: AllocResult, totalAsset: number): RebalanceMove[] {
  const cur: Record<string, number> = current as any;
  return target.buckets.map(b => {
    const from = cur[b.key] ?? 0;
    const to = b.pct;
    const deltaAmount = Math.round(totalAsset * (to - from) / 100);
    const action: RebalanceMove['action'] = Math.abs(to - from) < 2 ? 'hold' : deltaAmount > 0 ? 'buy' : 'sell';
    return { key: b.key, label: b.label, from, to, deltaAmount, action };
  });
}
