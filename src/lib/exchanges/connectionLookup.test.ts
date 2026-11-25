// src/lib/exchanges/connectionLookup.test.ts
//
// 이 시험이 지키는 한 문장: **연결을 못 읽은 것을 "연결이 없다"로 적지 않는다.**
// ★은 이 모듈이 있는 이유 그 자체다 — 지우면 읽기 실패가 다시 404가 된다.
import { test, eq, assert } from '../../test/harness';
import { connectionLookupVerdict, NO_ROWS_CODE } from './connectionLookup';

export function runConnectionLookupTests(): void {
  console.log('\n[연결 조회 판정 — 못 읽음과 없음을 가른다]');

  test('행이 오면 찾은 것이다', () => {
    const v = connectionLookupVerdict({ data: { id: 'c1' }, error: null, shape: 'single' });
    eq(v.kind, 'FOUND');
    eq(v.status, 200);
  });

  test('★ 0행 오류(PGRST116)만 "없다"다', () => {
    const v = connectionLookupVerdict({ data: null, error: { code: NO_ROWS_CODE }, shape: 'single' });
    eq(v.kind, 'NOT_FOUND');
    eq(v.status, 404);
    eq(v.code, 'connection_not_found');
  });

  test('★ 그 밖의 오류는 404가 아니다 — 못 읽은 것이다', () => {
    for (const code of ['PGRST301', '42501', 'ECONNRESET', '']) {
      const v = connectionLookupVerdict({ data: null, error: { code }, shape: 'single' });
      eq(v.kind, 'UNREADABLE', `code=${code}`);
      eq(v.status, 503, `code=${code}`);
      assert(v.status !== 404, `code=${code}: 못 읽은 것을 "없다"로 적었다`);
    }
  });

  test('★ 코드가 없는 오류도 못 읽은 것이다 (없음으로 떨어지지 않는다)', () => {
    for (const error of [{}, { message: '연결이 끊겼습니다' }, 'boom', 0, [], true]) {
      const v = connectionLookupVerdict({ data: null, error, shape: 'single' });
      eq(v.kind, 'UNREADABLE', `error=${JSON.stringify(error)}`);
    }
  });

  test('★ single에서 행도 오류도 없으면 "없다"가 아니다', () => {
    // `.single()`은 0행이면 PGRST116을 준다. 둘 다 비어 온 것은
    // **대답을 못 받은 것**이다 — 그것을 없음으로 적으면 조용히 통과한다.
    const v = connectionLookupVerdict({ data: null, error: null, shape: 'single' });
    eq(v.kind, 'UNREADABLE');
    eq(v.status, 503);
  });

  test('maybeSingle에서 행도 오류도 없으면 그것이 "없다"다', () => {
    const v = connectionLookupVerdict({ data: null, error: null, shape: 'maybeSingle' });
    eq(v.kind, 'NOT_FOUND');
    eq(v.status, 404);
  });

  test('★ maybeSingle에서도 오류는 "없다"로 바뀌지 않는다', () => {
    const v = connectionLookupVerdict({ data: null, error: { code: '42501' }, shape: 'maybeSingle' });
    eq(v.kind, 'UNREADABLE');
    eq(v.status, 503);
  });

  test('★ 행이 객체가 아니면 찾은 것으로 세지 않는다', () => {
    for (const data of ['c1', 7, true]) {
      const v = connectionLookupVerdict({ data, error: null, shape: 'single' });
      assert(v.kind !== 'FOUND', `data=${JSON.stringify(data)}: 연결이 아닌 값을 연결로 읽었다`);
    }
  });

  test('★ shape를 안 주면 single로 본다 — 느슨한 쪽으로 기울지 않는다', () => {
    const v = connectionLookupVerdict({ data: null, error: null } as any);
    eq(v.kind, 'UNREADABLE');
  });

  test('★ 판정 문구에 조회 오류 원문이 섞이지 않는다', () => {
    // DB 오류 메시지에는 접속 문자열이 섞일 수 있다. 사유는 고정 문구다.
    const v = connectionLookupVerdict({
      data: null,
      error: { code: '08006', message: 'could not connect to postgres://user:pw@host/db' },
      shape: 'single',
    });
    assert(!/postgres:\/\/|password|pw@|secret|key=/i.test(v.reason), v.reason);
  });

  test('UNREADABLE은 어떤 경우에도 404를 쓰지 않는다', () => {
    const cases = [
      { data: null, error: { code: 'X' }, shape: 'single' as const },
      { data: null, error: null, shape: 'single' as const },
      { data: null, error: 'boom', shape: 'maybeSingle' as const },
    ];
    for (const c of cases) {
      const v = connectionLookupVerdict(c);
      if (v.kind === 'UNREADABLE') eq(v.status, 503, JSON.stringify(c));
    }
  });
}
