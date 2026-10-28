// src/lib/engine/keysetScan.test.ts
//
// 이 함수가 틀리면 **보호가 조용히 빠진다.** 그래서 "끝까지 읽었다"를
// 참이라고 말하는 경로를 전부 센다.

import { test, eq, assert } from '../../test/harness';
import { scanKeyset, chunk } from './keysetScan';

type Row = { k: string };
const rows = (n: number, from = 1): Row[] =>
  Array.from({ length: n }, (_, i) => ({ k: `k${String(from + i).padStart(5, '0')}` }));

/** 주어진 전체 목록을 커서 계약대로 돌려주는 가짜 DB */
function pagerOf(all: Row[], hook?: (nth: number) => { data?: any; error?: any } | undefined) {
  let nth = 0;
  const calls: { cursor: string | null; size: number }[] = [];
  const read = async (cursor: string | null, size: number) => {
    nth++;
    calls.push({ cursor, size });
    const h = hook?.(nth);
    if (h !== undefined) return h;
    const rest = cursor == null ? all : all.filter((r) => r.k > cursor);
    return { data: rest.slice(0, size), error: null };
  };
  return { read, calls, nthOf: () => nth };
}

export async function runKeysetScanTests() {
  console.log('\n[keyset 스캔 — "끝까지 읽었다"를 언제 말할 수 있는가]');

  const keyOf = (r: Row) => r.k;
  const opts = { pageSize: 50, maxPages: 40 };

  // ── 경계: 49 / 50 / 51 ──
  for (const [n, pages] of [[49, 1], [50, 2], [51, 2]] as [number, number][]) {
    const p = pagerOf(rows(n));
    const r = await scanKeyset<Row>(p.read, keyOf, opts);
    test(`${n}행 — 전부 읽고 complete`, () => {
      eq(r.complete, true, `사유: ${r.reason}`);
      eq(r.rows.length, n, '행 수가 다르다');
      eq(r.pages, pages, `페이지 ${r.pages}번 (기대 ${pages})`);
    });
  }

  test('★ 꽉 찬 페이지는 반드시 다음을 묻는다 — 50행에서 멈추면 51번째가 사라진다', async () => {
    const p = pagerOf(rows(50));
    await scanKeyset<Row>(p.read, keyOf, opts);
    eq(p.nthOf(), 2, '딱 꽉 찬 페이지에서 끝을 확인하지 않았다');
  });

  test('★ 커서는 직전 페이지의 마지막 키다 (OFFSET이 아니다)', async () => {
    const p = pagerOf(rows(120));
    await scanKeyset<Row>(p.read, keyOf, opts);
    eq(p.calls[0].cursor, null, '첫 페이지에 커서를 넣었다');
    eq(p.calls[1].cursor, 'k00050', `2페이지 커서가 ${p.calls[1].cursor}다`);
    eq(p.calls[2].cursor, 'k00100', `3페이지 커서가 ${p.calls[2].cursor}다`);
  });

  // ── 실패는 전부 complete=false ──
  const fails: [string, (nth: number) => any, string][] = [
    ['오류 응답', (n) => (n === 2 ? { data: null, error: { message: '503' } } : undefined), 'query_failed'],
    ['비배열', (n) => (n === 2 ? { data: { x: 1 }, error: null } : undefined), 'invalid_page'],
    ['null 정상코드', (n) => (n === 2 ? { data: null, error: null } : undefined), 'invalid_page'],
    ['페이지 초과', (n) => (n === 2 ? { data: rows(60, 51), error: null } : undefined), 'invalid_page'],
    ['키 중복', (n) => (n === 2 ? { data: rows(10, 1), error: null } : undefined), 'unstable_page'],
    ['키 역행', (n) => (n === 2 ? { data: rows(10, 10), error: null } : undefined), 'unstable_page'],
    ['빈 키', (n) => (n === 2 ? { data: [{ k: '' }], error: null } : undefined), 'unstable_page'],
  ];
  for (const [label, hook, code] of fails) {
    const p = pagerOf(rows(200), hook);
    const r = await scanKeyset<Row>(p.read, keyOf, opts);
    test(`★★ ${label} — complete=false, ${code}`, () => {
      eq(r.complete, false, '잘린 응답을 완전하다고 적었다');
      eq(r.failure, code, `판정이 ${r.failure}다`);
      assert((r.reason ?? '').length > 0, '사유를 적지 않았다');
    });
  }

  test('★★ read가 던져도 complete=false다', async () => {
    const r = await scanKeyset<Row>(async () => { throw new Error('소켓이 끊겼다'); }, keyOf, opts);
    eq(r.complete, false, '예외를 완전한 조회로 읽었다');
    eq(r.failure, 'query_failed', `판정이 ${r.failure}다`);
  });

  test('★★ 실패해도 읽은 만큼은 돌려준다 (부분 목록 + complete=false)', async () => {
    const p = pagerOf(rows(200), (n) => (n === 2 ? { data: null, error: { message: '503' } } : undefined));
    const r = await scanKeyset<Row>(p.read, keyOf, opts);
    eq(r.rows.length, 50, '1페이지에서 읽은 것을 버렸다');
    eq(r.complete, false, '부분 목록을 완전하다고 적었다');
  });

  test('★★ 페이지 상한에 닿고 뒤에 더 있으면 scan_limit이다 — 조용히 끝내지 않는다', async () => {
    const p = pagerOf(rows(300));
    const r = await scanKeyset<Row>(p.read, keyOf, { pageSize: 50, maxPages: 2 });
    eq(r.complete, false, '상한에서 끊은 것을 완전하다고 적었다');
    eq(r.failure, 'scan_limit', `판정이 ${r.failure}다`);
    eq(r.rows.length, 100, '상한까지는 읽어야 한다');
  });

  test('★ 상한에 딱 맞으면 complete이다 (1행 확인으로 가른다)', async () => {
    const p = pagerOf(rows(100));
    const r = await scanKeyset<Row>(p.read, keyOf, { pageSize: 50, maxPages: 2 });
    eq(r.complete, true, `사유: ${r.reason}`);
    eq(r.rows.length, 100, '행 수가 다르다');
    eq(p.calls[p.calls.length - 1].size, 1, '끝 확인은 1행이어야 한다');
  });

  test('0행이면 1페이지에서 끝난다 — 평소 회차에 왕복이 늘지 않는다', async () => {
    const p = pagerOf([]);
    const r = await scanKeyset<Row>(p.read, keyOf, opts);
    eq(r.complete, true, '0행을 모른다고 적었다');
    eq(r.pages, 1, `페이지를 ${r.pages}번 읽었다`);
  });

  for (const bad of [
    { pageSize: 0, maxPages: 10 }, { pageSize: 50, maxPages: 0 },
    { pageSize: 1001, maxPages: 10 }, { pageSize: 1.5, maxPages: 10 },
  ]) {
    const r = await scanKeyset<Row>(async () => ({ data: [], error: null }), keyOf, bad);
    test(`설정이 잘못되면(${bad.pageSize}/${bad.maxPages}) 완전하다고 하지 않는다`, () => {
      eq(r.complete, false, '잘못된 설정으로 완전한 조회를 주장했다');
    });
  }

  test('chunk는 순서를 지키고 아무것도 잃지 않는다', () => {
    const c = chunk([1, 2, 3, 4, 5], 2);
    eq(JSON.stringify(c), '[[1,2],[3,4],[5]]', '쪼개기가 틀렸다');
    eq(chunk([], 3).length, 0, '빈 목록에서 빈 묶음을 만들었다');
  });
}
