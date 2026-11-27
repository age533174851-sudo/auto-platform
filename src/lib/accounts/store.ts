// ─────────────────────────────────────────────────────────────
// TRAIGO Hub Accounts — Store (localStorage)
// 모의매매 구조: 실거래 연결 전 mock 잔고/포지션을 들고 있음
// ─────────────────────────────────────────────────────────────

import type { HubState, HubAccount, ProfitTransferRule } from './types';

export const HUB_STORE_KEY = 'tg_hub_accounts_v1';

// ── 빈 시작 상태 ─────────────────────────────────────────
//
// **저장된 것이 없으면 빈 계좌다.** 예전에는 여기서 "마스터 프롬프트
// 예시"를 돌려줬다 — 총 1,000만 원 · 오늘 +16.2만 원 · 실현손익 +109.5만
// 원 · 단타 봇 실행 중 · BTC 5배 롱을 비롯한 포지션 6건. 화면
// (`HubAccountsPage`, 로그인이 필요한 '통합 운용' 탭)은 그것을 예시라는
// 표시 없이 **사용자의 계좌로** 그렸고, 버튼 하나만 눌러도 그 숫자가
// localStorage에 저장돼 남았다. 넣은 적 없는 돈과 한 적 없는 거래다.
//
// 계좌 **칸**(단타·장투·현금·자동매매)은 남긴다 — 화면이 그릴 자리이고
// 지어낸 사실이 아니다. 금액·손익·포지션·봇 상태는 전부 비운다.
// (`dca.ts`의 `loadDCARules`가 같은 이유로 예시 이력을 걷어 냈다.)
function emptyAccount(
  id: string, kind: HubAccount['kind'], name: string, icon: string, color: string,
  riskLevel: HubAccount['riskLevel'],
): HubAccount {
  return {
    id, kind, name, icon, color,
    balance: 0,
    cash: 0,
    realizedPnl: 0,
    todayPnl: 0,
    cumulativeReturn: 0,
    riskLevel,
    botActive: false,
    positions: [],
  };
}

function seed(): HubState {
  const accounts: HubAccount[] = [
    emptyAccount('acc_short', 'shortterm', '단타 계좌',     '⚡', '#F59E0B',     'high'),
    emptyAccount('acc_long',  'longterm',  '장투 계좌',     '📈', '#3B82F6',     'low'),
    emptyAccount('acc_cash',  'cash',      '현금 대기금',   '💵', 'var(--t-sub)', 'low'),
    emptyAccount('acc_bot',   'autobot',   '자동매매 계좌', '🤖', '#7C3AED',     'mid'),
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
