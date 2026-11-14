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
import { scheduleStateOf, isSchedulable, cancelVerdict, REVIVE_PATCH, exitClaimVerdict,
  restoreVerdict, purgeVerdict } from './scheduleCancel';

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

  // ══ 되살리기 · 기록 삭제 ══
  //
  // 2026-11-14 사용자: "저거 취소됨 할거면 다시 킬수 있게 만들어 놓든가
  // 그냥 저거 방치하고 계속 쌓이는게 마음에 안들어 / 내역 삭제할건 하고
  // 내비두면 다시 킬수 있게 만들어놔"
  //
  // 취소된 줄에 **길이 없었다.** 화면은 "같은 종목으로 예약을 다시
  // 만들면 되살아납니다"라고 적지만, 그건 `UNIQUE (user_id, symbol)`이
  // 살아 있을 때 얘기다. 그 제약이 없으면 새로 만들 때마다 **새 줄**이
  // 생기고 취소된 줄은 영영 남는다.

  test('★★ 되살리기는 꺼진 상태로 돌아온다 — 저절로 거래하지 않는다', () => {
    const v = restoreVerdict({ updated: 1, existed: true, wasCancelled: true });
    eq(v.code, 'RESTORED');
    assert(v.ok);
    eq(v.enabledAfter, false, '되살리자마자 거래가 시작되면 안 된다');
    assert(/켜/.test(v.reason), `어떻게 켜는지가 없다: ${v.reason}`);
  });

  test('★★ 취소되지 않은 줄은 되살릴 것이 없다 — 손대지 않는다', () => {
    const v = restoreVerdict({ updated: 0, existed: true, wasCancelled: false });
    eq(v.code, 'NOT_CANCELLED');
    assert(!v.ok);
  });

  test('★★ 결과를 못 읽으면 되살렸다고 적지 않는다', () => {
    eq(restoreVerdict({ updated: null, existed: true, wasCancelled: true }).code, 'FAILED');
    eq(restoreVerdict({ updated: 1, existed: true, wasCancelled: true, error: 'boom' }).code, 'FAILED');
  });

  test('★★ "못 읽었다"와 "안 됐다"를 같은 문장으로 적지 않는다', () => {
    // 둘 다 FAILED지만 사람이 할 일이 다르다. 못 읽은 것은 다시 눌러
    // 보면 되고, 안 된 것은 원인을 찾아야 한다. `null <= 0`이 true라
    // 코드만 보면 두 갈래가 같은 곳으로 떨어진다 — 문장으로 가른다.
    const unread = restoreVerdict({ updated: null, existed: true, wasCancelled: true });
    const zero = restoreVerdict({ updated: 0, existed: true, wasCancelled: true });
    assert(/읽지 못/.test(unread.reason), `못 읽은 것을 그렇게 안 적었다: ${unread.reason}`);
    assert(!/읽지 못/.test(zero.reason), `안 된 것을 "못 읽었다"로 적었다: ${zero.reason}`);
  });

  test('★★ 기록 삭제는 **취소된 줄만** — 살아 있는 예약은 지우지 않는다', () => {
    const live = purgeVerdict({ deleted: 1, existed: true, wasCancelled: false });
    eq(live.code, 'NOT_CANCELLED', '켜져 있거나 잠깐 꺼 둔 예약이 지워졌다');
    assert(!live.ok);
    assert(/취소/.test(live.reason), live.reason);

    const dead = purgeVerdict({ deleted: 1, existed: true, wasCancelled: true });
    eq(dead.code, 'PURGED');
    assert(dead.ok);
  });

  test('★ 지울 것이 없으면 지웠다고 적지 않는다', () => {
    eq(purgeVerdict({ deleted: 0, existed: false, wasCancelled: false }).code, 'NOT_FOUND');
    eq(purgeVerdict({ deleted: null, existed: true, wasCancelled: true }).code, 'FAILED');
    eq(purgeVerdict({ deleted: 1, existed: true, wasCancelled: true, error: 'boom' }).code, 'FAILED');
  });

  test('★★ 삭제도 "못 읽었다"와 "안 됐다"를 가른다', () => {
    const unread = purgeVerdict({ deleted: null, existed: true, wasCancelled: true });
    const zero = purgeVerdict({ deleted: 0, existed: true, wasCancelled: true });
    assert(/읽지 못/.test(unread.reason), unread.reason);
    assert(!/읽지 못/.test(zero.reason), `안 된 것을 "못 읽었다"로 적었다: ${zero.reason}`);
  });

  test('★ 삭제는 되돌릴 수 없다는 것을 문장이 말한다', () => {
    const v = purgeVerdict({ deleted: 1, existed: true, wasCancelled: true });
    assert(/되돌릴 수 없|영구/.test(v.reason), `되돌릴 수 없다는 말이 없다: ${v.reason}`);
  });

}
