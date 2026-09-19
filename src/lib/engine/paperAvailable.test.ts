// src/lib/engine/paperAvailable.test.ts
import { test, eq, assert } from '../../test/harness';
import { usedMarginOf, availableBalance, availableView } from './paperAvailable';

export function runPaperAvailableTests() {
  test('열린 포지션의 증거금을 잔고에서 뺀다', () => {
    const v = availableView(1000, [{ margin: 200 }, { margin: 300 }]);
    eq(v.usedMargin, 500);
    eq(v.available, 500);
    eq(v.unknownReason, null);
  });

  test('포지션이 없으면 잔고 전부가 가용이다 — **빈 목록일 때만**', () => {
    eq(availableView(1000, []).available, 1000);
  });

  // ── ★ 목록을 못 받은 것과 0건은 다르다 ──
  //
  // 이 시험은 원래 `availableView(1000, null).available === 1000`이었다.
  // 즉 **버그를 기대값으로 적어 두고 있었다.** 세 라우트가 전부 Supabase
  // `error`를 버리고 `data`만 썼기 때문에, 조회가 실패하면 여기 `null`이
  // 들어오고 화면에는 "열린 포지션 없음 · 가용 1000"이 떴다. 오류도 없고
  // 빈 칸도 없는, 정상으로 보이는 가짜 상태다.
  //
  // 호출부에서 `error`를 보는 것이 1차 방어이고, 이건 한 곳이라도
  // 빠뜨렸을 때 **없는 돈이 생기지 않게** 하는 2차 방어다.
  test('★ 포지션 목록을 못 받으면 0건이 아니라 모름이다', () => {
    for (const bad of [null, undefined, 'x', 0, false, {}]) {
      const v = availableView(1000, bad as any);
      eq(v.available, null, `${String(bad)}에서 가용이 숫자로 나왔습니다`);
      assert(!!v.unknownReason, `${String(bad)}에서 사유가 없습니다`);
    }
    eq(usedMarginOf(null).unreadable, 1);
    eq(usedMarginOf(undefined).unreadable, 1);
  });

  // ── ★ 못 읽은 증거금 ──
  test('★ 증거금을 못 읽으면 0으로 세지 않는다 — 없는 돈이 생긴다', () => {
    const u = usedMarginOf([{ margin: 200 }, { margin: null }, { margin: '' }, { margin: 'x' }]);
    eq(u.used, 200);
    eq(u.unreadable, 3);
    // 예전 코드는 `Number(p.margin) || 0`이라 여기서 가용 1,000이 나왔다
    eq(availableBalance(1000, u), null);
  });

  test('★ 못 읽은 가용 잔고는 0이 아니라 null이다', () => {
    const v = availableView(1000, [{ margin: null }]);
    eq(v.available, null);
    eq(v.usedMargin, null);
    assert(/0이라는 뜻이 아닙니다/.test(v.unknownReason || ''), '사유가 0 오해를 막지 않습니다');
  });

  test('잔고 자체를 못 읽어도 null이다', () => {
    for (const b of [null, undefined, '', 'abc', true]) {
      eq(availableView(b, []).available, null, `${String(b)}가 숫자로 읽혔습니다`);
    }
  });

  test('음수 증거금은 못 읽은 것으로 본다', () => {
    eq(usedMarginOf([{ margin: -5 }]).unreadable, 1);
  });

  test('증거금이 잔고보다 크면 가용은 0이다 — 음수를 적지 않는다', () => {
    eq(availableView(100, [{ margin: 500 }]).available, 0);
  });

  test('잔고 0은 못 읽음이 아니다', () => {
    const v = availableView(0, []);
    eq(v.available, 0);
    eq(v.unknownReason, null);
  });

  test('증거금 0인 줄은 정상이다', () => {
    eq(usedMarginOf([{ margin: 0 }]).unreadable, 0);
  });
}
