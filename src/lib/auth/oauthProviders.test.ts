// src/lib/auth/oauthProviders.test.ts
//
// 이 테스트가 막는 것 둘:
//  · 꺼진 제공자로 사용자를 **앱 밖 JSON 페이지로 내보내는 것**
//  · 확인에 실패했다는 이유로 **멀쩡한 로그인을 막는 것**
//
// 앞은 실제로 났다. 구글 버튼을 누르면 Supabase가 그린
// {"code":400,...,"msg":"Unsupported provider: provider is not enabled"}
// 가 떴고, 돌아올 길은 뒤로가기뿐이었다.

import { test, eq, assert } from '../../test/harness';
import {
  readProviderState, decideOAuthGo, disabledMessage, label,
} from './oauthProviders';

export function runOAuthProvidersTests() {
  console.log('[소셜 로그인 — 꺼진 제공자로 내보내지 않는다]');

  test('켜져 있으면 enabled true', () => {
    const s = readProviderState({ external: { google: true, kakao: false } }, 'google');
    eq(s.enabled, true);
  });

  test('꺼져 있으면 enabled false + 이유', () => {
    const s = readProviderState({ external: { google: false } }, 'google');
    eq(s.enabled, false);
    assert(s.reason.includes('꺼져'), s.reason);
  });

  // **확인 못 한 것은 꺼진 것이 아니다.** null로 두지 않고 false로
  // 떨어뜨리면, 설정 조회가 한 번 실패할 때마다 멀쩡한 구글 로그인이
  // 앱에서 사라진다.
  test('모양이 다르면 null — 꺼졌다고 단정하지 않는다', () => {
    for (const bad of [null, undefined, {}, { external: null }, { external: 'x' },
                       { external: { google: 'yes' } }, 'string', 42]) {
      eq(readProviderState(bad as any, 'google').enabled, null, JSON.stringify(bad));
    }
  });

  test('목록에 그 제공자가 아예 없어도 null', () => {
    eq(readProviderState({ external: { kakao: true } }, 'google').enabled, null);
  });

  // ── 보낼 것인가 ──────────────────────────────────────────
  test('켜져 있으면 보낸다', () => {
    eq(decideOAuthGo({ enabled: true, reason: '' }, 'google').go, true);
  });

  test('꺼져 있으면 안 보내고 앱 안에서 말한다', () => {
    const d = decideOAuthGo({ enabled: false, reason: '꺼짐' }, 'google');
    eq(d.go, false);
    assert(d.message.length > 0, '문구가 비어 있다');
  });

  test('확인 못 했으면 보낸다 — 확인 실패를 차단으로 바꾸지 않는다', () => {
    eq(decideOAuthGo({ enabled: null, reason: '조회 실패' }, 'google').go, true);
  });

  // "provider is not enabled"를 그대로 띄우면 사용자는 자기가 뭘 잘못한
  // 줄 안다. 이건 앱 주인이 대시보드에서 켜야 하는 것이다.
  test('안내에 지금 할 수 있는 일과 관리자가 할 일이 둘 다 있다', () => {
    const m = disabledMessage('google');
    assert(m.includes('이메일'), `지금 로그인할 방법이 없다: ${m}`);
    assert(m.includes('Supabase'), `관리자가 뭘 해야 하는지가 없다: ${m}`);
    assert(!m.includes('Unsupported provider'), '영어 원문을 그대로 띄운다');
  });

  test('제공자 이름은 한국어로 적는다', () => {
    eq(label('google'), '구글');
    eq(label('kakao'), '카카오');
  });
}
