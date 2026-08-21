// src/lib/ledger/ledgerEvent.ts
//
// **잔고가 변한 것과 번 것은 다르다.**
//
// 지금까지 손익은 자산 스냅샷의 차이로 추측했다. 그런데 자산은 매매가
// 아닌 이유로도 변한다 — 입출금, 이체, 수수료, 펀딩, 그리고
// **Gate 테스트넷 일일 충전과 Binance 테스트 자금 초기화.**
//
// 마지막이 특히 위험하다. 테스트넷 충전을 수익으로 세면 전략이 실제로
// 버는 것처럼 보이고, 그 숫자를 믿고 실전으로 넘어간다. 그래서:
//
//     매매손익 = 자산변화 − 외부유입 − 수수료 − 펀딩
//
// 이 식은 **네 항을 전부 알 때만** 성립한다. 하나라도 모르면 매매손익도
// 모르는 것이다 — 부분합계로 "번 것"을 말하지 않는다.

export type LedgerKind =
  /** 주문 의도 (아직 거래소에 안 갔다) */
  | 'ORDER_INTENT'
  /** 거래소가 접수했다 */
  | 'ORDER_ACK'
  /** 체결 */
  | 'FILL'
  /** 수수료 */
  | 'FEE'
  /** 펀딩비 */
  | 'FUNDING'
  /** 실현손익 */
  | 'REALIZED_PNL'
  /** 그 시점의 미실현손익 (참고값) */
  | 'UNREALIZED_SNAPSHOT'
  /** 외부에서 들어온 돈 */
  | 'DEPOSIT'
  | 'WITHDRAWAL'
  | 'TRANSFER'
  /** **테스트넷 가상자금.** 절대 수익이 아니다 */
  | 'TESTNET_CREDIT'
  | 'TESTNET_RESET'
  | 'DIVIDEND'
  | 'INTEREST'
  | 'FX'
  | 'ROLLOVER'
  /** 틀린 것을 고칠 때. **지우지 않고 더한다** */
  | 'ADJUSTMENT';

export type LedgerEnv = 'LIVE' | 'TESTNET' | 'MOCK';
export type LedgerSource = 'EXCHANGE_FILL' | 'EXCHANGE_INCOME' | 'ENGINE' | 'MANUAL';

export interface LedgerEvent {
  userId: string;
  env: LedgerEnv;
  connectionId?: string | null;
  exchange?: string | null;
  kind: LedgerKind;
  strategyId?: string | null;
  strategyHash?: string | null;
  symbol?: string | null;
  /** **거래소 주문 번호는 문자열이다** (#139) */
  venueOrderId?: string | null;
  orderIntentId?: string | null;
  /** 계좌 관점의 부호: 들어오면 +, 나가면 − */
  amount: number;
  currency?: string | null;
  quantity?: number | null;
  price?: number | null;
  occurredAtMs: number;
  source: LedgerSource;
  correlationId?: string | null;
  note?: string | null;
}

/** **외부에서 들어오고 나간 돈.** 매매로 번 것이 아니다 */
export const EXTERNAL_FLOW_KINDS: LedgerKind[] = [
  'DEPOSIT', 'WITHDRAWAL', 'TRANSFER', 'TESTNET_CREDIT', 'TESTNET_RESET',
];

/** 매매의 결과로 생긴 돈 */
export const TRADING_KINDS: LedgerKind[] = ['REALIZED_PNL', 'FILL'];

const s = (v: any): string => String(v ?? '').trim();
const num = (v: any): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * **같은 사건을 두 번 적지 않게 하는 열쇠.**
 *
 * 거래소를 다시 읽거나 워커가 재시작하면 같은 체결이 또 온다. 그때
 * 합계가 두 배가 되면 장부는 쓸모가 없다.
 *
 * **시각을 넣지 않는다.** `Date.now()`를 섞으면 재시도마다 새 열쇠가
 * 되고, 그건 멱등이 아니라 중복이다. 같은 논리적 사건은 같은 열쇠여야
 * 한다 — 주문 id·종류·수량·발생 시각(거래소가 준 값)으로 짓는다.
 */
