// src/lib/auth/sessionLogVerdict.test.ts
//
// **「현재 세션」 판정이 조용히 틀리면 사용자가 로그아웃됐다고 믿는다.**
//
// `/api/auth/session-log`는 네 자리에서 `error`를 버렸다. 그중 둘이 판단이다:
//
//   84줄  기존 세션 조회 → 실패하면 `existing`이 null → **신규 INSERT 경로**로
//         간다. `user_login_sessions`에 `(user_id, session_token)` 유일 제약이
//         없어서(003_login_sessions.sql — 인덱스만) **중복 행이 생긴다.**
//
//   193줄 현재 세션 여부 조회 → 실패하면 `isCurrent = false`로 단정하고
//         「다른 기기는 다음 토큰 갱신 시점에 자동으로 로그아웃됩니다」를 답한다.
//         자기 현재 세션을 끊은 사용자가 **그 말을 믿고 로그아웃을 안 한다.**
//
// 판정을 여기 한 곳에 둔다 — 라우트에 다시 적지 않는다.

import { test, eq, assert } from '../../test/harness';
import { existingSessionVerdict, currentSessionNote } from './sessionLogVerdict';

export function runSessionLogVerdictTests() {
  console.log('[세션 기록 — 못 읽은 것을 "없음"·"현재 아님"으로 단정하지 않는다]');

  test('행이 있으면 갱신이다', () => {
    eq(existingSessionVerdict({ row: { id: 'a' }, failed: false }), 'UPDATE');
  });

  test('행이 없으면 신규다', () => {
    eq(existingSessionVerdict({ row: null, failed: false }), 'INSERT');
  });

  test('★ 조회가 실패하면 신규로 넘어가지 않는다 (중복 행 방지)', () => {
    eq(existingSessionVerdict({ row: null, failed: true }), 'UNREADABLE');
  });

  test('★ 현재 세션 여부를 못 읽으면 false로 단정하지 않는다', () => {
    const v = currentSessionNote({ row: null, failed: true });
    assert(v.isCurrent === null, `못 읽은 것을 ${v.isCurrent}로 적었다`);
    assert(/확인하지 못/.test(v.note), `사유가 없다: ${v.note}`);
  });

  test('★ 못 읽었으면 안전한 쪽을 안내한다 (로그아웃하라고 말한다)', () => {
    const v = currentSessionNote({ row: null, failed: true });
    assert(/로그아웃/.test(v.note), `안전한 쪽 안내가 없다: ${v.note}`);
    assert(!/자동으로 로그아웃됩니다/.test(v.note),
      `못 읽었는데 "자동 로그아웃된다"고 말했다: ${v.note}`);
  });

  test('현재 세션이면 클라이언트 로그아웃을 안내한다', () => {
    const v = currentSessionNote({ row: { is_current: true }, failed: false });
    eq(v.isCurrent, true);
    assert(/별도로/.test(v.note), v.note);
  });

  test('현재 세션이 아니면 그대로 안내한다', () => {
    const v = currentSessionNote({ row: { is_current: false }, failed: false });
    eq(v.isCurrent, false);
    assert(/자동으로 로그아웃/.test(v.note), v.note);
  });

  // 배선 — 판정만 만들고 라우트가 안 쓰면 아무것도 안 바뀐다.
  //
  // **이름이 있는 것만으로는 부족하다.** 처음 쓴 판에서는 `import` 줄이
  // 이름을 담고 있어서, 호출을 떼어내도 이 시험이 통과했다(반대 증명에서
  // 잡혔다). 그래서 **import 줄을 지우고 호출 모양으로** 대조한다.
  test('★ 라우트가 두 판정을 모두 호출한다', () => {
    const src = require('node:fs').readFileSync(
      'src/app/api/auth/session-log/route.ts', 'utf8') as string;
    const code = src.replace(/\/\*[\s\S]*?\*\//g, (m: string) => m.replace(/[^\n]/g, ' '))
      .split('\n')
      .map((l: string) => l.replace(/\/\/.*$/, ''))
      .filter((l: string) => !/^\s*import\b/.test(l))
      .join('\n');
    assert(/existingSessionVerdict\s*\(/.test(code),
      '라우트가 existingSessionVerdict를 호출하지 않는다 (이름만 있는 것은 배선이 아니다)');
    assert(/currentSessionNote\s*\(/.test(code),
      '라우트가 currentSessionNote를 호출하지 않는다');
    assert(/UNREADABLE/.test(code), '라우트가 UNREADABLE을 처리하지 않는다');
  });
}
