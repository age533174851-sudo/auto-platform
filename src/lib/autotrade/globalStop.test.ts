// src/lib/autotrade/globalStop.test.ts
//
// 이 테스트가 막는 것 하나: **화면이 서버보다 센 말을 하는 것.**
//
// 원래 고장은 "서버를 부르지 않고 모든 봇이 중단되었습니다라고 적는
// 것"이었다. 고친 뒤에 남는 위험은 그 변형이다 — 일부만 꺼졌는데
// 전부 껐다고 적거나, 목록을 못 읽었는데 0개라고 적는 것.

import { test, eq, assert } from '../../test/harness';
import {
  stopTargets, summarize, unknownResult, headline, boundaryNote, isAlarming,
  IDLE_RESULT, type StopOutcome,
} from './globalStop';

const ok = (id: string): StopOutcome => ({ id, label: id, ok: true });
const bad = (id: string, reason = '거절'): StopOutcome => ({ id, label: id, ok: false, reason });

export function runGlobalStopTests() {
  console.log('[자동매매 전체정지 — 확인한 것만 말한다]');

  // ── 끌 대상 고르기 ────────────────────────────────────────
  test('켜져 있는 예약만 끌 대상이다', () => {
    const rows = [
      { id: 'a', symbol: 'BTCUSDT', enabled: true },
      { id: 'b', symbol: 'ETHUSDT', enabled: false },
      { id: 'c', symbol: 'SOLUSDT', enabled: true },
    ];
    eq(stopTargets(rows).map(t => t.id).join(','), 'a,c');
  });

  test('이미 꺼진 것을 세면 "몇 개를 껐다"가 부풀어난다', () => {
    const rows = [{ id: 'a', enabled: false }, { id: 'b', enabled: false }];
    eq(stopTargets(rows).length, 0);
    eq(summarize([]).code, 'NOTHING_TO_STOP');
  });

  test('enabled를 모르면 끄는 쪽에 넣는다', () => {
    // 모르는 것을 "이미 꺼져 있다"고 넘기면 도는 것을 놓친다.
    // 한 번 더 끄는 쪽이 안전하다.
    eq(stopTargets([{ id: 'x', symbol: 'BTCUSDT' }]).length, 1);
    eq(stopTargets([{ id: 'y', enabled: null }]).length, 1);
  });

  test('id가 없는 줄은 끄지 못하므로 대상이 아니다', () => {
    eq(stopTargets([{ symbol: 'BTCUSDT', enabled: true }, { id: '', enabled: true }]).length, 0);
  });

  test('목록이 배열이 아니면 빈 목록이다 — 던지지 않는다', () => {
    // 화면 껍데기가 응답 하나 때문에 안 뜨면 사용자는 앱을 잃는다.
    eq(stopTargets(null).length, 0);
    eq(stopTargets(undefined).length, 0);
    eq(stopTargets({ items: [] } as any).length, 0);
    eq(stopTargets('BTCUSDT' as any).length, 0);
  });

  test('이름이 없으면 id로 부른다', () => {
    eq(stopTargets([{ id: 'sch_1', enabled: true }])[0].label, 'sch_1');
    eq(stopTargets([{ id: 'sch_1', symbol: 'BTCUSDT', enabled: true }])[0].label, 'BTCUSDT');
  });

  // ── 결과 판정 ─────────────────────────────────────────────
  test('전부 꺼졌을 때만 ALL_STOPPED다', () => {
    const r = summarize([ok('a'), ok('b')]);
    eq(r.code, 'ALL_STOPPED');
    eq(r.stopped, 2); eq(r.failed, 0); eq(r.attempted, 2);
  });

  test('하나라도 실패하면 PARTIAL이다 — 부분 성공을 성공이라 적지 않는다', () => {
    const r = summarize([ok('a'), bad('b'), ok('c')]);
    eq(r.code, 'PARTIAL');
    eq(r.stopped, 2); eq(r.failed, 1);
    assert(headline(r).includes('아직 돌고'), `남은 것을 말하지 않는다: ${headline(r)}`);
  });

  test('전부 실패해도 PARTIAL이다 — 0개 껐다고 조용히 넘기지 않는다', () => {
    const r = summarize([bad('a'), bad('b')]);
    eq(r.code, 'PARTIAL');
    eq(r.stopped, 0); eq(r.failed, 2);
  });

  test('목록을 못 읽으면 UNKNOWN이다 — 0으로 적지 않는다', () => {
    const r = unknownResult('네트워크 오류');
    eq(r.code, 'UNKNOWN');
    eq(r.stopped, 0);
    assert(headline(r).includes('확인하지 못'), `모른다고 말하지 않는다: ${headline(r)}`);
  });

  // ── 문장 ──────────────────────────────────────────────────
  test('어떤 상태에서도 "모든 봇이 중단"이라고 적지 않는다', () => {
    // 이것이 원래 고장이었다. 표현 자체를 금지한다.
    const all = [
      IDLE_RESULT,
      { ...IDLE_RESULT, code: 'STOPPING' as const },
      summarize([]),
      summarize([ok('a')]),
      summarize([ok('a'), bad('b')]),
      unknownResult('x'),
    ];
    for (const r of all) {
      const text = headline(r) + ' ' + boundaryNote(r);
      assert(!/모든 봇/.test(text), `${r.code}에서 "모든 봇"이라고 말한다: ${text}`);
      assert(!/모두 (중단|정지)(됐|되었)/.test(text), `${r.code}에서 전부 멈췄다고 말한다: ${text}`);
    }
  });

  test('끄기 전·요청 중에는 멈췄다고 말하지 않는다', () => {
    eq(headline(IDLE_RESULT), '');
    const s = headline({ ...IDLE_RESULT, code: 'STOPPING' });
    assert(s.includes('아직'), `요청 중에 확정적으로 말한다: ${s}`);
  });

  test('센 개수만 말한다', () => {
    assert(headline(summarize([ok('a'), ok('b'), ok('c')])).includes('3개'), '개수를 안 적는다');
    const p = headline(summarize([ok('a'), bad('b')]));
    assert(p.includes('2개') && p.includes('1개'), `시도·실패 수를 안 적는다: ${p}`);
  });

  test('예약을 끄는 것이 청산이 아니라는 것을 항상 말한다', () => {
    for (const r of [summarize([ok('a')]), summarize([ok('a'), bad('b')]), summarize([]), unknownResult('x')]) {
      const n = boundaryNote(r);
      assert(n.includes('포지션'), `${r.code}: 열린 포지션 이야기가 없다`);
      assert(n.includes('취소되지 않'), `${r.code}: 주문 취소 여부를 말하지 않는다`);
    }
  });

  test('덜 멈춘 상태에서는 킬 스위치를 안내한다', () => {
    assert(boundaryNote(summarize([ok('a'), bad('b')])).includes('킬 스위치'), 'PARTIAL에서 안내 없음');
    assert(boundaryNote(unknownResult('x')).includes('킬 스위치'), 'UNKNOWN에서 안내 없음');
  });

  test('위험 색은 아직 도는 것이 있을 때만 켠다', () => {
    eq(isAlarming(summarize([ok('a')])), false);
    eq(isAlarming(summarize([])), false);
    eq(isAlarming(summarize([ok('a'), bad('b')])), true);
    eq(isAlarming(unknownResult('x')), true);
  });
}
