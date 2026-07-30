// src/lib/markets/tradeMode.ts
//
// 지금 어디에 주문을 보내는가 — **모의 / 테스트넷 / 실전**.
//
// 왜 순수 함수로 빼는가
// ─────────────────────
// 이 판정이 틀리면 **모의라고 믿고 실계좌에 주문이 나간다.** 화면에서는
// 둘이 똑같이 생겼다 — 같은 주문판, 같은 버튼, 같은 체결 문구. 사고가 난
// 뒤에야 안다.
//
// 특히 위험한 것이 '모르는 값'이다. 연결 행의 `is_testnet`이 null이거나
// 빠져 있을 때 그것을 실전으로 읽으면, 설정이 덜 된 계정이 곧바로 실계좌가
// 된다. 이 프로젝트의 다른 곳과 같은 규칙을 쓴다:
//
//   **`is_testnet === false`일 때만 실전이다.** 나머지는 전부 테스트넷.
//
// 반대 방향도 마찬가지다. 실전 연결을 테스트넷 목록에 넣으면 사용자는
// "테스트넷이니까 아무거나 눌러보자"고 한다. 그래서 분류는 배타적이다.

export type TradeMode = 'PAPER' | 'TESTNET' | 'LIVE';

export const TRADE_MODES: TradeMode[] = ['PAPER', 'TESTNET', 'LIVE'];

export interface TradeModeInfo {
  mode: TradeMode;
  /** 탭에 쓰는 짧은 이름 */
  short: string;
  label: string;
  /** 진짜 돈이 걸리는가 */
  realMoney: boolean;
  /** 거래소 연결이 필요한가 */
  needsConnection: boolean;
  /** 한 줄 설명 — 화면에 그대로 쓴다 */
  desc: string;
}

export const MODE_INFO: Record<TradeMode, TradeModeInfo> = {
  PAPER: {
    mode: 'PAPER', short: '모의', label: '모의투자',
    realMoney: false, needsConnection: false,
    desc: '앱 안의 가상 잔고로만 체결됩니다. 거래소로 주문이 나가지 않습니다.',
  },
  TESTNET: {
    mode: 'TESTNET', short: '테스트넷', label: '테스트넷 매매',
    realMoney: false, needsConnection: true,
    desc: '거래소 테스트넷에 실제 주문이 나갑니다. 돈은 걸리지 않습니다.',
  },
  LIVE: {
    mode: 'LIVE', short: '실전', label: '실전매매',
    realMoney: true, needsConnection: true,
    desc: '실제 자금으로 주문이 나갑니다. 되돌릴 수 없습니다.',
  },
};

/** 연결 행에서 이 판정에 필요한 것만 */
export interface ConnLike {
  id: string;
  label?: string | null;
  exchange_id?: string | null;
  /** **false일 때만** 실전이다. null·undefined는 테스트넷으로 본다 */
  is_testnet?: boolean | null;
  has_withdrawal?: boolean | null;
}

/**
 * 이 연결은 실전인가.
 *
 * `is_testnet !== false`를 테스트넷으로 보는 것은 이 프로젝트 전체의 규칙이다
 * (loadCreds·orderExecutor·webhook 모두 같다). 여기서만 다르게 읽으면
 * 화면이 말하는 모드와 실제로 주문이 가는 곳이 갈린다.
 */
export function isLiveConnection(c: ConnLike | null | undefined): boolean {
  return !!c && c.is_testnet === false;
}

/**
 * 이 모드에서 쓸 수 있는 연결들.
 *
 * 출금 권한이 있는 키는 어느 모드에서도 쓰지 않는다 — 자동매매에 쓰면
 * 키가 새는 순간 자금까지 나간다. 서버도 막지만 목록에서 먼저 뺀다.
 */
