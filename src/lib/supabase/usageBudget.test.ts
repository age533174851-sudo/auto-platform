// src/lib/supabase/usageBudget.test.ts
//
// **한도에 닿기 전에 말하는가.** 그리고 **아끼느라 보호를 끄지 않는가.**

import { test, eq, assert } from '../../test/harness';
import { usageVerdict, shouldSendUsageAlert, usageAllows, USAGE_TIERS } from './usageBudget';

const at = (pct: number) => usageVerdict({ used: pct, included: 100 });

export function runUsageBudgetTests() {
  console.log('[사용량 예산 사다리 — 402가 나기 전에 말한다]');

  // ── 단계 ───────────────────────────────────────────────────────
  test('★ 70 · 85 · 95 · 100에서 단계가 바뀐다', () => {
    eq(at(69.9).tier, 'OK');
    eq(at(70).tier, 'NOTICE');
    eq(at(84.9).tier, 'NOTICE');
    eq(at(85).tier, 'WARN');
    eq(at(94.9).tier, 'WARN');
    eq(at(95).tier, 'CRITICAL');
    eq(at(99.9).tier, 'CRITICAL');
    eq(at(100).tier, 'EXCEEDED');
    eq(at(140).tier, 'EXCEEDED');
  });

  test('OK에서는 알리지 않는다 — 매번 울리면 아무도 안 읽는다', () => {
    eq(at(10).shouldAlert, false);
    eq(at(70).shouldAlert, true);
  });

  test('단계 표가 내림차순이라 첫 일치가 가장 높은 단계다', () => {
    const pcts = USAGE_TIERS.map((t) => t.atPct);
    for (let i = 1; i < pcts.length; i++) assert(pcts[i] < pcts[i - 1], `정렬이 깨졌습니다: ${pcts}`);
  });

  // ── 못 읽은 것을 0%로 읽지 않는다 ───────────────────────────────
  test('★ 사용량을 못 읽으면 UNKNOWN이다 — 0%가 아니다', () => {
    for (const bad of [null, undefined, NaN, 'many']) {
      const v = usageVerdict({ used: bad as any, included: 100 });
      eq(v.tier, 'UNKNOWN', `${JSON.stringify(bad)}를 0%로 읽었습니다`);
      eq(v.pct, null, 'pct를 0으로 적었습니다');
      eq(v.shouldAlert, true, '모른다는 사실을 알리지 않습니다');
    }
  });

  test('★ 포함량을 못 읽거나 0이면 비율을 지어내지 않는다', () => {
    for (const bad of [null, undefined, 0, -5, 'lots']) {
      const v = usageVerdict({ used: 50, included: bad as any });
      eq(v.tier, 'UNKNOWN', `included=${JSON.stringify(bad)}인데 단계를 냈습니다`);
      eq(v.pct, null);
    }
  });

  test('음수 사용량은 믿지 않는다', () => {
    eq(usageVerdict({ used: -1, included: 100 }).tier, 'UNKNOWN');
  });

  test('★ 모르는 상태에서 한가한 조회를 막지는 않는다 — 모른다고 멈추면 모를 때마다 멈춘다', () => {
    const v = usageVerdict({ used: null, included: 100 });
    eq(v.throttleRoutine, false);
    eq(usageAllows(v, 'ROUTINE'), true);
    eq(usageAllows(v, 'PROTECTION'), true);
  });

  // ── 아끼는 것은 한가한 쪽에서만 ────────────────────────────────
  test('★ 95%부터 한가한 조회를 쉬게 한다', () => {
    eq(at(94).throttleRoutine, false);
    eq(at(95).throttleRoutine, true);
    eq(at(120).throttleRoutine, true);
  });

  test('★★ 어떤 단계에서도 보호 경로는 막지 않는다', () => {
    for (const p of [0, 70, 85, 95, 100, 300]) {
      eq(usageAllows(at(p), 'PROTECTION'), true,
        `${p}%에서 보호 경로를 막았습니다 — 열린 100배 포지션이 방치되는 쪽이 더 비쌉니다`);
    }
  });

  test('70·85%에서는 아직 아무것도 줄이지 않는다 — 알리기만 한다', () => {
    for (const p of [70, 85]) {
      eq(at(p).throttleRoutine, false);
      eq(usageAllows(at(p), 'ROUTINE'), true);
      eq(at(p).shouldAlert, true);
    }
  });

  // ── 같은 단계를 두 번 알리지 않는다 ────────────────────────────
  test('★ 같은 단계가 이어지면 다시 알리지 않는다', () => {
    eq(shouldSendUsageAlert(null, at(70)), true);
    eq(shouldSendUsageAlert('NOTICE', at(71)), false);
    eq(shouldSendUsageAlert('NOTICE', at(85)), true, '단계가 올랐는데 알리지 않았습니다');
  });

  test('내려갔다 다시 올라가면 다시 알린다', () => {
    eq(shouldSendUsageAlert('WARN', at(10)), false, 'OK는 알릴 일이 아니다');
    eq(shouldSendUsageAlert('OK', at(85)), true);
  });

  test('UNKNOWN도 한 번은 알린다', () => {
    eq(shouldSendUsageAlert(null, usageVerdict({ used: null, included: 100 })), true);
    eq(shouldSendUsageAlert('UNKNOWN', usageVerdict({ used: null, included: 100 })), false);
  });

  // ── 이것은 결제 차단이 아니다 ──────────────────────────────────
  test('★ 사유에 "차단"이 아니라 무엇을 했는지가 적힌다', () => {
    const v = at(96);
    assert(v.reason.includes('한가한'), `사유가 불명확합니다: ${v.reason}`);
    assert(v.reason.includes('보호'), '보호 경로가 그대로라는 사실이 사유에 없습니다');
  });

  test('모든 판정에 사유가 있다', () => {
    for (const v of [at(10), at(70), at(95), at(150), usageVerdict({ used: null, included: null })]) {
      assert(v.reason.trim().length > 0, `사유가 비었습니다: ${v.tier}`);
    }
  });

  test('pct는 읽었을 때만 숫자다', () => {
    eq(typeof at(42).pct, 'number');
    eq(at(42).pct != null && Math.abs((at(42).pct as number) - 42) < 1e-9, true);
  });
}
