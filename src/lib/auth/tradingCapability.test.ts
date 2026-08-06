// src/lib/auth/tradingCapability.test.ts
//
// 막으려는 것:
//  1. 친구에게 화면을 보여 주려고 계정을 열었는데 실전 자동매매까지
//     켜지는 것
//  2. 회원 등급(admin 등)이 거래 권한을 주는 것 — 관리자는 사용자를
//     관리하는 사람이지 돈을 걸 사람이 아니다
//  3. 설정 안 한 사람이 곧 전부 할 수 있는 사람이 되는 것
//  4. 실전 자동매매를 실전 수동과 같게 보는 것 — 사람이 누르는 것과
//     사람이 안 볼 때 도는 것은 위험이 다르다
import { test, assert, eq } from '../../test/harness';
import {
  capabilityOf, capAtLeast, canDo, intentOf, capabilityFromRole,
  DEFAULT_CAPABILITY, CAP_RANK,
} from './tradingCapability';

export function runTradingCapabilityTests() {
  console.log('[거래 권한 — 기본값은 가장 좁은 쪽]');

  test('설정 안 한 사람은 아무것도 못 한다', () => {
    // 넓은 쪽을 기본으로 두면 "아직 설정 안 한 사람"이 곧
    // "전부 할 수 있는 사람"이 된다.
    eq(DEFAULT_CAPABILITY, 'VIEW_ONLY');
    eq(capabilityOf(null), 'VIEW_ONLY');
    eq(capabilityOf(undefined), 'VIEW_ONLY');
    eq(capabilityOf(''), 'VIEW_ONLY');
  });

  test('모르는 값도 기본값이다 — 오타가 권한이 되지 않는다', () => {
    eq(capabilityOf('LIVE'), 'VIEW_ONLY');
    eq(capabilityOf('live_auto '), 'LIVE_AUTO', '공백과 소문자는 받아 준다');
    eq(capabilityOf('SUPER_TRADER'), 'VIEW_ONLY');
  });

  console.log('[거래 권한 — 등급은 권한을 주지 않는다]');

  test('어떤 등급도 거래 권한으로 바뀌지 않는다', () => {
    // 관리자는 사용자를 관리하는 사람이지 돈을 걸 사람이 아니다.
    for (const r of ['user', 'vip', 'lifetime', 'founder', 'admin', 'developer', 'super_admin']) {
      eq(capabilityFromRole(r), 'VIEW_ONLY', r);
    }
  });

  test('canDo는 등급을 아예 받지 않는다', () => {
    // 받으면 언젠가 "관리자는 통과"가 들어가고, 그러면 이 파일이
    // 있는 이유가 사라진다. 인자가 둘뿐이라는 것이 그 방어다.
    eq(canDo.length, 2);
  });

  console.log('[거래 권한 — 좁은 것이 넓은 것을 포함하지 않는다]');

  test('순서가 좁은 것부터 넓은 것이다', () => {
    assert(CAP_RANK.VIEW_ONLY < CAP_RANK.PAPER_ONLY);
    assert(CAP_RANK.PAPER_ONLY < CAP_RANK.TESTNET);
    assert(CAP_RANK.TESTNET < CAP_RANK.LIVE_MANUAL);
    assert(CAP_RANK.LIVE_MANUAL < CAP_RANK.LIVE_AUTO);
  });

  test('테스트넷 권한으로 실전 주문을 못 낸다', () => {
    const v = canDo('TESTNET', 'LIVE_ORDER');
    eq(v.allowed, false);
    assert(v.reason.includes('실전 수동'), v.reason);
  });

  test('실전 수동 권한으로 실전 자동매매를 못 켠다', () => {
    // 사람이 누르는 것과 사람이 안 볼 때 도는 것은 위험이 다르다.
    eq(canDo('LIVE_MANUAL', 'ENABLE_LIVE_AUTOTRADE').allowed, false);
    eq(canDo('LIVE_MANUAL', 'LIVE_ORDER').allowed, true);
  });

  test('모의만 있는 사람은 테스트넷도 못 간다', () => {
    eq(canDo('PAPER_ONLY', 'PAPER_ORDER').allowed, true);
    eq(canDo('PAPER_ONLY', 'TESTNET_ORDER').allowed, false);
  });

  test('보기 전용은 모의도 못 한다', () => {
    eq(canDo('VIEW_ONLY', 'VIEW').allowed, true);
    eq(canDo('VIEW_ONLY', 'PAPER_ORDER').allowed, false);
  });

  test('넓은 권한은 좁은 것을 포함한다', () => {
    for (const i of ['VIEW', 'PAPER_ORDER', 'TESTNET_ORDER', 'LIVE_ORDER',
                     'ENABLE_AUTOTRADE', 'ENABLE_LIVE_AUTOTRADE'] as const) {
      eq(canDo('LIVE_AUTO', i).allowed, true, i);
    }
  });

  test('capAtLeast도 같은 규칙이다', () => {
    eq(capAtLeast('TESTNET', 'PAPER_ONLY'), true);
    eq(capAtLeast('TESTNET', 'LIVE_MANUAL'), false);
    eq(capAtLeast(null, 'PAPER_ONLY'), false);
  });

  console.log('[거래 권한 — 주문이 어떤 동작인가]');

  test('모의는 모의다', () => {
    eq(intentOf({ paper: true }), 'PAPER_ORDER');
    eq(intentOf({ paper: true, testnet: false }), 'PAPER_ORDER', '모의가 먼저다');
  });

  test('is_testnet === false 일 때만 실전으로 본다', () => {
    // 저장소 공통 규칙. 모르는 값이 실제 돈 쪽으로 기울면 안 된다.
    eq(intentOf({ testnet: false }), 'LIVE_ORDER');
    eq(intentOf({ testnet: true }), 'TESTNET_ORDER');
    eq(intentOf({}), 'TESTNET_ORDER', '모르면 테스트넷 쪽');
    eq(intentOf({ testnet: undefined }), 'TESTNET_ORDER');
  });

  test('자동매매는 따로 본다', () => {
    eq(intentOf({ automated: true, testnet: true }), 'ENABLE_AUTOTRADE');
    eq(intentOf({ automated: true, testnet: false }), 'ENABLE_LIVE_AUTOTRADE');
    eq(intentOf({ automated: true }), 'ENABLE_AUTOTRADE', '모르면 테스트넷 쪽');
  });

  console.log('[거래 권한 — 친구 계정 시나리오]');

  test('친구에게 보기 권한만 주면 아무것도 못 한다', () => {
    const friend = 'VIEW_ONLY';
    for (const i of ['PAPER_ORDER', 'TESTNET_ORDER', 'LIVE_ORDER',
                     'ENABLE_AUTOTRADE', 'ENABLE_LIVE_AUTOTRADE'] as const) {
      eq(canDo(friend, i).allowed, false, i);
    }
    eq(canDo(friend, 'VIEW').allowed, true);
  });

  test('친구를 관리자로 올려도 거래 권한은 안 생긴다', () => {
    // 등급과 권한이 다른 축이라는 것이 이 테스트의 요지다.
    const capFromAdmin = capabilityFromRole('admin');
    eq(canDo(capFromAdmin, 'LIVE_ORDER').allowed, false);
    eq(canDo(capFromAdmin, 'ENABLE_LIVE_AUTOTRADE').allowed, false);
  });

  test('테스트넷 자동매매는 테스트넷 권한이면 된다', () => {
    // 실제 돈이 안 나가므로 실전 자동과 같은 문턱을 요구하지 않는다.
    eq(canDo('TESTNET', 'ENABLE_AUTOTRADE').allowed, true);
    eq(canDo('TESTNET', 'ENABLE_LIVE_AUTOTRADE').allowed, false);
  });

  test('사유에 지금 권한과 필요한 권한이 함께 적힌다', () => {
    const v = canDo('PAPER_ONLY', 'LIVE_ORDER');
    eq(v.capability, 'PAPER_ONLY');
    eq(v.required, 'LIVE_MANUAL');
    assert(v.reason.includes('모의만'), v.reason);
    assert(v.reason.includes('실전 수동'), v.reason);
  });

  console.log('[거래 권한 — 설치 안 된 정책과 조회 실패는 다르다]');

  test('표가 없으면 강제하지 않는다', async () => {
    // 마이그레이션 전에는 표가 없다. 그때 막으면 아무도 주문을 못 내고,
    // 푸는 유일한 방법이 SQL 실행이라 사용자가 자기 계좌에서 잠긴다.
    // 그건 안전이 아니라 고장이다.
    const { loadCapability } = await import('./loadCapability');
    const sb = { from: () => ({ select: () => ({ eq: () => ({
      maybeSingle: async () => ({ data: null, error: { code: '42P01', message: 'relation does not exist' } }),
    }) }) }) };
    const r = await loadCapability(sb, 'u1');
    eq(r.installed, false);
    eq(r.known, false);
    assert(r.reason.includes('039'), '무엇을 실행해야 하는지 적어야 한다');
  });

  test('표는 있는데 조회가 실패하면 설치된 것으로 본다 — 그래서 막힌다', async () => {
    // 이쪽은 진짜 모름이다. 설치 안 됨과 같게 다루면 권한 검사가
    // 통째로 열린다.
    const { loadCapability } = await import('./loadCapability');
    const sb = { from: () => ({ select: () => ({ eq: () => ({
      maybeSingle: async () => ({ data: null, error: { code: '08006', message: 'connection failure' } }),
    }) }) }) };
    const r = await loadCapability(sb, 'u1');
    eq(r.installed, true, '연결 오류를 설치 안 됨으로 읽으면 안 된다');
    eq(r.known, false);
    eq(r.capability, 'VIEW_ONLY');
  });

  test('행이 없는 것은 오류가 아니다 — 아직 권한을 안 준 것이다', async () => {
    const { loadCapability } = await import('./loadCapability');
    const sb = { from: () => ({ select: () => ({ eq: () => ({
      maybeSingle: async () => ({ data: null, error: null }),
    }) }) }) };
    const r = await loadCapability(sb, 'u1');
    eq(r.installed, true);
    eq(r.known, true, '읽는 데 성공했다');
    eq(r.capability, 'VIEW_ONLY');
  });

  test('저장된 권한을 읽는다', async () => {
    const { loadCapability } = await import('./loadCapability');
    const sb = { from: () => ({ select: () => ({ eq: () => ({
      maybeSingle: async () => ({ data: { capability: 'LIVE_MANUAL' }, error: null }),
    }) }) }) };
    const r = await loadCapability(sb, 'u1');
    eq(r.capability, 'LIVE_MANUAL');
    eq(r.known, true);
    eq(r.reason, '');
  });

  test('사용자를 모르면 가장 좁은 권한이다', async () => {
    const { loadCapability } = await import('./loadCapability');
    const r = await loadCapability(null, null);
    eq(r.capability, 'VIEW_ONLY');
    eq(r.installed, true, '설치 여부와는 다른 문제다 — 여기서 열면 안 된다');
  });
}
