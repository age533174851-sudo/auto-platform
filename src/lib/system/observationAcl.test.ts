// src/lib/system/observationAcl.test.ts
//
// **⑤B-3A-2.3 — 095가 약속한 것을 실제로 하는가.**
//
// 여기서 지키는 핵심 둘:
//   · `REVOKE SELECT`만 있으면 **통과시키지 않는다** — 쓰기가 남는다
//   · 줄바꿈·대소문자·공백만 바뀐 것은 **실패시키지 않는다** — 그러면
//     검사기가 서식 변경에 거짓 실패를 내고 아무도 안 믿게 된다
import { test, assert, eq } from '../../test/harness';
import {
  checkObservationAcl, parseAclStatements,
  PROTECTED_OBSERVATION_TABLES, PUBLIC_ROLES, SERVICE_ROLE,
} from './observationAcl';

// ★ 실제 095 **파일**은 여기서 읽지 않는다. 테스트 러너는 `src`만
//   임시 디렉터리로 복사하므로 `supabase/`가 없다. 실제 파일 검증은
//   `check-100x-contract.mjs`가 **같은 정본 함수를 돌려서** 한다 —
//   판정 로직을 두 벌로 만들지 않는다.
const GOOD = `
REVOKE ALL PRIVILEGES ON TABLE public.exact100x_risk_observations FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.exact100x_exit_escape_observations FROM anon, authenticated;
GRANT ALL PRIVILEGES ON TABLE public.exact100x_risk_observations TO service_role;
GRANT ALL PRIVILEGES ON TABLE public.exact100x_exit_escape_observations TO service_role;
`;

export function runObservationAclTests() {
  test('★ 줄바꿈·대소문자·공백만 바뀌면 그대로 통과한다', () => {
    const squashed = GOOD.replace(/\n/g, ' ').replace(/\s+/g, ' ');
    eq(checkObservationAcl(squashed).code, 'OK', '★ 한 줄로 합쳤다고 실패했다');
    eq(checkObservationAcl(GOOD.toLowerCase()).code, 'OK', '★ 소문자라고 실패했다');
    const spaced = GOOD.replace(/ /g, '   ').replace(/,/g, ' ,  ');
    eq(checkObservationAcl(spaced).code, 'OK', '★ 공백이 늘었다고 실패했다');
    const commented = `-- 설명\n/* 블록 */\n${GOOD}`;
    eq(checkObservationAcl(commented).code, 'OK', '★ 주석 때문에 실패했다');
  });

  test('PRIVILEGES 생략형도 같은 뜻이다', () => {
    eq(checkObservationAcl(GOOD.replace(/ALL PRIVILEGES/g, 'ALL')).code, 'OK');
  });

  test('TABLE 키워드 생략형도 같은 뜻이다', () => {
    eq(checkObservationAcl(GOOD.replace(/ON TABLE /g, 'ON ')).code, 'OK');
  });

  // ── ACL1 · ACL2 ──
  test('★ 한 표의 REVOKE를 지우면 잡는다', () => {
    const a = GOOD.split('\n').filter(l => !/REVOKE[\s\S]*risk_observations/.test(l)).join('\n');
    eq(checkObservationAcl(a).code, 'ROLE_NOT_REVOKED', '★ risk 표가 열려 있는데 통과했다');
    const b = GOOD.split('\n').filter(l => !/REVOKE[\s\S]*escape_observations/.test(l)).join('\n');
    eq(checkObservationAcl(b).code, 'ROLE_NOT_REVOKED', '★ escape 표가 열려 있는데 통과했다');
  });

  // ── ACL3 · ACL4 ──
  test('★ anon만 회수하고 authenticated를 남기면 잡는다', () => {
    const v = checkObservationAcl(GOOD.replace(/FROM anon, authenticated/g, 'FROM anon'));
    eq(v.code, 'ROLE_NOT_REVOKED');
    assert(v.reason.includes('authenticated'), `사유에 남은 role이 없다: ${v.reason}`);
  });

  test('★ authenticated만 회수하고 anon을 남기면 잡는다', () => {
    const v = checkObservationAcl(GOOD.replace(/FROM anon, authenticated/g, 'FROM authenticated'));
    eq(v.code, 'ROLE_NOT_REVOKED');
    assert(v.reason.includes('anon'), `사유에 남은 role이 없다: ${v.reason}`);
  });

  // ── ACL5 · ACL6 ──
  test('★ SELECT만 회수하면 잡는다 — 쓰기가 남는다', () => {
    const v = checkObservationAcl(GOOD.replace(/REVOKE ALL PRIVILEGES/g, 'REVOKE SELECT'));
    eq(v.code, 'REVOKE_NOT_ALL', '★ 읽기만 막고 "닫았다"고 적었다');
  });

  test('★ TRUNCATE를 남기는 열거형이면 잡는다', () => {
    const v = checkObservationAcl(GOOD.replace(/REVOKE ALL PRIVILEGES/g,
      'REVOKE SELECT, INSERT, UPDATE, DELETE'));
    eq(v.code, 'REVOKE_NOT_ALL', '★ TRUNCATE가 남았는데 통과했다');
  });

  // ── ACL7 · ACL8 ──
  test('★ service_role GRANT를 지우면 잡는다', () => {
    const v = checkObservationAcl(GOOD.split('\n').filter(l => !/^GRANT/.test(l)).join('\n'));
    eq(v.code, 'SERVICE_GRANT_MISSING', '★ 서버가 못 쓰는데 통과했다');
  });

  test('★ service_role 대신 authenticated에 GRANT하면 잡는다', () => {
    const v = checkObservationAcl(GOOD.replace(/TO service_role/g, 'TO authenticated'));
    eq(v.code, 'PUBLIC_ROLE_GRANTED', '★ 회수한 role을 다시 열었는데 통과했다');
  });

  // ── ACL9 ──
  test('★ 표 이름이 하나라도 틀리면 잡는다', () => {
    const v = checkObservationAcl(GOOD.replace(/exact100x_exit_escape_observations/g,
      'exact100x_exit_escape_observation'));
    eq(v.code, 'TABLE_NOT_PROTECTED', '★ 없는 표를 닫고 통과했다');
  });

  // ── ACL12 ──
  test('★ "RLS 있으니 REVOKE 불필요"로 둘 다 지우면 잡는다', () => {
    const v = checkObservationAcl(GOOD.split('\n').filter(l => !/^REVOKE/.test(l)).join('\n'));
    assert(!v.ok, '★ REVOKE 없이 통과했다 — RLS와 GRANT는 다른 층이다');
    eq(v.code, 'ROLE_NOT_REVOKED');
  });

  // ── replay-safe ──
  test('★ 데이터를 바꾸는 문장이 섞이면 잡는다', () => {
    for (const bad of ['DELETE FROM public.exact100x_risk_observations',
                       'TRUNCATE public.exact100x_risk_observations',
                       'DROP TABLE public.exact100x_risk_observations',
                       "UPDATE public.exact100x_risk_observations SET env = 'TESTNET'"]) {
      const v = checkObservationAcl(`${GOOD}\n${bad};`);
      eq(v.code, 'DESTRUCTIVE', `★ ${bad.split(' ')[0]}를 통과시켰다`);
    }
  });

  test('★ ACL 판정에 DB를 바꿀 수단이 없다', async () => {
    const src = await import('./observationAcl');
    for (const bad of ['applyAcl', 'grant', 'revoke', 'execSql', 'query']) {
      eq(Object.keys(src).includes(bad), false, `★ ${bad}를 내보낸다`);
    }
  });
}