export function idempotencyKeyOf(e: {
  env?: any; connectionId?: any; kind?: any; venueOrderId?: any;
  symbol?: any; occurredAtMs?: any; amount?: any; quantity?: any;
}): string {
  const parts = [
    s(e?.env).toUpperCase() || 'UNKNOWN_ENV',
    s(e?.connectionId) || 'no-conn',
    s(e?.kind).toUpperCase() || 'UNKNOWN_KIND',
    // 주문 번호는 문자열 그대로. 반올림된 숫자를 열쇠에 넣으면 서로
    // 다른 체결이 같은 열쇠를 갖는다.
    s(e?.venueOrderId) || 'no-order',
    s(e?.symbol).toUpperCase() || 'no-symbol',
    String(num(e?.occurredAtMs) ?? 'no-time'),
    String(num(e?.amount) ?? 'no-amount'),
    String(num(e?.quantity) ?? ''),
  ];
  return parts.join('|');
}

export interface EventVerdict {
  ok: boolean;
  code: 'OK' | 'MISSING_USER' | 'BAD_ENV' | 'BAD_KIND' | 'BAD_AMOUNT' | 'BAD_TIME' | 'BAD_SOURCE';
  event: (LedgerEvent & { idempotencyKey: string }) | null;
  message: string;
}

const KINDS = new Set<string>([
  'ORDER_INTENT', 'ORDER_ACK', 'FILL', 'FEE', 'FUNDING', 'REALIZED_PNL',
  'UNREALIZED_SNAPSHOT', 'DEPOSIT', 'WITHDRAWAL', 'TRANSFER',
  'TESTNET_CREDIT', 'TESTNET_RESET', 'DIVIDEND', 'INTEREST', 'FX',
  'ROLLOVER', 'ADJUSTMENT',
]);

/**
 * 사건 하나를 값으로 확정한다.
 *
 * **모르는 종류를 기타로 눕히지 않는다.** 분류를 못 하면 합계에서
 * 어느 항에 넣을지도 못 정한다 — 그건 조용히 틀리는 길이다.
 */
export function ledgerEventOf(raw: any): EventVerdict {
  const bad = (code: EventVerdict['code'], message: string): EventVerdict =>
    ({ ok: false, code, event: null, message });

  const userId = s(raw?.userId);
  if (!userId) return bad('MISSING_USER', 'userId가 없습니다');

  const env = s(raw?.env).toUpperCase();
  if (env !== 'LIVE' && env !== 'TESTNET' && env !== 'MOCK') {
    return bad('BAD_ENV', `환경은 LIVE · TESTNET · MOCK 중 하나입니다 (받은 값: ${raw?.env})`);
  }

  const kind = s(raw?.kind).toUpperCase();
  if (!KINDS.has(kind)) return bad('BAD_KIND', `모르는 사건 종류입니다: ${raw?.kind}`);

  const amount = num(raw?.amount);
  if (amount == null) return bad('BAD_AMOUNT', '금액이 숫자가 아닙니다 — 0으로 적지 않습니다');

  const occurredAtMs = num(raw?.occurredAtMs);
  if (occurredAtMs == null || occurredAtMs <= 0) {
    return bad('BAD_TIME', '발생 시각이 없습니다 — "지금"으로 적으면 순서가 뒤섞입니다');
  }

  const source = s(raw?.source).toUpperCase();
  if (!['EXCHANGE_FILL', 'EXCHANGE_INCOME', 'ENGINE', 'MANUAL'].includes(source)) {
    return bad('BAD_SOURCE', `출처를 알 수 없습니다: ${raw?.source}`);
  }

  const event: LedgerEvent = {
    userId, env: env as LedgerEnv,
    connectionId: s(raw?.connectionId) || null,
    exchange: s(raw?.exchange) || null,
    kind: kind as LedgerKind,
    strategyId: s(raw?.strategyId) || null,
    strategyHash: s(raw?.strategyHash) || null,
    symbol: s(raw?.symbol).toUpperCase() || null,
    venueOrderId: s(raw?.venueOrderId) || null,
    orderIntentId: s(raw?.orderIntentId) || null,
    amount, currency: s(raw?.currency).toUpperCase() || 'USDT',
    quantity: num(raw?.quantity), price: num(raw?.price),
    occurredAtMs, source: source as LedgerSource,
    correlationId: s(raw?.correlationId) || null,
    note: s(raw?.note) || null,
  };

  return {
    ok: true, code: 'OK',
    event: { ...event, idempotencyKey: idempotencyKeyOf(event) },
    message: '',
  };
}

