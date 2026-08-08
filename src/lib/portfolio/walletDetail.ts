// src/lib/portfolio/walletDetail.ts
//
// 지갑의 탭별 내용 — 선물 · 현물 · 전략계좌 · 장기투자, 그리고 자산 배분.
//
// **이 화면의 숫자는 전부 "못 읽었을 수 있는" 숫자다.**
//
// 거래소는 자주 느리고, 가끔 끊기고, 어떤 칸만 안 줄 때도 있다. 그때
// 화면이 할 수 있는 선택은 셋뿐이다:
//
//   0으로 그린다        → 사용자는 자기 돈이 사라졌다고 믿는다
//   빈칸으로 둔다        → 왜 없는지 모른다. 고장인지 잔고가 없는 건지
//   못 읽었다고 적는다   → 이것만이 맞다
//
// 그래서 모든 값은 `Cell`로 다닌다. 값과 **"읽었는가"**를 같이 들고
// 다니지 않으면, 화면 어딘가에서 반드시 `?? 0`이 붙는다.
//
// 그리고 자산 배분
// ────────────────
// 비율은 나눗셈이라 **하나만 못 읽어도 전부 틀린다.** 분모가 작아지니까
// 나머지 조각들이 실제보다 커 보이고, 그 그림은 아무 표시 없이 그럴듯하다.
// 그래서 한 칸이라도 못 읽으면 비율 자체를 내지 않는다.

import type { WalletEnv } from './wallet';

/** 왜 값이 없는가 */
export type CellState =
  /** 읽었다 */
  | 'OK'
  /** 아직 읽는 중 */
  | 'SYNCING'
  /** 거래소 연결이 끊겼다 */
  | 'DISCONNECTED'
  /** 물어봤는데 못 받았다 */
  | 'FAILED'
  /** 이 거래소가 안 주는 값이다 */
  | 'UNSUPPORTED';

export interface Cell {
  value: number | null;
  state: CellState;
  /** 화면에 그대로 쓸 문자열 */
  text: string;
}

export const CELL_TEXT: Record<CellState, string> = {
  OK: '',
  SYNCING: '동기화 중',
  DISCONNECTED: '연결 끊김',
  FAILED: '확인 불가',
  UNSUPPORTED: '미지원',
};

/**
 * 값 하나.
 *
 * **숫자가 아니면 무조건 못 읽은 것이다.** `'0'` 같은 문자열은 숫자로
 * 받아 주되, `null`·`''`·`true`·`NaN`은 전부 거절한다 — `Number(null)`이
 * 0이라 그냥 통과시키면 못 읽은 잔고가 0원이 된다.
 */
export function cellOf(v: any, state: CellState = 'OK'): Cell {
  if (state !== 'OK') return { value: null, state, text: CELL_TEXT[state] };
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') {
    return { value: null, state: 'FAILED', text: CELL_TEXT.FAILED };
  }
  const n = Number(v);
  if (!Number.isFinite(n)) return { value: null, state: 'FAILED', text: CELL_TEXT.FAILED };
  return { value: n, state: 'OK', text: '' };
}

// ── 선물 ──────────────────────────────────────────────────

export interface FuturesAccount {
  /** 'Gate Testnet Futures' 같은 이름 */
  name: string;
  env: WalletEnv;
  exchange: string;
  walletBalance: Cell;
  availableBalance: Cell;
  usedMargin: Cell;
  maintenanceMargin: Cell;
  unrealizedPnl: Cell;
  realizedPnl: Cell;
  /** 유지증거금 ÷ 순자산. 못 내면 null */
  marginRatio: Cell;
  openPositions: Cell;
  openOrders: Cell;
  lastSyncAtMs: number | null;
  connection: CellState;
  note: string;
}

export interface FuturesRow { label: string; cell: Cell; }

/**
 * 선물 계좌 한 장에 적을 줄들.
 *
 * 순서는 바이낸스 지갑과 같게 둔다 — 지갑잔고 → 가용 → 사용 증거금 →
 * 유지증거금 → 미실현 → 실현 → 증거금비율.
 */
export function futuresRowsOf(a: FuturesAccount | null | undefined): FuturesRow[] {
  const c = (x: any): Cell => x ?? cellOf(null, 'FAILED');
  if (!a) return [];
  return [
    { label: '지갑 잔고', cell: c(a.walletBalance) },
    { label: '주문 가능', cell: c(a.availableBalance) },
    { label: '사용 증거금', cell: c(a.usedMargin) },
    { label: '유지 증거금', cell: c(a.maintenanceMargin) },
    { label: '미실현 손익', cell: c(a.unrealizedPnl) },
    { label: '실현 손익', cell: c(a.realizedPnl) },
    { label: '증거금 비율', cell: c(a.marginRatio) },
    { label: '보유 포지션', cell: c(a.openPositions) },
    { label: '미체결 주문', cell: c(a.openOrders) },
  ];
}

