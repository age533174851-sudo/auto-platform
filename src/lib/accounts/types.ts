// ─────────────────────────────────────────────────────────────
// TRAIGO Hub Accounts — Type Definitions
// 단타/장투/현금/코인/주식/자동매매 계좌를 통합 관리하기 위한 타입
// ─────────────────────────────────────────────────────────────

export type AccountKind =
  | 'shortterm'   // 단타 계좌
  | 'longterm'    // 장투 계좌
  | 'cash'        // 현금 대기금
  | 'crypto'      // 코인 계좌 (현물 + 선물 통합)
  | 'stock'       // 주식 계좌
  | 'autobot';    // 자동매매 계좌

export type PositionSide = 'long' | 'short' | 'spot';
export type AssetClass = 'crypto_spot' | 'crypto_perp' | 'stock' | 'etf' | 'commodity' | 'cash';

export interface HubPosition {
  id: string;
  accountId: string;
  symbol: string;       // 'BTC', 'NVDA', ...
  name?: string;
  assetClass: AssetClass;
  side: PositionSide;
  qty: number;          // 수량 (코인은 코인 수, 주식은 주 수)
  avgPrice: number;     // 평단가
  currentPrice: number; // 현재가 (mock 기준)
  leverage?: number;    // 선물의 경우만
  liqPrice?: number;    // 청산가
  openedAt: number;     // timestamp
  isBot?: boolean;      // 자동매매 봇이 만든 포지션인지
}

export interface HubAccount {
  id: string;
  kind: AccountKind;
  name: string;
  icon: string;         // emoji
  color: string;        // tailwind/hex
  balance: number;       // 평가금액 (KRW)
  cash: number;          // 미사용 현금 (KRW)
  realizedPnl: number;   // 실현손익 누적 (KRW)
  todayPnl: number;      // 오늘 손익 (KRW)
  cumulativeReturn: number; // 누적 수익률 (%)
  riskLevel: 'low' | 'mid' | 'high' | 'extreme'; // 위험도
  botActive?: boolean;   // 자동매매 봇 가동 중인지
  positions: HubPosition[]; // 보유 포지션
}

// 단타 수익 자동 이동 룰
export interface ProfitTransferRule {
  enabled: boolean;
  toLongterm: number;  // 0~100 (%)
  toCash: number;      // 0~100 (%)
  // 나머지는 단타 재투자. (toLongterm + toCash <= 100)
}

// 매도 액션 옵션
export type SellScope =
  | 'all'             // 전체 매도
  | 'shortterm_only'  // 단타 계좌만
  | 'longterm_only'   // 장투 계좌만
  | 'crypto_perp'     // 코인 선물만
  | 'stock_only'      // 주식만
  | 'profit_only'     // 수익 중인 포지션만
  | 'loss_only';      // 손실 중인 포지션만

export interface SellAction {
  scope: SellScope;
  ratio: 25 | 50 | 75 | 100; // 비율
  confirmText?: string;       // 사용자가 입력한 확인 문구
}

// 긴급 탈출 결과
export interface EmergencyResult {
  ranAt: number;
  stoppedBots: number;        // 정지된 봇 수
  closedPerpPositions: number; // 종료된 선물 포지션 수
  closedLeveraged: number;     // 종료된 레버리지 포지션 수
  closedSpot: number;          // 매도된 현물 수
  notClosed: number;           // 사용자 선택으로 유지된 수
  realizedPnl: number;         // 실현 손익
  cashRecovered: number;       // 현금으로 회수된 금액
}

// 전체 Hub 상태 (localStorage 저장 대상)
export interface HubState {
  version: number;
  accounts: HubAccount[];
  transferRule: ProfitTransferRule;
  emergencyMode: boolean;
  lastEmergencyResult?: EmergencyResult;
  recentSellActions: { at: number; scope: SellScope; ratio: number; pnl: number }[];
}

export const ACCOUNT_KIND_META: Record<AccountKind, { name: string; icon: string; color: string; desc: string }> = {
  shortterm: { name: '단타 계좌',   icon: '⚡', color: '#F59E0B', desc: '돈 벌기용 — 짧게 치고 빠지기' },
  longterm:  { name: '장투 계좌',   icon: '📈', color: '#3B82F6', desc: '돈 키우기용 — 모아가기' },
  cash:      { name: '현금 대기금', icon: '💵', color: '#94A3B8', desc: '폭락장 추가매수 / 리스크 방어' },
  crypto:    { name: '코인 계좌',   icon: '🪙', color: '#F0B90B', desc: '현물 + 선물 통합' },
  stock:     { name: '주식 계좌',   icon: '🏛️', color: '#10B981', desc: 'ETF / 개별주' },
  autobot:   { name: '자동매매',    icon: '🤖', color: '#7C3AED', desc: '봇이 운용 중' },
};
