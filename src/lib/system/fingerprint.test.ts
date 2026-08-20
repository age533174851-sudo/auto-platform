// src/lib/system/fingerprint.test.ts
//
// **값을 보여주지 않고 "같은 값인가"만 묻는 장치.**
//
// 2026-08-19에 이 질문에 답할 방법이 없어서 하루를 더 썼다:
// 워커는 살아서 tick을 찍는데(build=5a45fa2), heartbeat 실패 로그도
// 없고, worker_heartbeat의 최신 줄은 8/16이었다. 셋이 동시에 참이려면
// 쓰기는 성공하는데 **다른 곳에** 쓰고 있어야 한다 — 그런데 그걸
// 확인할 값이 어디에도 없었다.

import { test, eq, assert } from '../../test/harness';
import { fingerprintOf, fingerprintMatch } from './fingerprint';

export function runFingerprintTests() {
  console.log('[지문 — 값은 안 보여주고 같은지만 말한다]');

  test('같은 값은 같은 지문을 준다', () => {
    const a = fingerprintOf('https://abc.supabase.co');
    const b = fingerprintOf('https://abc.supabase.co');
    eq(a, b);
    eq(a!.length, 6);
  });

  test('다른 값은 다른 지문을 준다', () => {
    assert(fingerprintOf('https://abc.supabase.co') !== fingerprintOf('https://xyz.supabase.co'),
      '다른 프로젝트가 같은 지문을 받으면 대조가 무의미하다');
  });

  test('**지문으로 원래 값을 되찾을 수 없다**', () => {
    const fp = fingerprintOf('https://abc.supabase.co')!;
    assert(!fp.includes('abc'), `지문에 값이 새어 나왔다: ${fp}`);
    assert(!fp.includes('supabase'), fp);
    assert(/^[0-9a-f]{6}$/.test(fp), fp);
  });

  test('앞뒤 공백은 같은 값으로 본다 — 복사할 때 딸려 오는 것', () => {
    eq(fingerprintOf('  https://abc.supabase.co  '), fingerprintOf('https://abc.supabase.co'));
  });

  test('**설정 안 된 것은 빈 지문이 아니라 null이다**', () => {
    // 빈 지문을 주면 "둘 다 설정 안 됨"이 "같은 값"으로 읽힌다.
    eq(fingerprintOf(''), null);
    eq(fingerprintOf(null), null);
    eq(fingerprintOf(undefined), null);
    eq(fingerprintOf('   '), null);
  });

  console.log('[지문 — 하나라도 없으면 "같다"가 아니다]');

  test('둘이 같으면 SAME', () => {
    const fp = fingerprintOf('https://abc.supabase.co');
    eq(fingerprintMatch(fp, fp).code, 'SAME');
  });

  test('**둘이 다르면 DIFFERENT — 서로 다른 곳을 보고 있다**', () => {
    const r = fingerprintMatch(
      fingerprintOf('https://abc.supabase.co'), fingerprintOf('https://xyz.supabase.co'));
    eq(r.code, 'DIFFERENT');
    assert(/다른 곳/.test(r.reason), r.reason);
  });

  test('**한쪽이 없으면 UNKNOWN이다** — 모르는 것을 같다고 하지 않는다', () => {
    eq(fingerprintMatch(null, 'abc123').code, 'UNKNOWN');
    eq(fingerprintMatch('abc123', null).code, 'UNKNOWN');
    eq(fingerprintMatch(null, null).code, 'UNKNOWN');
  });
}
