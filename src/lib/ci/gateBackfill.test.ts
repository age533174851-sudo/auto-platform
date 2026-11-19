// src/lib/ci/gateBackfill.test.ts
//
// **이 판정이 느슨해지면 빨간 체크 위에 초록이 덮인다.**
//
// 여기서 못 박는 것은 둘이다:
//   ① 못 읽었으면 적지 않는다 (없음으로 읽지 않는다)
//   ② 이미 있으면 손대지 않는다 — 상태가 무엇이든

import { test, eq, assert } from '../../test/harness';
import { gateBackfillVerdict, gateBackfillOutput } from './gateBackfill';

const SELF = 'auto-merge-gate';

export function runGateBackfillTests() {
  console.log('[게이트 메우기 — 없을 때만, 못 읽었으면 안 적는다]');

  test('체크가 하나도 없으면 메운다', () => {
    const v = gateBackfillVerdict({ selfName: SELF, checkRuns: [] });
    eq(v.code, 'MISSING');
    eq(v.publish, true);
  });

  test('다른 체크만 있고 게이트가 없으면 메운다', () => {
    const v = gateBackfillVerdict({
      selfName: SELF,
      checkRuns: [{ name: 'verify' }, { name: 'Supabase Preview' }],
    });
    eq(v.code, 'MISSING');
    eq(v.publish, true);
  });

  test('★ 목록을 못 읽었으면 적지 않는다 — 없다는 뜻이 아니다', () => {
    const v = gateBackfillVerdict({ selfName: SELF, checkRuns: null });
    eq(v.code, 'UNREADABLE');
    eq(v.publish, false);
    assert(/없다는 뜻이 아닙니다/.test(v.reason), v.reason);
  });

  test('★ 이미 있으면 손대지 않는다 — 돌고 있어도, 빨개도', () => {
    for (const extra of [[{ name: SELF }], [{ name: SELF }, { name: 'verify' }]]) {
      const v = gateBackfillVerdict({ selfName: SELF, checkRuns: extra });
      eq(v.code, 'PRESENT');
      eq(v.publish, false);
    }
  });

  test('이름이 비어 있으면 적지 않는다 — 무엇을 찾을지 모른다', () => {
    const v = gateBackfillVerdict({ selfName: '', checkRuns: [] });
    eq(v.code, 'UNREADABLE');
    eq(v.publish, false);
  });

  test('이름이 다르면 있는 것으로 치지 않는다 — 접두사도 아니다', () => {
    const v = gateBackfillVerdict({
      selfName: SELF,
      checkRuns: [{ name: 'auto-merge-gate-2' }, { name: 'auto-merge' }],
    });
    eq(v.code, 'MISSING');
    eq(v.publish, true);
  });

  test('이름이 null인 칸이 섞여도 터지지 않는다', () => {
    const v = gateBackfillVerdict({
      selfName: SELF,
      checkRuns: [{ name: null }, { }, { name: SELF }],
    });
    eq(v.code, 'PRESENT');
    eq(v.publish, false);
  });

  test('★ 메웠다는 사실을 숨기지 않는다', () => {
    const o = gateBackfillOutput({ runUrl: 'https://example.invalid/run/1' });
    assert(/안전망이 채웠습니다/.test(o.summary), o.summary);
    assert(o.summary.includes('https://example.invalid/run/1'), o.summary);
    assert(o.title.length > 0, '제목이 비었다');
  });

  test('run 주소를 모르면 그 줄만 빠진다', () => {
    const o = gateBackfillOutput({ runUrl: null });
    assert(/안전망이 채웠습니다/.test(o.summary), o.summary);
    assert(!/메운 run:/.test(o.summary), o.summary);
  });
}
