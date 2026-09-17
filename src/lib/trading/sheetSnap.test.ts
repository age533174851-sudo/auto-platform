// src/lib/trading/sheetSnap.test.ts
import { test, eq, assert } from '../../test/harness';
import {
  SHEET_SNAPS, DEFAULT_SNAP, sheetHeightVh, toggleSnap,
  sectionVisible, hiddenInHalf, SHEET_SECTIONS, bookRowsFor,
} from './sheetSnap';

export function runSheetSnapTests() {
  // ── ★ 차트가 보여야 한다 ──
  test('★ HALF는 화면을 다 덮지 않는다 — 위에 차트가 남아야 한다', () => {
    const half = sheetHeightVh('HALF');
    assert(half < 100, `HALF가 ${half}vh입니다 — 차트가 안 보입니다`);
    // 실측에서 차트는 y≈265에서 시작해 371px이었다. 800px 화면에서
    // 시트가 52vh(416px)면 상단이 384px이라 차트가 120px쯤 남는다.
    assert(half <= 60, `HALF가 ${half}vh로 너무 큽니다`);
    assert(half >= 40, `HALF가 ${half}vh로 너무 작아 주문 조작이 안 들어갑니다`);
  });

  test('★ 처음 열면 차트가 보이는 자리다', () => {
    eq(DEFAULT_SNAP, 'HALF');
    assert(sheetHeightVh(DEFAULT_SNAP) < 100, '기본 자리가 화면을 다 덮습니다');
  });

  test('EXPANDED가 HALF보다 크다', () => {
    assert(sheetHeightVh('EXPANDED') > sheetHeightVh('HALF'), '두 자리가 같습니다');
    assert(sheetHeightVh('EXPANDED') <= 92, '확장이 화면을 완전히 덮습니다');
  });

  test('자리는 둘뿐이고 버튼 하나로 오간다', () => {
    eq(SHEET_SNAPS.join(','), 'HALF,EXPANDED');
    eq(toggleSnap('HALF'), 'EXPANDED');
    eq(toggleSnap('EXPANDED'), 'HALF');
  });

  // ── ★ 어느 자리에서도 주문을 끝낼 수 있다 ──
  test('★ 주문 버튼은 두 자리 모두에 있다', () => {
    for (const s of SHEET_SNAPS) {
      assert(sectionVisible('SUBMIT', s), `${s}에서 주문 버튼이 없습니다`);
    }
  });

  test('★ HALF에 결정에 필요한 것이 다 있다 — 호가·방향·수량·주문', () => {
    for (const s of ['BOOK', 'SIDE', 'SIZING', 'SUBMIT']) {
      assert(sectionVisible(s, 'HALF'), `HALF에 ${s}가 없습니다`);
    }
  });

  test('설정은 EXPANDED에 있다', () => {
    for (const s of ['LEVERAGE', 'MARGIN_MODE', 'TP_SL', 'ESTIMATE', 'STOP_PRESETS']) {
      eq(sectionVisible(s, 'HALF'), false, `${s}가 HALF에 있습니다`);
      assert(sectionVisible(s, 'EXPANDED'), `${s}가 EXPANDED에도 없습니다`);
    }
  });

  test('EXPANDED는 모든 칸을 보여준다', () => {
    for (const s of SHEET_SECTIONS) {
      assert(sectionVisible(s, 'EXPANDED'), `EXPANDED에 ${s}가 없습니다`);
    }
  });

  test('모르는 칸은 그리지 않는다', () => {
    eq(sectionVisible('NOPE', 'HALF'), false);
    eq(sectionVisible('NOPE', 'EXPANDED'), false);
    eq(sectionVisible('', 'EXPANDED'), false);
  });

  test('★ 좁은 자리에서는 호가 줄을 줄이지, 주문 칸을 빼지 않는다', () => {
    // 호가는 위아래로 이어지지만 버튼은 없으면 못 누른다.
    assert(bookRowsFor('HALF') < bookRowsFor('EXPANDED'), 'HALF에서 호가가 안 줄었습니다');
    assert(bookRowsFor('HALF') >= 3, `HALF 호가가 ${bookRowsFor('HALF')}줄이면 시장을 못 봅니다`);
    // 줄었어도 방향·수량·주문은 그대로 있다
    for (const s of ['BOOK', 'SIDE', 'SIZING', 'SUBMIT']) {
      assert(sectionVisible(s, 'HALF'), `HALF에서 ${s}가 빠졌습니다`);
    }
  });

  test('HALF에서 감춘 칸을 화면이 말할 수 있다', () => {
    const hidden = hiddenInHalf();
    assert(hidden.length > 0, '감춘 칸 목록이 비었습니다');
    assert(hidden.indexOf('SUBMIT' as any) < 0, '주문 버튼을 감췄습니다');
    assert(hidden.indexOf('BOOK' as any) < 0, '호가를 감췄습니다');
  });
}
