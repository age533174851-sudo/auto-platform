// src/lib/engine/paperDeposit.test.ts
//
// **돈이 들어갔는데 실패라고 답하면, 사용자는 다시 누른다.**
//
// 무엇이 있었나
// ─────────────
// `082`가 `paper_deposit`의 반환을 `TABLE(applied, new_balance, new_initial)`에서
// `NUMERIC` 하나로 바꿨는데, 부르는 쪽은 그대로 `row.applied !== true`를 봤다.
// 스칼라에는 `applied`가 없으니 늘 참이고, 라우트는 409 `not_started`를 냈다.
//
// 그런데 RPC는 제 트랜잭션에서 이미 커밋됐다. 그래서 **잔고는 늘고 화면은
// 실패**다. 다시 누르면 두 번 들어간다.
//
// 여기서 고정하는 것
// ──────────────────
// 이 시험들은 가짜 Supabase가 **실제로 잔고를 증가시키게** 만든다. 그래서
// "성공이라고 답했는가"만이 아니라 **"몇 번 들어갔는가"**를 함께 본다.
// 답만 보면, 호출을 두 번 하면서 성공이라 답하는 구현도 만점을 받는다.

import { test, eq, assert } from '../../test/harness';
import { applyPaperDeposit, depositBalanceOf, isNoAccountError } from './paperDeposit';

const USER = 'user-1';

/**
 * 충전이 실제로 반영되는 가짜 DB.
 *
 * `shape`로 RPC 반환 모양을 고른다:
 *   'numeric'  082의 현재 계약 — 새 잔고 하나
 *   'table'    072의 옛 계약 — {applied, new_balance, new_initial}
 *   'missing'  계좌 없음 — 082는 예외를 던진다
 */
function fakeDb(opts?: {
  shape?: 'numeric' | 'table' | 'missing';
  balance?: number;
  initial?: number;
  selectFails?: boolean;
}) {
  const shape = opts?.shape ?? 'numeric';
  const state = { balance: opts?.balance ?? 1000, initial: opts?.initial ?? 1000 };
  const calls = { rpc: 0, select: 0 };

  const sb: any = {
    rpc(fn: string, args: any) {
      calls.rpc += 1;
      if (fn !== 'paper_deposit') {
        return Promise.resolve({ data: null, error: { message: `모르는 함수 ${fn}` } });
      }
      if (shape === 'missing') {
        // 082는 값이 아니라 예외로 알린다.
        return Promise.reject(new Error('paper_deposit: 계좌를 찾지 못했습니다'));
      }
      // **실제로 증가시킨다.** 이 시험의 요점은 "몇 번 들어갔는가"다.
      state.balance += Number(args.p_amount);
      state.initial += Number(args.p_amount);
      if (shape === 'table') {
        return Promise.resolve({
          data: [{ applied: true, new_balance: state.balance, new_initial: state.initial }],
          error: null,
        });
      }
      return Promise.resolve({ data: state.balance, error: null });
    },
    from() {
      const q: any = {
        select() { calls.select += 1; return q; },
        eq() { return q; },
        maybeSingle() {
          if (opts?.selectFails) {
            return Promise.resolve({ data: null, error: { message: 'boom' } });
          }
          return Promise.resolve({ data: { initial_balance: state.initial }, error: null });
        },
      };
      return q;
    },
  };
  return { sb, state, calls };
}

