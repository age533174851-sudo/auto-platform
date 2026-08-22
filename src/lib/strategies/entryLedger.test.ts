// src/lib/strategies/entryLedger.test.ts
//
// **"모른다"를 "안 됐다"로 접으면 하루 1회 잠금이 풀린다.**
//
// daily-ladder는 `exec.ok ? confirm : release` 두 갈래뿐이었다.
// `release`는 예약 행을 지우고, 그러면
// `(user_id, strategy_id, trade_date)` unique가 풀린다.
//
// `executeOrder`의 `ok: false`에는 세 가지가 섞여 있다:
//
//   REJECTED  거래소가 거부했다   — 안 나갔다
//   FAILED    보내지 못했다       — 안 나갔다
//   UNKNOWN   응답을 못 받았다    — **나갔는지 모른다**
//
// 마지막 것이 하루를 돌려받으면, 다음 주기에 두 번째 주문이 나가고
// 앞 주문이 실제로는 체결돼 있었다면 포지션이 두 배가 된다.
import { test, eq, assert } from '../../test/harness';
import { entryLedgerPlan, MONITORED_STATUSES, isConfirmedOpen } from './entryLedger';
import { holdReservation, confirmReservation, releaseReservation } from './ladderGate';

export function runEntryLedgerTests() {
  console.log('[진입 증거 → 장부 — 모르는 것은 통과가 아니다]');

  test('하루를 돌려주는 경우는 정확히 하나뿐이다', () => {
    const codes = ['ENTERED', 'NOT_ENTERED', 'UNKNOWN', 'ENTERED_UNPROTECTED'] as const;
    const released = codes.filter(c => entryLedgerPlan(c).releaseDay);
    eq(released.length, 1, `하루를 돌려주는 판정이 ${released.length}개다: ${released.join(', ')}`);
    eq(released[0], 'NOT_ENTERED');
  });

  test('모르는 것은 하루를 돌려주지 않는다', () => {
    const p = entryLedgerPlan('UNKNOWN');
    eq(p.releaseDay, false, '모르는데 하루를 돌려줬다 — 같은 날 두 번째 주문이 나간다');
    eq(p.allowRetryToday, false);
    eq(p.status, 'RECONCILE_REQUIRED');
    assert(p.note.includes('두 배'), p.note);
  });

  test('모르는 것을 청산 감시가 본다', () => {
    // 안 보면 미확정 주문이 영원히 미확정으로 남는다.
    eq(entryLedgerPlan('UNKNOWN').monitor, true);
    assert(MONITORED_STATUSES.includes('RECONCILE_REQUIRED'), '감시 목록에서 빠졌다');
  });

  test('보호 없는 포지션은 지우지 않는다', () => {
    // 지우면 보호 없는 포지션을 아무도 안 보게 된다.
    const p = entryLedgerPlan('ENTERED_UNPROTECTED');
    eq(p.releaseDay, false);
    eq(p.status, 'UNPROTECTED');
    eq(p.monitor, true);
    assert(MONITORED_STATUSES.includes('UNPROTECTED'));
  });

  test('보호 없는 포지션에서 같은 날 재진입하지 않는다', () => {
    eq(entryLedgerPlan('ENTERED_UNPROTECTED').allowRetryToday, false);
  });

  test('증거가 다 있을 때만 OPEN이다', () => {
    eq(entryLedgerPlan('ENTERED').status, 'OPEN');
    const others = (['NOT_ENTERED', 'UNKNOWN', 'ENTERED_UNPROTECTED'] as const)
      .filter(c => entryLedgerPlan(c).status === 'OPEN');
    eq(others.length, 0, `접수만으로 OPEN이 된 판정: ${others.join(', ')}`);
  });

  test('모르는 값이 들어와도 하루를 돌려주지 않는다', () => {
    // 새 판정 코드가 생겼는데 이 표를 안 고치면, 기본값이 안전한 쪽이어야 한다.
    const p = entryLedgerPlan('SOMETHING_NEW' as any);
    eq(p.releaseDay, false, '모르는 판정에 하루를 돌려줬다');
    eq(p.allowRetryToday, false);
  });

  test('확인된 열린 거래만 OPEN으로 센다', () => {
    eq(isConfirmedOpen('OPEN'), true);
    eq(isConfirmedOpen('RECONCILE_REQUIRED'), false);
    eq(isConfirmedOpen('UNPROTECTED'), false);
    eq(isConfirmedOpen(null), false);
  });

  console.log('[예약 붙잡기 — 지우지 않고 상태만 옮긴다]');

  /** update / delete를 기록하는 최소 supabase 흉내 */
  function trackingSb(failOn?: RegExp) {
    const ops: any[] = [];
    const sb: any = {
      from: () => ({
        update: (row: any) => ({
          eq: async () => {
            ops.push({ kind: 'update', row });
            if (failOn && failOn.test(JSON.stringify(Object.keys(row)))) {
              return { error: { message: 'column "connection_id" does not exist' } };
            }
            return { error: null };
          },
        }),
        delete: () => ({ eq: async () => { ops.push({ kind: 'delete' }); return { error: null }; } }),
      }),
    };
    return { sb, ops };
  }

  test('붙잡기는 예약 행을 지우지 않는다', async () => {
    const { sb, ops } = trackingSb();
    await holdReservation(sb, 'r1', { status: 'RECONCILE_REQUIRED', reason: '응답 못 받음' });
    eq(ops.filter(o => o.kind === 'delete').length, 0, '지웠다 — 하루 잠금이 풀린다');
    eq(ops[0].row.status, 'RECONCILE_REQUIRED');
  });

  test('붙잡기는 RESERVED에서 벗어난다', async () => {
    // 10분짜리 묵은 예약 청소는 `status='RESERVED'`이면서 entry_price가
    // 없는 줄을 지운다. 상태를 안 옮기면 그 청소가 하루 잠금을 푼다.
    const { sb, ops } = trackingSb();
    await holdReservation(sb, 'r1', { status: 'UNPROTECTED', reason: '보호 확인 못 함' });
    assert(ops[0].row.status !== 'RESERVED', '예약 상태 그대로면 청소가 지운다');
  });

  test('붙잡을 때 아는 값은 적고 모르는 값은 null이다', async () => {
    const { sb, ops } = trackingSb();
    await holdReservation(sb, 'r1', {
      status: 'UNPROTECTED', reason: 'x',
      fill: { entryPrice: 60000, stopLoss: 59000, connectionId: 'conn-a' },
    });
    eq(ops[0].row.entry_price, 60000);
    eq(ops[0].row.stop_loss, 59000);
    eq(ops[0].row.connection_id, 'conn-a');
    eq(ops[0].row.take_profit, null, '모르는 값을 0으로 적으면 안 된다');
  });

  test('connection_id 칸이 없는 배포에서도 상태는 옮긴다', async () => {
    // 여기서 실패하면 그 줄은 RESERVED로 남고 청소가 지운다.
    const { sb, ops } = trackingSb(/connection_id/);
    await holdReservation(sb, 'r1', { status: 'RECONCILE_REQUIRED', reason: 'x' });
    eq(ops.length, 2, '한 칸 때문에 상태를 못 옮겼다');
    eq(ops[1].row.status, 'RECONCILE_REQUIRED');
    eq(ops[1].row.connection_id, undefined);
  });

  test('예약 id가 없으면 아무것도 안 한다', async () => {
    const { sb, ops } = trackingSb();
    await holdReservation(sb, undefined, { status: 'UNPROTECTED', reason: 'x' });
    await confirmReservation(sb, undefined, {});
    await releaseReservation(sb, undefined);
    eq(ops.length, 0);
  });
}
