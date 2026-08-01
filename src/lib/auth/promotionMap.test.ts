// src/lib/auth/promotionMap.test.ts
//
// 여기서 틀리면 결과가 **권한 상승 또는 강등**이다.
//
//  · 파싱이 헐거우면 의도하지 않은 계정이 관리자가 된다
//  · 등급 비교가 틀리면 소유자가 super_admin에서 admin으로 내려간다
//
// 둘 다 화면에서는 "관리자입니다"로 똑같이 보인다.

import { test, eq, assert } from '../../test/harness';
import { parseEmailList, buildPromotionMap, shouldPromote } from './promotionMap';

const envOf = (o: Record<string, string>) => (name: string) => o[name];

export function runPromotionMapTests() {
  console.log('[승급 목록 — 파싱]');

  test('쉼표·세미콜론·공백·줄바꿈 어느 것으로 나눠도 받는다', () => {
    eq(parseEmailList('a@x.com, b@x.com;c@x.com d@x.com\ne@x.com').length, 5);
  });

  test('대소문자를 없앤다 — 로그인 이메일과 대조하려면 한 모양이어야 한다', () => {
    eq(parseEmailList('Owner@Example.COM')[0], 'owner@example.com');
  });

  test('@ 없는 조각은 버린다 — 오타가 계정을 만들지 않게', () => {
    eq(parseEmailList('admin, root, a@x.com').length, 1);
  });

  test('빈 값·없음은 빈 목록', () => {
    eq(parseEmailList('').length, 0);
    eq(parseEmailList(null).length, 0);
    eq(parseEmailList(undefined).length, 0);
  });

  console.log('[승급 목록 — 등급 배정]');

  test('목록별로 다른 등급을 준다', () => {
    const m = buildPromotionMap(envOf({
      ADMIN_EMAILS: 'a@x.com',
      DEVELOPER_EMAILS: 'd@x.com',
      SUPER_ADMIN_EMAILS: 's@x.com',
    }));
    eq(m.get('a@x.com'), 'admin');
    eq(m.get('d@x.com'), 'developer');
    eq(m.get('s@x.com'), 'super_admin');
  });

  test('여러 목록에 있으면 가장 높은 등급이 이긴다 — 읽는 순서에 좌우되면 안 된다', () => {
    const m = buildPromotionMap(envOf({
      ADMIN_EMAILS: 'me@x.com',
      SUPER_ADMIN_EMAILS: 'me@x.com',
      DEVELOPER_EMAILS: 'me@x.com',
    }));
    eq(m.get('me@x.com'), 'super_admin');
  });

  test('ADMIN_EMAIL(단수)도 같이 읽는다 — 예전 이름이 살아 있다', () => {
    eq(buildPromotionMap(envOf({ ADMIN_EMAIL: 'old@x.com' })).get('old@x.com'), 'admin');
  });

  test('환경변수가 하나도 없으면 아무도 승급하지 않는다', () => {
    eq(buildPromotionMap(envOf({})).size, 0);
  });

  test('목록에 없는 이메일은 없다', () => {
    const m = buildPromotionMap(envOf({ ADMIN_EMAILS: 'a@x.com' }));
    eq(m.get('b@x.com'), undefined);
  });

  console.log('[승급 판단 — 올리기만 한다]');

  test('낮으면 올린다', () => {
    eq(shouldPromote('user', 'admin').promote, true);
    eq(shouldPromote('founder', 'developer').promote, true);
  });

  test('같으면 두 번 쓰지 않는다', () => {
    eq(shouldPromote('admin', 'admin').promote, false);
  });

  test('높으면 내리지 않는다 — 환경변수를 잘못 고쳐도 강등되면 안 된다', () => {
    const r = shouldPromote('super_admin', 'admin');
    eq(r.promote, false, 'super_admin이 admin으로 내려갔다');
    assert(r.reason.includes('이미'), `이유를 적어야 한다: ${r.reason}`);
  });

  test('developer는 admin 목록에 있어도 내려가지 않는다', () => {
    eq(shouldPromote('developer', 'admin').promote, false);
  });

  test('등급이 아예 없으면(행이 없을 때) 준다', () => {
    eq(shouldPromote(null, 'admin').promote, true);
    eq(shouldPromote('', 'admin').promote, true);
  });

  test('모르는 등급 이름은 건드리지 않는다 — 낮은 것으로 보고 덮으면 강등이다', () => {
    const r = shouldPromote('owner', 'admin');
    eq(r.promote, false);
    assert(r.reason.includes('알 수 없는'), `이유를 적어야 한다: ${r.reason}`);
  });

  test('목록에 없으면(target null) 아무것도 하지 않는다', () => {
    eq(shouldPromote('user', null).promote, false);
  });
}
