// src/lib/auth/ownerBootstrap.test.ts
//
// 막으려는 것:
//  1. **저장소 소유자가 자기 계좌에서 잠기는 것.** 권한 표(039)를 만들고
//     기본값을 VIEW_ONLY로 뒀는데, 그 표에 값을 넣을 방법을 SQL 말고는
//     안 만들었다. 마이그레이션을 실행한 순간 소유자 본인이 막혔다
//  2. 그걸 고치려고 **권한 검사를 지우거나 모두를 관리자로 만드는 것**
//  3. 회원 등급(admin)이 거래 권한이 되는 것 — 그 규칙은 그대로다
//  4. 환경변수 하나가 사람이 명시적으로 준 권한을 **깎는 것**
//  5. 조회 실패에 부트스트랩이 얹혀, DB가 흔들릴 때마다 권한이 살아나는 것
import { test, assert, eq } from '../../test/harness';
import { ownerBootstrap, applyBootstrap } from './ownerBootstrap';
import { CAP_RANK, capabilityOf } from './tradingCapability';

const OWNER = '11111111-2222-3333-4444-555555555555';
const OTHER = '99999999-8888-7777-6666-555555555555';
const envOf = (m: Record<string, string>) => (k: string) => m[k];

export function runOwnerBootstrapTests() {
  console.log('[소유자 부트스트랩 — 자기 계좌에서 잠기지 않게]');

  test('지정된 소유자에게만 적용된다', () => {
    const env = envOf({ OWNER_USER_ID: OWNER });
    eq(ownerBootstrap(OWNER, env).applies, true);
    eq(ownerBootstrap(OTHER, env).applies, false);
  });

  test('설정이 없으면 아무에게도 적용되지 않는다', () => {
    const r = ownerBootstrap(OWNER, envOf({}));
    eq(r.applies, false);
    eq(r.configured, false);
    assert(r.reason.includes('OWNER_USER_ID'), r.reason);
  });

  test('부분 일치를 받지 않는다', () => {
    // 앞 몇 글자만 맞아도 통과하면 그건 권한 검사가 아니다.
    const env = envOf({ OWNER_USER_ID: OWNER });
    eq(ownerBootstrap(OWNER.slice(0, 8), env).applies, false);
    eq(ownerBootstrap(OWNER + 'x', env).applies, false);
  });

  test('여럿을 쉼표로 받는다 — 공백은 무시', () => {
    const env = envOf({ OWNER_USER_ID: ` ${OWNER} , ${OTHER} ` });
    eq(ownerBootstrap(OWNER, env).applies, true);
    eq(ownerBootstrap(OTHER, env).applies, true);
    eq(ownerBootstrap('다른사람', env).applies, false);
  });

  test('사용자를 모르면 적용하지 않는다', () => {
    const env = envOf({ OWNER_USER_ID: OWNER });
    eq(ownerBootstrap(null, env).applies, false);
    eq(ownerBootstrap('', env).applies, false);
    eq(ownerBootstrap(undefined, env).applies, false);
  });

  console.log('[소유자 부트스트랩 — 이메일도 받는다]');

  test('OWNER_EMAIL로 지정할 수 있다', () => {
    // 사람이 손으로 적는 값이고, 처음 손이 가는 것은 이메일이다.
    // id만 받으면 "이메일 넣었는데 왜 안 되지"가 된다.
    const env = envOf({ OWNER_EMAIL: 'me@example.com' });
    eq(ownerBootstrap({ userId: OWNER, email: 'me@example.com' }, env).applies, true);
    eq(ownerBootstrap({ userId: OWNER, email: 'other@example.com' }, env).applies, false);
  });

  test('이메일은 대소문자를 안 가린다', () => {
    // 대문자 하나로 잠긴 채 이유를 모르는 것이 지금 고치려는 문제다.
    const env = envOf({ OWNER_EMAIL: 'Me@Example.COM' });
    eq(ownerBootstrap({ userId: OWNER, email: 'me@example.com' }, env).applies, true);
    eq(ownerBootstrap({ userId: OWNER, email: '  ME@EXAMPLE.COM  ' }, env).applies, true);
  });

  test('id도 대소문자를 안 가린다 — 어디서 복사했든 통해야 한다', () => {
    // 여기서 엄격하게 굴어 얻는 것은 없고, 잃는 것은 "넣었는데 왜 안
    // 되지"로 잠긴 채 이유를 모르는 시간이다.
    const id = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const env = envOf({ OWNER_USER_ID: id.toUpperCase() });
    eq(ownerBootstrap({ userId: id }, env).applies, true);
  });

  test('id와 이메일을 같이 적어도 된다', () => {
    const env = envOf({ OWNER_USER_ID: OWNER, OWNER_EMAIL: 'me@example.com' });
    eq(ownerBootstrap({ userId: OWNER }, env).applies, true, 'id로 맞음');
    eq(ownerBootstrap({ userId: OTHER, email: 'me@example.com' }, env).applies, true, '이메일로 맞음');
    eq(ownerBootstrap({ userId: OTHER, email: 'x@y.com' }, env).applies, false);
  });

  test('이메일 자리에 id를, id 자리에 이메일을 적어도 섞이지 않는다', () => {
    // @가 있으면 이메일로 본다. UUID에는 @가 없으므로 갈리지 않는다.
    const env = envOf({ OWNER_USER_ID: 'me@example.com' });
    eq(ownerBootstrap({ userId: OWNER, email: 'me@example.com' }, env).applies, true);
  });

  test('예전처럼 문자열 하나만 넘겨도 된다', () => {
    const env = envOf({ OWNER_USER_ID: OWNER });
    eq(ownerBootstrap(OWNER, env).applies, true);
  });

  console.log('[소유자 부트스트랩 — 기본은 실전이 아니다]');

  test('지정이 없으면 TESTNET이다', () => {
    // 잠긴 것을 푸는 것이 목적이지 실전을 켜는 것이 아니다.
    const r = ownerBootstrap(OWNER, envOf({ OWNER_USER_ID: OWNER }));
    eq(r.capability, 'TESTNET');
    assert(r.reason.includes('기본값 TESTNET'), r.reason);
  });

  test('원하면 명시적으로 올릴 수 있다', () => {
    const r = ownerBootstrap(OWNER, envOf({ OWNER_USER_ID: OWNER, OWNER_CAPABILITY: 'LIVE_AUTO' }));
    eq(r.capability, 'LIVE_AUTO');
  });

  test('오타는 넓은 쪽으로 떨어지지 않는다', () => {
    // capabilityOf가 모르는 값을 기본값(VIEW_ONLY)으로 준다.
    const r = ownerBootstrap(OWNER, envOf({ OWNER_USER_ID: OWNER, OWNER_CAPABILITY: 'LIVE' }));
    eq(r.capability, 'VIEW_ONLY');
  });

  console.log('[소유자 부트스트랩 — 넓히기만 한다]');

  test('저장된 권한이 더 넓으면 깎지 않는다', () => {
    // 환경변수 하나가 사람이 명시적으로 준 권한을 깎으면, 그건
    // 부트스트랩이 아니라 덮어쓰기다.
    const boot = ownerBootstrap(OWNER, envOf({ OWNER_USER_ID: OWNER }));   // TESTNET
    const r = applyBootstrap('LIVE_AUTO', boot, CAP_RANK);
    eq(r.capability, 'LIVE_AUTO');
    eq(r.bootstrapped, false);
  });

  test('같은 등급이면 얹지 않는다', () => {
    const boot = ownerBootstrap(OWNER, envOf({ OWNER_USER_ID: OWNER }));
    eq(applyBootstrap('TESTNET', boot, CAP_RANK).bootstrapped, false);
  });

  test('좁으면 넓힌다', () => {
    const boot = ownerBootstrap(OWNER, envOf({ OWNER_USER_ID: OWNER }));
    const r = applyBootstrap('VIEW_ONLY', boot, CAP_RANK);
    eq(r.capability, 'TESTNET');
    eq(r.bootstrapped, true);
  });

  test('적용 안 되는 사람에게는 아무것도 안 바뀐다', () => {
    const boot = ownerBootstrap(OTHER, envOf({ OWNER_USER_ID: OWNER }));
    const r = applyBootstrap('VIEW_ONLY', boot, CAP_RANK);
    eq(r.capability, 'VIEW_ONLY');
    eq(r.bootstrapped, false);
  });

  console.log('[거래 권한 — ADMIN 등급과 별칭]');

  test('ADMIN이 가장 넓다', () => {
    assert(CAP_RANK.ADMIN > CAP_RANK.LIVE_AUTO);
    eq(capabilityOf('ADMIN'), 'ADMIN');
  });

  test('PAPER와 PAPER_ONLY는 같은 것이다', () => {
    // 하나만 받으면 다른 쪽을 적은 행이 조용히 VIEW_ONLY로 떨어지고,
    // 그 사람은 이유를 모른 채 막힌다.
    eq(capabilityOf('PAPER'), 'PAPER_ONLY');
    eq(capabilityOf('paper'), 'PAPER_ONLY');
    eq(capabilityOf('PAPER_TRADING'), 'PAPER_ONLY');
  });

  test('넓히는 별칭은 없다 — 오타가 권한이 되면 안 된다', () => {
    eq(capabilityOf('LIVE'), 'VIEW_ONLY');
    eq(capabilityOf('SUPER_ADMIN'), 'VIEW_ONLY');
    eq(capabilityOf('admin '), 'ADMIN', '공백과 소문자만 받아 준다');
  });

  console.log('[소유자 부트스트랩 — 조회 실패에는 얹지 않는다]');

  test('조회가 실패했으면 소유자여도 좁은 권한이다', async () => {
    // 진짜 모르는 상태다. 여기서 넓히면 DB가 흔들릴 때마다 권한이 살아난다.
    const { loadCapability } = await import('./loadCapability');
    const sb = { from: () => ({ select: () => ({ eq: () => ({
      maybeSingle: async () => ({ data: null, error: { code: '08006', message: 'connection failure' } }),
    }) }) }) };
    const prev = process.env.OWNER_USER_ID;
    process.env.OWNER_USER_ID = OWNER;
    try {
      const r = await loadCapability(sb, OWNER);
      eq(r.capability, 'VIEW_ONLY');
      eq(r.bootstrapped, undefined);
    } finally {
      if (prev == null) delete process.env.OWNER_USER_ID; else process.env.OWNER_USER_ID = prev;
    }
  });

  test('행이 없으면 부트스트랩이 얹힌다 — 이게 잠금을 푸는 자리다', async () => {
    const { loadCapability } = await import('./loadCapability');
    const sb = { from: () => ({ select: () => ({ eq: () => ({
      maybeSingle: async () => ({ data: null, error: null }),
    }) }) }) };
    const prev = process.env.OWNER_USER_ID;
    process.env.OWNER_USER_ID = OWNER;
    try {
      const r = await loadCapability(sb, OWNER);
      eq(r.capability, 'TESTNET');
      eq(r.bootstrapped, true);
      // 남에게는 그대로 좁다.
      eq((await loadCapability(sb, OTHER)).capability, 'VIEW_ONLY');
    } finally {
      if (prev == null) delete process.env.OWNER_USER_ID; else process.env.OWNER_USER_ID = prev;
    }
  });
}
