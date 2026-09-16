// src/lib/engine/paperChallengeScope.test.ts
//
// **남의 챌린지 id 하나로 남의 장부에 주문이 나가는 일을 여기서 고정한다.**
//
// 무엇을 증명하는가
// ─────────────────
//  ① 남의 challengeId는 **찾지 못한다** — 그리고 없는 것과 같은 답을 받는다
//  ② 못 찾았을 때 **기본 계좌로 내려가지 않는다** (default fallback 오염)
//  ③ 조회 실패를 "없다"로 적지 않는다 (UNREADABLE ≠ NOT_FOUND)
//  ④ 주문은 **RUNNING에서만** — READY·CLOSING·CLOSED·모르는 값 전부 거부
//  ⑤ challengeId가 없으면 **지금까지의 기본 계좌 동작 그대로**
//
// 결과 숫자만 보지 않는다. 실제로 `user_id`까지 함께 좁혔는지는 **질의
// 자체**를 봐야 한다 — 가짜 데이터를 어떻게 만드느냐에 따라 우연히 맞을 수
// 있기 때문이다.
import { test, eq, assert } from '../../test/harness';
import {
  resolveChallengeScope, challengeScopeFailed, challengeOrderGate,
  readChallengeId, resolvePaperTarget, paperTargetFailed,
} from './paperChallengeScope';

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
      in() { return q; },
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

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const MINE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const THEIRS = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MY_ACCT = 'acct-challenge-mine';
const THEIR_ACCT = 'acct-challenge-theirs';
const DEFAULT_ACCT = 'acct-default';

const ACCOUNTS = [
  { id: DEFAULT_ACCT, user_id: USER, is_default: true, balance: 1000 },
  { id: MY_ACCT, user_id: USER, is_default: false, balance: 500 },
  { id: THEIR_ACCT, user_id: OTHER, is_default: false, balance: 500 },
];

const CHALLENGES = [
  { id: MINE, user_id: USER, paper_account_id: MY_ACCT, status: 'RUNNING' },
  { id: THEIRS, user_id: OTHER, paper_account_id: THEIR_ACCT, status: 'RUNNING' },
];

