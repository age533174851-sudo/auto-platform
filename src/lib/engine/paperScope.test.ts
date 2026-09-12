// src/lib/engine/paperScope.test.ts
//
// **전용 계좌가 생기는 날 터질 것을, 생기기 전에 고정한다.**
//
// 무엇이 있었나
// ─────────────
// `081`이 모의 계좌를 사용자당 여러 개가 될 수 있게 바꿨다. 그때 **계좌
// 표**를 읽는 다섯 곳은 `is_default`로 좁혔는데, `paper_positions`를 읽는
// 자리는 **한 곳도 안 좁혔다.** 전부 `user_id`만 봤다.
//
// 계좌가 하나인 동안은 증상이 없다. 그래서 시험이 없으면 아무도 모른다.
// 전용 계좌(챌린지 등)가 처음 생기는 날 이렇게 된다:
//
//   가용 증거금   전용 계좌 증거금이 기본 계좌 예산을 깎는다
//   총자산        지갑에 전용 계좌 포지션이 섞인다
//   REVERSE       기본 계좌 신호가 전용 계좌 포지션을 닫는다
//
// 그래서 여기서는 **"어떤 필터로 물었는가"를 기록해서** 검사한다. 결과
// 숫자만 보면 가짜 데이터를 어떻게 만드느냐에 따라 우연히 맞을 수 있다.
// 실제로 계좌를 좁혔는지는 **질의 자체**를 봐야 한다.
//
// 그리고 반대 방향도 함께 고정한다: **기본 계좌 경로는 지금까지처럼
// 동작해야 한다.** 한쪽으로만 기울면 하위호환이 깨진다.

import { test, eq, assert } from '../../test/harness';
import { paperScopePlan, resolvePaperScope, paperScopeFailed, defaultPaperAccountId } from './paperScope';

// ── 질의를 기록하는 가짜 Supabase ──
//
// `.eq()`가 실제로 무엇으로 불렸는지 남긴다. 반환값은 테이블별로 미리 넣는다.
interface Recorded { table: string; filters: Array<[string, any]> }

function fakeSb(rows: Record<string, any[]>, opts?: { errorOn?: string }) {
  const calls: Recorded[] = [];
  const make = (table: string) => {
    const rec: Recorded = { table, filters: [] };
    calls.push(rec);
    const q: any = {
      select() { return q; },
      order() { return q; },
      limit() { return q; },
      gte() { return q; },
      eq(col: string, val: any) { rec.filters.push([col, val]); return q; },
      maybeSingle() {
        if (opts?.errorOn === table) return Promise.resolve({ data: null, error: { message: 'boom' } });
        return Promise.resolve({ data: match(table, rec)[0] ?? null, error: null });
      },
      then(res: any) {
        if (opts?.errorOn === table) return Promise.resolve({ data: null, error: { message: 'boom' } }).then(res);
        return Promise.resolve({ data: match(table, rec), error: null }).then(res);
      },
    };
    return q;
  };
  const match = (table: string, rec: Recorded) =>
    (rows[table] ?? []).filter(r => rec.filters.every(([c, v]) => r[c] === v));
  return { sb: { from: make }, calls };
}

const DEFAULT_ACCT = 'acct-default';
const CHALLENGE_ACCT = 'acct-challenge';
const USER = 'user-1';

const ACCOUNTS = [
  { id: DEFAULT_ACCT, user_id: USER, is_default: true, balance: 1000 },
  { id: CHALLENGE_ACCT, user_id: USER, is_default: false, balance: 100 },
];

/** 두 계좌에 각각 열린 포지션이 하나씩 있다 */
const POSITIONS = [
  { id: 'p-default', user_id: USER, paper_account_id: DEFAULT_ACCT, status: 'open',
    symbol: 'BTCUSDT', side: 'SHORT', margin: 100, realized_pnl: null },
  { id: 'p-challenge', user_id: USER, paper_account_id: CHALLENGE_ACCT, status: 'open',
    symbol: 'BTCUSDT', side: 'SHORT', margin: 60, realized_pnl: null },
];

