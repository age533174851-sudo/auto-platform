// src/lib/engine/lifecycleRows.test.ts
//
// **DB가 코드보다 뒤처져도 이미 열린 포지션은 계속 관리한다.**
//
// 마이그레이션이 아직인 DB에 코드가 먼저 닿으면, 새 칸을 넣은 조회는
// PostgREST가 통째로 거절한다. 그때 회차가 죽으면 청산·보호·복구가 함께
// 멈춘다 — 못 여는 것은 불편이고 열린 것을 못 닫는 것은 사고다.
//
// 여기서는 **후퇴가 좁게 일어나는지**를 본다. 아무 실패에나 후퇴하면
// 권한 오류·연결 끊김이 "마이그레이션이 아직"으로 덮여 정상 회차처럼
// 보인다.
import { test, assert, eq } from '../../test/harness';
import {
  loadLifecycleRows, isMissingIdentityColumn,
  LIFECYCLE_SELECT_IDENTITY, LIFECYCLE_SELECT_LEGACY, IDENTITY_COLUMNS,
} from './lifecycleRows';
import { managedCandidates, mayActOn } from './managedPosition';

const T = '2026-08-27T09:00:00.000Z';

/** 089가 적용된 DB의 줄 */
const rowWithIdentity = (o: any = {}) => ({
  id: 'ord-1', connection_id: 'conn-bn', exchange: 'binance',
  symbol: 'BTCUSDT', side: 'BUY', avg_price: 100, stop_loss: 90,
  status: 'FILLED', reduce_only: false, acked_at: T,
  signal_id: '[s:scalp]sig-1', stop_policy: 'FIXED_SL',
  execution_profile_id: 'MAX_LEV_100X',
  execution_preset_id: 'EXACT_100X',
  execution_contract_version: 2,
  ...o,
});

/** 089가 아직인 DB의 줄 — 세 칸이 **아예 없다** */
const rowLegacy = (o: any = {}) => {
  const r: any = rowWithIdentity(o);
  for (const c of IDENTITY_COLUMNS) delete r[c];
  return r;
};

/** PostgREST가 모르는 칼럼에 주는 오류 */
const missingCol = (col: string) => ({
  code: '42703',
  message: `column live_orders.${col} does not exist`,
});

/**
 * 조회 하나를 흉내 낸다. 어떤 select로 몇 번 불렸는지 센다 —
 * "후퇴했다"를 글자가 아니라 **호출 기록**으로 확인한다.
 */
function fakeQuery(handler: (select: string) => { data?: any; error?: any }) {
  const calls: string[] = [];
  const fn = async (select: string) => {
    calls.push(select);
    const r = handler(select);
    return { data: r.data ?? null, error: r.error ?? null };
  };
  return { fn, calls };
}

