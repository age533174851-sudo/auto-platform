// src/lib/accounts/dca.test.ts
//
// 이 시험이 막는 것: **처음 여는 사람에게 하지 않은 적립 이력을 보여 주는 것.**
//
// 저장된 규칙이 없을 때 `loadDCARules`는 예시 규칙 셋을 돌려줬다. 그 예시에는
// "누적 1,200,000원 · 2.1주 · 8회 실행 · 3일 전 실행" 같은 **이력**이 들어
// 있었고, 화면(`DCAPage`)은 그것을 사용자의 실제 규칙과 똑같이 그렸다 —
// 예시라는 표시도 없이. 사용자는 적립한 적이 없는데 120만 원을 넣은 줄 안다.
// 그리고 스위치 하나만 눌러도 그 숫자가 localStorage에 저장돼 영영 남는다.
//
// 모르는 것은 0도 아니고 지어낸 값도 아니다. 없으면 **없다**고 그린다
// (화면에는 이미 "아직 적립 룰이 없습니다" 빈 상태가 있다).

import { test, eq, assert } from '../../test/harness';
import { loadDCARules, createBlankRule, DCA_STORE_KEY } from './dca';

function withFakeStorage<T>(stored: Record<string, string>, fn: () => T): T {
  const g = globalThis as any;
  const had = 'window' in g;
  const prev = g.window;
  g.window = {
    localStorage: {
      getItem: (k: string) => (k in stored ? stored[k] : null),
      setItem: (k: string, v: string) => { stored[k] = v; },
    },
  };
  try { return fn(); }
  finally { if (had) g.window = prev; else delete g.window; }
}

export function runDcaStoreTests() {
  console.log('[자동 적립 — 하지 않은 적립을 이력으로 보여 주지 않는다]');

  test('★ 저장된 규칙이 없으면 빈 목록이다 — 예시 이력을 지어내지 않는다', () => {
    const rules = withFakeStorage({}, () => loadDCARules());
    eq(rules.length, 0, `저장된 것이 없는데 규칙 ${rules.length}개가 나왔다`);
  });

  test('★ 서버 렌더(창 없음)에서도 빈 목록이다', () => {
    const g = globalThis as any;
    assert(typeof g.window === 'undefined', '시험 전제: window가 없어야 한다');
    eq(loadDCARules().length, 0);
  });

  test('★ 저장값이 깨졌거나 목록이 아니면 빈 목록이다', () => {
    eq(withFakeStorage({ [DCA_STORE_KEY]: '{not json' }, () => loadDCARules()).length, 0);
    eq(withFakeStorage({ [DCA_STORE_KEY]: '{"a":1}' }, () => loadDCARules()).length, 0);
  });

  test('저장된 사용자 규칙은 그대로 돌려준다', () => {
    const mine = { ...createBlankRule(), id: 'dca_mine', totalInvested: 30000, runCount: 1 };
    const rules = withFakeStorage(
      { [DCA_STORE_KEY]: JSON.stringify([mine]) }, () => loadDCARules());
    eq(rules.length, 1);
    eq(rules[0].id, 'dca_mine');
    eq(rules[0].totalInvested, 30000);
  });

  test('새 규칙은 이력 0에서 시작한다', () => {
    const r = createBlankRule();
    eq(r.totalInvested, 0);
    eq(r.totalShares, 0);
    eq(r.runCount, 0);
    eq(r.lastRunAt, undefined);
  });
}
