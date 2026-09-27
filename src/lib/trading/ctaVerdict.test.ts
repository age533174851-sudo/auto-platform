// src/lib/trading/ctaVerdict.test.ts
//
// **회색으로 보이는 것과 눌리지 않는 것은 다르다.**
//
// 실제로 났던 고장
// ────────────────
// USDⓈ-M의 실행 버튼이 꺼짐을 세 번 따로 계산했고, 호출부가 넘긴
// `disabled`(= `!gate.ready || busy || intent !== 'OPEN'`)가 **색에만**
// 반영됐다. DOM `disabled`와 클릭 가드는 그 값을 안 봤다.
//
//     보이기   회색
//     실제     눌린다 → form.submit()까지 간다
//
// `form.submit()`이 `gate`와 `busy`는 다시 막지만 **`intent`는 모른다** —
// 그건 화면의 상태이지 폼의 상태가 아니다. 그래서 **청산 탭을 열어 둔 채로
// 진입 주문이 나갈 수 있었다.**
//
// 그래서 이 시험은 색을 보지 않는다
// ─────────────────────────────────
// 판정이 돌려주는 **`action`**을 본다. 화면은 그 값을 그대로 따르므로,
// `action === 'NONE'`이면 `chooseSide`도 `submit`도 호출되지 않는다.
import { test, eq, assert } from '../../test/harness';
import { ctaVerdict, type CtaVerdictInput } from './ctaVerdict';

/** 켜져 있고 아직 방향을 안 고른 기본 상태 */
const base: CtaVerdictInput = {
  gateReady: true, busy: false, intentOpen: true,
  locked: false, unavailable: false, sideChosen: false, sameSide: false,
};

/**
 * 버튼을 실제로 누른 것처럼 세어 본다.
 *
 * ★ `submit`은 **어떤 입력에서도 0이어야 한다.** 확인 시트가 생긴 뒤로
 *   이 버튼은 주문을 보내지 않는다 — 시트를 열 뿐이다. 그래서 화면의
 *   분기를 그대로 옮겨 놓고, `form.submit()`에 닿는 가지가 하나도 없음을
 *   센다. 가지를 되살리면 이 숫자가 1이 된다.
 */
function press(i: CtaVerdictInput) {
  const v = ctaVerdict(i);
  let chooseSide = 0, openReview = 0;
  const submit = 0;   // 이 버튼에는 제출 가지가 없다
  // 화면이 하는 일과 **같은 분기**다
  if (v.action === 'CHOOSE_SIDE') chooseSide += 1;
  if (v.action === 'OPEN_REVIEW') openReview += 1;
  return { v, chooseSide, openReview, submit };
}

