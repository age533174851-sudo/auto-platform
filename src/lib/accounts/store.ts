// ─────────────────────────────────────────────────────────────
// TRAIGO Hub Accounts — Store (localStorage)
// 모의매매 구조: 실거래 연결 전 mock 잔고/포지션을 들고 있음
// ─────────────────────────────────────────────────────────────

import type { HubState, HubAccount, ProfitTransferRule } from './types';

export const HUB_STORE_KEY = 'tg_hub_accounts_v1';

// ── Mock seed: 마스터 프롬프트 예시 그대로 ─────────────────
function seed(): HubState {
  const now = Date.now();
  const accounts: HubAccount[] = [
    {
      id: 'acc_short',
      kind: 'shortterm',
      name: '단타 계좌',
      icon: '⚡',
      color: '#F59E0B',
      balance: 3000000,
      cash: 800000,
      realizedPnl: 245000,
      todayPnl: 120000,
      cumulativeReturn: 8.93,
      riskLevel: 'high',
      botActive: true,
      positions: [
        { id: 'p1', accountId: 'acc_short', symbol: 'BTC',    name: 'Bitcoin',   assetClass: 'crypto_perp', side: 'long',  qty: 0.012, avgPrice: 95800000, currentPrice: 97200000, leverage: 5, liqPrice: 87100000, openedAt: now-3600_000, isBot: true },
        { id: 'p2', accountId: 'acc_short', symbol: 'NATGAS', name: 'Nat. Gas',  assetClass: 'commodity',   side: 'short', qty: 50,    avgPrice: 3.42,     currentPrice: 3.28,     leverage: 3, liqPrice: 4.11,     openedAt: now-7200_000, isBot: true },
      ],
    },
    {
      id: 'acc_long',
      kind: 'longterm',
      name: '장투 계좌',
      icon: '📈',
      color: '#3B82F6',
      balance: 6000000,
      cash: 300000,
      realizedPnl: 850000,
      todayPnl: 42000,
      cumulativeReturn: 14.12,
      riskLevel: 'low',
      botActive: false,
      positions: [
        { id: 'p3', accountId: 'acc_long', symbol: 'QQQ',  name: 'Invesco QQQ',  assetClass: 'etf',         side: 'spot', qty: 4,    avgPrice: 528_000, currentPrice: 562_000, openedAt: now-86400_000*30 },
        { id: 'p4', accountId: 'acc_long', symbol: 'NVDA', name: 'NVIDIA',       assetClass: 'stock',       side: 'spot', qty: 3,    avgPrice: 178_000, currentPrice: 201_000, openedAt: now-86400_000*45 },
        { id: 'p5', accountId: 'acc_long', symbol: 'MSFT', name: 'Microsoft',    assetClass: 'stock',       side: 'spot', qty: 2,    avgPrice: 520_000, currentPrice: 548_000, openedAt: now-86400_000*60 },
        { id: 'p6', accountId: 'acc_long', symbol: 'BTC',  name: 'Bitcoin (현물)',assetClass: 'crypto_spot', side: 'spot', qty: 0.02, avgPrice: 88_000_000, currentPrice: 97_200_000, openedAt: now-86400_000*90 },
      ],
    },
    {
      id: 'acc_cash',
      kind: 'cash',
      name: '현금 대기금',
      icon: '💵',
      color: '#94A3B8',
      balance: 1000000,
      cash: 1000000,
      realizedPnl: 0,
      todayPnl: 0,
      cumulativeReturn: 0,
      riskLevel: 'low',
      positions: [],
    },
    {
      id: 'acc_bot',
      kind: 'autobot',
      name: '자동매매 계좌',
      icon: '🤖',
      color: '#7C3AED',
      balance: 0,
      cash: 0,
      realizedPnl: 0,
      todayPnl: 0,
      cumulativeReturn: 0,
      riskLevel: 'mid',
      botActive: false,
      positions: [],
    },
  ];

  return {
    version: 1,
    accounts,
    transferRule: { enabled: true, toLongterm: 30, toCash: 20 },
    emergencyMode: false,
    recentSellActions: [],
  };
}

// ── localStorage I/O (SSR-safe) ───────────────────────────
export function loadHubState(): HubState {
  if (typeof window === 'undefined') return seed();
  try {
    const raw = window.localStorage.getItem(HUB_STORE_KEY);
    if (!raw) return seed();
    const parsed = JSON.parse(raw) as HubState;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.accounts)) return seed();
    // 마이그레이션 여지: version 체크
    if (parsed.version !== 1) return seed();
    return parsed;
  } catch (e) {
    console.warn('[hub] loadHubState failed, using seed', e);
    return seed();
  }
}

export function saveHubState(state: HubState): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(HUB_STORE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('[hub] saveHubState failed', e);
  }
}

export function resetHubState(): HubState {
  const fresh = seed();
  saveHubState(fresh);
  return fresh;
}

// ── 계산 헬퍼 ────────────────────────────────────────────
export function totalBalance(state: HubState): number {
  if (!state || !Array.isArray(state.accounts)) return 0;
  return state.accounts.reduce((s, a) => s + (a?.balance || 0), 0);
}

export function totalTodayPnl(state: HubState): number {
  if (!state || !Array.isArray(state.accounts)) return 0;
  return state.accounts.reduce((s, a) => s + (a?.todayPnl || 0), 0);
}

export function positionUnrealized(p: { qty: number; avgPrice: number; currentPrice: number; side: string }): number {
  const direction = p.side === 'short' ? -1 : 1;
  return (p.currentPrice - p.avgPrice) * p.qty * direction;
}

export function accountUnrealized(a: HubAccount): number {
  if (!a || !Array.isArray(a.positions)) return 0;
  return a.positions.reduce((s, p) => s + positionUnrealized(p), 0);
}

// 단타 수익 자동 이동 미리보기 (실제 이동은 사용자가 trigger)
export function previewTransfer(profit: number, rule: ProfitTransferRule): { toLong: number; toCash: number; keep: number } {
  if (!rule.enabled || profit <= 0) return { toLong: 0, toCash: 0, keep: Math.max(0, profit) };
  const toLong = Math.floor(profit * (rule.toLongterm / 100));
  const toCash = Math.floor(profit * (rule.toCash / 100));
  const keep   = profit - toLong - toCash;
  return { toLong, toCash, keep };
}
