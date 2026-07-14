// src/lib/autotrade/auditLog.ts
// AI 감사 로그 — 모든 AI 판단(진입/청산/대기)을 이유·신뢰도와 함께 기록.
// "왜 그때 그렇게 판단했는가"를 100% 추적 가능하게.
const KEY = 'tg_ai_audit_v1';
const CAP = 200;

export interface AuditReason { label: string; value: string; met: boolean }

export interface AuditEntry {
  id: string;
  ts: number;
  action: string;          // enter_long / hold / exit_tp / exit_sl / wait
  actionLabel: string;
  confidence: number;
  marketState: string;
  summary: string;
  reasons: AuditReason[];
  price?: number;
  asset?: string;
  executed: boolean;       // 실제 매매로 이어졌는지
  source: string;          // 'mock' | 'worker' | 'webhook'
}

type Listener = () => void;
const subs = new Set<Listener>();

const ACTION_LABEL: Record<string, string> = {
  enter_long: '롱 진입', enter_short: '숏 진입', hold: '보유 유지',
  exit_tp: '익절 청산', exit_sl: '손절 청산', wait: '대기', exit: '청산',
};

export function actionLabel(a: string): string { return ACTION_LABEL[a] || a; }

export function loadAudit(): AuditEntry[] {
  if (typeof window === 'undefined') return [];
  try { const r = localStorage.getItem(KEY); const a = r ? JSON.parse(r) : []; return Array.isArray(a) ? a : []; }
  catch { return []; }
}

export function logDecision(d: {
  action: string; confidence: number; marketState: string; summary: string;
  reasons?: AuditReason[]; price?: number; asset?: string; executed?: boolean; source?: string;
}): AuditEntry {
  const entry: AuditEntry = {
    id: `au_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    ts: Date.now(),
    action: d.action,
    actionLabel: actionLabel(d.action),
    confidence: Math.round(d.confidence),
    marketState: d.marketState,
    summary: d.summary,
    reasons: Array.isArray(d.reasons) ? d.reasons : [],
    price: d.price,
    asset: d.asset,
    executed: !!d.executed,
    source: d.source || 'mock',
  };
  if (typeof window !== 'undefined') {
    try {
      const cur = loadAudit();
      // 직전 항목과 동일 action+marketState면 중복 기록 방지 (대기 상태 도배 방지)
      const last = cur[0];
      if (last && last.action === entry.action && last.marketState === entry.marketState && !entry.executed && (entry.ts - last.ts) < 4000) {
        return last;
      }
      const next = [entry, ...cur].slice(0, CAP);
      localStorage.setItem(KEY, JSON.stringify(next));
      subs.forEach(cb => { try { cb(); } catch {} });
    } catch {}
  }
  return entry;
}

export function clearAudit() {
  if (typeof window === 'undefined') return;
  try { localStorage.removeItem(KEY); subs.forEach(cb => { try { cb(); } catch {} }); } catch {}
}

export function subscribeAudit(cb: Listener): () => void { subs.add(cb); return () => subs.delete(cb); }