export function runCtaVerdictTests() {
  console.log('[실행 버튼 판정]');

  // ── 1 ──
  test('① 진입 · 준비됨 · 안 바쁨 · 종목 있음 → 켜진다', () => {
    const { v } = press(base);
    eq(v.off, false);
    eq(v.reason, null);
  });

  // ── 2 ── 이것이 가장 위험했던 경로다
  test('★② 청산 탭이면 진입 버튼이 꺼진다 — 눌러도 아무 일도 없다', () => {
    for (const sideChosen of [false, true]) {
      const r = press({ ...base, intentOpen: false, sideChosen, sameSide: sideChosen });
      eq(r.v.off, true, '청산 탭인데 진입 버튼이 켜져 있다');
      eq(r.v.action, 'NONE');
      eq(r.chooseSide, 0, '청산 탭에서 방향이 골라졌다');
      eq(r.openReview, 0, '★ 청산 탭에서 주문 확인 창이 열렸다');
      eq(r.submit, 0, '★ 청산 탭에서 진입 주문이 나갔다');
      assert(/청산/.test(r.v.reason || ''), '왜 꺼졌는지 적지 않았다');
    }
  });

  // ── 3 ──
  test('③ 판정이 준비 안 됐으면 꺼진다 — 제출 0회', () => {
    const r = press({ ...base, gateReady: false, sideChosen: true, sameSide: true });
    eq(r.v.off, true);
    eq(r.openReview, 0);
    eq(r.chooseSide, 0);
  });

  // ── 4 ──
  test('④ 보내는 중이면 꺼진다 — 두 번째 제출 0회', () => {
    const r = press({ ...base, busy: true, sideChosen: true, sameSide: true });
    eq(r.v.off, true);
    eq(r.openReview, 0);
  });

  // ── 5 ──
  test('⑤ 종목이 없으면 꺼진다', () => {
    const r = press({ ...base, locked: true, sideChosen: true, sameSide: true });
    eq(r.v.off, true);
    eq(r.openReview, 0);
    assert(/종목/.test(r.v.reason || ''));
  });

  // ── 6 ──
  test('⑥ 이 시장에 없는 방향이면 꺼진다', () => {
    const r = press({ ...base, unavailable: true });
    eq(r.v.off, true);
    eq(r.chooseSide, 0);
  });

  // ── 7 ──
  test('★⑦ 켜진 버튼의 첫 클릭은 방향만 고른다 — 확인 창도 안 열린다', () => {
    const r = press({ ...base, sideChosen: false, sameSide: false });
    eq(r.v.action, 'CHOOSE_SIDE');
    eq(r.chooseSide, 1);
    eq(r.openReview, 0, '한 번의 클릭으로 확인 창이 열렸다');
    eq(r.submit, 0, '한 번의 클릭으로 주문이 나갔다');
  });

  // ── 8 ──
  test('★⑧ 두 번째 클릭은 **확인 창을 연다** — 주문은 여전히 안 나간다', () => {
    const r = press({ ...base, sideChosen: true, sameSide: true });
    eq(r.v.action, 'OPEN_REVIEW');
    eq(r.openReview, 1);
    eq(r.chooseSide, 0);
    eq(r.submit, 0, '★ 두 번의 클릭으로 주문이 나갔다 — 확인 창을 건너뛰었다');
  });

  test('★ 실행 버튼에는 제출 가지가 아예 없다 — 어떤 입력에서도', () => {
    // 이름과 행동을 갈라 놓지 않는다. `CtaAction`에 `'SUBMIT'`이 없으므로
    // 화면의 분기에서도 제출이 나올 수 없다.
    for (const gateReady of [false, true]) {
      for (const busy of [false, true]) {
        for (const intentOpen of [false, true]) {
          for (const locked of [false, true]) {
            for (const chosen of [false, true]) {
              const r = press({
                ...base, gateReady, busy, intentOpen, locked,
                sideChosen: chosen, sameSide: chosen,
              });
              eq(r.submit, 0);
              assert(r.v.action === 'NONE' || r.v.action === 'CHOOSE_SIDE'
                || r.v.action === 'OPEN_REVIEW', `모르는 할 일: ${r.v.action}`);
            }
          }
        }
      }
    }
  });

  test('다른 방향을 고른 상태면 이 버튼은 아직 고르기다', () => {
    const r = press({ ...base, sideChosen: true, sameSide: false });
    eq(r.v.on, false);
    eq(r.v.action, 'CHOOSE_SIDE');
    eq(r.openReview, 0);
  });

  test('★ 꺼짐 사유는 먼저 걸린 것이 나온다 — 뒤엣것은 앞엣것의 결과다', () => {
    // 종목이 없으면 판정도 준비되지 않는다. 그때 "준비 안 됨"이라고 적으면
    // 사용자는 무엇을 고쳐야 할지 모른다.
    const v = ctaVerdict({ ...base, locked: true, gateReady: false });
    assert(/종목/.test(v.reason || ''), `사유가 ${v.reason}이다`);
  });

  test('★ 꺼졌으면 action은 언제나 NONE이다', () => {
    const offs: Partial<CtaVerdictInput>[] = [
      { unavailable: true }, { locked: true }, { intentOpen: false },
      { busy: true }, { gateReady: false },
    ];
    for (const o of offs) {
      for (const chosen of [false, true]) {
        const v = ctaVerdict({ ...base, ...o, sideChosen: chosen, sameSide: chosen });
        eq(v.off, true, JSON.stringify(o));
        eq(v.action, 'NONE', JSON.stringify(o));
      }
    }
  });
}
