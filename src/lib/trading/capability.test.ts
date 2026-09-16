// src/lib/trading/capability.test.ts
//
// **지원하지 않는 기능이 실행 가능한 것처럼 보이지 않는지 고정한다.**
//
//  ① 미지원에는 **사람이 읽을 사유**가 반드시 있다 ("준비 중" 금지)
//  ② 서버 능력과 화면 배선을 **한 칸에 섞지 않는다**
//  ③ USDM 서버 능력을 이번 PR이 부정하지 않는다
//  ④ 정본 백엔드가 없는 탭은 그 사실을 말한다
import { test, eq, assert } from '../../test/harness';
import {
  orderCapability, orderCapabilities, unsupported, PAPER_ORDER_FEATURES,
  paperOrderUiWiring, dockTabSupport, DOCK_TABS,
  type OrderFeature,
} from './capability';
import { PAPER_MARKETS } from '../engine/paperPriceSource';

export function runPaperCapabilityTests() {
  // ── ① 사유가 있다 ──
  test('★ 미지원 기능에는 전부 사유가 있다', () => {
    for (const m of PAPER_MARKETS) {
      for (const f of PAPER_ORDER_FEATURES) {
        const c = orderCapability(m, f);
        if (unsupported(c)) {
          assert(typeof c.reason === 'string' && c.reason.length >= 8,
            `${m}/${f}에 사유가 없습니다`);
          assert(!/준비\s*중|coming soon|TODO/i.test(c.reason),
            `${m}/${f}의 사유가 얼버무립니다: ${c.reason}`);
        }
      }
    }
  });

  test('모르는 기능은 지원하지 않는다 — 기본이 거부다', () => {
    for (const m of PAPER_MARKETS) {
      assert(unsupported(orderCapability(m, 'WHATEVER' as OrderFeature)),
        `${m}에서 모르는 기능이 통과했습니다`);
    }
  });

  // ── 실제 계약과 맞는가 ──
  test('★ 지정가·감축전용·부분청산은 두 시장 모두 미지원이다', () => {
    for (const m of PAPER_MARKETS) {
      for (const f of ['TYPE_LIMIT', 'REDUCE_ONLY', 'PARTIAL_CLOSE'] as OrderFeature[]) {
        assert(unsupported(orderCapability(m, f)), `${m}/${f}가 지원으로 적혀 있습니다`);
      }
    }
  });

  test('★ 체결가는 화면이 정하지 않는다', () => {
    for (const m of PAPER_MARKETS) {
      assert(unsupported(orderCapability(m, 'PRICE_INPUT')),
        `${m}에서 화면이 체결가를 정할 수 있게 돼 있습니다`);
    }
  });

  test('현물은 숏·배율·마진모드·손절·익절이 없다', () => {
    for (const f of ['SIDE_SHORT', 'LEVERAGE', 'MARGIN_MODE',
                     'STOP_LOSS', 'TAKE_PROFIT'] as OrderFeature[]) {
      assert(unsupported(orderCapability('SPOT', f)), `현물에 ${f}가 열려 있습니다`);
    }
    assert(!unsupported(orderCapability('SPOT', 'SIDE_LONG')), '현물 매수가 막혀 있습니다');
  });

  test('★ 선물 손절은 선택이 아니라 필수다', () => {
    const c = orderCapability('USDM', 'STOP_LOSS');
    assert(!unsupported(c), '선물 손절이 미지원으로 적혀 있습니다');
    eq((c as any).required, true);
  });

  test('선물 익절은 선택이다', () => {
    const c = orderCapability('USDM', 'TAKE_PROFIT');
    assert(!unsupported(c), '선물 익절이 미지원으로 적혀 있습니다');
    eq((c as any).required, false);
  });

  test('배율 상한이 실제 계약(paperPlan)에서 온다', () => {
    const c = orderCapability('USDM', 'LEVERAGE');
    assert(!unsupported(c) && /100/.test((c as any).note), '배율 상한이 표시되지 않습니다');
  });

  test('전체 표에 모든 기능이 들어 있다', () => {
    for (const m of PAPER_MARKETS) {
      const all = orderCapabilities(m);
      eq(Object.keys(all).length, PAPER_ORDER_FEATURES.length);
      for (const f of PAPER_ORDER_FEATURES) assert(all[f] != null, `${m}/${f}가 표에 없습니다`);
    }
  });

  // ── ②③ 서버 능력 ≠ 화면 배선 ──
  test('★ 현물만 지금 주문할 수 있다', () => {
    eq(paperOrderUiWiring('SPOT').state, 'WIRED');
    eq(paperOrderUiWiring('SPOT').canOrder, true);
  });

  test('★ 선물은 서버가 되지만 화면이 없다 — 능력을 부정하지도, 주문을 열지도 않는다', () => {
    const w = paperOrderUiWiring('USDM');
    eq(w.state, 'SERVER_READY_UI_PENDING');
    eq(w.canOrder, false);                       // 닿을 수 없는 버튼을 열지 않는다
    assert(/서버가 이미 지원/.test(w.reason), '서버 능력을 부정하고 있습니다');
    // 그리고 서버 능력 표는 그대로 살아 있다 — 다음 PR이 이걸 다시 쓰지 않는다
    assert(!unsupported(orderCapability('USDM', 'LEVERAGE')), '선물 배율 능력이 지워졌습니다');
    assert(!unsupported(orderCapability('USDM', 'SIDE_SHORT')), '선물 숏 능력이 지워졌습니다');
  });

  test('모르는 시장은 주문할 수 없다', () => {
    for (const m of ['COINM', 'STOCK', '', null, undefined]) {
      const w = paperOrderUiWiring(m);
      eq(w.state, 'UNSUPPORTED');
      eq(w.canOrder, false);
    }
  });

  test('★ canOrder가 참인 상태는 WIRED 하나뿐이다', () => {
    const states = ['SPOT', 'USDM', 'COINM', '', null].map(paperOrderUiWiring);
    eq(states.filter(s => s.canOrder).length, 1);
    eq(states.filter(s => s.canOrder)[0].state, 'WIRED');
  });

  // ── ④ 독 탭 ──
  test('★ 대기 주문 탭에는 정본 백엔드가 없다고 말한다', () => {
    const s = dockTabSupport('ORDERS');
    assert(unsupported(s), '주문 탭이 지원으로 적혀 있습니다');
    assert(/대기 주문이 없습니다/.test((s as any).reason), '사유가 개념 부재를 말하지 않습니다');
  });

  test('포지션·이력·자산은 서버 표에서 온다', () => {
    for (const t of ['POSITIONS', 'HISTORY', 'ASSETS'] as const) {
      const s = dockTabSupport(t);
      assert(!unsupported(s), `${t}가 미지원으로 적혀 있습니다`);
      assert(/paper_/.test((s as any).note), `${t}의 근거 표가 적혀 있지 않습니다`);
    }
  });

  test('모르는 탭은 지원하지 않는다', () => {
    assert(unsupported(dockTabSupport('WAT' as any)), '모르는 탭이 통과했습니다');
    eq(DOCK_TABS.length, 4);
  });
}
