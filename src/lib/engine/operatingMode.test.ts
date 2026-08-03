// src/lib/engine/operatingMode.test.ts
//
// 가장 중요한 것은 "Shadow Live는 주문을 보내지 않는다"와
// "단계를 건너뛸 수 없다"이다.
import { test, assert, eq } from '../../test/harness';
import {
  parseMode, capability, canChangeMode, gateOrder, toLegacyMode, fromLegacyMode,
  LADDER, type OperatingMode, type ModeEvidence,, modeForDestination } from './operatingMode';

const CLEAN: ModeEvidence = {
  completedTrades: 999, daysInMode: 999,
  unresolvedOrders: 0, criticalMismatches: 0,
  hasLiveKey: true, liveUnlocked: true,
};

export function runOperatingModeTests() {
  console.log('[운영 모드 — Shadow Live]');

  test('Shadow Live는 주문을 보내지 않는다', () => {
    eq(capability('SHADOW_LIVE').sendsOrders, false, '섀도우가 실제로 주문을 보냈다');
    eq(gateOrder('SHADOW_LIVE', 50).disposition, 'RECORD');
  });

  test('Shadow Live는 보냈어야 할 주문을 기록한다', () => {
    eq(capability('SHADOW_LIVE').recordsIntent, true,
      '기록하지 않는 섀도우는 그냥 꺼둔 것과 같다');
  });

  test('Shadow Live는 금액이 아무리 커도 막히지 않고 기록된다', () => {
    // 보내지 않으므로 상한을 적용할 이유가 없다. 상한 때문에 기록이
    // 빠지면 정작 검증하려던 표본이 사라진다.
    eq(gateOrder('SHADOW_LIVE', 1_000_000).disposition, 'RECORD');
  });

  test('Shadow Live는 실계좌 키가 필요하다', () => {
    eq(capability('SHADOW_LIVE').needsLiveKey, true, '실계좌 데이터로 판단해야 의미가 있다');
    eq(capability('SHADOW_LIVE').realMoney, false, '돈은 걸리지 않는다');
  });

  test('실수로 섀도우가 실행 경로에 오면 가장 안전한 쪽으로 떨어진다', () => {
    eq(toLegacyMode('SHADOW_LIVE'), 'PAPER');
  });

  console.log('[운영 모드 — 사다리]');

  test('한 번에 한 단계씩만 오른다', () => {
    const r = canChangeMode('TESTNET', 'LIVE_SMALL', CLEAN);
    eq(r.allowed, false, 'Shadow Live를 건너뛰고 실전으로 갔다');
    assert(r.reasons.some(x => x.includes('SHADOW_LIVE')), '이유에 건너뛴 단계가 없다');
  });

  test('바로 위 단계로는 오를 수 있다', () => {
    eq(canChangeMode('TESTNET', 'SHADOW_LIVE', CLEAN).allowed, true);
  });

  test('내려가는 것은 언제나 허용한다', () => {
    for (const from of LADDER) {
      for (const to of LADDER) {
        if (LADDER.indexOf(to) >= LADDER.indexOf(from)) continue;
        assert(canChangeMode(from, to, {
          completedTrades: 0, daysInMode: 0, unresolvedOrders: 5,
          criticalMismatches: 3, hasLiveKey: false, liveUnlocked: false,
        }).allowed, `${from} → ${to} 하향이 막혔다 — 안전 밸브에 조건을 달면 안 된다`);
      }
    }
  });

  test('표본이 모자라면 못 오른다', () => {
    const r = canChangeMode('TESTNET', 'SHADOW_LIVE', { ...CLEAN, completedTrades: 3 });
    eq(r.allowed, false);
    assert(r.reasons.some(x => x.includes('표본')), r.reasons.join(', '));
  });

  test('미확정 주문을 남긴 채로 올라갈 수 없다', () => {
    const r = canChangeMode('TESTNET', 'SHADOW_LIVE', { ...CLEAN, unresolvedOrders: 1 });
    eq(r.allowed, false, '미확정을 안고 더 위험한 단계로 갔다');
  });

  test('상태 불일치를 남긴 채로 올라갈 수 없다', () => {
    eq(canChangeMode('TESTNET', 'SHADOW_LIVE', { ...CLEAN, criticalMismatches: 1 }).allowed, false);
  });

  test('실거래 잠금이 걸려 있으면 실전 단계로 못 간다', () => {
    const r = canChangeMode('SHADOW_LIVE', 'LIVE_SMALL', { ...CLEAN, liveUnlocked: false });
    eq(r.allowed, false);
  });

  console.log('[운영 모드 — 주문 관문]');

  test('UI 데모는 주문을 만들지도 않는다', () => {
    eq(gateOrder('UI_DEMO', 1).disposition, 'BLOCK');
  });

  test('소액 실전은 상한을 강제한다', () => {
    eq(gateOrder('LIVE_SMALL', 50).disposition, 'SEND');
    eq(gateOrder('LIVE_SMALL', 500).disposition, 'BLOCK', '상한이 권고에 그쳤다');
  });

  test('소액 실전은 건마다 사람 확인이 필요하다', () => {
    eq(gateOrder('LIVE_SMALL', 50).needsConfirmation, true);
    eq(gateOrder('TESTNET', 50).needsConfirmation, false, '테스트넷까지 확인을 요구하면 검증이 안 돈다');
  });

  test('실제 자금 여부를 관문이 알려준다', () => {
    eq(gateOrder('TESTNET', 10).live, false);
    eq(gateOrder('LIVE_LIMITED', 10).live, true);
  });

  console.log('[운영 모드 — 실패 시 안전한 쪽]');

  test('모르는 값은 가장 안전한 모드가 된다', () => {
    for (const bad of ['', 'live', 'LIVE', 'REAL', 'production', null, undefined, 'LIVE_HUGE']) {
      eq(parseMode(bad as any), 'UI_DEMO', `'${bad}'가 위험한 모드로 해석됐다`);
    }
  });

  test('예전 PAPER/TESTNET/LIVE를 사다리로 옮긴다', () => {
    eq(fromLegacyMode('PAPER'), 'PAPER');
    eq(fromLegacyMode('TESTNET'), 'TESTNET');
    eq(fromLegacyMode('LIVE'), 'LIVE_SMALL',
      '예전 LIVE는 상한도 확인도 없었다 — 가장 좀은 실자금 단계로 보내야 한다');
    eq(fromLegacyMode(''), 'UI_DEMO');
  });

  test('알려진 값은 그대로 읽는다', () => {
    eq(parseMode('shadow_live'), 'SHADOW_LIVE');
    eq(parseMode('SHADOW-LIVE'), 'SHADOW_LIVE');
    eq(parseMode('TESTNET'), 'TESTNET');
  });

  test('돈이 걸리는 모드는 셋 중 둘뿐이다', () => {
    const real = LADDER.filter(m => capability(m).realMoney);
    eq(real.length, 2, `실자금 모드가 늘었다: ${real.join(', ')}`);
    assert(!real.includes('SHADOW_LIVE' as OperatingMode), 'Shadow Live에 돈이 걸렸다');
  });

  // ── **관문은 목적지를 기준으로 정한다** ────────────────
  //
  // 수동 선물 주문 경로는 목적지(실제 돈인가)를 연결의 is_testnet으로,
  // 상한·사람 확인을 NEXT_PUBLIC_APP_MODE로 정했다. 둘이 서로 모른다.
  //
  // 테스트넷으로 며칠 돌리다 실전 연결을 고르면, 주문은 fapi(실제 돈)로
  // 나가는데 관문은 여전히 TESTNET이라 $100 상한도 사람 확인도 안 걸린다.
  // 환경변수 바꾸는 걸 잊는 순간 그렇게 되고, 그 실수는 실제 돈으로만
  // 드러난다.
  console.log('[운영 모드 — 목적지가 기준이다]');

  test('실계좌로 나가는데 모드가 테스트넷이면 실자금 단계로 올린다', () => {
    eq(modeForDestination('TESTNET', true), 'LIVE_SMALL');
    eq(modeForDestination('PAPER', true), 'LIVE_SMALL');
    eq(modeForDestination('UI_DEMO', true), 'LIVE_SMALL');
    eq(modeForDestination('SHADOW_LIVE', true), 'LIVE_SMALL');
  });

  test('올린 모드에는 상한과 사람 확인이 붙는다', () => {
    const m = modeForDestination('TESTNET', true);
    eq(capability(m).realMoney, true);
    eq(capability(m).maxNotionalUsd, 100, '상한이 안 붙었다');
    eq(capability(m).autoTrade, false, '사람 확인 없이 자동으로 나간다');
  });

  // 이미 실자금 단계면 그대로 둔다 — 사용자가 올려 둔 것을 되돌리지 않는다.
  test('이미 실자금 단계면 낮추지 않는다', () => {
    eq(modeForDestination('LIVE_LIMITED', true), 'LIVE_LIMITED');
    eq(modeForDestination('LIVE_SMALL', true), 'LIVE_SMALL');
  });

  // **오직 조이는 방향으로만 움직인다.** 테스트넷 목적지에 대해 모드를
  // 낮추면, UI_DEMO로 잠가 둔 것을 이 함수가 풀어 주는 셈이 된다.
  test('테스트넷 목적지면 아무것도 바꾸지 않는다', () => {
    for (const m of ['UI_DEMO', 'PAPER', 'TESTNET', 'SHADOW_LIVE', 'LIVE_SMALL', 'LIVE_LIMITED'] as const) {
      eq(modeForDestination(m, false), m, `${m}이 바뀌었다`);
    }
  });

  test('실계좌 + 상한 넘는 주문은 막힌다', () => {
    const m = modeForDestination('TESTNET', true);
    const g = gateOrder(m, 500);
    assert(g.disposition !== 'SEND', `$500이 상한 $100을 넘겼는데 나간다: ${g.disposition}`);
  });

  test('실계좌 + 상한 안이면 사람 확인을 요구한다', () => {
    const m = modeForDestination('TESTNET', true);
    const g = gateOrder(m, 50);
    eq(g.needsConfirmation, true, '실제 돈인데 확인 없이 나간다');
    eq(g.live, true);
  });
}
