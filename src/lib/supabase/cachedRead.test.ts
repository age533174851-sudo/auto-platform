// 조회 실패를 "없음"으로 적지 않고, **마지막으로 알던 값을 지우지도 않는다.**
//
// 예전 모양: `const { data } = await sb.from(...)` — error 를 아예 받지
// 않고 `data || []` 를 돌려줬다. 그러면 조회 실패가 빈 목록이 되고,
// 게다가 그 빈 목록을 localStorage 에 덮어써서 **안전망까지 지웠다.**
import { test, assert, eq } from '../../test/harness';
import { cachedReadVerdict, CACHED_READ_CODES } from './cachedRead';

export function runCachedReadTests() {
  test('★★ 조회 오류는 "없음"이 아니라 미확인이다 — 캐시를 덮어쓰지 않는다', () => {
    const v = cachedReadVerdict({ data: null, error: { message: 'relation "alerts" does not exist' } });
    eq(v.code, 'UNREAD');
    eq(v.ok, false);
    eq(v.rows, null);
    eq(v.mayWriteCache, false);
  });

  test('★★ data 가 null 인데 error 도 없으면 그것도 미확인이다', () => {
    // 표가 없거나 권한이 막히면 둘 다 비어 오는 경우가 있다.
    const v = cachedReadVerdict({ data: null, error: null });
    eq(v.code, 'UNREAD');
    eq(v.mayWriteCache, false);
  });

  test('★★ 배열이 아닌 것을 빈 배열로 바꾸지 않는다', () => {
    for (const bad of [{}, 'x', 0, true]) {
      const v = cachedReadVerdict({ data: bad as any, error: null });
      eq(v.code, 'UNREAD');
      eq(v.rows, null);
    }
  });

  test('★★ 빈 배열은 "없음"이 맞다 — 그때는 캐시를 갱신한다', () => {
    const v = cachedReadVerdict({ data: [], error: null });
    eq(v.code, 'EMPTY');
    eq(v.ok, true);
    assert(Array.isArray(v.rows) && v.rows.length === 0, '빈 배열이어야 한다');
    eq(v.mayWriteCache, true);
  });

  test('★★ 줄이 있으면 그대로 돌려주고 캐시를 갱신한다', () => {
    const rows = [{ id: 'a' }, { id: 'b' }];
    const v = cachedReadVerdict({ data: rows, error: null });
    eq(v.code, 'ROWS');
    eq(v.ok, true);
    eq(v.rows?.length, 2);
    eq(v.mayWriteCache, true);
  });

  test('★ 오류가 있으면 data 가 배열이어도 믿지 않는다', () => {
    // 일부 클라이언트는 부분 실패에서 둘 다 채워 보낸다.
    const v = cachedReadVerdict({ data: [{ id: 'a' }], error: { message: 'timeout' } });
    eq(v.code, 'UNREAD');
    eq(v.rows, null);
    eq(v.mayWriteCache, false);
  });

  test('★ 사유에 오류 원문을 담지 않는다 — 연결 문자열이 섞일 수 있다', () => {
    const secretish = 'postgres://user:pw@host:5432/db';
    const v = cachedReadVerdict({ data: null, error: { message: `connect ${secretish} failed` } });
    assert(!v.reason.includes(secretish), `사유가 오류 원문을 담았다: ${v.reason}`);
    assert(v.reason.length > 0, '사유가 비어 있다');
  });

  test('★ 코드 목록이 정본이다 — 코드를 더하면 여기가 깨진다', () => {
    eq(CACHED_READ_CODES.length, 3);
    for (const c of ['UNREAD', 'EMPTY', 'ROWS']) {
      assert((CACHED_READ_CODES as readonly string[]).includes(c), `${c} 가 목록에 없다`);
    }
  });
}
