// src/lib/engine/riskObservationEligibility.test.ts
//
// **"실제 자격증명으로 HTTP를 보냈다"는 실측의 조건이 아니다.**
//
// `getSymbolPositionRiskEx`는 포지션이 0이어도 줄을 돌려준다 — 신규
// 진입 전 마진 모드를 알아야 해서 일부러 그렇게 만들었다. 그래서 그
// 응답만 보고 VERIFIED로 적으면 **없는 포지션의 청산가**가 실측 통계에
// 들어간다. 부호가 반대면 **다른 다리**를 적는다.
import { test, eq } from '../../test/harness';
import { verifiedTestnetObservationEligibility as elig } from './riskObservationEligibility';

const EXACT100X = { profileId: 'MAX_LEV_100X', presetId: 'EXACT_100X', contractVersion: 2 };

const base = (over: any = {}) => ({
  testnet: true, exchange: 'binance', side: 'LONG' as const,
  executionIdentity: EXACT100X, positionAmt: 0.2, ...over,
});

export function runRiskObservationEligibilityTests() {
  console.log('\n🎟  ⑤B-2 실측 표본 자격 (열린 포지션이어야 실측이다)');

  test('TESTNET · LONG 후보 · 양수 수량 → 자격 있음', () => {
    const v = elig(base());
    eq(v.code, 'ELIGIBLE');
    eq(v.eligible, true);
  });

  test('TESTNET · SHORT 후보 · 음수 수량 → 자격 있음', () => {
    const v = elig(base({ side: 'SHORT', positionAmt: -0.2 }));
    eq(v.code, 'ELIGIBLE');
    eq(v.eligible, true);
  });

  test('★ 수량 0은 열린 포지션이 아니다', () => {
    for (const q of [0, -0]) {
      const v = elig(base({ positionAmt: q }));
      eq(v.code, 'NO_POSITION',
        `★ 수량 ${q}인데 실측으로 적었다 — 없는 포지션의 청산가가 통계에 들어간다`);
      eq(v.eligible, false);
    }
  });

  test('★ LONG 후보인데 수량이 음수면 다른 다리다', () => {
    const v = elig(base({ side: 'LONG', positionAmt: -0.2 }));
    eq(v.code, 'SIDE_MISMATCH');
    eq(v.eligible, false);
  });

  test('★ SHORT 후보인데 수량이 양수면 다른 다리다', () => {
    const v = elig(base({ side: 'SHORT', positionAmt: 0.2 }));
    eq(v.code, 'SIDE_MISMATCH');
    eq(v.eligible, false);
  });

  test('★ LIVE는 VERIFIED_TESTNET이 아니다', () => {
    const v = elig(base({ testnet: false }));
    eq(v.code, 'NOT_TESTNET',
      '★ LIVE 관측이 TESTNET 실측 통계로 들어갔다');
    eq(v.eligible, false);
  });

  test('★ 망을 못 읽었으면 통과가 아니다', () => {
    for (const t of [null, undefined, 'true' as any, 1 as any]) {
      eq(elig(base({ testnet: t })).code, 'NOT_TESTNET', String(t));
    }
  });

  test('★ MOCK/다른 거래소는 자격이 없다', () => {
    eq(elig(base({ exchange: 'gate' })).code, 'VENUE_UNSUPPORTED');
    eq(elig(base({ exchange: null })).code, 'VENUE_UNSUPPORTED');
  });

  test('★ 실행 계약이 없거나 반쪽이면 자격이 없다', () => {
    eq(elig(base({ executionIdentity: null })).code, 'IDENTITY_MISMATCH');
    eq(elig(base({ executionIdentity: { profileId: 'MAX_LEV_100X' } as any })).code,
      'IDENTITY_MISMATCH', '★ 반쪽 계약을 통과시켰다');
  });

  test('★ 수량을 못 읽었으면 0으로 읽지 않는다', () => {
    for (const q of [null, undefined, NaN, Infinity, -Infinity, 'x', true]) {
      const v = elig(base({ positionAmt: q }));
      eq(v.code, 'POSITION_UNUSABLE', `수량 ${String(q)}`);
      eq(v.eligible, false);
    }
  });

  test('★ 방향을 못 읽었으면 추정하지 않는다', () => {
    eq(elig(base({ side: null })).code, 'POSITION_UNUSABLE');
    eq(elig(base({ side: 'BUY' as any })).code, 'POSITION_UNUSABLE');
  });

  test('★ 입력이 비어도 터지지 않는다', () => {
    for (const bad of [null, undefined, {} as any]) {
      eq(elig(bad).eligible, false);
    }
  });

  test('★ 이것은 종료 판정이 아니다 — 행동 칸이 없다', () => {
    const v = elig(base());
    for (const k of Object.keys(v)) {
      eq(/action|close|exit|order|send/i.test(k), false,
        `★ 자격 판정에 행동 칸이 있다 (${k})`);
    }
  });

  test('★ 자격 판정기는 거래소를 바꿀 수단이 없다', async () => {
    const src = await import('./riskObservationEligibility');
    for (const bad of ['sendClose', 'closePosition', 'sendSymbolClose',
                       'runExitAuthority', 'placeFuturesOrder']) {
      eq(Object.keys(src).includes(bad), false, `★ ${bad}를 내보낸다`);
    }
  });
}