export function runLifecycleRowsTests() {
  console.log('\n🗄  주문 장부 읽기 — 089 미적용에서도 멈추지 않는다');

  // ① 칸이 있으면 한 번에 읽는다
  test('★ 계약 칸이 있으면 identity까지 한 번에 읽는다', () => {
    const q = fakeQuery(() => ({ data: [rowWithIdentity()] }));
    return loadLifecycleRows(q.fn).then(r => {
      eq(r.projection, 'IDENTITY');
      eq(r.error, null);
      eq(r.rows.length, 1);
      eq(q.calls.length, 1, '★ 멀쩡한데 두 번 읽었습니다');
      eq(q.calls[0], LIFECYCLE_SELECT_IDENTITY);
      eq(r.rows[0].execution_preset_id, 'EXACT_100X');
    });
  });

  // ② 칸이 없으면 옛 모양으로 한 번 더
  test('★ 계약 칸이 없으면 옛 모양으로 다시 읽어 회차를 살린다', () => {
    const q = fakeQuery(sel => sel === LIFECYCLE_SELECT_IDENTITY
      ? { error: missingCol('execution_profile_id') }
      : { data: [rowLegacy()] });
    return loadLifecycleRows(q.fn).then(r => {
      eq(r.error, null, '★ 089가 아직이라고 회차를 죽였습니다 — 열린 포지션이 방치됩니다');
      eq(r.projection, 'LEGACY');
      eq(r.rows.length, 1);
      eq(q.calls.length, 2, '정확히 한 번만 후퇴한다');
      eq(q.calls[1], LIFECYCLE_SELECT_LEGACY);
      // 후퇴 모양에서 세 칸이 빠졌는지 — 넣은 채로 재시도하면 또 실패한다
      for (const c of IDENTITY_COLUMNS) {
        eq(LIFECYCLE_SELECT_LEGACY.includes(c), false, `${c}가 옛 모양에 남아 있습니다`);
      }
    });
  });

  // ③ 후퇴로 읽은 줄은 identity가 null이다 — 지어내지 않는다
  test('★ 후퇴로 읽은 줄의 identity는 null이지 추측값이 아니다', () => {
    const q = fakeQuery(sel => sel === LIFECYCLE_SELECT_IDENTITY
      ? { error: missingCol('execution_contract_version') }
      : { data: [rowLegacy()] });
    return loadLifecycleRows(q.fn).then(r => {
      const c = managedCandidates(r.rows);
      eq(c.positions.length, 1);
      eq(c.positions[0].executionIdentity, null,
        '★ 칸을 못 읽었는데 identity를 만들어 냈습니다');
    });
  });

  // ④ 후퇴해도 기존 고정 손절 포지션은 평소대로 관리된다
  test('★ 후퇴 상태에서도 고정 손절 포지션은 계속 관리된다', () => {
    const q = fakeQuery(sel => sel === LIFECYCLE_SELECT_IDENTITY
      ? { error: missingCol('execution_preset_id') }
      : { data: [rowLegacy({ stop_policy: 'FIXED_SL', stop_loss: 90 })] });
    return loadLifecycleRows(q.fn).then(r => {
      const c = managedCandidates(r.rows);
      eq(c.positions.length, 1, '★ 후퇴가 관리 대상을 줄였습니다');
      eq(c.positions[0].management.code, 'MANAGED');
      eq(mayActOn(c.positions[0]), true,
        '★ 마이그레이션이 아직이라는 이유로 열린 포지션을 못 닫게 됐습니다');
    });
  });

  // ⑤ 후퇴해도 NO_FIXED_SL 유예 규칙은 그대로다
  test('★ 후퇴 상태에서도 NO_FIXED_SL 유예가 유지된다', () => {
    const q = fakeQuery(sel => sel === LIFECYCLE_SELECT_IDENTITY
      ? { error: missingCol('execution_profile_id') }
      : { data: [rowLegacy({ stop_policy: 'NO_FIXED_SL', stop_loss: null })] });
    return loadLifecycleRows(q.fn).then(r => {
      const c = managedCandidates(r.rows);
      eq(c.positions.length, 0, '★ 후퇴가 PR1의 유예를 풀었습니다');
      assert(!!c.deferred.find((d: any) => d.code === 'NO_FIXED_SL_EXIT_UNWIRED'),
        '유예 기록은 그대로 남는다');
    });
  });
  // 후퇴 모양이 `stop_policy`를 함께 빼면 위 규칙이 조용히 풀린다.
  test('★ 옛 모양도 stop_policy는 읽는다', () => {
    eq(LIFECYCLE_SELECT_LEGACY.includes('stop_policy'), true,
      '★ 후퇴가 손절 정책까지 버렸습니다 — NO_FIXED_SL 주문이 일반 생명주기로 들어갑니다');
  });

  // ⑥ 089와 무관한 오류에는 후퇴하지 않는다
  test('★ 089와 무관한 오류는 후퇴하지 않고 실패한다', () => {
    const others = [
      { code: '42501', message: 'permission denied for table live_orders' },
      { code: 'PGRST301', message: 'JWT expired' },
      { message: 'fetch failed' },
      // 다른 칼럼이 없다는 오류 — 이건 우리 문제가 아니다
      { code: '42703', message: 'column live_orders.strategy_id does not exist' },
    ];
    return Promise.all(others.map(err => {
      const q = fakeQuery(() => ({ error: err }));
      return loadLifecycleRows(q.fn).then(r => {
        eq(r.projection, null, `★ ${err.message}를 "089 미적용"으로 읽었습니다`);
        assert(!!r.error, '실패는 실패로 적는다');
        eq(q.calls.length, 1, `★ ${err.message}에 후퇴를 시도했습니다 — 진짜 고장이 덮입니다`);
      });
    })).then(() => undefined);
  });

  // ⑦ 후퇴 판정 자체
  test('후퇴 판정은 세 칸을 가리키는 "칼럼 없음"에만 참이다', () => {
    for (const c of IDENTITY_COLUMNS) {
      eq(isMissingIdentityColumn(missingCol(c)), true, c);
      eq(isMissingIdentityColumn({
        code: 'PGRST204',
        message: `Could not find the '${c}' column of 'live_orders' in the schema cache`,
      }), true, `${c} (스키마 캐시)`);
    }
    for (const [err, why] of [
      [null, '오류 없음'],
      [{ code: '42501', message: 'permission denied' }, '권한'],
      [{ code: '42703', message: 'column live_orders.foo does not exist' }, '다른 칼럼'],
      [{ message: 'execution_profile_id' }, '코드도 문구도 칼럼 없음이 아님'],
    ] as Array<[any, string]>) {
      eq(isMissingIdentityColumn(err), false, why);
    }
  });

  test('두 번째 조회까지 실패하면 실패로 적는다', () => {
    const q = fakeQuery(sel => sel === LIFECYCLE_SELECT_IDENTITY
      ? { error: missingCol('execution_profile_id') }
      : { error: { code: '42501', message: 'permission denied' } });
    return loadLifecycleRows(q.fn).then(r => {
      eq(r.projection, null);
      eq(r.rows.length, 0, '못 읽은 것을 0건으로 적지 않는다');
      assert(String(r.error).includes('permission'), '두 번째 실패 사유를 적는다');
    });
  });

  test('던져진 예외도 같은 규칙으로 다룬다', () => {
    const q = fakeQuery(sel => {
      if (sel === LIFECYCLE_SELECT_IDENTITY) throw missingCol('execution_preset_id');
      return { data: [rowLegacy()] };
    });
    return loadLifecycleRows(q.fn).then(r => {
      eq(r.projection, 'LEGACY');
      eq(r.rows.length, 1);
    });
  });
}
