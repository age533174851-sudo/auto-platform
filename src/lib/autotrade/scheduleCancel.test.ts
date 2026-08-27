// src/lib/autotrade/scheduleCancel.test.ts
//
// **가장 나쁜 결과는 "화면에서 사라졌는데 워커가 계속 도는 것"이다.**
//
// 그래서 여기서 고정하는 것은 두 가지다:
//   · 취소를 성공으로 적는 조건 (못 읽었으면 성공이 아니다)
//   · 취소가 끄기보다 세다 (되살리기가 슬그머니 다시 돌게 하지 않는다)
//
// 실행과 취소의 경합 자체는 값으로 못 막는다 — DB 한 문장 안에서
// 끝나야 하고, 그건 firstEvalRace.test.ts가 선점 조건으로 확인한다.
import { test, assert, eq } from '../../test/harness';
import { scheduleStateOf, isSchedulable, cancelVerdict, REVIVE_PATCH, exitClaimVerdict } from './scheduleCancel';

export function runScheduleCancelTests() {
  console.log('\n🗑️  예약 취소 (화면에서 사라졌는데 워커가 돌면 안 된다)');

  // ══ 상태 ══
  test('켜져 있으면 ACTIVE · 꺼져 있으면 PAUSED · 취소면 CANCELLED', () => {
    eq(scheduleStateOf({ enabled: true }), 'ACTIVE', '켜짐');
    eq(scheduleStateOf({ enabled: false }), 'PAUSED', '꺼짐 — 다시 켤 수 있다');
    eq(scheduleStateOf({ enabled: true, cancelled_at: '2026-08-27T00:00:00Z' }), 'CANCELLED', '취소');
  });

  test('취소가 끄기보다 세다 — enabled가 true여도 취소는 취소다', () => {
    const row = { enabled: true, cancelled_at: '2026-08-27T00:00:00Z' };
    eq(scheduleStateOf(row), 'CANCELLED', '되살리기가 enabled만 바꿔도 안 돈다');
    assert(!isSchedulable(row), '**워커가 돌리면 안 된다**');
  });

  test('꺼진 예약은 워커가 돌리지 않는다', () => {
    assert(!isSchedulable({ enabled: false }), '꺼짐');
    assert(isSchedulable({ enabled: true }), '켜짐만 돈다');
    assert(!isSchedulable(null), '없는 줄');
  });

  // ══ 취소 판정 ══
  test('한 줄을 고쳤으면 취소된 것이다', () => {
    const v = cancelVerdict({ updated: 1, existed: true });
    eq(v.code, 'CANCELLED', '취소');
    assert(v.ok, '목록에서 지워도 된다');
  });

  test('DB 오류를 성공으로 적지 않는다', () => {
    const v = cancelVerdict({ updated: null, existed: true, error: 'connection reset' });
    eq(v.code, 'FAILED', '실패');
    assert(!v.ok, '**화면에서 지우면 안 된다 — 워커는 계속 돈다**');
    assert(v.reason.includes('connection reset'), '이유를 싣는다');
  });

  test('결과를 못 읽었으면 취소됐다고 단정하지 않는다', () => {
    const v = cancelVerdict({ updated: null, existed: true });
    eq(v.code, 'FAILED', '모른다');
    assert(!v.ok, '0으로 읽지 않는다');
  });

  test('이미 취소된 것을 또 눌러도 오류가 아니다', () => {
    const v = cancelVerdict({ updated: 0, existed: true, alreadyCancelled: true });
    eq(v.code, 'ALREADY_CANCELLED', '멱등');
    assert(v.ok, '결과는 같다 — 사용자에게 실패라고 말하지 않는다');
  });

  test('없는 예약은 NOT_FOUND다', () => {
    const v = cancelVerdict({ updated: 0, existed: false });
    eq(v.code, 'NOT_FOUND', '없다');
    assert(!v.ok, '지웠다고 말하지 않는다');
  });

  test('있는데 안 고쳐졌으면 성공이라 적지 않는다', () => {
    const v = cancelVerdict({ updated: 0, existed: true });
    eq(v.code, 'FAILED', '설명되지 않는 0줄');
    assert(!v.ok, '조용히 통과시키지 않는다');
  });

  // ══ 되살리기 ══
  test('되살릴 때 취소 표식을 지운다 — 안 지우면 새 예약이 영영 안 돈다', () => {
    eq(REVIVE_PATCH.cancelled_at, null, '취소 시각');
    eq(REVIVE_PATCH.cancelled_by, null, '취소 주체');
    // 되살린 뒤의 모양
    const revived = { enabled: true, ...REVIVE_PATCH };
    eq(scheduleStateOf(revived), 'ACTIVE', '다시 돈다');
    assert(isSchedulable(revived), '워커가 집는다');
  });
  // ══ 예약청산 선점 ══
  //
  // 예전에는 이 판정 자체가 없었다 — 읽고 · 쏘고 · 그제서야 기록했다.
  // 그 사이에 취소가 커밋되거나 다른 실행기가 끼어들 수 있었다.
  test('선점에 성공해야 주문한다', () => {
    const v = exitClaimVerdict({ updated: 1 });
    eq(v.code, 'CLAIMED', '잡았다');
    assert(v.mayFire, '주문해도 된다');
  });

  test('0줄이면 주문하지 않는다 — 취소됐거나 남이 이미 집었다', () => {
    const v = exitClaimVerdict({ updated: 0 });
    eq(v.code, 'SKIPPED', '못 잡았다');
    assert(!v.mayFire, '**같은 예약이 두 번 나가지 않는다**');
    assert(!/실패/.test(v.reason), '못 잡은 것을 오류로 적지 않는다');
  });

  test('선점 조회가 실패하면 잡았다고 보지 않는다', () => {
    const v = exitClaimVerdict({ updated: null, error: 'timeout' });
    eq(v.code, 'CLAIM_FAILED', '모른다');
    assert(!v.mayFire, '**모르면 쏘지 않는다**');
    assert(v.reason.includes('timeout'), '이유를 싣는다');
  });

  test('결과를 못 읽어도 잡았다고 보지 않는다', () => {
    const v = exitClaimVerdict({ updated: null });
    eq(v.code, 'CLAIM_FAILED', '모른다');
    assert(!v.mayFire, '0으로 읽지 않는다');
  });

}
