// src/lib/system/migrationStatus.test.ts
//
// 화면이 사람에게 숙제를 넘기지 않는지 본다. 그리고 **못 읽은 것을
// 초록으로 칠하지 않는지**를 본다 — 그게 이 저장소에서 가장 자주 난 거짓말이다.

import { test, eq, assert } from '../../test/harness';
import { migrationStatusOf } from './migrationStatus';

const REQ = ['055_a.sql', '056_b.sql'];
const row = (filename: string, over: any = {}) =>
  ({ filename, checksum: 'c1', status: 'APPLIED', verified: true, ...over });

export function runMigrationStatusTests() {
  console.log('[마이그레이션 상태 — 사람에게 숙제를 넘기지 않는다]');

  test('전부 적용돼 있으면 초록이고 진입을 막지 않는다', () => {
    const s = migrationStatusOf({ required: REQ, rows: REQ.map(n => row(n)) });
    eq(s.code, 'UP_TO_DATE');
    eq(s.health, 'ok');
    eq(s.entryAllowed, true);
    eq(s.blockedReason, null);
  });

  test('기록을 못 읽으면 초록이 아니고 진입도 막는다', () => {
    const s = migrationStatusOf({ required: REQ, rows: null });
    eq(s.code, 'UNKNOWN');
    eq(s.health, 'unknown');
    eq(s.entryAllowed, false);
    assert(!/모두 적용/.test(s.detail), '못 읽은 것을 적용됨으로 적으면 안 된다');
  });

  test('남은 것이 있으면 "적용하세요"가 아니라 "적용 중"이라고 적는다', () => {
    const s = migrationStatusOf({ required: REQ, rows: [row('055_a.sql')] });
    eq(s.code, 'APPLYING');
    eq(s.pending.join(','), '056_b.sql');
    // **화면이 사람에게 SQL 편집기를 열라고 시키지 않는다**
    assert(!/Supabase|SQL 편집기|실행하세요|적용해/.test(s.detail), `숙제 문구가 남아 있다: ${s.detail}`);
    eq(s.entryAllowed, false);
  });

  test('적용 실패가 남아 있으면 빨강이고 새 주문을 막는다', () => {
    const s = migrationStatusOf({
      required: REQ,
      rows: [row('055_a.sql'), row('056_b.sql', { status: 'FAILED', verified: false })],
    });
    eq(s.code, 'FAILED');
    eq(s.health, 'bad');
    eq(s.entryAllowed, false);
    assert(!!s.blockedReason, '자동으로 못 한 이유가 있어야 한다');
  });

  test('실행은 됐지만 확인이 안 된 것은 적용으로 세지 않는다', () => {
    // **psql이 0으로 끝난 것과 표가 생긴 것은 다른 사실이다**
    const s = migrationStatusOf({
      required: REQ,
      rows: [row('055_a.sql'), row('056_b.sql', { verified: false })],
    });
    eq(s.code, 'APPLYING');
    eq(s.applied, 1);
  });

  test('적용된 뒤 파일이 바뀌면 알리되 자동으로 다시 실행하지 않는다', () => {
    const s = migrationStatusOf({
      required: REQ,
      rows: REQ.map(n => row(n, { checksum: 'old' })),
      checksums: { '055_a.sql': 'old', '056_b.sql': 'new' },
    });
    eq(s.code, 'DRIFT');
    assert(/다시 실행하지 않습니다/.test(String(s.blockedReason)), s.blockedReason || '');
    // 적용 자체는 끝난 상태라 진입까지 막지는 않는다
    eq(s.entryAllowed, true);
  });

  test('빈 기록은 "아무것도 적용 안 됨"이지 "모름"이 아니다', () => {
    const s = migrationStatusOf({ required: REQ, rows: [] });
    eq(s.code, 'APPLYING');
    eq(s.applied, 0);
    eq(s.pending.length, 2);
  });

  test('**기록표가 없으면 신규 진입을 막는다** — 기록 없음은 "적용됨"이 아니다', () => {
    // 실제 돈이 걸린 시스템에서 DB 스키마와 코드 버전이 다른데 신규
    // 주문을 계속 허용하면 안 된다. 054가 정확히 그 상태였다 —
    // 쓰기는 조용히 실패하고 매매는 계속됐다.
    const s = migrationStatusOf({ required: REQ, rows: [], tracked: false });
    eq(s.code, 'NOT_TRACKED');
    eq(s.entryAllowed, false);
    eq(s.health, 'bad');
    assert(!!s.blockedReason, '왜 자동으로 못 했는지는 적어야 한다');
    assert(!/SQL 편집기|붙여 넣/.test(String(s.blockedReason)), '사람에게 SQL을 시키지 않는다');
    // **막는 것은 새로 여는 것뿐이다**
    assert(/청산·보호·복구는 계속/.test(s.entryReason), s.entryReason);
  });

  test('기록표가 생긴 뒤에는 남은 것이 진입을 막는다', () => {
    const s = migrationStatusOf({ required: REQ, rows: [], tracked: true });
    eq(s.code, 'APPLYING');
    eq(s.entryAllowed, false);
  });
}
