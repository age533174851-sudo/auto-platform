// src/lib/strategies/exitPolicy.test.ts
//
// **청산 정책이 진입 전략을 오염시키면 안 된다.**
//
// 사용자의 원본은 진입에 규칙이 있었고 청산은 재량이었다. 여기 적힌
// 0.4% / 0.8%는 검증용으로 **새로 정한** 값이고 원본이 아니다. 그 사실이
// 코드에도 남아 있어야, 나중에 "내 원본 성적"을 물었을 때 이 숫자를
// 원본으로 읽지 않는다.
//
// 그리고 100배에서 손절 위치는 안전장치다. 청산 거리 바깥에 손절을 두면
// 손절이 있으나 마나고 증거금 전액이 사라진다.

import { test, eq, assert } from '../../test/harness';
import {
  EXIT_POLICIES, DEFAULT_EXIT_POLICY_ID, resolveExitPolicy,
  exitPricesFor, liquidationGuard,
} from './exitPolicy';

const v1 = resolveExitPolicy('testnet-exit-v1').spec!;

export function runExitPolicyTests() {
  console.log('[청산 정책 — 진입 전략과 따로 관리한다]');

  test('검증용 정책은 id와 버전을 갖는다 — 원본에 박히지 않는다', () => {
    eq(v1.id, 'testnet-exit-v1');
    eq(v1.version, '1');
    eq(DEFAULT_EXIT_POLICY_ID, 'testnet-exit-v1');
    // 이 문구가 응답과 기록에 그대로 나가야 한다.
    assert(v1.note.includes('원본'), v1.note);
  });

  test('오늘 쓰는 값은 손절 0.4% · 익절 0.8% · 전량이다', () => {
    eq(v1.stopPct, 0.4);
    eq(v1.takeProfitPct, 0.8);
    eq(v1.partial, false);
  });

  test('모르는 정책 이름은 기본값으로 대신하지 않는다', () => {
    const r = resolveExitPolicy('made-up');
    eq(r.ok, false); eq(r.spec, null);
  });

  test('안 주면 기본 정책이다', () => {
    eq(resolveExitPolicy(undefined).spec?.id, DEFAULT_EXIT_POLICY_ID);
    eq(resolveExitPolicy('').spec?.id, DEFAULT_EXIT_POLICY_ID);
  });

  console.log('[청산 정책 — 방향이 부호를 정한다]');

  test('롱은 아래가 손절, 위가 익절', () => {
    const p = exitPricesFor({ side: 'LONG', entryPrice: 100, spec: v1 });
    eq(p.ok, true);
    eq(p.stop, 99.6);
    eq(p.takeProfit, 100.8);
  });

  test('숏은 위가 손절, 아래가 익절 — 뒤집히면 손절이 이익 쪽에 걸린다', () => {
    const p = exitPricesFor({ side: 'SHORT', entryPrice: 100, spec: v1 });
    eq(p.stop, 100.4);
    eq(p.takeProfit, 99.2);
  });

  test('손절은 언제나 진입가 반대편이다', () => {
    for (const entry of [100, 43_210.5, 0.00031]) {
      const l = exitPricesFor({ side: 'LONG', entryPrice: entry, spec: v1 });
      const s = exitPricesFor({ side: 'SHORT', entryPrice: entry, spec: v1 });
      assert(l.stop! < entry, `롱 손절이 진입가 위다 (${entry})`);
      assert(l.takeProfit! > entry, `롱 익절이 진입가 아래다 (${entry})`);
      assert(s.stop! > entry, `숏 손절이 진입가 아래다 (${entry})`);
      assert(s.takeProfit! < entry, `숏 익절이 진입가 위다 (${entry})`);
    }
  });

  test('손익비가 1:2다', () => {
    const p = exitPricesFor({ side: 'LONG', entryPrice: 1000, spec: v1 });
    eq(Number((p.takeProfit! - 1000).toFixed(6)), 8);
    eq(Number((1000 - p.stop!).toFixed(6)), 4);
  });

  test('진입가를 못 읽으면 가격을 만들지 않는다', () => {
    for (const e of [null, undefined, 0, -1, 'abc', NaN]) {
      eq(exitPricesFor({ side: 'LONG', entryPrice: e as any, spec: v1 }).ok, false, String(e));
    }
  });

  console.log('[청산 정책 — 손절이 청산보다 먼저 와야 한다]');

  test('100배에서 손절 0.4%는 청산 거리 0.6% 안쪽이다', () => {
    const g = liquidationGuard({ leverage: 100, stopPct: 0.4 });
    eq(g.ok, true); eq(g.code, 'OK');
    eq(g.liquidationDistancePct, 0.6);
  });

  test('100배에서 손절 1%면 막는다 — 손절 전에 청산된다', () => {
    const g = liquidationGuard({ leverage: 100, stopPct: 1 });
    eq(g.ok, false); eq(g.code, 'STOP_BEYOND_LIQUIDATION');
    assert(g.reason.includes('증거금 전액'), g.reason);
    // 손절 1%면 100/(1+0.4) ≈ 71배가 천장이다.
    eq(Math.floor(g.maxSafeLeverage!), 71);
  });

  test('손절이 청산 거리와 같아도 막는다 — 동점은 안전이 아니다', () => {
    eq(liquidationGuard({ leverage: 100, stopPct: 0.6 }).ok, false);
  });

  test('유지증거금이 커지면 여유가 줄고, 넘으면 막힌다', () => {
    // 수수료·펀딩이 여유를 갉아먹는 상황을 MMR로 표현한다.
    eq(liquidationGuard({ leverage: 100, stopPct: 0.4, mmrPct: 0.5 }).ok, true);
    eq(liquidationGuard({ leverage: 100, stopPct: 0.4, mmrPct: 0.65 }).ok, false);
  });

  test('배율이 너무 높으면 진입 즉시 청산 구간이다', () => {
    const g = liquidationGuard({ leverage: 300, stopPct: 0.1 });
    eq(g.ok, false); eq(g.code, 'IMMEDIATE_LIQUIDATION');
  });

  test('값을 못 읽으면 안전하다고 답하지 않는다', () => {
    for (const [lev, stop] of [[null, 0.4], [100, null], ['abc', 0.4], [0, 0.4]] as any[]) {
      const g = liquidationGuard({ leverage: lev, stopPct: stop });
      eq(g.ok, false, `${lev}/${stop}`);
      eq(g.code, 'UNKNOWN', `${lev}/${stop}`);
    }
  });

  test('목록의 모든 정책이 100배에서 안전하다 — 새 정책을 넣을 때 여기서 걸린다', () => {
    for (const p of EXIT_POLICIES) {
      const g = liquidationGuard({ leverage: 100, stopPct: p.stopPct });
      assert(g.ok, `${p.id}: ${g.reason}`);
    }
  });
}
