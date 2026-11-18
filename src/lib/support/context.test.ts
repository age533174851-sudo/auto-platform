// 허용 목록이 실제로 "목록에 없으면 안 나간다"로 동작하는지 본다.
import { test, assert, eq } from '../../test/harness';
import { pickContext, deviceFromWidth, CONTEXT_KEYS } from './context';

export function runSupportContextTests() {
  test('★★ 목록에 없는 칸은 실리지 않는다 — 새 칸이 조용히 새지 않는다', () => {
    const r = pickContext({ screen: 'auto', apiKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', cookies: 'x=1' });
    eq(r.context.screen, 'auto');
    eq((r.context as any).apiKey, undefined);
    eq((r.context as any).cookies, undefined);
    assert(r.dropped.includes('apiKey') && r.dropped.includes('cookies'), JSON.stringify(r.dropped));
  });

  test('★★ 버린 칸 이름만 남기고 값은 남기지 않는다', () => {
    const secret = 'vmPUZE6mv9SD5V5e14y7Ju91duEh8A08dM2SHuM0';
    const r = pickContext({ apiKey: secret });
    assert(!JSON.stringify(r).includes(secret), '버린 값이 결과에 남았습니다');
  });

  test('★★ 허용된 칸이라도 값에 비밀이 섞이면 버린다', () => {
    const r = pickContext({ errorCode: 'X-MBX-APIKEY:vmPUZE6mv9SD5V5e14y7Ju91duEh8A08dM2SHuM0' });
    eq(r.context.errorCode, undefined);
    assert(r.dropped.includes('errorCode'), JSON.stringify(r.dropped));
  });

  test('모양이 안 맞는 값은 그 칸만 버리고 나머지는 싣는다', () => {
    const r = pickContext({ viewport: '390 x 844', screen: 'paper' });
    eq(r.context.viewport, undefined);
    eq(r.context.screen, 'paper');
  });

  test('길이 상한을 넘으면 버린다', () => {
    eq(pickContext({ errorCode: 'A'.repeat(65) }).context.errorCode, undefined);
    eq(pickContext({ errorCode: 'A'.repeat(64) }).context.errorCode, 'A'.repeat(64));
  });

  test('글이 아닌 값은 버린다', () => {
    for (const v of [1, true, null, {}, []]) {
      eq(pickContext({ screen: v }).context.screen, undefined);
    }
  });

  test('입력이 객체가 아니면 빈 결과다 — 던지지 않는다', () => {
    for (const bad of [null, undefined, 'x', 7, []]) {
      const r = pickContext(bad);
      eq(Object.keys(r.context).length, 0);
      eq(r.dropped.length, 0);
    }
  });

  test('정상 묶음은 그대로 실린다', () => {
    const input = { screen: 'auto', device: 'mobile', viewport: '390x844', uiMode: 'easy',
      runEnv: 'PAPER', venue: 'binance', errorCode: 'ORDER_REJECTED',
      requestId: 'req_01abc', occurredAt: '2026-11-18T05:30:00.000Z',
      browser: 'Samsung Internet', appVersion: '1.4.2+build9' };
    const r = pickContext(input);
    eq(r.dropped.length, 0);
    for (const k of Object.keys(input)) assert((r.context as any)[k] != null, `${k}가 빠졌습니다`);
  });

  test('모든 허용 칸이 목록으로 노출된다', () => {
    assert(CONTEXT_KEYS.includes('runEnv') && CONTEXT_KEYS.includes('uiMode'), CONTEXT_KEYS.join(','));
  });

  // ── 기기와 모드는 다른 축이다 ──
  test('★★ 폭은 기기만 정한다 — Easy/Pro를 정하지 않는다', () => {
    eq(deviceFromWidth(390), 'mobile');
    eq(deviceFromWidth(767), 'mobile');
    eq(deviceFromWidth(768), 'tablet');
    eq(deviceFromWidth(1099), 'tablet');
    eq(deviceFromWidth(1100), 'pc');
    eq(deviceFromWidth(1920), 'pc');
    // uiMode는 폭에서 나오지 않는다 — 값이 들어와야만 실린다
    eq(pickContext({ device: 'pc' }).context.uiMode, undefined);
  });

  test('폭을 못 읽으면 null이다 — pc로 치지 않는다', () => {
    for (const bad of [null, undefined, 0, -1, 'x', NaN]) eq(deviceFromWidth(bad), null);
  });
}