/**
 * 증거금 비율.
 *
 * **분모를 못 읽으면 내지 않는다.** 여기서 0으로 채우면 비율이 무한대나
 * 0이 되는데, 둘 다 화면에서는 "안전함"이나 "청산 직전"으로 읽힌다 —
 * 둘 다 사실이 아니다.
 */
export function marginRatioOf(maintenance: Cell, equity: Cell): Cell {
  if (maintenance.value === null || equity.value === null) {
    return cellOf(null, 'FAILED');
  }
  if (equity.value <= 0) {
    // 순자산이 0 이하면 비율에 뜻이 없다. 큰 숫자를 그리면 더 헷갈린다.
    return cellOf(null, 'FAILED');
  }
  return cellOf((maintenance.value / equity.value) * 100);
}

/**
 * 마지막 동기화가 언제였는지 한 줄.
 *
 * **"방금"이라고 쓰지 않는다.** 시각을 모르면 모른다고 적는다 —
 * 오래된 숫자를 최신인 줄 알고 보는 것이 이 화면에서 가장 위험하다.
 */
export function syncTextOf(lastSyncAtMs: number | null | undefined, nowMs: number): string {
  if (lastSyncAtMs === null || lastSyncAtMs === undefined || !Number.isFinite(lastSyncAtMs)) {
    return '마지막 동기화 시각을 모릅니다 — 화면의 숫자가 언제 것인지 알 수 없습니다';
  }
  const sec = Math.max(0, Math.round((nowMs - lastSyncAtMs) / 1000));
  if (sec < 60) return `${sec}초 전 동기화`;
  if (sec < 3600) return `${Math.floor(sec / 60)}분 전 동기화`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}시간 전 동기화`;
  return `${Math.floor(sec / 86400)}일 전 동기화 — 오래된 값입니다`;
}

// ── 현물 ──────────────────────────────────────────────────

export interface SpotAsset {
  symbol: string;
  name?: string;
  quantity: Cell;
  available: Cell;
  locked: Cell;
  /** 평가액 */
  valuation: Cell;
  /** 24시간 변동률(%) */
  change24hPct: Cell;
}

/**
 * 현물 보유 목록.
 *
 * **수량 0인 코인은 빼되, 수량을 못 읽은 것은 남긴다.** 빼 버리면
 * 사용자는 그 코인이 없다고 믿는데, 사실은 못 읽었을 뿐이다.
 */
export function spotRowsOf(assets: SpotAsset[] | null | undefined): SpotAsset[] {
  const list = Array.isArray(assets) ? assets : [];
  return list
    .filter(a => a && String(a.symbol || '').trim())
    .filter(a => a.quantity.value === null || a.quantity.value !== 0)
    .sort((a, b) => {
      // 평가액이 큰 것부터. 못 읽은 것은 위로 — 숨기지 않는다.
      const av = a.valuation.value, bv = b.valuation.value;
      if (av === null && bv === null) return 0;
      if (av === null) return -1;
      if (bv === null) return 1;
      return bv - av;
    });
}

// ── 전략계좌 ──────────────────────────────────────────────

export interface StrategyAccount {
  strategyName: string;
  allocatedCapital: Cell;
  currentEquity: Cell;
  availableCapital: Cell;
  realizedPnl: Cell;
  unrealizedPnl: Cell;
  fees: Cell;
  funding: Cell;
  /** 수익률(%) */
  returnPct: Cell;
  /** 최대 낙폭(%) */
  mddPct: Cell;
  activePositions: Cell;
}

/**
 * 전략 수익률.
 *
 * **배정 자금을 모르면 내지 않는다.** 분모를 1로 두거나 현재 자산으로
 * 대신하면, 손실 중인 전략의 수익률이 실제보다 좋게 나온다.
 */
export function strategyReturnOf(allocated: Cell, equity: Cell): Cell {
  if (allocated.value === null || equity.value === null) return cellOf(null, 'FAILED');
  if (allocated.value <= 0) return cellOf(null, 'FAILED');
  return cellOf(((equity.value - allocated.value) / allocated.value) * 100);
}

export interface StrategyTotal {
  total: number | null;
  complete: boolean;
  missing: string[];
  note: string;
}

/**
 * 전략 자산 합계.
 *
 * **하나라도 못 읽으면 합계를 내지 않는다.** 넷 중 셋만 더해 '총 전략
 * 자산'이라고 적으면 못 읽은 전략의 돈이 없는 것처럼 보인다.
 */
export function strategyTotalOf(accounts: StrategyAccount[] | null | undefined): StrategyTotal {
  const list = Array.isArray(accounts) ? accounts : [];
  if (list.length === 0) {
    return { total: null, complete: false, missing: [],
      note: '전략계좌가 없습니다 — 자산이 0이라는 뜻이 아닙니다' };
  }
  const missing = list.filter(a => a.currentEquity.value === null).map(a => a.strategyName);
  if (missing.length > 0) {
    return { total: null, complete: false, missing,
      note: `${missing.join(', ')}의 자산을 읽지 못해 합계를 내지 않습니다 —`
        + ' 나머지만 더하면 못 읽은 전략의 돈이 없는 것처럼 보입니다' };
  }
  return {
    total: list.reduce((a, s) => a + (s.currentEquity.value as number), 0),
    complete: true, missing: [], note: '',
  };
}

// ── 장기투자 ──────────────────────────────────────────────

export interface LongtermHolding {
  symbol: string;
  name?: string;
  quantity: Cell;
  avgCost: Cell;
  marketValue: Cell;
  unrealizedPnl: Cell;
  dividends: Cell;
  /** 비중(%). allocationOf가 채운다 */
  allocationPct?: Cell;
}

// ── 자산 배분 ─────────────────────────────────────────────

export interface AllocationSlice {
  label: string;
  value: number | null;
  pct: number | null;
}

export interface Allocation {
  slices: AllocationSlice[];
  total: number | null;
  /** 비율을 낼 수 있었는가 */
  complete: boolean;
  note: string;
}

/**
 * 자산 배분.
 *
 * **한 조각이라도 못 읽으면 비율을 내지 않는다.**
 *
 * 비율은 나눗셈이라 하나만 빠져도 전부 틀린다 — 분모가 작아지니까
 * 나머지 조각이 실제보다 커 보이고, 그 그림은 아무 표시 없이 그럴듯하다.
 * 현물 35% / 선물 25%처럼 딱 떨어지는 숫자가 뜨면 아무도 의심하지 않는다.
 */
export function allocationOf(
  parts: Array<{ label: string; cell: Cell }> | null | undefined,
): Allocation {
  const list = Array.isArray(parts) ? parts : [];
  if (list.length === 0) {
    return { slices: [], total: null, complete: false,
      note: '배분을 낼 계좌가 없습니다' };
  }

  const missing = list.filter(p => p.cell.value === null).map(p => p.label);
  if (missing.length > 0) {
    return {
      slices: list.map(p => ({ label: p.label, value: p.cell.value, pct: null })),
      total: null, complete: false,
      note: `${missing.join(', ')}을(를) 읽지 못해 비율을 내지 않습니다 —`
        + ' 한 조각이 빠지면 분모가 작아져 나머지가 실제보다 커 보이고,'
        + ' 그 그림에는 틀렸다는 표시가 없습니다',
    };
  }

  const total = list.reduce((a, p) => a + (p.cell.value as number), 0);
  if (total <= 0) {
    return {
      slices: list.map(p => ({ label: p.label, value: p.cell.value, pct: null })),
      total, complete: false,
      note: '자산이 0이라 비율을 낼 수 없습니다',
    };
  }

  return {
    slices: list.map(p => ({
      label: p.label, value: p.cell.value,
      pct: ((p.cell.value as number) / total) * 100,
    })),
    total, complete: true, note: '',
  };
}

// ── 계좌 선택은 여기 없다 ────────────────────────────────
//
// 예전에는 이 파일에 accountsForEnv/accountsNoteOf가 있었다. 그런데
// 실제로 계좌를 읽어 보니 판정에 더 필요한 것이 있었다 — 읽는 중인지,
// 못 읽은 건지, 진짜 없는 건지, 그리고 주문이 쓰는 것과 같은
// connectionId인지.
//
// 그래서 `walletAccounts.ts`로 옮겼다. **같은 일을 하는 판정을 두 곳에
// 두지 않는다** — 이 저장소에서 가장 자주 나는 고장이 "경로가 둘인데
// 한쪽만 고침"이고, 계좌 판정이 갈리면 지갑과 주문이 다른 계좌를 본다.