export function runPaperDepositTests() {
  // ── 재현: 이 시험이 고장을 고정한다 ──
  //
  // 옛 호출부는 스칼라를 받고 `row.applied !== true`로 409를 냈다. 그때
  // 잔고는 이미 늘어 있었다.
  test('재현: 스칼라 반환(082 계약)을 실패로 읽지 않는다', async () => {
    const { sb, state } = fakeDb({ shape: 'numeric', balance: 1000, initial: 1000 });
    const r = await applyPaperDeposit(sb, USER, 500);
    eq(r.code, 'APPLIED', '돈이 들어갔는데 실패라고 답했다 — 사용자가 다시 누른다');
    eq(r.balance, 1500);
    eq(state.balance, 1500, '잔고가 정확히 한 번 늘어야 한다');
  });

  // **한 번만 들어간다.** 성공이라 답하면서 두 번 부르는 구현을 막는다.
  test('성공 한 번에 잔고와 초기자본이 각각 한 번만 는다', async () => {
    const { sb, state, calls } = fakeDb({ balance: 1000, initial: 1000 });
    const r = await applyPaperDeposit(sb, USER, 250);
    eq(r.code, 'APPLIED');
    eq(calls.rpc, 1, 'RPC는 한 번만 불러야 한다');
    eq(state.balance, 1250);
    eq(state.initial, 1250, '초기자본도 같이 올라야 한다 — 안 올리면 넣은 돈이 수익이 된다');
    eq(r.initialBalance, 1250);
  });

  test('두 번 부르면 두 번 는다 — 가짜 DB가 실제로 반영한다는 확인', async () => {
    // 이 대조군이 없으면 위 시험이 "아무것도 안 하는 가짜"에서도 통과한다.
    const { sb, state } = fakeDb({ balance: 1000 });
    await applyPaperDeposit(sb, USER, 100);
    await applyPaperDeposit(sb, USER, 100);
    eq(state.balance, 1200);
  });

  // ── 반환 모양 ──

  test('옛 표 모양도 그대로 읽는다', async () => {
    const { sb } = fakeDb({ shape: 'table', balance: 1000 });
    const r = await applyPaperDeposit(sb, USER, 500);
    eq(r.code, 'APPLIED');
    eq(r.balance, 1500);
  });

  test('잔고를 못 읽으면 0이 아니라 null이다', () => {
    eq(depositBalanceOf(null), null);
    eq(depositBalanceOf(undefined), null);
    eq(depositBalanceOf([]), null);
    eq(depositBalanceOf({}), null);
    eq(depositBalanceOf('abc'), null);
    eq(depositBalanceOf(NaN), null);
    // 옛 표 모양이 "계좌 없음"이라고 말한 경우
    eq(depositBalanceOf({ applied: false, new_balance: null }), null);
  });

  test('숫자·문자열·배열·표를 전부 같은 값으로 읽는다', () => {
    eq(depositBalanceOf(1500), 1500);
    eq(depositBalanceOf('1500'), 1500);
    eq(depositBalanceOf([1500]), 1500);
    eq(depositBalanceOf({ applied: true, new_balance: 1500 }), 1500);
    eq(depositBalanceOf([{ applied: true, new_balance: '1500' }]), 1500);
    // 잔고 0은 유효한 값이다 — null과 다르다
    eq(depositBalanceOf(0), 0);
  });

  // ── 계좌 없음 ──
  //
  // `082`는 값이 아니라 **예외**로 알린다. 이것을 500으로 읽으면 "아직
  // 시작하지 않았습니다"라고 안내해야 할 자리에서 "서버 오류"가 나간다.
  test('계좌가 없으면 NO_ACCOUNT다 — 서버 오류가 아니다', async () => {
    const { sb, state } = fakeDb({ shape: 'missing' });
    const r = await applyPaperDeposit(sb, USER, 500);
    eq(r.code, 'NO_ACCOUNT');
    eq(state.balance, 1000, '계좌가 없으면 아무것도 움직이면 안 된다');
  });

  test('계좌 없음 예외를 error로 받아도 NO_ACCOUNT다', async () => {
    const sb: any = {
      rpc: () => Promise.resolve({ data: null, error: { message: 'paper_deposit: 계좌를 찾지 못했습니다' } }),
      from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }) }),
    };
    eq((await applyPaperDeposit(sb, USER, 500)).code, 'NO_ACCOUNT');
  });

  test('계좌 없음과 그냥 실패를 구분한다', () => {
    assert(isNoAccountError('paper_deposit: 계좌를 찾지 못했습니다'));
    eq(isNoAccountError('connection reset by peer'), false);
    eq(isNoAccountError(''), false);
  });

  // ── 성공 뒤의 실패는 실패가 아니다 ──
  //
  // ★ 이 시험이 이 파일의 핵심이다. 숫자가 돌아온 뒤에 무엇이 실패해도
  //   실패라고 답하면 사용자가 다시 누르고, 그것이 이중 입금이다.
  test('초기자본을 다시 못 읽어도 충전은 성공으로 답한다', async () => {
    const { sb, state } = fakeDb({ balance: 1000, selectFails: true });
    const r = await applyPaperDeposit(sb, USER, 500);
    eq(r.code, 'APPLIED', '돈이 들어간 뒤의 읽기 실패를 충전 실패로 답하면 다시 누른다');
    eq(r.balance, 1500);
    eq(r.initialBalance, null, '모르는 것은 null이다 — 0으로 적지 않는다');
    eq(state.balance, 1500);
  });

  test('초기자본 조회가 던져도 충전은 성공이다', async () => {
    const { sb } = fakeDb({ balance: 1000 });
    sb.from = () => { throw new Error('boom'); };
    const r = await applyPaperDeposit(sb, USER, 500);
    eq(r.code, 'APPLIED');
    eq(r.initialBalance, null);
  });

  // ── 넣기 전에 멈추는 자리 ──

  test('금액이 유효하지 않으면 부르지도 않는다', async () => {
    for (const bad of [0, -100, NaN, Infinity]) {
      const { sb, calls, state } = fakeDb();
      const r = await applyPaperDeposit(sb, USER, bad as number);
      eq(r.code, 'REJECTED', `${bad}이 통과했다`);
      eq(calls.rpc, 0, '돈이 움직일 수 있는 호출을 하면 안 된다');
      eq(state.balance, 1000);
    }
  });

  test('사용자를 모르면 부르지 않는다', async () => {
    const { sb, calls } = fakeDb();
    eq((await applyPaperDeposit(sb, '', 500)).code, 'REJECTED');
    eq((await applyPaperDeposit(sb, null, 500)).code, 'REJECTED');
    eq((await applyPaperDeposit(sb, '   ', 500)).code, 'REJECTED');
    eq(calls.rpc, 0);
  });

  test('DB가 없으면 FAILED다 — 성공이라고 답하지 않는다', async () => {
    eq((await applyPaperDeposit(null, USER, 500)).code, 'FAILED');
  });

  // 호출이 실패했으면 들어갔는지 알 수 없다. **성공으로도 계좌없음으로도
  // 적지 않는다.**
  test('알 수 없는 실패는 FAILED다', async () => {
    const sb: any = {
      rpc: () => Promise.resolve({ data: null, error: { message: 'connection reset' } }),
      from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }) }),
    };
    const r = await applyPaperDeposit(sb, USER, 500);
    eq(r.code, 'FAILED');
    assert(String(r.reason).includes('connection reset'), '사유를 그대로 남겨야 한다');
  });
}
