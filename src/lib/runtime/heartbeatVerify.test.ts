// src/lib/runtime/heartbeatVerify.test.ts
//
// 지키는 것
//  1. "요청 성공"만으로 ok라고 적지 않는다 — 0행은 실패다
//  2. 못 읽은 것과 안 써진 것을 가른다
//  3. 방금 쓴 값이 다시 읽히지 않으면 실패다
//  4. project ref로 같은 DB를 판단하고, 모르면 모른다고 한다
import { test, assert, eq } from '../../test/harness';
import {
  heartbeatVerdict, projectRefOf, projectRefFromPostgresUrl, sameProject,
} from './heartbeatVerify';

const NOW = '2026-08-23T09:00:00.000Z';
const OLD = '2026-08-21T04:00:00.000Z';
const SHA = 'f469f8dbc29d102a3eb0c1d6a0da1c7a8db0d146';
const OLDSHA = '0a3a5cf1111111111111111111111111111111111';

const base = {
  expected: { workerId: 'w1', lastSeen: NOW, version: SHA },
  writeError: null as string | null,
  returnedRows: 1 as number | null,
  readError: null as string | null,
  readRow: { worker_id: 'w1', last_seen: NOW, version: SHA } as any,
};

export function runHeartbeatVerifyTests() {
  console.log('\n💓 heartbeat 쓰기 확인 (heartbeatVerify)');

  test('쓰고 다시 읽어 같으면 RECORDED', () => {
    const v = heartbeatVerdict(base);
    eq(v.code, 'RECORDED', '통과');
    assert(v.ok, 'ok');
  });

  // ── 1. 오류 없이 0행 — 이번 고장의 모양 ──
  test('오류가 없어도 0행이면 ok라고 적지 않는다', () => {
    const v = heartbeatVerdict({ ...base, returnedRows: 0 });
    eq(v.code, 'WRITE_NOT_VISIBLE', '0행은 실패다');
    assert(!v.ok, 'ok가 아니다');
    assert(v.suspectKey, '서비스 키를 의심해야 한다');
    assert(/RLS/.test(v.message), 'RLS가 UPDATE를 0행으로 만드는 모양이라고 말해야 한다');
  });

  test('행 수를 세지 못한 것(null)은 0행이 아니다', () => {
    const v = heartbeatVerdict({ ...base, returnedRows: null });
    eq(v.code, 'RECORDED', '못 센 것을 0으로 읽으면 안 된다');
  });

  test('upsert가 오류를 돌려주면 WRITE_FAILED', () => {
    const v = heartbeatVerdict({ ...base, writeError: 'permission denied for table worker_heartbeat' });
    eq(v.code, 'WRITE_FAILED', '쓰기 실패');
    assert(/permission denied/.test(v.message), '사유가 남아야 한다');
  });

  // ── 2. 못 읽은 것과 안 써진 것 ──
  test('다시 읽기가 실패한 것은 "안 써졌다"가 아니다', () => {
    const v = heartbeatVerdict({ ...base, readError: 'fetch failed' });
    eq(v.code, 'READBACK_FAILED', '못 읽음');
    assert(!v.suspectKey, '못 읽은 것만으로 키를 의심하지 않는다');
    assert(/다릅니다/.test(v.message) || /다음 주기/.test(v.message), '구분해서 말해야 한다');
  });

  test('다시 읽었는데 행이 없으면 READBACK_MISSING', () => {
    const v = heartbeatVerdict({ ...base, readRow: null });
    eq(v.code, 'READBACK_MISSING', '행이 없다');
    assert(v.suspectKey, '남지 않았다면 권한을 의심한다');
  });

  // ── 3. 방금 쓴 값이 안 보이면 실패 ──
  test('다시 읽은 last_seen이 더 오래됐으면 READBACK_STALE — 이번 고장의 증상', () => {
    const v = heartbeatVerdict({
      ...base,
      readRow: { worker_id: 'w1', last_seen: OLD, version: OLDSHA },
    });
    eq(v.code, 'READBACK_STALE', '반영 안 됨');
    assert(!v.ok, 'ok가 아니다');
    assert(v.message.includes(OLD), '읽은 값이 메시지에 있어야 한다');
  });

  test('다른 워커가 더 최신을 썼으면 실패가 아니다', () => {
    const later = '2026-08-23T09:00:05.000Z';
    const v = heartbeatVerdict({ ...base, readRow: { worker_id: 'w1', last_seen: later, version: SHA } });
    eq(v.code, 'RECORDED', '더 최신인 것은 정상이다');
  });

  test('version이 다르면 그 사실을 말한다', () => {
    const v = heartbeatVerdict({ ...base, readRow: { worker_id: 'w1', last_seen: NOW, version: OLDSHA } });
    eq(v.code, 'READBACK_STALE', '버전 불일치');
    assert(v.message.includes(SHA.slice(0, 7)), '쓴 값');
    assert(v.message.includes(OLDSHA.slice(0, 7)), '읽은 값');
  });

  test('version 칸이 아직 없는 배포(null)에서는 버전을 따지지 않는다', () => {
    const v = heartbeatVerdict({ ...base, readRow: { worker_id: 'w1', last_seen: NOW, version: null } });
    eq(v.code, 'RECORDED', '054 이전 배포를 실패로 만들지 않는다');
  });

  test('읽은 행에 last_seen이 없으면 반영 안 된 것으로 본다', () => {
    const v = heartbeatVerdict({ ...base, readRow: { worker_id: 'w1', last_seen: null, version: SHA } });
    eq(v.code, 'READBACK_STALE', 'last_seen이 없으면 확인이 아니다');
  });

  // ── 4. project ref ──
  test('supabase URL에서 project ref를 뽑는다', () => {
    eq(projectRefOf('https://sgbysrvvxlluzffmgcho.supabase.co'), 'sgbysrvvxlluzffmgcho', 'ref');
    eq(projectRefOf('https://sgbysrvvxlluzffmgcho.supabase.co/'), 'sgbysrvvxlluzffmgcho', '끝슬래시');
    eq(projectRefOf('https://self-hosted.example.com'), null, '모르는 모양은 null');
    eq(projectRefOf(''), null, '빈 값');
  });

  test('postgres 접속 문자열에서 ref를 뽑되 비밀은 내보내지 않는다', () => {
    const direct = 'postgresql://postgres:SUPERSECRET@db.sgbysrvvxlluzffmgcho.supabase.co:5432/postgres';
    eq(projectRefFromPostgresUrl(direct), 'sgbysrvvxlluzffmgcho', '직접 접속');

    const pooled = 'postgresql://postgres.sgbysrvvxlluzffmgcho:SUPERSECRET@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres';
    eq(projectRefFromPostgresUrl(pooled), 'sgbysrvvxlluzffmgcho', '풀러 접속');

    for (const u of [direct, pooled]) {
      const out = String(projectRefFromPostgresUrl(u));
      assert(!out.includes('SUPERSECRET'), '비밀번호가 새면 안 된다');
      assert(!out.includes('pooler.supabase.com'), '호스트도 내보내지 않는다');
    }
    eq(projectRefFromPostgresUrl('not a url'), null, '못 읽으면 null');
    eq(projectRefFromPostgresUrl(''), null, '빈 값');
  });

  test('ref를 모르면 같다고 하지 않는다', () => {
    eq(sameProject('a', 'a'), true, '같음');
    eq(sameProject('a', 'b'), false, '다름');
    eq(sameProject(null, 'a'), null, '모르면 모른다');
    eq(sameProject('a', null), null, '모르면 모른다');
  });
}
