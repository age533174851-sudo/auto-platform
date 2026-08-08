// src/lib/runtime/dataLocation.test.ts
//
// 실제로 찾은 것:
//
//   AutoTradeEngine이 60초마다 전략을 평가한다
//   → listStrategies()가 읽는다
//   → src/lib/strategies/store.ts: window.localStorage.getItem(KEY)
//
// **전략이 브라우저 안에만 있다.** 서버는 그 전략이 있는지조차 모른다.
// 크론을 아무리 잘 붙여도 읽을 것이 없다.
//
// 막으려는 것:
//  1. 이걸 타이머 문제로 오해하는 것 — 크론을 붙이면 될 거라고 믿게 된다
//  2. 브라우저 저장을 전부 문제로 모는 것 — 접힘 상태는 거기 있는 게 맞다
//  3. 저장 위치를 모르는데 괜찮다고 하는 것
import { test, assert, eq } from '../../test/harness';
import {
  locationVerdict, auditDataLocations, DATA_ITEMS,
} from './dataLocation';

export function runDataLocationTests() {
  console.log('[저장 위치 — 크론을 붙여도 돌릴 것이 없었다]');

  test('실행에 쓰이는 것이 브라우저에만 있으면 막힌다', () => {
    const v = locationVerdict('EXECUTION', 'BROWSER_ONLY');
    eq(v.ok, false);
    assert(v.warning.includes('자동 실행이 되지 않습니다'), v.warning);
    assert(v.nextStep.includes('크론을 붙여도'), v.nextStep);
  });

  test('서버에 있으면 통과다', () => {
    for (const k of ['EXECUTION', 'USER_ASSET', 'PREFERENCE', 'EPHEMERAL'] as const) {
      const v = locationVerdict(k, 'SERVER');
      eq(v.ok, true, k);
      eq(v.warning, '', k);
    }
  });

  test('브라우저 저장을 전부 문제로 몰지 않는다', () => {
    // 접힘/펼침이나 정렬 순서는 거기 있는 것이 맞다. 전부 경고로 띄우면
    // 경고가 배경이 되고 진짜 문제가 묻힌다.
    eq(locationVerdict('PREFERENCE', 'BROWSER_ONLY').ok, true);
    eq(locationVerdict('EPHEMERAL', 'BROWSER_ONLY').ok, true);
  });

  test('잃으면 다시 만들어야 하는 것은 경고한다', () => {
    const v = locationVerdict('USER_ASSET', 'BROWSER_ONLY');
    eq(v.ok, false);
    assert(v.warning.includes('기기를 바꾸면 사라집니다'), v.warning);
  });

  test('저장 위치를 모르면 괜찮다고 하지 않는다', () => {
    const v = locationVerdict('PREFERENCE', 'UNKNOWN');
    eq(v.ok, false);
    assert(v.nextStep.includes('잃어도 모릅니다'), v.nextStep);
  });

  console.log('[저장 위치 — 전수 판정]');

  test('전략빌더 전략이 자동 실행을 막는 것으로 잡힌다', () => {
    const a = auditDataLocations();
    const strat = a.misplaced.find(x => x.id === 'user_strategies');
    assert(!!strat, '전략빌더 전략이 목록에 없다');
    eq(strat!.kind, 'EXECUTION');
    eq(strat!.location, 'BROWSER_ONLY');
    assert(a.blocksExecution > 0, String(a.blocksExecution));
  });

  test('요약이 자동 실행을 막는 개수를 따로 적는다', () => {
    const a = auditDataLocations();
    eq(a.ok, false);
    assert(a.summary.includes('자동 실행을 막습니다'), a.summary);
    assert(a.summary.includes('서버가 읽을 수 없습니다'), a.summary);
  });

  test('서버에 있는 것은 목록에 안 뜬다', () => {
    const a = auditDataLocations();
    for (const id of ['autotrade_schedules', 'scheduled_exits', 'strategy_accounts']) {
      assert(!a.misplaced.some(x => x.id === id), `${id}가 잘못 잡혔다`);
    }
  });

  test('화면 설정은 목록에 안 뜬다', () => {
    const a = auditDataLocations();
    assert(!a.misplaced.some(x => x.id === 'ui_prefs'), '편의 설정이 잘못 잡혔다');
  });

  test('전부 서버면 통과라고 말한다', () => {
    const a = auditDataLocations([
      { id: 'a', label: 'A', kind: 'EXECUTION', location: 'SERVER', where: 'x' },
    ]);
    eq(a.ok, true);
    eq(a.blocksExecution, 0);
    assert(a.summary.includes('모두 서버에'), a.summary);
  });

  test('목록의 모든 항목이 어디 저장되는지 적혀 있다', () => {
    // 'localStorage'라고만 적으면 어느 파일인지 못 찾는다.
    for (const it of DATA_ITEMS) {
      assert(it.where.trim().length > 0, it.id);
      assert(it.label.trim().length > 0, it.id);
    }
  });
}
