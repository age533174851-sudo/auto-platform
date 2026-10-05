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

  // ══════════════════════════════════════════════════════════
  // **완전한 identity ≠ Exact100X identity**
  // ══════════════════════════════════════════════════════════
  //
  //   `executionIdentityComplete`는 "세 칸이 찼는가"만 본다. 그걸로
  //   자격을 주면 다른 계약의 포지션이 Exact100X 실측 통계에 섞인다.

  test('★ 다른 완전한 계약은 Exact100X가 아니다', async () => {
    const { executionIdentityComplete } = await import('../execution/profile');
    for (const id of [
      { profileId: 'SCALP_HIGH_LEV', presetId: 'STABILIZE', contractVersion: 2 },
      { profileId: 'SWING_LOW_LEV', presetId: 'RESEARCH', contractVersion: 2 },
      { profileId: 'DAILY_HIGH_LEV', presetId: 'STABILIZE', contractVersion: 2 },
    ]) {
      // ★ 핵심 불변: 완전한데도 자격이 없어야 한다.
      eq(executionIdentityComplete(id as any), true,
        `전제: ${id.profileId}/${id.presetId}는 완전한 identity다`);
      eq(elig(base({ executionIdentity: id })).code, 'IDENTITY_MISMATCH',
        `★ ${id.profileId}/${id.presetId}가 Exact100X 실측으로 들어갔다`);
    }
  });

  test('★ 짝이 아닌 조합은 통과하지 못한다', () => {
    // SCALP_HIGH_LEV + EXACT_100X — 프리셋만 빌려 온 조합
    eq(elig(base({ executionIdentity: {
      profileId: 'SCALP_HIGH_LEV', presetId: 'EXACT_100X', contractVersion: 2,
    } })).code, 'IDENTITY_MISMATCH');
    // MAX_LEV_100X + 다른 프리셋
    eq(elig(base({ executionIdentity: {
      profileId: 'MAX_LEV_100X', presetId: 'STABILIZE', contractVersion: 2,
    } })).code, 'IDENTITY_MISMATCH');
  });

  test('★ 지원하지 않는 계약 버전은 통과하지 못한다', async () => {
    const { EXECUTION_CONTRACT_VERSION } = await import('../execution/profile');
    for (const v of [EXECUTION_CONTRACT_VERSION - 1, EXECUTION_CONTRACT_VERSION + 1,
                     0, -1, 1.5, '2.0', 'two', null]) {
      eq(elig(base({ executionIdentity: {
        profileId: 'MAX_LEV_100X', presetId: 'EXACT_100X', contractVersion: v as any,
      } })).code, 'IDENTITY_MISMATCH', `버전 ${String(v)}`);
    }
  });

  test('★ 세 칸이 임의 문자열이면 resolver가 막는다', () => {
    eq(elig(base({ executionIdentity: {
      profileId: 'NOPE', presetId: 'ALSO_NOPE', contractVersion: 2,
    } })).code, 'IDENTITY_MISMATCH');
  });

  test('★ 정상 Exact100X는 통과한다 (정본이 실제로 푸는가)', async () => {
    const { EXECUTION_CONTRACT_VERSION } = await import('../execution/profile');
    eq(elig(base({ executionIdentity: {
      profileId: 'MAX_LEV_100X', presetId: 'EXACT_100X',
      contractVersion: EXECUTION_CONTRACT_VERSION,
    } })).code, 'ELIGIBLE');
  });

  test('★ 자격 정본은 계약의 **모양**까지 본다 — 이름만으로 주지 않는다', async () => {
    const { exact100xIdentity } = await import('../execution/profile');
    const ok = exact100xIdentity('MAX_LEV_100X', 'EXACT_100X', 2);
    eq(ok.ok, true);
    eq(ok.code, 'EXACT_100X');
    // 다른 계약은 OTHER_CONTRACT, 못 푸는 것은 UNRESOLVED — 사유가 갈린다.
    eq(exact100xIdentity('SCALP_HIGH_LEV', 'STABILIZE', 2).code, 'OTHER_CONTRACT');
    eq(exact100xIdentity('NOPE', 'NOPE', 2).code, 'UNRESOLVED');
    eq(exact100xIdentity('MAX_LEV_100X', 'EXACT_100X', 99).code, 'UNRESOLVED');
    eq(exact100xIdentity(null, null, null).code, 'UNRESOLVED');
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
