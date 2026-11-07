// src/lib/exchanges/connectionIdentity.test.ts
//
// **⑤B-3A-3.1 — 테스트넷을 등록해도 실전 연결이 살아 있는가.**
//
// 여기서 지키는 핵심: 자리(identity)에 환경이 들어간다, 기존 연결을
// 덮지 않는다, 자동으로 합치거나 지우지 않는다, 키 값을 다루지 않는다.
import { test, assert, eq } from '../../test/harness';
import {
  CONNECTION_IDENTITY_COLUMNS, connectionConflictTarget,
  CONNECTION_IDENTITY_CONSTRAINT, LEGACY_IDENTITY_CONSTRAINT,
  envNicknameOf, resolveNickname, nicknameVerdict, envSwitchVerdict,
  sameIdentity, duplicateIdentityGroups,
} from './connectionIdentity';

const U = 'user-1';

export function runConnectionIdentityTests() {
  // ── 자리 ──

  test('★ 자리에 환경이 들어간다', () => {
    eq(CONNECTION_IDENTITY_COLUMNS.join(','), 'user_id,exchange_id,is_testnet');
    assert(CONNECTION_IDENTITY_COLUMNS.includes('is_testnet' as any),
      '★ is_testnet이 자리에서 빠졌다 — 테스트넷 등록이 실전을 덮는다');
  });

  test('★ conflict target을 손으로 적지 않는다 (자리에서 만든다)', () => {
    eq(connectionConflictTarget(), CONNECTION_IDENTITY_COLUMNS.join(','));
    eq(connectionConflictTarget(), 'user_id,exchange_id,is_testnet');
    assert(connectionConflictTarget() !== 'user_id,exchange_id',
      '★ 옛 conflict target으로 되돌아갔다');
  });

  test('새 제약과 옛 제약 이름이 다르다', () => {
    // String()으로 감싼다. 둘 다 리터럴 타입이라 TS가 "절대 같을 수 없다"고
    // 보지만, 누가 나중에 둘을 같게 만들면 잡아야 하는 런타임 검사다.
    assert(String(CONNECTION_IDENTITY_CONSTRAINT) !== String(LEGACY_IDENTITY_CONSTRAINT),
      '★ 새 제약과 옛 제약 이름이 같다 — 096이 자기가 만든 제약을 떨어뜨린다');
    assert(/env/.test(CONNECTION_IDENTITY_CONSTRAINT), '새 제약 이름에 환경이 안 보인다');
  });

  test('★ 같은 거래소의 실전과 테스트넷은 다른 자리다', () => {
    const live = { userId: U, exchangeId: 'binance', isTestnet: false };
    const test1 = { userId: U, exchangeId: 'binance', isTestnet: true };
    eq(sameIdentity(live, test1), false, '★ 실전과 테스트넷을 같은 자리로 본다');
    eq(sameIdentity(live, { ...live }), true);
  });

  // ── 환경별 이름 ──

  test('★ 두 환경의 기본 이름이 다르다', () => {
    const l = envNicknameOf('Binance', false);
    const t = envNicknameOf('Binance', true);
    assert(l !== t, '★ 실전과 테스트넷 기본 이름이 같다 — nickname unique가 부딪힌다');
    assert(/실전/.test(l), `실전 이름에 표시가 없다: ${l}`);
    assert(/테스트넷/.test(t), `테스트넷 이름에 표시가 없다: ${t}`);
    assert(envNicknameOf('Gate', false) !== envNicknameOf('Gate', true), '★ Gate도 같다');
  });

  test('사용자가 적은 이름은 보존한다', () => {
    eq(resolveNickname({ custom: '내 데모', exchangeNameKr: 'Binance', isTestnet: true }), '내 데모');
    eq(resolveNickname({ custom: '  ', exchangeNameKr: 'Binance', isTestnet: true }),
      envNicknameOf('Binance', true));
    eq(resolveNickname({ custom: null, exchangeNameKr: 'Binance', isTestnet: false }),
      envNicknameOf('Binance', false));
  });

  // ── 이름 충돌 ──

  test('★ 다른 환경이 쓰는 이름이면 덮지 않고 거부한다', () => {
    const v = nicknameVerdict({
      wanted: '내 바이낸스',
      existing: [{ nickname: '내 바이낸스', isTestnet: false }],
      isTestnet: true,
    });
    eq(v.code, 'NICKNAME_CONFLICT', '★ 실전 연결 이름을 테스트넷이 덮었다');
    eq(v.ok, false);
  });

  test('같은 환경의 같은 이름은 그 연결 갱신이므로 충돌이 아니다', () => {
    eq(nicknameVerdict({ wanted: '내 바이낸스',
      existing: [{ nickname: '내 바이낸스', isTestnet: true }], isTestnet: true }).code, 'OK');
  });

  test('이름이 비면 거부한다', () => {
    eq(nicknameVerdict({ wanted: '  ', existing: [], isTestnet: true }).code, 'NICKNAME_CONFLICT');
  });

  test('환경별 기본 이름끼리는 부딪히지 않는다', () => {
    const v = nicknameVerdict({
      wanted: envNicknameOf('Binance', true),
      existing: [{ nickname: envNicknameOf('Binance', false), isTestnet: false }],
      isTestnet: true,
    });
    eq(v.code, 'OK', '기본 이름이 서로 부딪힌다');
  });

  // ── 환경 전환 ──

  test('★ 전환하려는 쪽에 연결이 있으면 자동으로 합치지 않고 거부한다', () => {
    const v = envSwitchVerdict({
      target: { connectionId: 'live-1', isTestnet: false },
      siblings: [{ connectionId: 'live-1', isTestnet: false },
        { connectionId: 'test-1', isTestnet: true }],
      toTestnet: true,
    });
    eq(v.code, 'ENV_CONNECTION_EXISTS', '★ 자리가 겹치는데 통과시켰다');
    assert(/삭제한 뒤/.test(v.reason), `사람이 할 일을 말하지 않는다: ${v.reason}`);
  });

  test('★ 반대 방향도 같다', () => {
    eq(envSwitchVerdict({
      target: { connectionId: 'test-1', isTestnet: true },
      siblings: [{ connectionId: 'test-1', isTestnet: true },
        { connectionId: 'live-1', isTestnet: false }],
      toTestnet: false,
    }).code, 'ENV_CONNECTION_EXISTS');
  });

  test('반대편이 없으면 전환할 수 있다', () => {
    eq(envSwitchVerdict({
      target: { connectionId: 'live-1', isTestnet: false },
      siblings: [{ connectionId: 'live-1', isTestnet: false }],
      toTestnet: true,
    }).code, 'OK');
  });

  test('같은 환경으로 바꾸려면 바꿀 것이 없다', () => {
    eq(envSwitchVerdict({
      target: { connectionId: 'live-1', isTestnet: false },
      siblings: [], toTestnet: false,
    }).code, 'NO_CHANGE');
  });

  test('★ 자기 자신을 반대편으로 세지 않는다', () => {
    // siblings에 자기가 들어 있어도 그것 때문에 막히면 전환이 영구 불가가 된다
    eq(envSwitchVerdict({
      target: { connectionId: 'only', isTestnet: false },
      siblings: [{ connectionId: 'only', isTestnet: false }],
      toTestnet: true,
    }).code, 'OK');
  });

  // ── migration preflight와 같은 판정 ──

  test('현재 production 모양은 새 자리로 유일하다', () => {
    // Gate TESTNET 1 + Binance LIVE 2 (서로 다른 사용자) — 네가 읽어 준 모양
    const rows = [
      { userId: U, exchangeId: 'gate', isTestnet: true },
      { userId: U, exchangeId: 'binance', isTestnet: false },
      { userId: 'user-2', exchangeId: 'binance', isTestnet: false },
    ];
    eq(duplicateIdentityGroups(rows).length, 0);
  });

  test('★ 같은 자리가 둘이면 그 사실을 센다 (합치지 않는다)', () => {
    const d = duplicateIdentityGroups([
      { userId: U, exchangeId: 'binance', isTestnet: true },
      { userId: U, exchangeId: 'binance', isTestnet: true },
      { userId: U, exchangeId: 'binance', isTestnet: false },
    ]);
    eq(d.length, 1);
    eq(d[0].count, 2);
    eq(d[0].identity.isTestnet, true);
  });

  test('실전과 테스트넷이 각각 하나면 duplicate가 아니다', () => {
    eq(duplicateIdentityGroups([
      { userId: U, exchangeId: 'binance', isTestnet: false },
      { userId: U, exchangeId: 'binance', isTestnet: true },
    ]).length, 0, '★ 실전+테스트넷 동시 보유를 duplicate로 읽었다');
  });

  // ── 권한·시크릿 ──

  test('★ identity 정본에 키·시크릿을 다루는 수단이 없다', async () => {
    const src = await import('./connectionIdentity');
    for (const bad of ['encryptSecret', 'decryptSecret', 'apiKey', 'apiSecret',
                       'upsert', 'deleteConnection', 'setTestnet']) {
      eq(Object.keys(src).includes(bad), false, `★ ${bad}를 내보낸다`);
    }
  });

  test('★ 사유 문구에 키처럼 보이는 값이 없다', () => {
    const vs = [
      nicknameVerdict({ wanted: 'x', existing: [{ nickname: 'x', isTestnet: false }], isTestnet: true }),
      envSwitchVerdict({ target: { connectionId: 'a', isTestnet: false },
        siblings: [{ connectionId: 'b', isTestnet: true }], toTestnet: true }),
    ];
    for (const v of vs) {
      assert(!/[A-Za-z0-9]{32,}/.test(v.reason), `★ 사유에 값처럼 보이는 문자열이 있다: ${v.reason}`);
    }
  });
}
