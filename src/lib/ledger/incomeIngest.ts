// src/lib/ledger/incomeIngest.ts
//
// **수수료와 펀딩을 모르면 "번 것"을 말할 수 없다.**
//
// `tradingPnlOf()`는 네 항을 전부 알 때만 숫자를 만든다:
//
//   매매손익 = 자산변화 − 외부유입 − 수수료 − 펀딩
//
// 지금까지 수수료와 펀딩은 아무도 안 모았다. 그래서 장부 표는 있는데
// 매매손익은 영원히 `null`이었다 — 048(자산 스냅샷)이 표만 만들어지고
// 채우는 코드가 없던 것과 **정확히 같은 고장**이다.
//
// 거래소는 이미 답을 갖고 있다
// ───────────────────────────
//   Binance  `/fapi/v1/income`         incomeType별로 다 준다
//   Gate     `/futures/usdt/account_book`  pnl · fee · fund
//
// 두 곳의 모양이 다르지만 `getGateAccountBook`이 이미 바이낸스 이름으로
// 맞춰 준다. 이 파일은 **그 공통 모양을 장부 사건으로 옮기기만** 한다.
//
// 조용히 틀리지 않기 위한 규칙
// ───────────────────────────
// 모르는 종류를 손익으로 읽지 않는다. 테스트넷 충전을 수익으로 읽지
// 않는다. 그리고 **어느 구간을 읽었는지 기록하지 않으면 완전성을
// 말할 수 없다** — 절반만 읽고 계산하면 나머지 절반이 전부 수익이 된다.

import type { LedgerEvent, LedgerEnv, LedgerKind } from './ledgerEvent';

/** 두 거래소가 공통으로 맞춰 주는 모양 */
export interface IncomeRow {
  incomeType: string;
  income: number;
  time: number;
  symbol?: string | null;
  /** 거래소가 주는 고유 번호가 있으면. **문자열이다** */
  tranId?: string | null;
}

export type IncomeClass = LedgerKind | 'UNKNOWN';

/**
 * 거래소가 준 종류 이름 → 장부 종류.
 *
 * **모르는 이름을 손익으로 읽지 않는다.** 거래소는 종류를 늘린다
 * (Binance만 해도 10가지가 넘고 계속 는다). 모르는 것을 REALIZED_PNL로
 * 뭉뚱그리면 그게 곧 없는 수익을 만드는 길이다.
 */
export function classifyIncome(type: string): IncomeClass {
  const t = String(type ?? '').trim().toUpperCase();
  switch (t) {
    case 'REALIZED_PNL': return 'REALIZED_PNL';
    case 'COMMISSION':
    case 'FEE': return 'FEE';
    case 'FUNDING_FEE':
    case 'FUND': return 'FUNDING';
    case 'TRANSFER':
    case 'INTERNAL_TRANSFER': return 'TRANSFER';
    case 'DEPOSIT': return 'DEPOSIT';
    case 'WITHDRAW':
    case 'WITHDRAWAL': return 'WITHDRAWAL';
    // Gate는 입출금을 dnw 하나로 준다. 부호로 가른다(아래에서).
    case 'DNW': return 'TRANSFER';
    // **테스트넷 가상자금. 절대 수익이 아니다.**
    case 'WELCOME_BONUS':
    case 'TEST_FUND':
    case 'TESTNET_CREDIT': return 'TESTNET_CREDIT';
    case 'INSURANCE_CLEAR':
    case 'REFERRAL_KICKBACK':
    case 'COMMISSION_REBATE': return 'ADJUSTMENT';
    default: return 'UNKNOWN';
  }
}

export interface IngestResult {
  events: LedgerEvent[];
  /** 알아보지 못해 적지 않은 것들 — **조용히 버리지 않는다** */
  skipped: Array<{ type: string; count: number }>;
  /** 이번에 읽은 구간 */
  fromMs: number | null;
  toMs: number | null;
}

/**
 * 거래소 원장 → 장부 사건.
 *
 * **부호를 뒤집지 않는다.** 거래소는 이미 계좌 관점(들어오면 +, 나가면 −)
 * 으로 준다. 여기서 다시 뒤집으면 수수료가 수익이 된다.
 */
