// src/lib/system/migrationStatus.test.ts
//
// 화면이 사람에게 숙제를 넘기지 않는지 본다. 그리고 **못 읽은 것을
// 초록으로 칠하지 않는지**를 본다 — 그게 이 저장소에서 가장 자주 난 거짓말이다.

import { test, eq, assert } from '../../test/harness';
import { migrationStatusOf, migrationsAppliedOf } from './migrationStatus';
import { deploymentVerdict } from '../runtime/workerPlan';

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

  // ── 상태 코드가 "배포가 끝났는가"에 답하는 방식 ──
  //
  // 이 판단이 `/api/system/deployment`에 복사돼 있었고 거기서 `DRIFT`를
  // false로 읽었다. 050(#226)·016(#228)에서 과거 파일을 의도적으로 고쳤고
  // 그 drift는 계속 남으므로, 배포 판정기가 **영구히** "DB 스키마가
  // 따라오지 않았습니다"를 말하게 됐다. 언제나 빨강인 검사는 진짜 어긋난
  // 날의 빨강과 구별되지 않는다.

  test('DRIFT는 적용 완료다 — 전부 적용됐고 파일만 바뀐 것이다', () => {
    eq(migrationsAppliedOf('DRIFT'), true);
    eq(migrationsAppliedOf('UP_TO_DATE'), true);
  });

  test('진짜 미적용은 그대로 false다', () => {
    eq(migrationsAppliedOf('APPLYING'), false);
    eq(migrationsAppliedOf('FAILED'), false);
    eq(migrationsAppliedOf('NEEDS_APPROVAL'), false);
    eq(migrationsAppliedOf('NOT_TRACKED'), false);
  });

  test('못 읽은 것은 null이다 — 모르는 것을 됐다로 읽지 않는다', () => {
    eq(migrationsAppliedOf('UNKNOWN'), null);
    eq(migrationsAppliedOf(undefined), null);
    eq(migrationsAppliedOf(null), null);
    eq(migrationsAppliedOf('처음 보는 코드'), null);
  });

  test('DRIFT여도 배포 판정은 MATCHED다 — 세 SHA가 같고 남은 것이 없다', () => {
    // #228 직후 실제로 겪은 상태를 그대로 만든다.
    const SHA = '108bd54f556cbd57e288ce556bc838a89c036ce9';
    const st = migrationStatusOf({
      required: ['016_a.sql', '050_b.sql'],
      rows: [
        { filename: '016_a.sql', checksum: '옛것', status: 'BASELINE', verified: true },
        { filename: '050_b.sql', checksum: '옛것', status: 'BASELINE', verified: true },
      ],
      checksums: { '016_a.sql': '새것', '050_b.sql': '새것' },
    });
    eq(st.code, 'DRIFT', '전부 적용됐는데 파일이 바뀌었으면 DRIFT다');
    eq(st.pending.length, 0, 'DRIFT에 남은 것이 있으면 안 된다');
    eq(st.failed.length, 0);

    const v = deploymentVerdict({
      mainSha: SHA, vercelSha: SHA, flySha: SHA,
      migrationsApplied: migrationsAppliedOf(st.code),
      pendingMigrations: st.pending,
    });
    eq(v.code, 'MATCHED', v.reason);
    eq(v.matched, true, v.reason);
  });

  test('진짜로 남은 것이 있으면 배포 판정은 실패한다', () => {
    const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const st = migrationStatusOf({ required: ['016_a.sql', '050_b.sql'], rows: [
      { filename: '016_a.sql', checksum: 'x', status: 'APPLIED', verified: true },
    ], tracked: true });
    eq(st.code, 'APPLYING');
    eq(st.pending.length, 1);
    const v = deploymentVerdict({
      mainSha: SHA, vercelSha: SHA, flySha: SHA,
      migrationsApplied: migrationsAppliedOf(st.code), pendingMigrations: st.pending,
    });
    eq(v.matched, false, '남은 마이그레이션이 있으면 배포 완료가 아니다');
    eq(v.code, 'MISMATCH');
  });

  test('실패한 마이그레이션이 있으면 배포 판정은 실패한다', () => {
    const SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const v = deploymentVerdict({
      mainSha: SHA, vercelSha: SHA, flySha: SHA,
      migrationsApplied: migrationsAppliedOf('FAILED'), pendingMigrations: [],
    });
    eq(v.matched, false);
    eq(v.code, 'MISMATCH');
  });

  test('상태를 못 읽으면 통과시키지 않는다', () => {
    const SHA = 'cccccccccccccccccccccccccccccccccccccccc';
    const v = deploymentVerdict({
      mainSha: SHA, vercelSha: SHA, flySha: SHA,
      migrationsApplied: migrationsAppliedOf('UNKNOWN'), pendingMigrations: [],
    });
    eq(v.matched, false, '모르는 것을 배포 완료로 읽지 않는다');
    eq(v.code, 'UNKNOWN');
  });

  test('DRIFT여도 SHA가 어긋나면 실패한다 — 스키마 판정이 SHA 판정을 덮지 않는다', () => {
    const v = deploymentVerdict({
      mainSha: 'dddddddddddddddddddddddddddddddddddddddd',
      vercelSha: 'dddddddddddddddddddddddddddddddddddddddd',
      flySha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      migrationsApplied: migrationsAppliedOf('DRIFT'), pendingMigrations: [],
    });
    eq(v.matched, false);
    eq(v.code, 'MISMATCH');
  });
}
