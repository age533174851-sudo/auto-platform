// src/lib/trading/oneScreen.test.ts
import { test, eq, assert } from '../../test/harness';
import {
  splitColumns, BOOK_MIN_PX, GUTTER_PX, mustBeOnFirstScreen,
  FIRST_SCREEN_MUST, MAY_SCROLL,
  coreBudget, CHART_MIN_H, CHART_PREF_H, SPLIT_MIN_H, TOOLBAR_H, CTA_H, ESTIMATE_H,
  POSITION_ROW_H, BOOK_H,
} from './oneScreen';

export function runOneScreenTests() {
  // ── ★ 호가가 잘리지 않는다 ──
  test('★ 320·360·412 어디서도 호가 열이 바닥 아래로 내려가지 않는다', () => {
    for (const w of [320, 360, 412]) {
      const c = splitColumns(w);
      assert(c.bookPx >= BOOK_MIN_PX,
        `${w}px에서 호가가 ${c.bookPx}px입니다 (바닥 ${BOOK_MIN_PX})`);
      eq(c.tooNarrow, false, `${w}px가 너무 좁다고 나옵니다`);
    }
  });

  test('★ 바닥은 실측에서 나왔다 — 가격 53 + 수량 30 + 패딩 16', () => {
    assert(BOOK_MIN_PX >= 99, `바닥 ${BOOK_MIN_PX}px는 실측 내용폭(99px)보다 작습니다`);
  });

  test('★ 50:50을 박지 않는다 — 주문 쪽이 넓다', () => {
    const c = splitColumns(360);
    assert(c.orderPct > c.bookPct, `주문 ${c.orderPct}% / 호가 ${c.bookPct}%`);
    eq(c.orderPct + c.bookPct, 100);
  });

  test('일반적인 폭에서는 60:40이다', () => {
    for (const w of [360, 390, 412, 768]) {
      const c = splitColumns(w);
      eq(c.orderPct, 60, `${w}px`);
      eq(c.bookPct, 40, `${w}px`);
    }
  });

  test('★ 아주 좁으면 호가에 바닥을 주고 주문이 양보한다', () => {
    // 호가가 잘리면 시장을 잘못 읽는다. 주문 열은 줄이 늘어날 뿐이다.
    const c = splitColumns(250);
    assert(c.bookPct > 40, `좁은데도 호가가 ${c.bookPct}%입니다`);
    assert(c.bookPx >= BOOK_MIN_PX || c.tooNarrow, '바닥도 못 지키면서 좁다고도 안 합니다');
  });

  test('폭을 못 읽으면 가장 좁은 기기로 가정한다 — 넓게 가정하면 좁은 기기에서 깨진다', () => {
    for (const bad of [null, undefined, '', NaN, 'abc']) {
      const c = splitColumns(bad);
      eq(c.bookPx, splitColumns(320).bookPx, `${String(bad)}가 320 기준이 아닙니다`);
    }
  });

  test('간격을 뺀 폭으로 계산한다', () => {
    const c = splitColumns(360);
    eq(c.bookPx, Math.round((360 - GUTTER_PX) * 0.4));
  });

  // ── ★ 첫 화면 계약 ──
  test('★ 차트·주문·호가·CTA는 첫 화면에서 밀려나지 않는다', () => {
    for (const p of ['MARKET_HEADER', 'CHART', 'ORDER_CONTROLS', 'ORDER_BOOK', 'CTA']) {
      assert(mustBeOnFirstScreen(p), `${p}가 첫 화면 목록에 없습니다`);
    }
  });

  test('부가 정보는 내리면 나와도 된다 — 스크롤 0을 절대조건으로 두지 않는다', () => {
    for (const p of MAY_SCROLL) {
      eq(mustBeOnFirstScreen(p), false, `${p}가 첫 화면 필수로 잡혀 있습니다`);
    }
    // 두 목록이 겹치지 않는다
    for (const p of FIRST_SCREEN_MUST) {
      assert(MAY_SCROLL.indexOf(p) < 0, `${p}가 양쪽에 다 있습니다`);
    }
  });

  test('모르는 부분은 필수가 아니다', () => {
    eq(mustBeOnFirstScreen('NOPE'), false);
    eq(mustBeOnFirstScreen(''), false);
  });

  // ── ★ 세로 예산 — 320×600에서 슬라이더가 덮였던 자리 ──
  //
  // 실기 크기 그대로 넣는다. 통 높이 = 화면 − 앱 하단 탭(58) − 터미널 헤더(85).
  const CORES: Array<[string, number, number]> = [
    // [기기, 통 높이, 시장정보 높이]
    ['320x600', 600 - 58 - 85, 106],
    ['360x660', 660 - 58 - 85, 74],
    ['412x760', 760 - 58 - 85, 74],
  ];

  test('★ 어떤 기기에서도 띠의 합이 통을 넘지 않는다 — CTA가 밀려나지 않는다', () => {
    for (const [name, core, hdr] of CORES) {
      const b = coreBudget(core, hdr);
      const sum = hdr + TOOLBAR_H + b.chartHeight + b.splitHeight + ESTIMATE_H + CTA_H;
      assert(sum <= core + 1, `${name}: 띠 합 ${sum}px > 통 ${core}px — CTA가 화면 밖입니다`);
      assert(b.splitHeight >= 0, `${name}: 주문 칸이 음수 높이(${b.splitHeight})입니다`);
    }
  });

  test('★ 차트는 어떤 기기에서도 캔들이 보이는 높이 아래로 내려가지 않는다', () => {
    for (const [name, core, hdr] of CORES) {
      const b = coreBudget(core, hdr);
      assert(b.chartHeight >= CHART_MIN_H,
        `${name}: 차트가 ${b.chartHeight}px입니다 (실기에서 52px은 격자선뿐이었다)`);
    }
  });

  test('★ 차트가 통을 다 먹지 않는다 — 주문 칸이 남는다', () => {
    const b = coreBudget(1200, 74);
    eq(b.chartHeight, CHART_PREF_H, '통이 커져도 차트는 선호 높이에서 멈춰야 합니다');
    assert(b.splitHeight > SPLIT_MIN_H, '넓은 통에서 주문 칸이 더 받지 못했습니다');
    eq(b.orderScrolls, false);
  });

  test('★ 좁아서 주문 칸이 모자라면 숨기지 않고 그 칸만 스크롤한다고 말한다', () => {
    const [, core, hdr] = CORES[0];
    const b = coreBudget(core, hdr);
    // 320×600에서는 실제로 모자란다. 모자란 것을 모자라다고 말해야
    // 바깥이 그 칸에 스크롤을 준다 — 넘친 부분이 말없이 사라지면 안 된다.
    eq(b.orderScrolls, b.splitHeight < SPLIT_MIN_H);
  });

  test('★ 못 읽은 높이를 0으로 적지 않는다 — Number(null)은 0이다', () => {
    for (const bad of [null, undefined, '', NaN, -1, 0, false, {}]) {
      const b = coreBudget(bad as any, 74);
      assert(b.chartHeight >= CHART_MIN_H,
        `${String(bad)}에서 차트가 ${b.chartHeight}px로 죽었습니다`);
    }
    // 헤더를 못 재면 0으로 본다 — 그래야 차트가 커졌다가 재면 줄어든다.
    // 반대로 하면 첫 프레임에 CTA가 밖으로 나간다.
    const m = coreBudget(457, null as any);
    const k = coreBudget(457, 106);
    assert(m.chartHeight >= k.chartHeight, '헤더를 못 잰 쪽이 더 작게 잡혔습니다');
  });

  test('시장정보가 길어지면 그만큼 차트가 양보한다', () => {
    const short = coreBudget(517, 74);
    const tall = coreBudget(517, 120);
    assert(tall.chartHeight <= short.chartHeight,
      '헤더가 46px 늘었는데 차트가 줄지 않았습니다 — CTA가 밀려납니다');
  });

  // ── ★ 열린 포지션 줄이 호가를 밀어내지 않는다 ──
  //
  // 이 줄 34px은 어디선가 나와야 한다. 차트는 이미 바닥(96px)에 있는
  // 기기가 있으므로 남는 곳은 [주문│호가]뿐이고, 거기서 빼면 **매수
  // 3줄 중 하나가 밀려 나간다.** 호가는 원래 위아래로 이어지는 것처럼
  // 보여서 화면만으로는 밀렸는지 알 수 없다 — 가장 나쁜 종류다.
  //
  // 그래서 자리가 없으면 통 안에 넣지 않는다(`positionInCore: false`).
  // 바깥 스크롤로 내려가지만 잘리지는 않는다.
  const TALL: Array<[string, number, number]> = [
    ['360x660', 660 - 58 - 85, 78],
    ['360x800', 800 - 58 - 85, 78],
    ['412x915', 915 - 58 - 85, 78],
  ];

  test('★ 포지션 줄을 통 안에 넣어도 차트·호가 바닥이 남는 기기에서만 넣는다', () => {
    for (const [name, core, hdr] of TALL) {
      const b = coreBudget(core, hdr, true);
      eq(b.positionInCore, true, `${name}: 자리가 있는데 포지션 줄을 밖으로 뺐습니다`);
      assert(b.chartHeight >= CHART_MIN_H, `${name}: 차트가 ${b.chartHeight}px로 줄었습니다`);
      assert(b.splitHeight >= SPLIT_MIN_H,
        `${name}: [주문│호가]가 ${b.splitHeight}px입니다 (호가 실측 ${BOOK_H})`);
    }
  });

  test('★ 자리가 없으면 통 밖으로 뺀다 — 호가를 자르지 않는다', () => {
    const [, core, hdr] = CORES[0];          // 320×600
    const b = coreBudget(core, hdr, true);
    eq(b.positionInCore, false, '320×600에서 포지션 줄이 통 안으로 들어왔습니다');
    // 그리고 포지션이 있든 없든 **나머지 배치가 똑같아야** 한다.
    const without = coreBudget(core, hdr, false);
    eq(b.chartHeight, without.chartHeight, '포지션 때문에 차트가 줄었습니다');
    eq(b.splitHeight, without.splitHeight, '포지션 때문에 호가 칸이 줄었습니다');
  });

  test('★ 포지션이 없으면 그 줄 자리를 비워 두지 않는다', () => {
    for (const [name, core, hdr] of CORES) {
      const a = coreBudget(core, hdr, false);
      eq(a.positionInCore, false, `${name}: 포지션이 없는데 자리를 잡았습니다`);
      // 포지션 없을 때의 차트가 있을 때보다 작아지면 평소에 손해다.
      const b = coreBudget(core, hdr, true);
      assert(a.chartHeight >= b.chartHeight,
        `${name}: 포지션이 없는데 차트가 더 작습니다`);
    }
  });

  test('포지션 줄 높이는 실측에서 나왔다', () => {
    assert(POSITION_ROW_H > 0 && POSITION_ROW_H < 60,
      `포지션 줄 ${POSITION_ROW_H}px는 한 줄 높이가 아닙니다`);
  });
}