export function incomeToEvents(i: {
  rows: IncomeRow[] | null | undefined;
  userId: string;
  env: LedgerEnv;
  connectionId: string;
  exchange: string;
  currency?: string;
}): IngestResult {
  const rows = Array.isArray(i?.rows) ? i.rows : [];
  const events: LedgerEvent[] = [];
  const skipCount = new Map<string, number>();
  let fromMs: number | null = null;
  let toMs: number | null = null;

  for (const r of rows) {
    const t = Number(r?.time);
    const amount = Number(r?.income);
    // **시각이나 금액이 숫자가 아니면 적지 않는다.** 0으로 적으면
    // 그 사건은 영원히 '없었던 일'이 된다.
    if (!Number.isFinite(t) || t <= 0 || !Number.isFinite(amount)) {
      skipCount.set('BAD_ROW', (skipCount.get('BAD_ROW') ?? 0) + 1);
      continue;
    }
    if (fromMs == null || t < fromMs) fromMs = t;
    if (toMs == null || t > toMs) toMs = t;

    let kind = classifyIncome(String(r?.incomeType ?? ''));
    if (kind === 'UNKNOWN') {
      // 모르는 종류. **손익으로 읽지 않고 그 사실을 남긴다.**
      const key = String(r?.incomeType ?? '(빈 값)').toUpperCase();
      skipCount.set(key, (skipCount.get(key) ?? 0) + 1);
      continue;
    }
    // Gate의 dnw는 부호로 입금/출금을 가른다.
    if (String(r?.incomeType ?? '').toUpperCase() === 'DNW') {
      kind = amount >= 0 ? 'DEPOSIT' : 'WITHDRAWAL';
    }
    // **테스트넷 환경의 입금은 가상자금이다.** 실전 입금과 같은 칸에
    // 넣으면 나중에 둘을 못 가른다.
    if (i.env === 'TESTNET' && (kind === 'DEPOSIT' || kind === 'TRANSFER') && amount > 0) {
      kind = 'TESTNET_CREDIT';
    }

    events.push({
      userId: i.userId,
      env: i.env,
      connectionId: i.connectionId,
      exchange: i.exchange,
      kind: kind as LedgerKind,
      symbol: r?.symbol ? String(r.symbol) : null,
      // 거래소가 준 고유 번호가 있으면 그대로 쓴다. **문자열이다** (#139)
      venueOrderId: r?.tranId != null ? String(r.tranId) : null,
      amount,
      currency: i.currency || 'USDT',
      occurredAtMs: t,
      source: 'EXCHANGE_INCOME',
      note: `거래소 원장 ${String(r?.incomeType ?? '')}`,
    } as LedgerEvent);
  }

  return {
    events,
    skipped: Array.from(skipCount.entries()).map(([type, count]) => ({ type, count })),
    fromMs, toMs,
  };
}

// ── 어디까지 읽었는가 ──

export interface Coverage {
  /** 이 시각부터 덮여 있다 */
  fromMs: number | null;
  /** 이 시각까지 덮여 있다 */
  toMs: number | null;
}

/**
 * 다음에 어디부터 읽을 것인가.
 *
 * **겹쳐서 읽는다.** 거래소는 사건을 조금 늦게 노출하기도 하고, 그 사이에
 * 시작점을 딱 맞춰 두면 그 몇 건이 영원히 빠진다. 중복은 열쇠가 막는다 —
 * 빠지는 것보다 겹치는 것이 낫다.
 */
export const OVERLAP_MS = 10 * 60_000;

/** 한 번에 이 기간보다 더 오래 거슬러 올라가지 않는다 */
export const MAX_BACKFILL_MS = 7 * 24 * 60 * 60_000;

export function nextIngestFrom(i: {
  coverage: Coverage | null | undefined;
  nowMs: number;
}): { fromMs: number; reason: string } {
  const to = i?.coverage?.toMs;
  if (to == null || !Number.isFinite(to)) {
    // 처음이다. 너무 멀리 거슬러 올라가면 한 번에 수천 건을 읽는다.
    return { fromMs: i.nowMs - MAX_BACKFILL_MS, reason: '첫 수집 — 최근 7일부터' };
  }
  const from = Math.max(to - OVERLAP_MS, i.nowMs - MAX_BACKFILL_MS);
  return { fromMs: from, reason: `지난 수집 지점에서 ${Math.round(OVERLAP_MS / 60_000)}분 겹쳐서` };
}

/**
 * 이 기간의 손익을 말해도 되는가.
 *
 * **덮이지 않은 구간이 있으면 안 된다.** 절반만 읽고 계산하면 나머지
 * 절반의 수수료와 펀딩이 전부 수익으로 둔갑한다.
 */
export function ledgerCovers(i: {
  coverage: Coverage | null | undefined;
  periodFromMs: number;
  periodToMs: number;
}): { complete: boolean; reason: string } {
  const c = i?.coverage;
  if (!c || c.fromMs == null || c.toMs == null) {
    return { complete: false, reason: '거래소 원장을 아직 읽은 적이 없습니다' };
  }
  if (c.fromMs > i.periodFromMs) {
    return {
      complete: false,
      reason: `${new Date(c.fromMs).toISOString().slice(0, 10)} 이전 구간이 장부에 없습니다 — `
        + '그 기간의 수수료·펀딩을 모르면 매매손익을 만들 수 없습니다',
    };
  }
  if (c.toMs < i.periodToMs) {
    const gapMin = Math.round((i.periodToMs - c.toMs) / 60_000);
    return { complete: false, reason: `최근 ${gapMin}분이 아직 수집되지 않았습니다` };
  }
  return { complete: true, reason: '요청 기간이 장부에 모두 덮여 있습니다' };
}
