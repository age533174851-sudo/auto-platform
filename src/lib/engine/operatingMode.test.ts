// src/lib/engine/operatingMode.test.ts
//
// 가장 중요한 것은 "Shadow Live는 주문을 보내지 않는다"와
// "단계를 건너뛸 수 없다"이다.
import { test, assert, eq } from '../../test/harness';
import {
  parseMode, capability, canChangeMode, gateOrder, toLegacyMode, fromLegacyMode,
  modeForDestination, notionalCapOf, modeNeedsConfirmation,
  LADDER, type OperatingMode, type ModeEvidence,
} from './operatingMode';
import { isProvenFill } from './holdingEvidence';

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

  // ── 못 센 것을 0건으로 읽지 않는다 ──
  //
  //   미확정 주문 수는 **승급을 막는 증거**다. 그 조회가 실패했을 때
  //   0건으로 적으면, 막아야 할 상태에서 관문이 열린 것으로 보인다 —
  //   "확인하지 못한 것은 통과가 아니다"가 깨지는 자리다.

  test('★ 미확정 주문 수를 못 세었으면 올라갈 수 없다 — 0건이라는 뜻이 아니다', () => {
    const r = canChangeMode('TESTNET', 'SHADOW_LIVE',
      { ...CLEAN, unresolvedOrders: 0, unresolvedKnown: false });
    eq(r.allowed, false, '★ 못 센 미확정 주문을 0건으로 읽어 관문이 열렸다');
    assert(r.reasons.some(x => x.includes('확인하지 못')), r.reasons.join(', '));
  });

  test('★ 표본을 못 읽었으면 "표본 부족"이 아니라 "확인 못 함"이다', () => {
    const r = canChangeMode('TESTNET', 'SHADOW_LIVE',
      { ...CLEAN, completedTrades: 0, daysInMode: 0, samplesKnown: false });
    eq(r.allowed, false);
    assert(r.reasons.some(x => x.includes('확인하지 못')),
      `못 읽은 것을 "부족"으로 적었다: ${r.reasons.join(', ')}`);
  });

  test('★ 실계좌 키 목록을 못 읽었으면 "등록 안 됨"이라고 적지 않는다', () => {
    const r = canChangeMode('SHADOW_LIVE', 'LIVE_SMALL',
      { ...CLEAN, hasLiveKey: false, liveKeyKnown: false });
    eq(r.allowed, false, '막는 방향은 그대로다');
    assert(r.reasons.some(x => x.includes('확인하지 못')),
      `없다고 단정했다: ${r.reasons.join(', ')}`);
    assert(!r.reasons.some(x => x === '실계좌 API 키가 등록돼 있지 않습니다'),
      '못 읽은 것을 "등록돼 있지 않다"로 적었다');
  });

  test('플래그가 없거나 true면 기존 판정이 그대로다 (하위 호환)', () => {
    eq(canChangeMode('TESTNET', 'SHADOW_LIVE', CLEAN).allowed, true);
    eq(canChangeMode('TESTNET', 'SHADOW_LIVE', {
      ...CLEAN, unresolvedKnown: true, samplesKnown: true, liveKeyKnown: true,
    }).allowed, true);
  });

  test('★ 확인하지 못한 증거는 강등을 막지 않는다', () => {
    const r = canChangeMode('LIVE_SMALL', 'TESTNET', {
      ...CLEAN, unresolvedKnown: false, samplesKnown: false, liveKeyKnown: false,
    });
    eq(r.allowed, true, '★ 내려오는 길을 막으면 위험한 단계에 갇힌다');
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

  console.log('[운영 모드 — 상한이 자산과 함께 자라는가]');

  // ── 왜 비율이어야 하나 ──
  //
  // 고정 $1,000 상한은 100배 전략의 명목가(자산의 10배)를 **계좌가
  // 아무리 커져도** 막는다. $10,000 계좌의 10배는 $100,000이니까.
  // 그러면 사용자가 상한을 손으로 올리게 되고, 손으로 올리는 상한은
  // 결국 꺼진다. 자산에 붙여 두면 그럴 이유가 없어진다.
  test('자산을 모르면 고정 상한만 남는다 — 유리하게 읽지 않는다', () => {
    eq(notionalCapOf('LIVE_SMALL'), 100);
    eq(notionalCapOf('LIVE_SMALL', { equityUsd: null }), 100);
    eq(notionalCapOf('LIVE_LIMITED', { equityUsd: 0 }), 1000, '자산 0을 비율에 넣었다');
  });

  test('자산이 크면 상한도 크다', () => {
    eq(notionalCapOf('LIVE_SMALL', { equityUsd: 1000 }), 2000);      // 자산의 200%
    eq(notionalCapOf('LIVE_LIMITED', { equityUsd: 10_000 }), 200_000); // 자산의 2000%
  });

  test('자산이 작으면 고정 금액이 지켜 준다 — 둘 중 큰 쪽', () => {
    eq(notionalCapOf('LIVE_SMALL', { equityUsd: 10 }), 100, '$10 계좌라고 상한이 $20이 되면 안 된다');
    eq(notionalCapOf('LIVE_LIMITED', { equityUsd: 10 }), 1000);
  });

  test('상한 없는 모드는 그대로 없다', () => {
    eq(notionalCapOf('TESTNET', { equityUsd: 1000 }), null);
  });

  test('UI 데모의 상한 0은 0으로 남는다 — 비율이 올려 주면 안 된다', () => {
    eq(notionalCapOf('UI_DEMO', { equityUsd: 1_000_000 }), 0);
    eq(gateOrder('UI_DEMO', 1, { equityUsd: 1_000_000 }).disposition, 'BLOCK');
  });

  // **이것이 내일 아침을 막을 뻔한 것이다.**
  // $360 계좌, 증거금 10%, 100배 → 명목가 $3,600.
  // 예전 고정 상한($1,000)에서는 실전 자동매매가 매일 BLOCK이었다.
  test('$360 계좌의 100배 전략(명목가 $3,600)이 제한 자동매매를 통과한다', () => {
    const g = gateOrder('LIVE_LIMITED', 3600, { equityUsd: 360 });
    eq(g.disposition, 'SEND', g.reason);
    eq(g.needsConfirmation, false, '예약으로 도는 모드가 사람 확인을 요구하면 크론이 못 낸다');
  });

  test('그래도 무한은 아니다 — 자산의 20배를 넘으면 막는다', () => {
    const g = gateOrder('LIVE_LIMITED', 8000, { equityUsd: 360 });
    eq(g.disposition, 'BLOCK', '증거금 20%를 넘는 명목가가 그대로 나갔다');
    assert(g.reason.includes('360'), '왜 막혔는지 자산이 안 적혀 있다: ' + g.reason);
  });

  test('환경변수로 올린 상한도 반영된다', () => {
    eq(notionalCapOf('LIVE_SMALL', { overrideMaxNotionalUsd: 5000 }), 5000);
    eq(gateOrder('LIVE_SMALL', 3000, { overrideMaxNotionalUsd: 5000 }).disposition, 'SEND');
  });

  test('음수·NaN 덮어쓰기는 무시한다 — 상한이 사라지면 안 된다', () => {
    eq(notionalCapOf('LIVE_SMALL', { overrideMaxNotionalUsd: -1 }), 100);
    eq(notionalCapOf('LIVE_SMALL', { overrideMaxNotionalUsd: NaN }), 100);
    eq(notionalCapOf('LIVE_SMALL', { equityUsd: NaN }), 100);
  });

  // ── 예약이 실제로 실행될 수 있는 모드인가 ──
  //
  // LIVE_SMALL은 정의상 건마다 사람이 확인한다. 크론에게는 확인해 줄
  // 사람이 없으므로, 예약에 걸어 두면 매일 409로 끝난다. 화면은 '켜짐'인데
  // 주문은 한 건도 안 나간다 — 이 저장소에서 제일 자주 나온 모양이다.
  test('제한 자동매매만 사람 없이 돌 수 있다', () => {
    eq(capability('LIVE_SMALL').autoTrade, false, 'LIVE_SMALL이 자동으로 돌면 확인의 의미가 없다');
    eq(capability('LIVE_LIMITED').autoTrade, true, '예약으로 돌 수 있는 실전 모드가 하나도 없다');
    eq(gateOrder('LIVE_LIMITED', 10, { equityUsd: 1000 }).needsConfirmation, false);
  });

  // ── 확인 요구는 명목가를 몰라도 답이 나온다 ──
  //
  // 이 판단이 `gateOrder` 안에만 있으면 **계획이 나온 뒤에만** 물어볼 수
  // 있다. 100배 경로에서 계획을 만드는 일은 거래소에 배율을 거는 일이라,
  // confirm 없이 온 실계좌 요청이 409로 막히기 전에 계좌 설정이 먼저
  // 바뀐다. 그래서 모드만 보는 함수로 빼 두고 쓰기 전에 부른다.
  //
  // **두 벌이 되면 안 된다.** 모든 모드에서 두 답이 같아야 한다.
  test('확인 요구 판정은 gateOrder와 한 벌이다 — 모든 모드에서', () => {
    for (const m of LADDER) {
      // 상한에 걸리지 않는 작은 명목가로 물어본다(상한 BLOCK은 다른 규칙이다).
      const g = gateOrder(m, 1, { equityUsd: 1_000_000 });
      if (g.disposition === 'SEND') {
        eq(modeNeedsConfirmation(m), g.needsConfirmation,
          `${m}: 쓰기 전 판정과 gateOrder의 확인 요구가 다르다 — 규칙이 두 벌이다`);
      }
    }
  });

  test('실제 자금인데 자동이 아닌 모드만 확인을 요구한다', () => {
    eq(modeNeedsConfirmation('LIVE_SMALL'), true, '실계좌 수동 모드가 확인을 안 받는다');
    eq(modeNeedsConfirmation('LIVE_LIMITED'), false);
    eq(modeNeedsConfirmation('TESTNET'), false, '테스트넷에 사람 확인을 요구하면 자동매매가 멈춘다');
    eq(modeNeedsConfirmation('UI_DEMO'), false);
    eq(modeNeedsConfirmation('SHADOW_LIVE'), false, '주문을 안 보내는 모드에 확인할 대상이 없다');
  });

  // 상한 BLOCK은 명목가가 필요하다 — 그래서 쓰기 앞으로 옮길 수 없다.
  // 그 사실 자체를 시험으로 박아 둔다. 나중에 누가 "상한도 앞으로 옮기자"고
  // 할 때, 그러려면 명목가가 필요하다는 것이 여기서 드러난다.
  test('1회 상한 판정은 명목가가 있어야 한다', () => {
    eq(gateOrder('LIVE_SMALL', 1, { equityUsd: 1_000_000 }).disposition, 'SEND');
    eq(gateOrder('LIVE_SMALL', 1e9, { equityUsd: 1_000_000 }).disposition, 'BLOCK');
  });

  // ── 승급 표본은 "증명된 체결"만 센다 ──
  //
  //   `/api/autotrade/mode`가 표본을 `['FILLED','RECONCILED']`로 셌다.
  //   `RECONCILED`는 최종 체결 결과를 **모르는** 상태다. 그걸 표본으로
  //   세면 체결된 적 없는 주문이 실전 승급의 근거가 된다. 집계 쪽을
  //   고쳤으므로 승급·강등 판정이 그 집계로 어떻게 움직이는지 못박는다.
  console.log('[운영 모드 — 승급 표본은 증명된 체결만]');

  /** 라우트와 같은 규칙으로 센다 (라우트는 isProvenFill을 쓴다) */
  const countSample = (rows: any[]) => {
    const kept = rows.filter(isProvenFill);
    return {
      completedTrades: kept.length,
      daysInMode: new Set(kept.map((r) => String(r.created_at).slice(0, 10))).size,
    };
  };

  test('RECONCILED 10건만으로는 섀도우로 올라가지 못한다', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      status: 'RECONCILED', filled_qty: 0.068,
      created_at: `2026-10-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    }));
    const ev = { ...CLEAN, ...countSample(rows) };
    eq(ev.completedTrades, 0, 'RECONCILED가 표본으로 셌다');
    eq(ev.daysInMode, 0);
    const r = canChangeMode('TESTNET', 'SHADOW_LIVE', ev);
    eq(r.allowed, false, '체결이 증명되지 않은 주문으로 승급됐다');
    assert(r.reasons.some((x) => x.includes('표본 부족')), r.reasons.join(' / '));
  });

  test('증명된 체결 10건·10일이면 섀도우로 올라간다', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      status: 'FILLED', filled_qty: 0.068,
      created_at: `2026-10-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    }));
    const ev = { ...CLEAN, ...countSample(rows) };
    eq(ev.completedTrades, 10);
    eq(ev.daysInMode, 10);
    eq(canChangeMode('TESTNET', 'SHADOW_LIVE', ev).allowed, true);
  });

  test('상태가 FILLED여도 수량 증거가 없으면 표본이 아니다', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      status: 'FILLED', filled_qty: null,
      created_at: `2026-10-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    }));
    const ev = { ...CLEAN, ...countSample(rows) };
    eq(ev.completedTrades, 0);
    eq(canChangeMode('TESTNET', 'SHADOW_LIVE', ev).allowed, false);
  });

  test('섞여 있으면 증명된 것만 센다 — 하루에 몰아넣어도 기간은 안 찬다', () => {
    const rows = [
      { status: 'FILLED', filled_qty: 1, created_at: '2026-10-01T01:00:00Z' },
      { status: 'FILLED', filled_qty: 1, created_at: '2026-10-01T02:00:00Z' },
      { status: 'RECONCILED', filled_qty: 1, created_at: '2026-10-02T00:00:00Z' },
      { status: 'ACKED', filled_qty: 1, created_at: '2026-10-03T00:00:00Z' },
      { status: 'FILLED', filled_qty: 0, created_at: '2026-10-04T00:00:00Z' },
    ];
    const ev = { ...CLEAN, ...countSample(rows) };
    eq(ev.completedTrades, 2);
    eq(ev.daysInMode, 1, '하루에 여러 건을 넣어 기간을 채울 수 있었다');
  });

  test('강등은 표본과 무관하게 항상 허용된다', () => {
    // 안전 밸브에 조건을 달면 정작 급할 때 못 내려간다.
    const empty = { ...CLEAN, completedTrades: 0, daysInMode: 0,
      unresolvedOrders: 99, criticalMismatches: 99, hasLiveKey: false, liveUnlocked: false };
    for (const [from, to] of [
      ['LIVE_LIMITED', 'LIVE_SMALL'], ['LIVE_SMALL', 'SHADOW_LIVE'],
      ['SHADOW_LIVE', 'TESTNET'], ['LIVE_LIMITED', 'TESTNET'],
    ] as [OperatingMode, OperatingMode][]) {
      eq(canChangeMode(from, to, empty).allowed, true, `${from} → ${to} 강등이 막혔다`);
    }
  });

  test('미확정 주문이 남아 있으면 표본이 충분해도 올라가지 못한다', () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      status: 'FILLED', filled_qty: 1,
      created_at: `2026-09-${String(i % 30 + 1).padStart(2, '0')}T00:00:00Z`,
    }));
    const ev = { ...CLEAN, ...countSample(rows), unresolvedOrders: 1 };
    const r = canChangeMode('TESTNET', 'SHADOW_LIVE', ev);
    eq(r.allowed, false);
    assert(r.reasons.some((x) => x.includes('미확정')), r.reasons.join(' / '));
  });
}