/** 이 질의가 계좌로 좁혔는가 */
const scopedTo = (c: Recorded, id: string) =>
  c.filters.some(([col, v]) => col === 'paper_account_id' && v === id);

export function runPaperScopeTests() {
  // ── 계좌를 정하는 규칙 ──
  test('사용자를 모르면 계좌를 정하지 않는다', () => {
    const p = paperScopePlan({ userId: '', paperAccountId: 'x' });
    eq(p.kind, 'STOP');
    eq((p as any).code, 'NO_USER');
  });

  test('계좌를 명시하면 그 계좌, 안 하면 기본 계좌를 찾는다', () => {
    eq(paperScopePlan({ userId: USER, paperAccountId: CHALLENGE_ACCT }).kind, 'EXPLICIT');
    eq(paperScopePlan({ userId: USER }).kind, 'DEFAULT');
    // 공백만 있는 값은 '지정하지 않음'이다 — 빈 문자열로 질의하면 아무것도 안 나온다
    eq(paperScopePlan({ userId: USER, paperAccountId: '   ' }).kind, 'DEFAULT');
  });

  test('기본 계좌를 찾을 때 is_default로 좁혀 묻는다', async () => {
    const { sb, calls } = fakeSb({ paper_accounts: ACCOUNTS });
    const s = await resolvePaperScope(sb, USER);
    assert(!paperScopeFailed(s), '기본 계좌를 찾아야 한다');
    eq((s as any).accountId, DEFAULT_ACCT);
    eq((s as any).source, 'DEFAULT');
    const c = calls.find(x => x.table === 'paper_accounts')!;
    assert(c.filters.some(([k, v]) => k === 'is_default' && v === true), 'is_default로 좁혀야 한다');
  });

  // **남의 계좌를 넣으면 기본 계좌로 대신 처리하지 않는다.**
  // 대신 처리하면 사용자가 고른 적 없는 장부로 주문이 나간다.
  test('남의 계좌 id는 기본 계좌로 폴백하지 않고 멈춘다', async () => {
    const { sb } = fakeSb({ paper_accounts: ACCOUNTS });
    const s = await resolvePaperScope(sb, 'user-2', CHALLENGE_ACCT);
    assert(paperScopeFailed(s), '남의 계좌는 통과하면 안 된다');
    eq((s as any).code, 'NOT_OWNED');
  });

  test('명시 계좌는 소유자까지 함께 묻는다', async () => {
    const { sb, calls } = fakeSb({ paper_accounts: ACCOUNTS });
    const s = await resolvePaperScope(sb, USER, CHALLENGE_ACCT);
    assert(!paperScopeFailed(s));
    eq((s as any).accountId, CHALLENGE_ACCT);
    const c = calls.find(x => x.table === 'paper_accounts')!;
    assert(c.filters.some(([k, v]) => k === 'id' && v === CHALLENGE_ACCT), 'id로 물어야 한다');
    assert(c.filters.some(([k, v]) => k === 'user_id' && v === USER), '소유자도 물어야 한다');
  });

  // **조회 실패를 '계좌 없음'으로 읽지 않는다.**
  test('조회가 실패하면 없음이 아니라 UNREADABLE이다', async () => {
    const { sb } = fakeSb({ paper_accounts: ACCOUNTS }, { errorOn: 'paper_accounts' });
    const s = await resolvePaperScope(sb, USER);
    assert(paperScopeFailed(s));
    eq((s as any).code, 'UNREADABLE');
  });

  test('기본 계좌가 없으면 NO_ACCOUNT — 아무 계좌나 고르지 않는다', async () => {
    const { sb } = fakeSb({ paper_accounts: [{ id: CHALLENGE_ACCT, user_id: USER, is_default: false }] });
    const s = await resolvePaperScope(sb, USER);
    assert(paperScopeFailed(s));
    eq((s as any).code, 'NO_ACCOUNT');
  });

  test('defaultPaperAccountId는 못 찾으면 null이다 — 0이나 빈 문자열이 아니다', async () => {
    const { sb } = fakeSb({ paper_accounts: [] });
    eq(await defaultPaperAccountId(sb, USER), null);
    const ok = fakeSb({ paper_accounts: ACCOUNTS });
    eq(await defaultPaperAccountId(ok.sb, USER), DEFAULT_ACCT);
  });

  // ── 교차계좌 오염 회귀 ──

  test('용량 판정이 전용 계좌 증거금을 기본 계좌 예산에서 빼지 않는다', async () => {
    const { readPaperCapacity } = await import('./paperCapacity');
    const { sb, calls } = fakeSb({ paper_accounts: ACCOUNTS, paper_positions: POSITIONS });
    const cap = await readPaperCapacity(sb, USER);
    eq(cap.known, true);
    // 기본 계좌 포지션(증거금 100)만 세야 한다. 전용 계좌 60이 섞이면 160이 된다.
    eq((cap as any).usedMargin, 100, '전용 계좌 증거금이 섞였다');
    eq((cap as any).available, 900);
    const posQ = calls.find(x => x.table === 'paper_positions')!;
    assert(scopedTo(posQ, DEFAULT_ACCT), '포지션 질의가 계좌로 좁혀지지 않았다');
  });

  test('용량 판정이 명시 계좌를 받으면 그 계좌만 본다', async () => {
    const { readPaperCapacity } = await import('./paperCapacity');
    const { sb, calls } = fakeSb({ paper_accounts: ACCOUNTS, paper_positions: POSITIONS });
    const cap = await readPaperCapacity(sb, USER, CHALLENGE_ACCT);
    eq(cap.known, true);
    eq((cap as any).balance, 100, '전용 계좌 잔고여야 한다');
    eq((cap as any).usedMargin, 60, '전용 계좌 증거금이어야 한다');
    const posQ = calls.find(x => x.table === 'paper_positions')!;
    assert(scopedTo(posQ, CHALLENGE_ACCT), '명시 계좌로 좁혀야 한다');
  });

  // **REVERSE가 남의 계좌 포지션을 닫지 않는다.**
  // 이 저장소의 절대 규칙 — symbol만 보고 주문 소유권을 판단하지 않는다.
  test('REVERSE 청산이 지정한 계좌의 포지션만 집는다', async () => {
    const { closeOpposingPositions } = await import('./paperStore');
    const { sb, calls } = fakeSb({ paper_accounts: ACCOUNTS, paper_positions: POSITIONS });
    // 닫기 자체는 여기서 확인하지 않는다. **무엇을 집었는가**가 요점이다.
    await closeOpposingPositions(sb, USER, DEFAULT_ACCT, 'BTCUSDT', 'LONG', 100).catch(() => 0);
    const posQ = calls.find(x => x.table === 'paper_positions')!;
    assert(scopedTo(posQ, DEFAULT_ACCT), 'REVERSE가 계좌로 좁히지 않았다 — 남의 포지션을 닫는다');
  });

  test('계좌를 안 주면 REVERSE는 아무것도 닫지 않는다', async () => {
    const { closeOpposingPositions } = await import('./paperStore');
    const { sb, calls } = fakeSb({ paper_accounts: ACCOUNTS, paper_positions: POSITIONS });
    const n = await closeOpposingPositions(sb, USER, '', 'BTCUSDT', 'LONG', 100);
    eq(n, 0, '계좌를 모르면 닫지 않는다');
    eq(calls.filter(x => x.table === 'paper_positions').length, 0, '질의조차 하지 않는다');
  });

  test('총자산 읽기가 전용 계좌 포지션을 섞지 않는다', async () => {
    const { readPaperEquity } = await import('../portfolio/paperRead');
    const { sb, calls } = fakeSb({
      paper_accounts: [{
        ...ACCOUNTS[0], balance: 1000, initial_balance: 1000,
        started_at: '2026-01-01T00:00:00Z', total_pnl: 0, total_fees: 0,
      }],
      paper_positions: POSITIONS,
    });
    await readPaperEquity(sb, USER, { markPrice: async () => 100 });
    const posQ = calls.find(x => x.table === 'paper_positions');
    assert(posQ != null, '포지션을 읽어야 한다');
    assert(scopedTo(posQ!, DEFAULT_ACCT), '총자산이 계좌로 좁혀지지 않았다');
  });
}