export function runPaperChallengeScopeTests() {
  // ── challengeId 읽기 ──
  test('challengeId는 UUID 모양만 받는다', () => {
    eq(readChallengeId(MINE), MINE);
    eq(readChallengeId('  ' + MINE.toUpperCase() + '  '), MINE);
    eq(readChallengeId(''), null);
    eq(readChallengeId('   '), null);
    eq(readChallengeId('not-a-uuid'), null);
    eq(readChallengeId(null), null);
    eq(readChallengeId(123 as any), null);
    // SQL을 넣으려 해도 모양에서 걸린다
    eq(readChallengeId("' OR 1=1 --"), null);
  });

  // ── ① 남의 챌린지 ──
  test('남의 challengeId는 찾지 못한다 — 없는 것과 같은 답이다', async () => {
    const { sb } = fakeSb({ paper_challenges: CHALLENGES });
    const s = await resolveChallengeScope(sb, USER, THEIRS);
    assert(challengeScopeFailed(s), '남의 챌린지가 통과했습니다');
    eq((s as any).code, 'NOT_FOUND');
  });

  test('없는 challengeId도 같은 NOT_FOUND다 — 존재를 알려 주지 않는다', async () => {
    const { sb } = fakeSb({ paper_challenges: CHALLENGES });
    const gone = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const s1 = await resolveChallengeScope(sb, USER, gone);
    const s2 = await resolveChallengeScope(sb, USER, THEIRS);
    eq((s1 as any).code, (s2 as any).code);
    eq((s1 as any).reason, (s2 as any).reason);
  });

  test('소유자까지 함께 좁혀 묻는다', async () => {
    const { sb, calls } = fakeSb({ paper_challenges: CHALLENGES });
    await resolveChallengeScope(sb, USER, MINE);
    const q = calls.find(c => c.table === 'paper_challenges');
    assert(!!q, '챌린지를 묻지 않았습니다');
    assert(q!.filters.some(([c, v]) => c === 'id' && v === MINE), 'id로 좁히지 않았습니다');
    assert(q!.filters.some(([c, v]) => c === 'user_id' && v === USER), 'user_id로 좁히지 않았습니다');
  });

  test('내 챌린지는 전용 계좌로 풀린다', async () => {
    const { sb } = fakeSb({ paper_challenges: CHALLENGES });
    const s = await resolveChallengeScope(sb, USER, MINE);
    assert(!challengeScopeFailed(s), '내 챌린지를 못 찾았습니다');
    eq((s as any).accountId, MY_ACCT);
    eq((s as any).status, 'RUNNING');
  });

  // ── ③ 못 읽음 ≠ 없음 ──
  test('조회 실패를 "없다"로 적지 않는다', async () => {
    const { sb } = fakeSb({ paper_challenges: CHALLENGES }, { errorOn: 'paper_challenges' });
    const s = await resolveChallengeScope(sb, USER, MINE);
    assert(challengeScopeFailed(s), '오류인데 통과했습니다');
    eq((s as any).code, 'UNREADABLE');
  });

  test('사용자를 모르면 챌린지를 정하지 않는다', async () => {
    const { sb } = fakeSb({ paper_challenges: CHALLENGES });
    const s = await resolveChallengeScope(sb, '', MINE);
    eq((s as any).code, 'NO_USER');
  });

  test('모양이 아닌 challengeId는 질의도 하지 않는다', async () => {
    const { sb, calls } = fakeSb({ paper_challenges: CHALLENGES });
    const s = await resolveChallengeScope(sb, USER, 'nope');
    eq((s as any).code, 'NO_CHALLENGE_ID');
    eq(calls.length, 0);
  });

  // ── ④ RUNNING만 ──
  test('주문은 RUNNING에서만 받는다 — 나머지는 전부 거부다', () => {
    eq(challengeOrderGate('RUNNING').allowed, true);
    for (const s of ['READY', 'CLOSING', 'CLOSED']) {
      eq(challengeOrderGate(s).allowed, false);
    }
  });

  test('모르는 상태도 거부다 — 상태가 늘어도 조용히 열리지 않는다', () => {
    for (const s of ['PAUSED', '', null, undefined, 'running']) {
      eq(challengeOrderGate(s as any).allowed, false);
    }
  });

  // ── ② default fallback 오염 ──
  test('남의 챌린지를 지정하면 기본 계좌로 내려가지 않는다', async () => {
    const { sb } = fakeSb({ paper_challenges: CHALLENGES, paper_accounts: ACCOUNTS });
    const t = await resolvePaperTarget(sb, USER, THEIRS);
    assert(paperTargetFailed(t), '남의 챌린지가 장부로 풀렸습니다');
    eq((t as any).kind, 'CHALLENGE');
    // **기본 계좌가 답으로 나오면 안 된다**
    eq((t as any).accountId, undefined);
  });

  test('없는 챌린지를 지정해도 기본 계좌로 내려가지 않는다', async () => {
    const { sb } = fakeSb({ paper_challenges: CHALLENGES, paper_accounts: ACCOUNTS });
    const t = await resolvePaperTarget(sb, USER, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    assert(paperTargetFailed(t), '없는 챌린지가 장부로 풀렸습니다');
  });

  test('챌린지 조회가 실패해도 기본 계좌로 내려가지 않는다', async () => {
    const { sb } = fakeSb(
      { paper_challenges: CHALLENGES, paper_accounts: ACCOUNTS },
      { errorOn: 'paper_challenges' });
    const t = await resolvePaperTarget(sb, USER, MINE);
    assert(paperTargetFailed(t), '조회 실패가 장부로 풀렸습니다');
    eq((t as any).code, 'UNREADABLE');
  });

  test('모양이 아닌 challengeId도 기본 계좌로 내려가지 않는다', async () => {
    const { sb } = fakeSb({ paper_challenges: CHALLENGES, paper_accounts: ACCOUNTS });
    // 빈 문자열이 아니라 "값은 왔는데 모양이 아닌" 경우다
    const t = await resolvePaperTarget(sb, USER, 'garbage');
    assert(paperTargetFailed(t), '잘못된 challengeId가 장부로 풀렸습니다');
    eq((t as any).kind, 'CHALLENGE');
  });

  // ── ⑤ 기존 PAPER 동작 유지 ──
  test('challengeId가 없으면 기본 계좌 그대로다', async () => {
    const { sb } = fakeSb({ paper_challenges: CHALLENGES, paper_accounts: ACCOUNTS });
    const t = await resolvePaperTarget(sb, USER);
    assert(!paperTargetFailed(t), '기본 계좌를 못 찾았습니다');
    eq((t as any).kind, 'DEFAULT');
    eq((t as any).accountId, DEFAULT_ACCT);
    eq((t as any).challengeId, null);
  });

  test('빈 challengeId는 "안 준 것"과 같다 — 기존 동작이 깨지지 않는다', async () => {
    const { sb } = fakeSb({ paper_challenges: CHALLENGES, paper_accounts: ACCOUNTS });
    for (const v of ['', '   ', null, undefined]) {
      const t = await resolvePaperTarget(sb, USER, v as any);
      assert(!paperTargetFailed(t), `${JSON.stringify(v)}에서 기본 계좌를 못 찾았습니다`);
      eq((t as any).accountId, DEFAULT_ACCT);
    }
  });

  test('기본 계좌가 없으면 기본 경로도 멈춘다 — 아무 계좌나 고르지 않는다', async () => {
    const { sb } = fakeSb({
      paper_challenges: CHALLENGES,
      // 기본 계좌가 없다. 전용 계좌만 있다.
      paper_accounts: ACCOUNTS.filter(a => !a.is_default),
    });
    const t = await resolvePaperTarget(sb, USER);
    assert(paperTargetFailed(t), '기본 계좌가 없는데 통과했습니다');
    eq((t as any).code, 'NO_ACCOUNT');
  });

  test('내 챌린지는 전용 계좌 장부로 풀린다', async () => {
    const { sb } = fakeSb({ paper_challenges: CHALLENGES, paper_accounts: ACCOUNTS });
    const t = await resolvePaperTarget(sb, USER, MINE);
    assert(!paperTargetFailed(t), '내 챌린지를 못 찾았습니다');
    eq((t as any).kind, 'CHALLENGE');
    eq((t as any).accountId, MY_ACCT);
    eq((t as any).challengeId, MINE);
    // **기본 계좌가 섞이지 않았다**
    assert((t as any).accountId !== DEFAULT_ACCT, '챌린지가 기본 계좌로 풀렸습니다');
  });
}
