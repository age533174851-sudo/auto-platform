// src/lib/exchanges/pickConnection.ts
//
// **어느 계좌를 쓸 것인가 — 규칙은 한 곳에만 있어야 한다.**
//
// 무엇이 문제였나
// ───────────────
// 같은 질문에 두 곳이 다르게 답하고 있었다.
//
//   · TerminalContext  → `usable[0]`  (목록의 첫 번째)
//   · AutotradeControl → `list.find(c => c.is_testnet !== false)` (테스트넷 우선)
//
// 그래서 실전 연결이 먼저 등록돼 있으면, 매매 화면은 실전 계좌를 고른
// 채로 열리고 자동매매 화면은 테스트넷을 고른 채로 열린다. 같은 계정,
// 같은 순간, 다른 계좌. 어느 쪽이 맞는지는 화면을 봐서는 알 수 없다.
//
// 그리고 셋 더
// ────────────
//  2. 자동으로 고른 계좌를 **저장하지 않았다.** `setConnId(keep)`는
//     localStorage를 안 거치는 경로라, 손으로 고른 것만 기억되고 자동으로
//     고른 것은 매번 처음부터 다시 뽑혔다.
//
//  3. 목록에 없는 id가 **그대로 남았다.** `if (keep) setConnId(keep)`이라,
//     쓸 수 있는 연결이 하나도 없으면 예전 id가 화면에 남는다. 화면은
//     계좌가 선택된 것처럼 그리는데 그 계좌는 이제 없다.
//
//  4. 저장된 계좌가 지워졌을 때 **말없이 다른 계좌로 옮겼다.** 다음 주문이
//     사용자가 모르는 계좌로 나간다. 옮기는 것 자체는 맞지만, 옮겼다는
//     사실은 말해야 한다.
//
// 왜 테스트넷을 먼저 고르나
// ─────────────────────────
// 이 화면의 최악은 **모르고 누른 첫 주문이 실제 돈이 되는 것**이다.
// 기본 매매 모드도 같은 이유로 모의다. 자동 선택이 실전 계좌에 서 있으면
// 그 방어가 한 칸 얇아진다.

export interface ConnLike {
  id?: any;
  label?: any;
  exchange_id?: any;
  is_testnet?: any;
  has_withdrawal?: any;
}

export type PickSource =
  /** 지난번에 고른 계좌를 그대로 씀 */
  | 'SAVED'
  /** 테스트넷을 먼저 골랐다 */
  | 'PREFERRED_TESTNET'
  /** 하나뿐이라 그것 */
  | 'ONLY_ONE'
  /** 테스트넷이 없어 첫 번째 */
  | 'FIRST'
  /** 쓸 수 있는 연결이 없다 */
  | 'NONE';

export interface PickResult {
  /** 고른 연결 id. 없으면 null — **빈 문자열이 아니다** */
  id: string | null;
  source: PickSource;
  /** 사용자에게 말해야 하는 것. 없으면 빈 문자열 */
  reason: string;
  /** 저장돼 있던 id가 목록에 없어서 버려졌는가 */
  savedGone: boolean;
  /** 실전 계좌를 골랐는가. 화면이 이걸 눈에 띄게 그려야 한다 */
  isLive: boolean;
}

/** 저장소 공통 규칙: `is_testnet === false` 일 때만 실전이다 */
export function isLiveConn(c: ConnLike | null | undefined): boolean {
  return !!c && c.is_testnet === false;
}

export function labelOf(c: ConnLike | null | undefined): string {
  if (!c) return '알 수 없는 연결';
  const name = String(c.label ?? c.exchange_id ?? '연결').trim() || '연결';
  return `${name} · ${isLiveConn(c) ? '실전' : '테스트넷'}`;
}

/**
 * 쓸 수 있는 연결만 남긴다.
 *
 * 출금 권한이 있는 키는 **자동 경로에서 절대 쓰지 않는다.** 이 필터가
 * 위쪽에도 있지만 여기에도 둔다 — 한쪽이 빠져도 다른 쪽이 잡는다.
 */
