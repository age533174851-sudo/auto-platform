// src/lib/supabase/urlObserve.test.ts
//
// 지키는 것
//  1. 값이 응답에 새지 않는다 — present · projectRef · 지문 6자뿐
//  2. 모르는 것을 "같다"로 적지 않는다
//  3. 관측일 뿐 아무것도 고르거나 막지 않는다 (모듈에 그런 것이 없다)
import { test, assert, eq } from '../../test/harness';
import { observeSupabaseUrls, sameProjectOf, projectRefOf } from './urlObserve';
import { fingerprintOf } from '../system/fingerprint';

const A = 'https://sgbysrvvxlluzffmgcho.supabase.co';
const B = 'https://otherprojectref00000.supabase.co';

export function runUrlObserveTests() {
  console.log('\n🔎 Supabase URL 관측 (동작 변경 없음)');

  test('두 이름이 같으면 sameProject=true', () => {
    const o = observeSupabaseUrls({ SUPABASE_URL: A, NEXT_PUBLIC_SUPABASE_URL: A });
    eq(o.sameProject, true, '같음');
    eq(o.saw.server.projectRef, 'sgbysrvvxlluzffmgcho', 'server ref');
    eq(o.saw.public.projectRef, 'sgbysrvvxlluzffmgcho', 'public ref');
    assert(o.saw.server.present && o.saw.public.present, '둘 다 있음');
  });

  test('두 이름이 다른 프로젝트면 sameProject=false', () => {
    const o = observeSupabaseUrls({ SUPABASE_URL: A, NEXT_PUBLIC_SUPABASE_URL: B });
    eq(o.sameProject, false, '다름');
    eq(o.saw.server.fingerprint, fingerprintOf(A), 'server 지문');
    eq(o.saw.public.fingerprint, fingerprintOf(B), 'public 지문');
    assert(/다른 프로젝트/.test(o.note), '사실을 말해야 한다');
    assert(/동작도 바꾸지 않습니다/.test(o.note), '막지 않는다는 것도 분명히 한다');
  });

  test('끝슬래시·공백만 다른 것은 다른 것이 아니다', () => {
    const o = observeSupabaseUrls({ SUPABASE_URL: `  ${A}/ `, NEXT_PUBLIC_SUPABASE_URL: A });
    eq(o.sameProject, true, '같은 곳');
  });

  // ── 한쪽만 있을 때 ──
  test('SUPABASE_URL만 있으면 public.present=false이고 비교는 null', () => {
    const o = observeSupabaseUrls({ SUPABASE_URL: A });
    eq(o.saw.server.present, true, 'server 있음');
    eq(o.saw.public.present, false, 'public 없음');
    eq(o.saw.public.projectRef, null, '없으면 ref도 없다');
    eq(o.sameProject, null, '비교할 수 없으면 null');
    assert(/admin client는 이 이름을 씁니다/.test(o.note), '어느 쪽이 실제로 쓰이는지 말해야 한다');
  });

  test('NEXT_PUBLIC만 있으면 server.present=false', () => {
    const o = observeSupabaseUrls({ NEXT_PUBLIC_SUPABASE_URL: B });
    eq(o.saw.server.present, false, 'server 없음');
    eq(o.saw.public.present, true, 'public 있음');
    eq(o.sameProject, null, '비교 불가');
  });

  test('둘 다 없으면 전부 null/false이고 던지지 않는다', () => {
    const o = observeSupabaseUrls({});
    eq(o.saw.server.present, false, 'server');
    eq(o.saw.public.present, false, 'public');
    eq(o.sameProject, null, '비교 불가');
  });

  // ── 모르는 것을 같다고 하지 않는다 ──
  test('ref를 못 읽는 주소는 지문이 다르면 false, 같으면 null', () => {
    eq(sameProjectOf('https://a.example.com', 'https://b.example.com'), false, '지문이 다르면 다른 것은 확실하다');
    eq(sameProjectOf('https://self.example.com', 'https://self.example.com'), true, '문자열이 같으면 같다');
  });

  test('project ref를 못 읽으면 null — 지어내지 않는다', () => {
    eq(projectRefOf('https://db.example.com'), null, '모르는 모양');
    eq(projectRefOf(''), null, '빈 값');
    eq(projectRefOf('not a url'), null, 'URL 아님');
  });

  test('한쪽 ref만 알면 같다고 하지 않는다', () => {
    const r = sameProjectOf(A, 'https://proxy.example.com');
    assert(r === false || r === null, '같다고 적으면 안 된다');
  });

  // ── 값이 새지 않는다 ──
  test('URL 값 자체는 응답 어디에도 없다', () => {
    const secretish = 'https://sgbysrvvxlluzffmgcho.supabase.co?token=DO_NOT_LEAK';
    const o = observeSupabaseUrls({ SUPABASE_URL: secretish, NEXT_PUBLIC_SUPABASE_URL: B });
    const s = JSON.stringify(o);
    assert(!s.includes('DO_NOT_LEAK'), '쿼리스트링이 새면 안 된다');
    assert(!s.includes('supabase.co'), '전체 URL이 들어가면 안 된다');
    assert(s.includes('sgbysrvvxlluzffmgcho'), 'project ref는 비밀이 아니므로 남는다');
  });

  test('지문은 6자다', () => {
    const o = observeSupabaseUrls({ SUPABASE_URL: A, NEXT_PUBLIC_SUPABASE_URL: B });
    eq(String(o.saw.server.fingerprint).length, 6, 'server');
    eq(String(o.saw.public.fingerprint).length, 6, 'public');
  });

  // ── 관측일 뿐이다 ──
  test('이 모듈은 접속 대상을 고르거나 막는 것을 내보내지 않는다', async () => {
    const mod: any = await import('./urlObserve');
    const names = Object.keys(mod).sort();
    eq(names.join(','), 'observeServerSupabaseUrls,observeSupabaseUrls,projectRefOf,sameProjectOf',
       '관측 함수만 있어야 한다 — resolver/게이트가 들어오면 이 테스트가 먼저 깨진다');
  });
}
