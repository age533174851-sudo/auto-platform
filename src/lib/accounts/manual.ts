// src/lib/accounts/manual.ts
// 수동 등록 계좌 — 은행/토스/증권/코인현물/코인선물/기타
// 비로그인 → localStorage. 자동 업데이트 안 됨 (직접 입력/수정)

export type ManualAccountType = 'bank' | 'toss' | 'stock' | 'coin_spot' | 'coin_futures' | 'etc';

export interface ManualHolding {
  id:        string;
  symbol:    string;
  name?:     string;
  qty:       number;
  avgPrice:  number;
  curPrice:  number;
  leverage?: number;          // 선물
  side?:     'long' | 'short';
}

export interface ManualAccount {
  id:          string;
  name:        string;
  institution: string;
  type:        ManualAccountType;
  cashBalance: number;
  currency:    'KRW' | 'USD' | 'USDT';
  holdings:    ManualHolding[];
  createdAt:   number;
  updatedAt:   number;
}

const KEY = 'tg_manual_accounts_v1';

export const ACCOUNT_TYPE_LABEL: Record<ManualAccountType, string> = {
  bank: '은행', toss: '토스', stock: '증권',
  coin_spot: '코인 현물', coin_futures: '코인 선물', etc: '기타',
};

export const ACCOUNT_TYPE_COLOR: Record<ManualAccountType, string> = {
  bank: '#3B82F6', toss: '#0064FF', stock: '#10B981',
  coin_spot: '#F7931A', coin_futures: '#7C3AED', etc: '#94A3B8',
};

export function loadManualAccounts(): ManualAccount[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function persist(accounts: ManualAccount[]): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(KEY, JSON.stringify(accounts)); } catch {}
}

export function saveManualAccount(acc: ManualAccount): ManualAccount[] {
  const list = loadManualAccounts();
  const idx = list.findIndex(a => a.id === acc.id);
  acc.updatedAt = Date.now();
  if (idx >= 0) list[idx] = acc; else list.push(acc);
  persist(list);
  return list;
}

export function deleteManualAccount(id: string): ManualAccount[] {
  const list = loadManualAccounts().filter(a => a.id !== id);
  persist(list);
  return list;
}

export interface AccountValuation {
  cash: number; holdingsValue: number; cost: number;
  total: number; pnl: number; pnlPct: number;
}

export function valuateAccount(acc: ManualAccount): AccountValuation {
  let holdingsValue = 0, cost = 0;
  for (const h of acc.holdings) {
    const positionCost = h.avgPrice * h.qty;
    cost += positionCost;
    if (acc.type === 'coin_futures') {
      const lev = h.leverage && h.leverage > 0 ? h.leverage : 1;
      const isShort = h.side === 'short';
      const diff = isShort ? (h.avgPrice - h.curPrice) : (h.curPrice - h.avgPrice);
      const pnl = h.avgPrice > 0 ? (diff / h.avgPrice) * positionCost * lev : 0;
      holdingsValue += positionCost + pnl;
    } else {
      holdingsValue += h.curPrice * h.qty;
    }
  }
  const total = acc.cashBalance + holdingsValue;
  const pnl = holdingsValue - cost;
  const pnlPct = cost > 0 ? (pnl / cost) * 100 : 0;
  return { cash: acc.cashBalance, holdingsValue, cost, total, pnl, pnlPct };
}

export function valuateAll(accounts: ManualAccount[]) {
  let totalAssets = 0, totalPnl = 0;
  const byType: Record<string, number> = {};
  for (const acc of accounts) {
    const v = valuateAccount(acc);
    totalAssets += v.total; totalPnl += v.pnl;
    byType[acc.type] = (byType[acc.type] || 0) + v.total;
  }
  return { totalAssets, byType, totalPnl };
}

export function muid(): string {
  return `ma_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