// ── 합계 ─────────────────────────────────────────────

export interface LedgerTotals {
  /** 외부에서 순수하게 들어온 돈 (입금 − 출금 + 이체 + 테스트넷 충전) */
  externalFlow: number;
  /** **테스트넷 가상자금만 따로.** 수익과 절대 섞지 않는다 */
  testnetCredit: number;
  fees: number;
  funding: number;
  realizedPnl: number;
  /** 사건 수 */
  count: number;
  /** 종류별 개수 */
  byKind: Record<string, number>;
}

/** 사건 목록을 항목별로 더한다. **분류를 못 한 것은 어디에도 안 들어간다** */
export function ledgerTotals(events: Array<{ kind: string; amount: number }>): LedgerTotals {
  const list = Array.isArray(events) ? events : [];
  const out: LedgerTotals = {
    externalFlow: 0, testnetCredit: 0, fees: 0, funding: 0, realizedPnl: 0,
    count: 0, byKind: {},
  };
  for (const e of list) {
    const k = s(e?.kind).toUpperCase();
    const a = num(e?.amount);
    if (!KINDS.has(k) || a == null) continue;
    out.count++;
    out.byKind[k] = (out.byKind[k] ?? 0) + 1;
    if (k === 'FEE') out.fees += a;
    else if (k === 'FUNDING') out.funding += a;
    else if (k === 'REALIZED_PNL') out.realizedPnl += a;
    else if (k === 'TESTNET_CREDIT' || k === 'TESTNET_RESET') {
      out.testnetCredit += a; out.externalFlow += a;
    } else if (EXTERNAL_FLOW_KINDS.includes(k as LedgerKind)) out.externalFlow += a;
  }
  const r = (n: number) => Number(n.toFixed(8));
  return {
    ...out,
    externalFlow: r(out.externalFlow), testnetCredit: r(out.testnetCredit),
    fees: r(out.fees), funding: r(out.funding), realizedPnl: r(out.realizedPnl),
  };
}

export interface TradingPnl {
  value: number | null;
  complete: boolean;
  /** 무엇을 몰라서 확정 못 했는가 */
  missing: string[];
  reason: string;
}

/**
 * **매매로 번 것.**
 *
 *     매매손익 = 자산변화 − 외부유입 − 수수료 − 펀딩
 *
 * 네 항을 전부 알 때만 숫자를 만든다. 하나라도 모르면 null이다 —
 * 부분합계로 "번 것"을 말하면, 못 읽은 입금이 그대로 수익이 된다.
 *
 * 그리고 장부가 **그 기간을 다 덮고 있어야** 한다. 사건을 절반만 읽고
 * 계산하면 나머지 절반이 전부 매매손익으로 둔갑한다.
 */
export function tradingPnlOf(i: {
  equityChange: number | null | undefined;
  totals: LedgerTotals | null | undefined;
  /** 장부가 이 기간을 빠짐없이 덮는가 */
  ledgerComplete?: boolean;
}): TradingPnl {
  const missing: string[] = [];
  const eq = num(i?.equityChange);
  if (eq == null) missing.push('자산 변화');
  if (!i?.totals) missing.push('장부');
  if (i?.ledgerComplete !== true) missing.push('장부 완전성');

  if (missing.length > 0) {
    return {
      value: null, complete: false, missing,
      reason: `${missing.join(' · ')}을 확인하지 못해 매매 손익을 확정하지 않습니다 — `
        + '부분 합계로 "번 것"을 말하면 못 읽은 입금이 수익으로 둔갑합니다',
    };
  }

  const t = i.totals!;
  const value = Number((eq! - t.externalFlow - t.fees - t.funding).toFixed(8));
  return {
    value, complete: true, missing: [],
    reason: t.testnetCredit !== 0
      ? `자산 변화에서 외부 유입(테스트넷 충전 ${t.testnetCredit} 포함) · 수수료 · 펀딩을 뺀 값입니다`
      : '자산 변화에서 외부 유입 · 수수료 · 펀딩을 뺀 값입니다',
  };
}
