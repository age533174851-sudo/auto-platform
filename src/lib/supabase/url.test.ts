// src/lib/supabase/url.test.ts
//
// 지키는 것
//  1. 둘이 다르면 URL_MISMATCH — 조용히 한쪽을 고르지 않는다
//  2. 둘이 같으면 같은 DB를 쓴다
//  3. 한쪽만 있으면 정해진 fallback대로 움직이고, 어느 쪽인지 말한다
//  4. 진단 지문은 **admin client가 고른 URL** 기준이다
//  5. 6자 해시가 같다고 같은 DB라고 단정하지 않는다
//  6. 값은 밖으로 나가지 않는다
import { test, assert, eq } from '../../test/harness';
import {
  resolveServerSupabaseUrl, normalizeSupabaseUrl, supabaseProjectRef, sameDatabase,
} from './url';
import { fingerprintOf } from '../system/fingerprint';

const A = 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co';
const B = 'https://bbbbbbbbbbbbbbbbbbbb.supabase.co';

export function runSupabaseUrlTests() {
  console.log('\n🔗 서버 Supabase URL 해석기 (supabase/url)');

  // ── 1. 서로 다르면 실패 ──
  test('SUPABASE_URL=A / NEXT_PUBLIC_SUPABASE_URL=B → URL_MISMATCH', () => {
    const r = resolveServerSupabaseUrl({ SUPABASE_URL: A, NEXT_PUBLIC_SUPABASE_URL: B });
    eq(r.code, 'URL_MISMATCH', '다르면 불일치');
    eq(r.url, null, '고르지 않는다 — 한쪽을 고르면 쓰기와 진단이 갈린다');
    eq(r.source, 'NONE', '고른 곳이 없다');
    eq(r.fingerprint, null, '고르지 못했으면 지문도 없다 — "같음"이 아니다');
  });

  test('불일치 메시지에 두 지문과 project ref가 같이 나온다', () => {
    const r = resolveServerSupabaseUrl({ SUPABASE_URL: A, NEXT_PUBLIC_SUPABASE_URL: B });
    assert(r.message.includes(fingerprintOf(A)), 'A 지문');
    assert(r.message.includes(fingerprintOf(B)), 'B 지문');
    assert(/project aaaaaaaaaaaaaaaaaaaa vs bbbbbbbbbbbbbbbbbbbb/.test(r.message), 'ref로도 구분되어야 한다');
  });

  test('불일치여도 값 자체는 새어 나가지 않는다', () => {
    const r = resolveServerSupabaseUrl({
      SUPABASE_URL: 'https://secret-project-xyz.supabase.co?key=DO_NOT_LEAK',
      NEXT_PUBLIC_SUPABASE_URL: B,
    });
    const s = JSON.stringify(r);
    assert(!s.includes('DO_NOT_LEAK'), 'URL 값이 그대로 나갔다');
  });

  // ── 2. 같으면 쓴다 ──
  test('둘이 같으면 같은 DB를 쓴다', () => {
    const r = resolveServerSupabaseUrl({ SUPABASE_URL: A, NEXT_PUBLIC_SUPABASE_URL: A });
    eq(r.code, 'OK', '통과');
    eq(r.url, A, '그 값');
    eq(r.source, 'SUPABASE_URL', 'canonical이 먼저');
  });

  test('끝슬래시·공백만 다른 것은 다른 것이 아니다', () => {
    const r = resolveServerSupabaseUrl({ SUPABASE_URL: `  ${A}/  `, NEXT_PUBLIC_SUPABASE_URL: A });
    eq(r.code, 'OK', '같은 곳이다');
    eq(r.url, A, '정규화된 값');
  });

  // ── 3. 한쪽만 있을 때 ──
  test('SUPABASE_URL만 있으면 그것을 쓴다', () => {
    const r = resolveServerSupabaseUrl({ SUPABASE_URL: A });
    eq(r.code, 'OK', '통과');
    eq(r.source, 'SUPABASE_URL', 'canonical');
    eq(r.url, A, '그 값');
  });

  test('NEXT_PUBLIC만 있으면 내려가되 내려갔다고 말한다', () => {
    const r = resolveServerSupabaseUrl({ NEXT_PUBLIC_SUPABASE_URL: B });
    eq(r.code, 'OK', '통과');
    eq(r.source, 'NEXT_PUBLIC_SUPABASE_URL', 'fallback');
    eq(r.url, B, '그 값');
    assert(/fallback|내려갔/.test(r.message), '내려갔다는 사실이 보여야 한다');
  });

  test('둘 다 없으면 MISSING — 빈 문자열로 접속하지 않는다', () => {
    const r = resolveServerSupabaseUrl({});
    eq(r.code, 'MISSING', '없음');
    eq(r.url, null, 'null이어야 한다');
  });

  test('URL 형식이 아니면 INVALID', () => {
    const r = resolveServerSupabaseUrl({ SUPABASE_URL: 'not a url' });
    eq(r.code, 'INVALID', '형식 오류');
    eq(r.url, null, '쓰지 않는다');
    assert(!r.message.includes('not a url'), '값을 메시지에 넣지 않는다');
  });

  // ── 4. 지문은 실제로 고른 URL 기준 ──
  test('지문은 admin client가 고른 URL의 것이다 — 표시용을 따로 계산하지 않는다', () => {
    // 예전 버그 재현 형태: 표시용은 SUPABASE_URL, 실제 접속은 NEXT_PUBLIC.
    // 이제 둘이 다르면 애초에 고르지 못한다.
    const mismatch = resolveServerSupabaseUrl({ SUPABASE_URL: A, NEXT_PUBLIC_SUPABASE_URL: B });
    eq(mismatch.fingerprint, null, '고르지 못했으면 지문이 없다');

    const only = resolveServerSupabaseUrl({ NEXT_PUBLIC_SUPABASE_URL: B });
    eq(only.fingerprint, fingerprintOf(B), '실제로 쓰는 값의 지문이어야 한다');
    assert(only.fingerprint !== fingerprintOf(A), 'A의 지문이 나오면 예전 버그다');
  });

  test('saw에는 두 이름이 각각 무엇을 가리켰는지 남는다', () => {
    const r = resolveServerSupabaseUrl({ SUPABASE_URL: A, NEXT_PUBLIC_SUPABASE_URL: B });
    eq(r.saw.server?.fingerprint, fingerprintOf(A), 'server 쪽');
    eq(r.saw.public?.fingerprint, fingerprintOf(B), 'public 쪽');
    eq(r.saw.server?.projectRef, 'aaaaaaaaaaaaaaaaaaaa', 'ref도');
  });

  // ── 5. 6자 해시로 단정하지 않는다 ──
  test('project ref를 뽑는다', () => {
    eq(supabaseProjectRef('https://sgbysrvvxlluzffmgcho.supabase.co'), 'sgbysrvvxlluzffmgcho', 'ref');
    eq(supabaseProjectRef('https://db.example.com'), null, '모르는 모양은 null — 지어내지 않는다');
    eq(supabaseProjectRef(''), null, '빈 값은 null');
  });

  test('ref를 둘 다 알면 ref로 판단한다', () => {
    const a = { fingerprint: 'aaaaaa', projectRef: 'proj1' };
    const b = { fingerprint: 'bbbbbb', projectRef: 'proj1' };
    eq(sameDatabase(a, b), true, '같은 프로젝트');
    eq(sameDatabase(a, { fingerprint: 'aaaaaa', projectRef: 'proj2' }), false, '다른 프로젝트');
  });

  test('지문만 같으면 "같다"고 단정하지 않는다 — null(모름)이다', () => {
    const a = { fingerprint: '1351b7', projectRef: null };
    const b = { fingerprint: '1351b7', projectRef: null };
    eq(sameDatabase(a, b), null, '6자가 같다고 같은 DB라고 적으면 안 된다');
  });

  test('지문이 다르면 ref 없이도 다르다고 말할 수 있다', () => {
    eq(sameDatabase({ fingerprint: 'aaaaaa', projectRef: null }, { fingerprint: 'bbbbbb', projectRef: null }),
       false, '다른 것은 확실하다');
  });

  test('한쪽을 모르면 모른다 — 없는 것을 같다고 하지 않는다', () => {
    eq(sameDatabase(null, { fingerprint: 'aaaaaa', projectRef: 'p' }), null, '모름');
  });

  test('normalize는 값을 바꾸지 않고 다듬기만 한다', () => {
    eq(normalizeSupabaseUrl(`\n ${A}// `), A, '공백·끝슬래시만');
    eq(normalizeSupabaseUrl(null), '', 'null은 빈 문자열');
  });
}
