// src/lib/portfolio/walletAccounts.ts
//
// **지갑이 매매 화면과 다른 계좌를 보면 안 된다.**
//
// 지금 지갑 > 테스트넷에는 "이 환경에 연결된 계좌가 없습니다"가 떠 있다.
// 그런데 매매 화면에서는 같은 순간에 Gate 테스트넷으로 주문이 나간다.
// 계좌가 없는 게 아니라 **지갑이 안 물어본 것**이다.
//
// 이 저장소에서 반복되는 고장이 정확히 이 모양이다 —
// 기능은 있는데 서로 배선이 안 됨. 그래서 이 파일은 새 판정을 만들지
// 않고, 이미 주문이 쓰는 판정을 **그대로 가져다 쓴다.**
//
//   src/lib/markets/tradeMode.ts
//   isLiveConnection(c) → c.is_testnet === false
//
// 여기서만 다르게 읽으면 화면이 말하는 계좌와 실제로 주문이 깎는 계좌가
// 갈린다. 그건 이미 한 번 난 사고다.
//
// 환경 매핑
// ─────────
//   LIVE      isLiveConnection === true
//   TESTNET   isLiveConnection === false  ← is_testnet이 null/undefined면 여기
//   MOCK      거래소 연결이 아니다 (앱 안의 모의 장부)
//
// **null을 실전으로 올리지 않는다.** 그리고 반대로, 테스트넷 연결을
// 필터에서 빠뜨리지도 않는다 — 둘 다 "계좌가 있는데 없다고 뜨는" 결과가
// 되고, 그게 지금 화면에 뜬 그 문구다.

import { isLiveConnection, type ConnLike } from '../markets/tradeMode';
import type { WalletEnv } from './wallet';
import type { CellState } from './walletDetail';

/**
 * 화면이 지금 어느 단계인가.
 *
 * **`READY`가 기본값이면 안 된다.** 아직 물어보지도 않았는데 "계좌
 * 없음"이 먼저 뜨고, 잠시 뒤에 계좌가 나타난다. 사용자는 그 첫 화면을
 * 보고 "연결이 풀렸나" 한다.
 */
export type LoadPhase = 'LOADING' | 'READY' | 'FAILED';

export interface WalletAccount {
  /** 매매·자동매매가 쓰는 것과 **같은 id**여야 한다 */
  connectionId: string;
  label: string;
  exchange: string;
  env: WalletEnv;
  /** 잔고를 물어볼 수 있는가 */
  queryable: boolean;
  /** 못 물어보는 이유. 물어볼 수 있으면 빈 문자열 */
  blockedReason: string;
  connection: CellState;
}

/** 거래소 id를 사람이 읽는 이름으로. 모르는 값은 그대로 둔다 */
const EX_NAME: Record<string, string> = {
  binance: 'Binance', gate: 'Gate', gateio: 'Gate',
  bybit: 'Bybit', upbit: 'Upbit', bithumb: 'Bithumb', okx: 'OKX', kis: '한국투자증권',
};

function exchangeOf(c: any): string {
  return String(c?.exchange_id ?? c?.exchange ?? '').trim().toLowerCase();
}

/**
 * 이 연결이 지갑의 어느 환경에 속하는가.
 *
 * **주문이 쓰는 판정을 그대로 쓴다.** 여기서 `is_testnet === true`처럼
 * 다르게 쓰면, 값이 비어 있는 연결이 지갑에서는 실전으로 보이고 주문은
 * 테스트넷으로 나간다.
 */
export function envOfConnection(c: ConnLike | null | undefined): WalletEnv {
  return isLiveConnection(c) ? 'LIVE' : 'TESTNET';
}

/**
 * 연결 목록을 지갑 계좌 목록으로.
 *
 * **출금 권한 키를 목록에서 지우지 않는다.** 주문 경로는 그런 키를
 * 빼지만(주문에 쓰면 키가 새는 순간 자금까지 나간다), 지갑에서까지
 * 빼 버리면 계좌가 있는데 "계좌 없음"이 뜬다 — 사용자는 연결이
 * 풀렸다고 믿고 키를 다시 등록한다. 대신 왜 못 읽는지를 적는다.
 */