export function usableConnections(conns: ConnLike[] | null | undefined): ConnLike[] {
  return (Array.isArray(conns) ? conns : [])
    .filter(c => c && String(c.id ?? '').trim() && !c.has_withdrawal);
}

export interface PickOptions {
  /** 지난번에 고른 id (localStorage) */
  saved?: string | null;
  /**
   * 테스트넷을 먼저 고를 것인가. 기본은 그렇다.
   *
   * 끄고 싶은 자리가 생기면 그때 명시적으로 끈다 — 기본값을 넓은 쪽에
   * 두면 아무 생각 없이 부른 곳이 실전을 고른다.
   */
  preferTestnet?: boolean;
}

/**
 * 지금 쓸 계좌를 고른다.
 *
 * **순수 함수다.** 저장소도 안 읽고 상태도 안 바꾼다 — 그래야 이 규칙에
 * 테스트가 붙고, 붙어야 두 화면이 갈리지 않는다.
 */
export function pickConnection(
  conns: ConnLike[] | null | undefined,
  opts: PickOptions = {},
): PickResult {
  const usable = usableConnections(conns);
  const saved = String(opts.saved ?? '').trim();
  const preferTestnet = opts.preferTestnet !== false;

  if (usable.length === 0) {
    const hadAny = (Array.isArray(conns) ? conns : []).length > 0;
    return {
      id: null, source: 'NONE', savedGone: !!saved, isLive: false,
      reason: hadAny
        ? '쓸 수 있는 거래소 연결이 없습니다 — 등록된 키가 전부 출금 권한을 갖고 있습니다'
        : '거래소 연결이 없습니다',
    };
  }

  const savedConn = saved ? usable.find(c => String(c.id) === saved) : null;
  if (savedConn) {
    return {
      id: String(savedConn.id), source: 'SAVED', savedGone: false,
      isLive: isLiveConn(savedConn), reason: '',
    };
  }

  const savedGone = !!saved;
  const testnet = preferTestnet ? usable.find(c => !isLiveConn(c)) : null;
  const picked = testnet ?? usable[0];
  const source: PickSource = testnet ? 'PREFERRED_TESTNET'
    : usable.length === 1 ? 'ONLY_ONE' : 'FIRST';

  // **말없이 옮기지 않는다.** 옮기는 것 자체는 맞지만, 다음 주문이
  // 사용자가 모르는 계좌로 나가는 것은 다른 이야기다.
  const parts: string[] = [];
  if (savedGone) parts.push('전에 쓰던 계좌가 목록에 없습니다');
  if (source === 'FIRST' && usable.length > 1) {
    parts.push(`테스트넷 연결이 없어 ${labelOf(picked)}(으)로 시작합니다`);
  } else if (savedGone) {
    parts.push(`${labelOf(picked)}(으)로 바꿨습니다`);
  }
  if (isLiveConn(picked) && parts.length === 0) {
    parts.push(`실전 계좌(${labelOf(picked)})가 선택되었습니다 — 주문하면 진짜 돈이 나갑니다`);
  }

  return {
    id: String(picked.id), source, savedGone,
    isLive: isLiveConn(picked),
    reason: parts.join(' · '),
  };
}

/**
 * 지금 들고 있는 id가 아직 유효한가.
 *
 * **목록에 없는 id를 그대로 두면 안 된다.** 화면은 계좌가 선택된 것처럼
 * 그리는데 그 계좌는 없고, 주문은 그제서야 실패한다. 누를 수 없는 것은
 * 눌러 보고 알 일이 아니다.
 */
export function connectionStillValid(
  conns: ConnLike[] | null | undefined, id: string | null | undefined,
): boolean {
  const s = String(id ?? '').trim();
  if (!s) return false;
  return usableConnections(conns).some(c => String(c.id) === s);
}
