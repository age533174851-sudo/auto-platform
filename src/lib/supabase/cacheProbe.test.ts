// src/lib/supabase/cacheProbe.test.ts
//
// 지키는 것
//  1. 못 읽은 것을 "낡았다"로 읽지 않는다
//  2. 세 팔의 조합마다 정확히 한 판정이 나온다
//  3. no-store fetch가 실제로 cache:'no-store'를 붙이고 나머지는 보존한다
//  4. "재현 안 됨"과 "고쳐짐"을 섞지 않는다
import { test, assert, eq } from '../../test/harness';
import { cacheProbeVerdict, noStoreFetch, type ProbeArm } from './cacheProbe';

const NOW = Date.parse('2026-08-24T13:34:13.000Z');
const FRESH = '2026-08-24T13:34:12.286Z';       // 1초 전
const STALE = '2026-08-20T14:18:35.000Z';       // 사흘 전

const arm = (lastSeen: string | null, error: string | null = null): ProbeArm =>
  ({ ran: true, lastSeen, error });

export function runCacheProbeTests() {
  console.log('\n🧊 fetch 캐시 A/B 판정 (cacheProbe)');

  // ── 실측으로 본 그 모양 ──
  test('기존만 낡고 URL만 바꾼 질의가 최신이면 FETCH_CACHE_STALE', () => {
    const v = cacheProbeVerdict({
      baseline: arm(STALE), variantUrl: arm(FRESH), noStore: arm(FRESH), nowMs: NOW,
    });
    eq(v.code, 'FETCH_CACHE_STALE', 'URL 단위로 굳음');
    eq(v.ageSec.baseline! > 300000, true, '사흘 전');
    eq(v.ageSec.variantUrl, 1, '1초 전');
    assert(/한 곳의 모양만 바꾸면/.test(v.nextStep), '증상만 숨기지 말라고 말해야 한다');
  });

  test('URL을 바꿔도 낡고 no-store만 최신이면 NO_STORE_ONLY', () => {
    const v = cacheProbeVerdict({
      baseline: arm(STALE), variantUrl: arm(STALE), noStore: arm(FRESH), nowMs: NOW,
    });
    eq(v.code, 'NO_STORE_ONLY', 'URL로는 안 깨진다');
    assert(/no-store가 필요/.test(v.nextStep), '무엇이 필요한지 말해야 한다');
  });

  test('셋 다 낡았으면 캐시가 아니다', () => {
    const v = cacheProbeVerdict({
      baseline: arm(STALE), variantUrl: arm(STALE), noStore: arm(STALE), nowMs: NOW,
    });
    eq(v.code, 'NOT_CACHE', '캐시 아님');
    assert(/캐시 가설을 접고/.test(v.nextStep), '방향을 바꾸라고 말해야 한다');
  });

  test('기존도 최신이면 FRESH — 다만 고쳐진 것과 구분해서 적는다', () => {
    const v = cacheProbeVerdict({
      baseline: arm(FRESH), variantUrl: arm(FRESH), noStore: arm(FRESH), nowMs: NOW,
    });
    eq(v.code, 'FRESH', '재현 안 됨');
    assert(/재현되지 않은 것은 고쳐진 것과 다릅니다/.test(v.nextStep), '섞으면 안 된다');
  });

  // ── 못 읽은 것 ──
  test('기존을 못 읽었으면 UNVERIFIED — 낡았다고 적지 않는다', () => {
    const v = cacheProbeVerdict({
      baseline: arm(null, 'fetch failed'), variantUrl: arm(FRESH), noStore: arm(FRESH), nowMs: NOW,
    });
    eq(v.code, 'UNVERIFIED', '확인 못 함');
    eq(v.ageSec.baseline, null, '나이도 없다');
    assert(/캐시가 아니라는 뜻이 아닙니다/.test(v.headline), '단정하지 않는다');
  });

  test('대조군을 둘 다 못 읽었으면 UNVERIFIED', () => {
    const v = cacheProbeVerdict({
      baseline: arm(STALE), variantUrl: arm(null, 'x'), noStore: arm(null, 'y'), nowMs: NOW,
    });
    eq(v.code, 'UNVERIFIED', '비교 불가');
  });

  test('시각을 못 읽는 값은 null로 다룬다 — 0으로 읽지 않는다', () => {
    const v = cacheProbeVerdict({
      baseline: arm('not-a-date'), variantUrl: arm(FRESH), noStore: arm(FRESH), nowMs: NOW,
    });
    eq(v.ageSec.baseline, null, 'null');
    eq(v.code, 'UNVERIFIED', '비교 불가');
  });

  test('freshWithinSec 경계를 넘으면 낡은 것으로 본다', () => {
    const justOver = new Date(NOW - 601 * 1000).toISOString();
    const v = cacheProbeVerdict({
      baseline: arm(justOver), variantUrl: arm(FRESH), noStore: arm(FRESH), nowMs: NOW,
    });
    eq(v.code, 'FETCH_CACHE_STALE', '601초는 낡음');
  });

  // ── no-store fetch ──
  test('no-store fetch가 cache 옵션을 붙인다', async () => {
    let seen: any = null;
    const fake = (async (_u: any, init: any) => { seen = init; return { ok: true } as any; }) as any;
    await noStoreFetch(fake)('https://example.test/x' as any, { headers: { a: 'b' } } as any);
    eq(seen.cache, 'no-store', 'no-store가 붙어야 한다');
    eq(seen.headers.a, 'b', '원래 옵션은 보존해야 한다');
  });

  test('init이 없어도 던지지 않는다', async () => {
    let seen: any = null;
    const fake = (async (_u: any, init: any) => { seen = init; return { ok: true } as any; }) as any;
    await noStoreFetch(fake)('https://example.test/x' as any);
    eq(seen.cache, 'no-store', 'no-store');
  });

  test('method 같은 옵션을 덮어쓰지 않는다', async () => {
    let seen: any = null;
    const fake = (async (_u: any, init: any) => { seen = init; return { ok: true } as any; }) as any;
    await noStoreFetch(fake)('https://example.test/x' as any, { method: 'POST', body: 'q' } as any);
    eq(seen.method, 'POST', 'method 보존');
    eq(seen.body, 'q', 'body 보존');
    eq(seen.cache, 'no-store', 'no-store도 붙는다');
  });
}
