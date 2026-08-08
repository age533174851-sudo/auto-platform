// src/lib/strategies/syncPlan.test.ts
//
// 막으려는 것:
//  1. **새 기기에서 로그인했더니 전략이 다 지워지는 것.** 새 기기의
//     localStorage는 비어 있다. 그걸 "사용자가 다 지웠다"로 읽으면
//     휴대폰 로그인 한 번에 PC에서 만든 전략이 전부 사라진다
//  2. 서버 조회가 실패했는데 빈 목록을 그리는 것 — 사용자는 날아갔다고
//     믿고 다시 만들고, 서버에는 원본이 남아 중복이 된다.
//     그리고 둘 다 켜지면 주문이 두 번 나간다
//  3. 양쪽이 다 바뀌었는데 조용히 최신 것을 고르는 것 — 진 쪽의 변경은
//     흔적도 없이 사라지고, 사용자는 자기가 바꾼 게 안 먹혔다고만 안다
import { test, assert, eq } from '../../test/harness';
import { syncPlan, listVerdict, fingerprintOf, fromRow } from './syncPlan';

const S = (id: string, over: any = {}): any =>
  ({ id, name: id, enabled: false, tp: 1, updatedAt: 1000, createdAt: 0, ...over });

export function runStrategySyncTests() {
  console.log('[전략 동기화 — 없는 것을 지운 것으로 읽지 않는다]');

  test('새 기기의 빈 목록이 서버 전략을 지우지 않는다', () => {
    // 이게 이 파일이 있는 이유다. 휴대폰으로 한 번 로그인한 것만으로
    // PC에서 만든 전략이 사라지면 안 된다.
    const p = syncPlan({ local: [], remote: [S('a'), S('b')], remoteReadOk: true });
    eq(p.deletions.length, 0);
    eq(p.downloads.length, 2);
    eq(p.uploads.length, 0);
    assert(p.downloads[0].reason.includes('지워진 것이 아닙니다'), p.downloads[0].reason);
  });

  test('서버에 없는 것은 올린다', () => {
    const p = syncPlan({ local: [S('a')], remote: [], remoteReadOk: true });
    eq(p.uploads.length, 1);
    eq(p.deletions.length, 0);
  });

  test('어떤 경우에도 지울 것을 내지 않는다', () => {
    const cases: any[] = [
      { local: [], remote: [S('a')], remoteReadOk: true },
      { local: [S('a')], remote: [], remoteReadOk: true },
      { local: [S('a')], remote: [S('a', { tp: 9 })], remoteReadOk: true },
      { local: [], remote: [], remoteReadOk: true },
    ];
    for (const c of cases) eq(syncPlan(c).deletions.length, 0, JSON.stringify(c.local));
  });

  console.log('[전략 동기화 — 못 읽었으면 아무것도 쓰지 않는다]');

  test('서버를 못 읽으면 올리지도 내리지도 않는다', () => {
    // 서버 상태를 모르는 채로 올리면 갱신인지 새로 만드는 건지도 모른다.
    const p = syncPlan({ local: [S('a')], remote: null, remoteReadOk: false });
    eq(p.blocked, true);
    eq(p.ok, false);
    eq(p.uploads.length, 0);
    assert(p.reason.includes('중복'), p.reason);
  });

  test('읽었는지조차 모르면 성공으로 치지 않는다', () => {
    const p = syncPlan({ local: [S('a')], remote: [], remoteReadOk: null });
    eq(p.blocked, true);
    assert(p.reason.includes('확인하지 못했습니다'), p.reason);
  });

  test('입력이 아예 없어도 막는다', () => {
    eq(syncPlan(null).blocked, true);
    eq(syncPlan(undefined as any).ok, false);
  });

  console.log('[전략 동기화 — 양쪽이 바뀌면 고르지 않는다]');

  test('마지막 동기화 이후 양쪽이 다 바뀌면 충돌이다', () => {
    // 휴대폰에서 손절을, PC에서 익절을 바꿨다. 최신 것만 남기면
    // 다른 하나는 소리 없이 사라진다.
    const p = syncPlan({
      local: [S('a', { sl: 2, updatedAt: 3000 })],
      remote: [S('a', { tp: 3, updatedAt: 2500 })],
      remoteReadOk: true, lastSyncAtMs: 2000,
    });
    eq(p.conflicts.length, 1);
    eq(p.uploads.length, 0);
    eq(p.downloads.length, 0);
    assert(p.conflicts[0].reason.includes('조용히 없어집니다'), p.conflicts[0].reason);
    assert(p.reason.includes('직접 정하세요'), p.reason);
  });

  test('한쪽만 바뀌었으면 그쪽이 이긴다', () => {
    const up = syncPlan({
      local: [S('a', { tp: 9, updatedAt: 3000 })],
      remote: [S('a', { updatedAt: 1000 })],
      remoteReadOk: true, lastSyncAtMs: 2000,
    });
    eq(up.uploads.length, 1);
    eq(up.conflicts.length, 0);

    const down = syncPlan({
      local: [S('a', { updatedAt: 1000 })],
      remote: [S('a', { tp: 9, updatedAt: 3000 })],
      remoteReadOk: true, lastSyncAtMs: 2000,
    });
    eq(down.downloads.length, 1);
    eq(down.conflicts.length, 0);
  });

  test('마지막 동기화 시각을 모르면 최신 것을 고르지 않는다', () => {
    // 모르는 채로 고르면 진 쪽 변경이 사라진다. 모를 때는 물어본다.
    const p = syncPlan({
      local: [S('a', { tp: 9, updatedAt: 3000 })],
      remote: [S('a', { tp: 1, updatedAt: 1000 })],
      remoteReadOk: true,
    });
    eq(p.conflicts.length, 1);
    eq(p.uploads.length, 0);
    assert(p.conflicts[0].reason.includes('확인하지 못했습니다'), p.conflicts[0].reason);
  });

  test('내용이 같으면 저장 시각이 달라도 충돌이 아니다', () => {
    // 저장만 다시 눌러도 updatedAt은 바뀐다. 그게 변경은 아니다.
    const p = syncPlan({
      local: [S('a', { updatedAt: 5000 })],
      remote: [S('a', { updatedAt: 1000 })],
      remoteReadOk: true, lastSyncAtMs: 2000,
    });
    eq(p.inSync.length, 1);
    eq(p.conflicts.length, 0);
    eq(p.summary, '이미 같습니다');
  });

  test('내용은 다른데 양쪽 다 안 바뀐 것으로 나오면 충돌로 둔다', () => {
    const p = syncPlan({
      local: [S('a', { tp: 9, updatedAt: 500 })],
      remote: [S('a', { tp: 1, updatedAt: 600 })],
      remoteReadOk: true, lastSyncAtMs: 2000,
    });
    eq(p.conflicts.length, 1);
    assert(p.conflicts[0].reason.includes('어긋났습니다'), p.conflicts[0].reason);
  });

  test('시각은 지문에서 뺀다', () => {
    eq(fingerprintOf(S('a', { updatedAt: 1 })), fingerprintOf(S('a', { updatedAt: 999 })));
    assert(fingerprintOf(S('a', { tp: 1 })) !== fingerprintOf(S('a', { tp: 2 })), '내용은 잡아야 한다');
  });

  test('id가 없는 줄은 세지 않는다', () => {
    const p = syncPlan({ local: [S(''), S('a')], remote: [], remoteReadOk: true });
    eq(p.uploads.length, 1);
  });

  console.log('[전략 동기화 — 못 읽었을 때 빈 목록을 그리지 않는다]');

  test('서버를 못 읽으면 전략이 없다고 하지 않는다', () => {
    const v = listVerdict([], null, false);
    eq(v.complete, false);
    eq(v.strategies.length, 0);
    assert(v.warning.includes('없다는 뜻이 아닙니다'), v.warning);
    assert(v.warning.includes('중복'), v.warning);
  });

  test('서버를 못 읽어도 브라우저 것은 보여 준다', () => {
    const v = listVerdict([S('a')], null, false);
    eq(v.source, 'BROWSER');
    eq(v.strategies.length, 1);
    eq(v.complete, false);
    assert(v.warning.includes('다른 기기'), v.warning);
  });

  test('아직 안 올라간 전략이 있으면 그렇다고 적는다', () => {
    const v = listVerdict([S('local-only')], [S('a')], true);
    eq(v.source, 'MERGED');
    eq(v.strategies.length, 2);
    assert(v.warning.includes('기기를 바꾸면'), v.warning);
  });

  test('전부 서버에 있으면 군말이 없다', () => {
    const v = listVerdict([S('a')], [S('a')], true);
    eq(v.source, 'SERVER');
    eq(v.warning, '');
    eq(v.strategies.length, 1);
  });

  test('최신순으로 낸다', () => {
    const v = listVerdict([], [S('old', { updatedAt: 100 }), S('new', { updatedAt: 900 })], true);
    eq(v.strategies[0].id, 'new');
  });

  console.log('[전략 동기화 — 모르는 칸을 그럴듯하게 채우지 않는다]');

  test('enabled는 true일 때만 true다', () => {
    // 'true' 문자열이나 1을 켜짐으로 읽으면 안 켠 전략이 돈다.
    for (const v of ['true', 1, 'yes', null, undefined]) {
      eq(fromRow({ id: 'a', enabled: v })!.enabled, false, String(v));
    }
    eq(fromRow({ id: 'a', enabled: true })!.enabled, true);
  });

  test('id가 없으면 줄을 만들지 않는다', () => {
    eq(fromRow({ name: 'x' }), null);
    eq(fromRow(null), null);
  });

  test('ISO 시각을 읽는다', () => {
    const r = fromRow({ id: 'a', updated_at: '2026-01-01T00:00:00Z' });
    eq(r!.updatedAt, Date.parse('2026-01-01T00:00:00Z'));
  });
}
