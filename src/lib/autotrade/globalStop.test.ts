// src/lib/autotrade/globalStop.test.ts
//
// 이 테스트가 막는 것 하나: **화면이 서버보다 센 말을 하는 것.**
//
// 원래 고장은 "서버를 부르지 않고 모든 봇이 중단되었습니다라고 적는
// 것"이었다. 고친 뒤에 남는 위험은 그 변형이다 — 일부만 꺼졌는데
// 전부 껐다고 적거나, 목록을 못 읽었는데 0개라고 적는 것.

import { test, eq, assert } from '../../test/harness';
import {
  stopTargets, verify, unknownResult, headline, boundaryNote, isAlarming,
  IDLE_RESULT, type StopOutcome, type AfterCheck,
} from './globalStop';

const ok = (id: string): StopOutcome => ({ id, label: id, ok: true });
const bad = (id: string, reason = '거절'): StopOutcome => ({ id, label: id, ok: false, reason });

/** 끈 뒤 다시 읽었더니 n개가 켜져 있더라 */
const read = (n: number): AfterCheck => ({ state: 'read', remaining: n });
/** 끈 뒤 다시 읽지 못했다 */
const unread = (reason = '네트워크 오류'): AfterCheck => ({ state: 'unread', reason });
/** 예전 테스트를 옮겨 적기 위한 축약 — 다시 읽어서 0개를 확인한 경우 */
const clean = (o: StopOutcome[]) => verify(o, read(0));

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
    eq(clean([]).code, 'NOTHING_TO_STOP');   // clean = verify(o, read(0))
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
  test('다시 읽어서 0개를 확인했을 때만 ALL_STOPPED다', () => {
    const r = clean([ok('a'), ok('b')]);
    eq(r.code, 'ALL_STOPPED');
    eq(r.stopped, 2); eq(r.failed, 0); eq(r.attempted, 2); eq(r.remaining, 0);
  });

  test('PATCH가 전부 성공해도 다시 읽어 남아 있으면 REMAINS다', () => {
    // **이것이 이번에 막는 고장이다.** 끄는 사이에 다른 창에서 켜거나
    // 새 예약이 생기면, 개별 성공 수는 그대로여도 도는 것이 남는다.
    const r = verify([ok('a'), ok('b')], read(1));
    eq(r.code, 'REMAINS');
    eq(r.stopped, 2); eq(r.remaining, 1);
    assert(headline(r).includes('1개가 아직 켜져'), `남은 것을 말하지 않는다: ${headline(r)}`);
  });

  test('일부 실패 + 남아 있음 → REMAINS', () => {
    const r = verify([ok('a'), bad('b'), ok('c')], read(1));
    eq(r.code, 'REMAINS');
    eq(r.stopped, 2); eq(r.failed, 1); eq(r.remaining, 1);
  });

  test('일부 실패했어도 다시 읽어 0개면 켜진 것이 없다고 말할 수 있다', () => {
    // 서버가 지금 0개라고 답했다. 그것이 현재 상태다. 다만 거절이
    // 있었다는 사실은 숨기지 않는다.
    const r = clean([ok('a'), bad('b')]);
    eq(r.code, 'ALL_STOPPED');
    eq(r.remaining, 0); eq(r.failed, 1);
    assert(headline(r).includes('거절'), `거절을 숨긴다: ${headline(r)}`);
  });

  test('전부 실패하고 남아 있으면 REMAINS다 — 0개 껐다고 조용히 넘기지 않는다', () => {
    const r = verify([bad('a'), bad('b')], read(2));
    eq(r.code, 'REMAINS');
    eq(r.stopped, 0); eq(r.failed, 2); eq(r.remaining, 2);
  });

  // ── 마지막 조회를 못 했을 때 ──────────────────────────────
  test('다시 읽지 못하면 UNVERIFIED다 — 전부 꺼졌다고 단정하지 않는다', () => {
    const r = verify([ok('a'), ok('b')], unread());
    eq(r.code, 'UNVERIFIED');
    eq(r.stopped, 2);
    eq(r.remaining, null);   // 모르는 것을 0으로 적지 않는다
    const h = headline(r);
    assert(h.includes('2개'), `껐다는 응답 수를 말하지 않는다: ${h}`);
    assert(h.includes('확인하지 못'), `모른다고 말하지 않는다: ${h}`);
    assert(!/전부|모두/.test(h), `확인 못 했는데 단정한다: ${h}`);
  });

  test('끌 것이 없었는데 다시 읽으니 켜져 있으면 그 사실이 먼저다', () => {
    const r = verify([], read(2));
    eq(r.code, 'REMAINS');
    eq(r.remaining, 2);
  });

  test('끌 것이 없었어도 다시 읽지 못했으면 확정하지 않는다', () => {
    // **이 갈래가 한 번 뚫렸다.**
    //   ① 첫 조회 0개 → ② 끈 것 없음 → ③ 그 사이 예약이 켜짐 → ④ 조회 실패
    // 지금 무엇이 도는지 모르는데 NOTHING_TO_STOP으로 빠져서
    // "켜져 있는 예약이 없습니다"라고 적고 경고색도 안 켜졌다.
    const r = verify([], unread());
    eq(r.code, 'UNVERIFIED');                        // G1
    eq(r.remaining, null);                           // G2
    eq(isAlarming(r), true);                         // G3
    const h = headline(r);
    assert(h.includes('확인하지 못'), `모른다고 말하지 않는다: ${h}`);   // G4
    // G5 — 지금 켜진 것이 없다고 단정하면 안 된다
    assert(!/켜져 있는 자동매매 예약이 없습니다/.test(h), `현재 상태를 단정한다: ${h}`);
    assert(!/끌 것이 없었습니다$/.test(h), `확인 못 한 것을 끝난 일로 적는다: ${h}`);
    // G6
    assert(boundaryNote(r).includes('킬 스위치'), '확인 못 한 상태에 킬 스위치 안내가 없다');
  });

  test('끌 것이 없고 다시 읽어 0개면 그때만 NOTHING_TO_STOP이다', () => {
    const r = verify([], read(0));                   // G7
    eq(r.code, 'NOTHING_TO_STOP');
    eq(r.remaining, 0);
    eq(isAlarming(r), false);
  });

  test('끌 것이 없었는데 다시 읽으니 켜져 있으면 REMAINS다', () => {
    const r = verify([], read(1));                   // G8
    eq(r.code, 'REMAINS');
    eq(r.remaining, 1);
    eq(isAlarming(r), true);
  });

  test('조회 실패는 끈 개수와 무관하게 UNVERIFIED다', () => {
    // 갈래가 둘로 갈라져 있으면 한쪽만 고쳐지는 날이 온다.
    for (const o of [[], [ok('a')], [ok('a'), bad('b')], [bad('a')]]) {
      const r = verify(o, unread());
      eq(r.code, 'UNVERIFIED');
      eq(r.remaining, null);
      assert(isAlarming(r), `${o.length}개 시도에서 경고가 꺼져 있다`);
    }
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
      clean([]),
      clean([ok('a')]),
      verify([ok('a'), bad('b')], read(1)),
      verify([ok('a')], unread()),
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
    assert(headline(clean([ok('a'), ok('b'), ok('c')])).includes('3개'), '개수를 안 적는다');
    const p = headline(verify([ok('a'), bad('b')], read(1)));
    assert(p.includes('2개') && p.includes('1개'), `시도·성공·남은 수를 안 적는다: ${p}`);
  });

  test('예약을 끄는 것이 청산이 아니라는 것을 항상 말한다', () => {
    for (const r of [clean([ok('a')]), verify([ok('a'), bad('b')], read(1)), clean([]), verify([ok('a')], unread()), unknownResult('x')]) {
      const n = boundaryNote(r);
      assert(n.includes('포지션'), `${r.code}: 열린 포지션 이야기가 없다`);
      assert(n.includes('취소되지 않'), `${r.code}: 주문 취소 여부를 말하지 않는다`);
    }
  });

  test('덜 멈춘 상태에서는 킬 스위치를 안내한다', () => {
    assert(boundaryNote(verify([ok('a'), bad('b')], read(1))).includes('킬 스위치'), 'REMAINS에서 안내 없음');
    assert(boundaryNote(verify([ok('a')], unread())).includes('킬 스위치'), 'UNVERIFIED에서 안내 없음');
    assert(boundaryNote(unknownResult('x')).includes('킬 스위치'), 'UNKNOWN에서 안내 없음');
  });

  test('위험 색은 아직 도는 것이 있을 때만 켠다', () => {
    eq(isAlarming(clean([ok('a')])), false);
    eq(isAlarming(clean([])), false);
    eq(isAlarming(verify([ok('a'), bad('b')], read(1))), true);
    eq(isAlarming(verify([ok('a')], unread())), true);   // 확인 못 한 것도 위험이다
    eq(isAlarming(unknownResult('x')), true);
  });
}
