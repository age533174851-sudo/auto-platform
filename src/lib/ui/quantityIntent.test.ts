// src/lib/ui/quantityIntent.test.ts
//
// **표시용으로 깎은 숫자가 실행 수량이 되면 안 된다.**
//
// 조사에서 나온 실제 수치가 이 시험의 출발점이다:
//
//   px 0.0000345 · stepSize 1 · 실제 포지션 1,000,145
//   100% 버튼 → 34.51 USDT → 주문 시 1,000,289.855 → 서버 내림 1,000,289
//   보유보다 **+144 많다.** 서버 내림은 반올림 오차가 stepSize보다 크면
//   되돌리지 못한다.
//
// 자리수를 6에서 8로 늘려도 USDT 되돌림·가격 시점차·포지션 축소는 그대로다.

import { test, eq, assert } from '../../test/harness';
import {
  makeIntent, intentStillValid, closePercentOf, executionQuantityOf,
} from './quantityIntent';
// 확인창 정책은 복제하지 않는다 — 화면이 쓰는 그 함수를 그대로 시험한다.
import { shouldConfirm, DEFAULTS } from './preferences';

export function runQuantityIntentTests() {
  console.log('[수량 의도 — 표시와 실행을 가른다]');

  // ── 청산 비율은 개수를 만들지 않는다 ──

  test('100% 청산은 percent를 들고 간다 — 개수가 아니다', () => {
    const { intent, display } = makeIntent({
      source: 'PERCENT_CLOSE', rawBaseQty: 1_000_145, percent: 100,
      displayNumber: 34.505, displayDecimals: 2,
    });
    eq(closePercentOf(intent, display), 100);
  });

  test('25 · 50 · 75%도 각각 그대로 간다', () => {
    for (const p of [25, 50, 75]) {
      const { intent, display } = makeIntent({
        source: 'PERCENT_CLOSE', rawBaseQty: 1, percent: p,
        displayNumber: 1, displayDecimals: 6,
      });
      eq(closePercentOf(intent, display), p);
    }
  });

  test('**+144 초과가 애초에 만들어지지 않는다**', () => {
    // 예전 경로: (1000145 × 0.0000345).toFixed(2) = 34.51 → /0.0000345
    const px = 0.0000345, pos = 1_000_145;
    const oldPath = Number((pos * px).toFixed(2)) / px;
    assert(oldPath > pos, `옛 경로가 초과하지 않으면 이 시험은 의미가 없다: ${oldPath}`);
    // 새 경로: 개수를 만들지 않는다. 서버가 그 순간 포지션을 다시 읽는다.
    const { intent, display } = makeIntent({
      source: 'PERCENT_CLOSE', rawBaseQty: pos, percent: 100,
      displayNumber: pos * px, displayDecimals: 2,
    });
    eq(closePercentOf(intent, display), 100);
  });

  test('비율이 말이 안 되면 비율 청산으로 보내지 않는다', () => {
    for (const p of [0, -10, 101, NaN]) {
      const { intent, display } = makeIntent({
        source: 'PERCENT_CLOSE', rawBaseQty: 1, percent: p as number,
        displayNumber: 1, displayDecimals: 6,
      });
      eq(closePercentOf(intent, display), null);
    }
  });

  test('신규·위험 의도는 비율 청산으로 새지 않는다', () => {
    for (const s of ['PERCENT_ENTRY', 'RISK'] as const) {
      const { intent, display } = makeIntent({
        source: s, rawBaseQty: 0.5, displayNumber: 0.5, displayDecimals: 6,
      });
      eq(closePercentOf(intent, display), null);
    }
  });

  // ── 신규·위험은 반올림 없는 값으로 나간다 ──

  test('신규 비율: 실행 수량이 계산값보다 커지지 않는다 — 정확히 같다', () => {
    const raw = 0.123456789;
    const { intent, display } = makeIntent({
      source: 'PERCENT_ENTRY', rawBaseQty: raw, displayNumber: raw, displayDecimals: 6,
    });
    const shown = Number(display);
    assert(shown > raw, `이 시험의 전제: 표시값이 올라가야 한다 (${shown})`);
    const ex = executionQuantityOf(intent, display, shown);
    eq(ex.qty, raw);                      // 표시값(0.123457)이 아니라 원본
    eq(ex.from, 'INTENT');
    assert((ex.qty as number) <= raw, '계산값보다 커졌습니다');
  });

  test('위험 버튼: planSize가 낸 값이 그대로 나간다', () => {
    const planned = 0.0074999999;
    const { intent, display } = makeIntent({
      source: 'RISK', rawBaseQty: planned, displayNumber: planned, displayDecimals: 6,
    });
    const ex = executionQuantityOf(intent, display, Number(display));
    eq(ex.qty, planned);
    assert((ex.qty as number) <= planned, '허용 위험을 넘었습니다');
  });

  test('USDT 칸이어도 실행은 개수 원본이다 — 가격으로 되돌리지 않는다', () => {
    // 버튼 시각 가격 t1, 주문 시각 가격 t2. 예전에는 USDT를 t2로 나눴다.
    const raw = 2.5, pxT1 = 100, pxT2 = 90;
    const { intent, display } = makeIntent({
      source: 'PERCENT_ENTRY', rawBaseQty: raw,
      displayNumber: raw * pxT1, displayDecimals: 2,
    });
    const oldPath = Number(display) / pxT2;          // 250 / 90 = 2.777…
    assert(oldPath > raw, `전제: 가격이 내리면 옛 경로가 커진다 (${oldPath})`);
    const ex = executionQuantityOf(intent, display, oldPath);
    eq(ex.qty, raw);                                  // 가격 변화의 영향 0
    eq(ex.from, 'INTENT');
  });

  // ── 사용자가 고치면 의도는 끝난다 ──

  test('칸을 고치면 의도가 풀리고 사용자가 적은 값이 나간다', () => {
    const { intent, display } = makeIntent({
      source: 'PERCENT_CLOSE', rawBaseQty: 1, percent: 100,
      displayNumber: 1, displayDecimals: 6,
    });
    eq(intentStillValid(intent, display), true);
    eq(intentStillValid(intent, '0.003'), false);
    eq(closePercentOf(intent, '0.003'), null);        // 전량으로 나가지 않는다
    const ex = executionQuantityOf(intent, '0.003', 0.003);
    eq(ex.qty, 0.003);
    eq(ex.from, 'MANUAL');
  });

  test('한 글자만 달라도 의도가 아니다', () => {
    const { intent, display } = makeIntent({
      source: 'PERCENT_ENTRY', rawBaseQty: 0.5, displayNumber: 0.5, displayDecimals: 6,
    });
    eq(intentStillValid(intent, display + '1'), false);
    eq(intentStillValid(intent, ''), false);
  });

  test('의도가 없으면 사용자가 적은 값이 정답이다', () => {
    const ex = executionQuantityOf(null, '0.01', 0.01);
    eq(ex.qty, 0.01);
    eq(ex.from, 'MANUAL');
  });

  test('의도의 원본이 못 쓸 값이면 사용자 값으로 떨어진다', () => {
    const { intent, display } = makeIntent({
      source: 'RISK', rawBaseQty: 0, displayNumber: 1, displayDecimals: 6,
    });
    eq(executionQuantityOf(intent, display, 1).from, 'MANUAL');
  });

  test('둘 다 못 쓰면 수량이 없다 — 0으로 지어내지 않는다', () => {
    eq(executionQuantityOf(null, '', null).qty, null);
    eq(executionQuantityOf(null, 'abc', NaN).qty, null);
  });

  // ── 청산 비율을 만드는 자리가 넷이다 ──
  //
  // 비율 칩 · 빠른 부분청산 · 빠른 전량청산 · 청산 탭 진입. 처음 배선에서
  // 칩만 고치고 빠른 액션은 옛 방식으로 남아 있었다 — 그 버튼은 새 경로를
  // 타지 않고 절대 수량으로 떨어진다. 넷이 같은 의도를 만들어야 한다.

  test('빠른 부분청산 50%도 percent 50을 만든다', () => {
    const pos = 1_000_145;
    const { intent, display } = makeIntent({
      source: 'PERCENT_CLOSE', rawBaseQty: pos * 0.5, percent: 50,
      displayNumber: pos * 0.5, displayDecimals: 6,
    });
    eq(closePercentOf(intent, display), 50);
  });

  test('빠른 전량청산도 percent 100을 만든다 — 개수가 아니다', () => {
    const pos = 1_000_145;
    const { intent, display } = makeIntent({
      source: 'PERCENT_CLOSE', rawBaseQty: pos, percent: 100,
      displayNumber: pos, displayDecimals: 6,
    });
    eq(closePercentOf(intent, display), 100);
    // 개수 경로로 떨어지지 않는다: 비율이 나오면 그것이 정답이다.
    assert(closePercentOf(intent, display) != null, '절대 수량 경로로 떨어졌습니다');
  });

  // ── 확인창을 건너뛰지 않는다 ──
  //
  // 처음 배선은 판정 직후 곧바로 청산을 보내고 return해서, **실전 비율
  // 청산이 필수 확인창을 지나지 않았다.** 실전은 설정과 무관하게 항상
  // 묻는다는 계약을 깨는 회귀였다. 정책은 여기 한 곳에 있다.

  test('실전은 설정을 꺼도 반드시 확인한다 — 비율 청산도 같다', () => {
    const prefs = { ...DEFAULTS, confirmKinds: [] as any };
    eq(shouldConfirm(prefs, 'MARKET', true), true);
    eq(shouldConfirm(prefs, 'LIMIT', true), true);
  });

  test('테스트넷 정책은 그대로다 — 강화도 약화도 하지 않는다', () => {
    const on = { ...DEFAULTS, confirmKinds: ['MARKET'] as any };
    const off = { ...DEFAULTS, confirmKinds: [] as any };
    eq(shouldConfirm(on, 'MARKET', false), true);
    eq(shouldConfirm(off, 'MARKET', false), false);
  });

  test('취소하면 아무것도 보내지 않는다 — 의도는 그대로 남는다', () => {
    // 확인창을 물리는 것은 화면이지만, 취소가 의도를 지우면 안 된다.
    // 다시 누를 때 같은 비율이어야 한다.
    const { intent, display } = makeIntent({
      source: 'PERCENT_CLOSE', rawBaseQty: 1, percent: 100,
      displayNumber: 1, displayDecimals: 6,
    });
    eq(closePercentOf(intent, display), 100);
    eq(intentStillValid(intent, display), true);
  });

  test('표시는 깎여도 실행은 깎이지 않는다 (자리수를 늘리는 것이 해결이 아니다)', () => {
    const raw = 1_000_145 * 0.0000345;                // 34.5050025
    const { intent, display } = makeIntent({
      source: 'PERCENT_ENTRY', rawBaseQty: raw, displayNumber: raw, displayDecimals: 2,
    });
    eq(display, '34.51');                             // 사람이 읽는 값
    eq(executionQuantityOf(intent, display, Number(display)).qty, raw);
  });
}