export function connectionsFor(mode: TradeMode, conns: ConnLike[] | null | undefined): ConnLike[] {
  const list = (Array.isArray(conns) ? conns : []).filter(c => c && c.has_withdrawal !== true);
  if (mode === 'PAPER') return [];
  if (mode === 'LIVE') return list.filter(isLiveConnection);
  return list.filter(c => !isLiveConnection(c));
}

export interface ModeResolution {
  ok: boolean;
  mode: TradeMode;
  /** 이 모드에서 쓸 연결. PAPER면 null */
  connId: string | null;
  /** 쓸 수 없을 때의 이유. 화면에 그대로 보여준다 */
  reason: string;
  /** 실제 자금이 걸리는가 — 화면 경고의 근거 */
  realMoney: boolean;
}

/**
 * 이 모드로 주문할 수 있는가, 있다면 어느 연결로.
 *
 * `preferId`는 사용자가 골라 둔 연결이다. 그 연결이 이 모드에 맞지 않으면
 * **조용히 다른 것으로 바꾸지 않는다** — 실전 연결을 골라 둔 채 테스트넷
 * 탭을 눌렀을 때 아무 말 없이 다른 연결로 주문이 나가면 안 된다.
 * 목록의 첫 번째로 정하되, 그 사실이 reason에 남는다.
 */
export function resolveTradeMode(
  mode: TradeMode,
  conns: ConnLike[] | null | undefined,
  preferId?: string | null,
): ModeResolution {
  const info = MODE_INFO[mode];
  const base = { mode, realMoney: info.realMoney };

  if (!info.needsConnection) {
    return { ...base, ok: true, connId: null, reason: '' };
  }

  const usable = connectionsFor(mode, conns);
  if (usable.length === 0) {
    const anyConn = (Array.isArray(conns) ? conns : []).length > 0;
    return {
      ...base, ok: false, connId: null,
      reason: mode === 'LIVE'
        ? (anyConn
            ? '실전 연결이 없습니다. 등록된 키가 전부 테스트넷입니다.'
            : '거래소 연결이 없습니다.')
        : (anyConn
            ? '테스트넷 연결이 없습니다. 등록된 키가 전부 실전입니다.'
            : '거래소 연결이 없습니다.'),
    };
  }

  const preferred = preferId ? usable.find(c => c.id === preferId) : null;
  if (preferred) return { ...base, ok: true, connId: preferred.id, reason: '' };

  return {
    ...base, ok: true, connId: usable[0].id,
    reason: preferId
      ? '고른 연결이 이 모드에 맞지 않아 다른 연결을 씁니다 — 아래에서 확인하세요'
      : '',
  };
}

/**
 * 주문을 보낼 곳.
 *
 * 모드마다 라우트가 다르다. 화면이 이걸 직접 조립하면 한 곳을 고쳐도
 * 나머지가 남는다 — 모의 주문이 실계좌 라우트로 가는 것이 그런 실수다.
 */
export function orderEndpointFor(mode: TradeMode, market: 'SPOT' | 'USDM' | 'COINM'): string {
  if (mode === 'PAPER') return '/api/paper/order';
  if (market === 'SPOT') return '/api/binance/spot/order';
  if (market === 'COINM') return '/api/binance/coinm/order';
  return '/api/binance/futures/order';
}

/**
 * 실전으로 넘어갈 때 사람이 읽어야 하는 문구.
 *
 * 모드 전환은 한 번 누르면 끝나는 동작인데, 그 뒤의 모든 주문이 실제 돈이
 * 된다. 전환 자체를 확인 대상으로 둔다.
 */
export function switchWarning(from: TradeMode, to: TradeMode): string | null {
  if (to !== 'LIVE') return null;
  return [
    `${MODE_INFO[from].label} → ${MODE_INFO.LIVE.label}로 바꿉니다.`,
    '',
    '이제부터 주문 버튼은 **실제 자금**을 사용합니다.',
    '되돌릴 수 없고, 체결되면 취소할 수 없습니다.',
  ].join('\n');
}
