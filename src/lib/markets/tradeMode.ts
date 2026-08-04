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
  /** 좁은 화면용 한 줄. 색만으로 구분하게 두지 않으려면 짧아도 글자는 남아야 한다 */
  descShort: string;
}

export const MODE_INFO: Record<TradeMode, TradeModeInfo> = {
  PAPER: {
    mode: 'PAPER', short: '모의', label: '모의투자',
    realMoney: false, needsConnection: false,
    desc: '앱 안의 가상 잔고로만 체결됩니다. 거래소로 주문이 나가지 않습니다.',
    descShort: '가상 잔고 · 거래소로 안 나감',
  },
  TESTNET: {
    mode: 'TESTNET', short: '테스트넷', label: '테스트넷 매매',
    realMoney: false, needsConnection: true,
    desc: '거래소 테스트넷에 실제 주문이 나갑니다. 돈은 걸리지 않습니다.',
    descShort: '테스트넷 주문 · 돈 안 걸림',
  },
  LIVE: {
    mode: 'LIVE', short: '실전', label: '실전매매',
    realMoney: true, needsConnection: true,
    desc: '실제 자금으로 주문이 나갑니다. 되돌릴 수 없습니다.',
    descShort: '실제 자금 · 되돌릴 수 없음',
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
  /**
   * 이 모드에서 쓸 수 있었던 연결의 수.
   *
   * 2 이상이면 앱이 하나를 골랐다는 뜻이다. `is_testnet`은 사용자가 적은
   * 값이지 거래소가 확인해 준 값이 아니라서, 잘못 표시된 연결이 섞여
   * 있으면 엉뚱한 계좌로 주문이 나간다. 그 가능성을 화면이 알아야 한다.
   */
  choices?: number;
  /** 실제로 고른 연결의 이름. 화면이 "어디로 나가는지"를 적을 수 있어야 한다 */
  chosenLabel?: string;
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
  if (preferred) {
    return {
      ...base, ok: true, connId: preferred.id, reason: '',
      choices: usable.length, chosenLabel: labelOf(preferred),
    };
  }

  // ── 같은 모드에 쓸 수 있는 연결이 둘 이상이면 **조용히 고르지 않는다** ──
  //
  // 실제로 이런 일이 있었다. 바이낸스 연결이 둘(실전·데모)인데 하나가
  // is_testnet=true로 잘못 저장돼 있었다. 테스트넷 탭에서는 둘 다
  // '쓸 수 있는 연결'이라 첫 번째가 뽑혔고, 그게 데모 서버가 모르는
  // 키였다. 화면에는 다른 연결의 잔고가 떠 있었고 주문만 -2015로 막혔다.
  //
  // is_testnet 칸은 **사용자가 적은 값**이지 거래소가 확인해 준 값이
  // 아니다. 그래서 이 값이 틀릴 수 있다는 전제로, 여러 개일 때는 어느
  // 것을 골랐는지 반드시 말한다. 잘못 골랐다는 뜻이 아니라 —
  // **골랐다는 사실 자체를 사용자가 알아야 한다.**
  const picked = usable[0];
  const others = usable.length - 1;
  return {
    ...base, ok: true, connId: picked.id,
    choices: usable.length, chosenLabel: labelOf(picked),
    reason: preferId
      ? `고른 연결이 이 모드에 맞지 않아 ${labelOf(picked)}(으)로 주문합니다 — 아래에서 확인하세요`
      : others > 0
        ? `이 모드에 쓸 수 있는 연결이 ${usable.length}개입니다 — ${labelOf(picked)}(으)로 주문합니다. `
          + '다른 연결을 쓰려면 직접 고르세요.'
        : '',
  };
}

/** 거래소 id를 사람이 읽는 이름으로. 모르는 값은 그대로 둔다 — 지어내지 않는다. */
const EX_NAME: Record<string, string> = {
  binance: '바이낸스', gate: '게이트아이오', gateio: '게이트아이오',
  bybit: '바이빗', upbit: '업비트', bithumb: '빗썸', okx: 'OKX', kis: '한국투자증권',
};

/**
 * 화면에 적을 연결 이름.
 *
 * **원시 UUID를 사람에게 보여주지 않는다.**
 *
 * 예전에는 label도 exchange_id도 없으면 `id.slice(0,8)`을 그대로 적었다.
 * 그래서 매매 화면에 이런 문장이 떴다:
 *
 *   "고른 연결이 이 모드에 맞지 않아 cd7fd4be(으)로 주문합니다"
 *
 * 사용자 입장에서 cd7fd4be는 아무 의미가 없다. 그런데 이 문장은
 * **앱이 다른 계좌로 바꿔서 주문한다**는 뜻이라, 어느 계좌인지 모르면
 * 확인할 방법이 없다. 돈이 나가는 화면에서 식별자가 식별을 못 한다.
 *
 * 그래서 사람이 알아볼 수 있는 것부터 쓴다 — 거래소 이름과 실전/테스트넷.
 * 그것도 없으면 id를 쓰되 **'연결'이라고 이름표를 붙여** 그게 무엇인지
 * 알 수 있게 한다.
 */
function labelOf(c: ConnLike): string {
  const l = String(c?.label || '').trim();
  if (l) return l;

  const exRaw = String(c?.exchange_id || '').trim().toLowerCase();
  const ex = EX_NAME[exRaw] || (exRaw ? exRaw : '');
  // 저장소 전체 규칙: is_testnet === false 만 실전이다.
  const net = c?.is_testnet === false ? '실전' : '테스트넷';
  const short = String(c?.id || '').slice(0, 8);

  // **id 앞자리를 괄호에 넣어 함께 적는다.**
  //
  // 거래소 이름만 쓰면 읽기는 좋은데, 같은 거래소·같은 망 연결이 둘이면
  // 이름이 똑같아진다. "2개입니다 — 바이낸스 테스트넷으로 주문합니다"는
  // 어느 쪽인지 알려주지 못한다. 고르지 않고 골라 준 사실을 알리려던
  // 문장이 정작 무엇을 골랐는지는 못 말하게 된다.
  //
  // 벌거벗은 UUID는 안 되지만, 이름 뒤에 붙는 식별자는 필요하다.
  if (ex) return short ? `${ex} ${net} (${short})` : `${ex} ${net}`;
  // 거래소조차 모를 때. 그때도 '연결'이라는 이름표를 붙인다.
  return short ? `${net} 연결 ${short}` : '알 수 없는 연결';
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