export function accountsFromConnections(
  conns: any[] | null | undefined,
): WalletAccount[] {
  const list = Array.isArray(conns) ? conns : [];
  return list
    .filter(c => c && String(c.id ?? '').trim())
    .map(c => {
      const ex = exchangeOf(c);
      const withdrawal = c.has_withdrawal === true;
      const supported = ex === 'binance' || ex === 'gate' || ex === 'gateio';
      const env = envOfConnection(c);
      const name = EX_NAME[ex] || (ex ? ex.toUpperCase() : '거래소 미상');

      return {
        connectionId: String(c.id),
        label: `${name} ${env === 'LIVE' ? 'Live' : 'Testnet'}`
          + (c.label || c.nickname ? ` · ${c.label || c.nickname}` : ''),
        exchange: ex,
        env,
        queryable: supported && !withdrawal,
        blockedReason: withdrawal
          ? '출금 권한이 있는 키라 잔고를 조회하지 않습니다 — 거래 전용 키로 다시 등록하세요'
          : !supported
            ? `${name} 지갑 조회는 아직 지원하지 않습니다 (Binance·Gate만)`
            : '',
        connection: (supported && !withdrawal ? 'SYNCING' : 'UNSUPPORTED') as CellState,
      };
    });
}

/**
 * 이 환경에서 보여 줄 계좌.
 *
 * MOCK은 거래소 연결이 아니다 — 앱 안의 모의 장부라 여기엔 아무것도
 * 없는 것이 맞다. 그 사실을 화면이 적어야 "연결이 안 됐나"로 오해하지 않는다.
 */
export function accountsInEnv(env: WalletEnv, accounts: WalletAccount[] | null | undefined): WalletAccount[] {
  const list = Array.isArray(accounts) ? accounts : [];
  return list.filter(a => a && a.env === env);
}

export interface AccountsVerdict {
  phase: LoadPhase;
  accounts: WalletAccount[];
  /** 화면에 그대로 적을 한 줄 */
  message: string;
  /** 이 환경에 계좌가 정말 없는가. **읽기 실패와 구분한다** */
  trulyEmpty: boolean;
}

/**
 * 화면이 무엇을 그릴 것인가.
 *
 * **셋을 절대 섞지 않는다:**
 *
 *   읽는 중          "계좌 불러오는 중"
 *   읽었는데 없음     "연결된 계좌가 없습니다"
 *   못 읽음          "계좌 목록을 확인하지 못했습니다"
 *
 * 지금 화면은 셋을 하나로 뭉개서 "연결된 계좌가 없습니다"만 띄운다.
 * 그래서 계좌가 멀쩡히 있는데도 없다고 나온다.
 */
export function accountsVerdict(
  env: WalletEnv,
  phase: LoadPhase,
  accounts: WalletAccount[] | null | undefined,
  error?: string,
): AccountsVerdict {
  if (phase === 'LOADING') {
    return { phase, accounts: [], trulyEmpty: false, message: '계좌 불러오는 중…' };
  }
  if (phase === 'FAILED') {
    return { phase, accounts: [], trulyEmpty: false,
      message: '계좌 목록을 확인하지 못했습니다 — 연결이 없다는 뜻이 아닙니다'
        + (error ? ` (${error})` : '') };
  }

  const inEnv = accountsInEnv(env, accounts);
  if (inEnv.length > 0) {
    return { phase, accounts: inEnv, trulyEmpty: false, message: '' };
  }

  // 읽었는데 이 환경에 없다. **다른 환경에는 있는지까지 말한다** —
  // "테스트넷엔 없지만 실전엔 2개 있다"를 알면 탭을 잘못 봤다는 걸 안다.
  const others = (Array.isArray(accounts) ? accounts : []).filter(a => a.env !== env);
  return {
    phase, accounts: [], trulyEmpty: true,
    message: env === 'MOCK'
      ? '모의는 거래소 연결이 아니라 앱 안의 장부입니다 — 연결이 없는 것이 정상입니다'
      : others.length > 0
        ? `이 환경에 연결된 계좌가 없습니다 — 다른 환경에 ${others.length}개 있습니다`
          + ` (${[...new Set(others.map(o => o.env))].join(', ')})`
        : '연결된 계좌가 없습니다',
  };
}

// ── /api/wallets 응답을 지갑이 쓰는 모양으로 ──────────────

export interface WalletFetchResult {
  connectionId: string;
  ok: boolean;
  /** 라우트가 준 트리 (lib/markets/wallets의 모양) */
  tree: any;
  error: string;
}

/**
 * 선물 지갑을 읽었는가 — 그리고 못 읽었으면 왜.
 *
 * `/api/wallets`는 현물과 선물을 따로 부르고 **하나가 죽어도 나머지를
 * 돌려준다.** 그래서 `res.ok`가 참이어도 선물은 실패했을 수 있고,
 * 그 사실은 `tree.futures.ok === false`에만 있다. 이걸 안 읽으면
 * 화면은 실패한 지갑을 '잔고 0'으로 그린다.
 */
export function futuresStateOf(r: WalletFetchResult | null | undefined): CellState {
  if (!r) return 'SYNCING';
  if (!r.ok) return r.error && /연결|network|fetch/i.test(r.error) ? 'DISCONNECTED' : 'FAILED';
  const f = r.tree?.futures;
  if (!f) return 'FAILED';
  if (f.ok === false) return 'FAILED';
  return 'OK';
}

/** 현물 쪽도 같은 이유로 따로 본다 */
export function spotStateOf(r: WalletFetchResult | null | undefined): CellState {
  if (!r) return 'SYNCING';
  if (!r.ok) return r.error && /연결|network|fetch/i.test(r.error) ? 'DISCONNECTED' : 'FAILED';
  const s = r.tree?.spot;
  if (!s) return 'FAILED';
  if (s.ok === false) return 'FAILED';
  return 'OK';
}

export interface EquitySum {
  total: number | null;
  /** 합계를 낼 수 있었는가 */
  complete: boolean;
  /** 못 읽은 계좌 이름 */
  missing: string[];
  /** 읽는 데 성공한 계좌 수 */
  readCount: number;
  note: string;
}

/**
 * 이 환경의 총자산.
 *
 * **한 계좌라도 못 읽으면 합계를 내지 않는다.** 두 계좌 중 하나만 더해
 * '총 평가자산'이라고 적으면, 못 읽은 계좌의 돈이 사라진 것처럼 보인다.
 *
 * 조회에 성공했는데 잔고가 0인 것과, 조회 자체를 못 한 것은 다르다 —
 * 앞은 합계에 0으로 들어가고 뒤는 합계를 막는다.
 */
export function equitySumOf(
  accounts: WalletAccount[] | null | undefined,
  results: Map<string, WalletFetchResult> | null | undefined,
): EquitySum {
  const list = Array.isArray(accounts) ? accounts : [];
  const map = results ?? new Map<string, WalletFetchResult>();

  if (list.length === 0) {
    return { total: null, complete: false, missing: [], readCount: 0,
      note: '' };
  }

  const missing: string[] = [];
  let sum = 0, readCount = 0;

  for (const a of list) {
    if (!a.queryable) { missing.push(a.label); continue; }
    const r = map.get(a.connectionId);
    const v = totalEquityFromTree(r);
    if (v === null) { missing.push(a.label); continue; }
    sum += v;
    readCount++;
  }

  if (missing.length > 0) {
    return { total: null, complete: false, missing, readCount,
      note: `${missing.join(', ')}을(를) 읽지 못해 총자산을 내지 않습니다 —`
        + ' 나머지만 더하면 못 읽은 계좌의 돈이 사라진 것처럼 보입니다' };
  }
  return { total: sum, complete: true, missing: [], readCount, note: '' };
}

/**
 * 트리에서 총자산 하나 뽑기.
 *
 * **못 읽었으면 null이다.** `?? 0`을 쓰면 실패가 잔고 0이 된다.
 */
export function totalEquityFromTree(r: WalletFetchResult | null | undefined): number | null {
  if (!r || !r.ok) return null;
  const t = r.tree;
  if (!t) return null;
  // 라우트가 이미 "한쪽이라도 모르면 null"로 계산해 둔 값을 그대로 쓴다.
  const v = t.totalUsdt ?? t.total ?? null;
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
