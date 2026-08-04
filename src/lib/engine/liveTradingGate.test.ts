// src/lib/engine/liveTradingGate.test.ts
//
// 이 테스트가 막는 것
// ───────────────────
// **미리보기 배포가 실계좌에 주문을 내는 것.**
//
// Vercel은 PR마다 미리보기 배포를 만든다. 환경변수는 Environment별로
// 범위를 정하는데, ALLOW_LIVE_TRADING을 Preview에도 켜 두면 그 미리보기
// 주소로 실주문이 나간다. 미리보기는 리뷰용이라 누구나 열어 보고,
// 워크플로가 그 주소를 가리키게 되는 사고도 흔하다.
//
// 이 저장소에는 VERCEL_ENV를 보는 코드가 **한 줄도 없었다.** 즉
// Production과 Preview를 구분한 적이 없다.

import { test, eq, assert } from '../../test/harness';
import { judgeLiveGate } from './liveTradingGate';

const P = 'production', V = 'preview', D = 'development';

export function runLiveTradingGateTests() {
  console.log('[실거래 관문 — 미리보기에서 진짜 돈이 나가면 안 된다]');

  test('Production에서 스위치가 켜져 있으면 열린다', () => {
    const g = judgeLiveGate({ ALLOW_LIVE_TRADING: 'true', VERCEL_ENV: P });
    eq(g.allowed, true, g.reason);
    eq(g.env, 'production');
  });

  // **이것이 이 파일의 이유다.**
  test('Preview는 스위치가 켜져 있어도 막는다', () => {
    const g = judgeLiveGate({ ALLOW_LIVE_TRADING: 'true', VERCEL_ENV: V });
    eq(g.allowed, false, '미리보기에서 실주문이 나간다');
    eq(g.unlocked, true, '스위치 상태 자체는 켜짐으로 보고해야 한다');
    assert(g.reason.includes('Preview'), g.reason);
    assert(g.reason.includes('체크를 해제'), '무엇을 해야 하는지 안 적었다: ' + g.reason);
  });

  // 미리보기에서 정말로 실주문을 내야 할 때가 있다(테스트넷 키로는
  // 재현이 안 되는 문제). 그때는 스위치를 하나 더 켜야 하고, 켜져
  // 있으면 그 사실이 응답에 그대로 실린다.
  test('미리보기 예외는 명시적으로만 열리고, 열리면 눈에 띈다', () => {
    const g = judgeLiveGate({
      ALLOW_LIVE_TRADING: 'true', VERCEL_ENV: V,
      ALLOW_LIVE_TRADING_ON_PREVIEW: 'true',
    });
    eq(g.allowed, true);
    eq(g.previewOverride, true);
    assert(g.reason.includes('⚠️'), '예외로 열렸는데 조용하다: ' + g.reason);
    assert(g.reason.includes('반드시 끄세요'), g.reason);
  });

  test('예외 스위치만 켜고 본 스위치가 꺼져 있으면 안 열린다', () => {
    const g = judgeLiveGate({ VERCEL_ENV: V, ALLOW_LIVE_TRADING_ON_PREVIEW: 'true' });
    eq(g.allowed, false);
  });

  test('개발 환경에서는 안 열린다', () => {
    const g = judgeLiveGate({ ALLOW_LIVE_TRADING: 'true', VERCEL_ENV: D });
    eq(g.allowed, false);
    assert(g.reason.includes('테스트넷'), g.reason);
  });

  // **모르는 환경을 유리하게 읽지 않는다.**
  // VERCEL_ENV가 없으면 로컬이거나 자체 호스팅이다. Production으로
  // 치면 그 실수는 실제 돈으로만 드러난다.
  test('환경을 모르면 막는다 — Production으로 치지 않는다', () => {
    const g = judgeLiveGate({ ALLOW_LIVE_TRADING: 'true' });
    eq(g.allowed, false);
    eq(g.env, 'unknown');
    assert(g.reason.includes('VERCEL_ENV'), '무엇이 없어서 막혔는지 안 적었다: ' + g.reason);
  });

  test('모르는 값이 들어와도 Production이 되지 않는다', () => {
    for (const v of ['prod', 'PRODUCTION ', 'live', '1', 'true']) {
      const g = judgeLiveGate({ ALLOW_LIVE_TRADING: 'true', VERCEL_ENV: v });
      if (v === 'PRODUCTION ') continue;   // 아래에서 따로 본다
      eq(g.allowed, false, `VERCEL_ENV='${v}'가 Production으로 읽혔다`);
    }
  });

  test('대소문자는 받아 준다 — 사람이 넣는 값이다', () => {
    eq(judgeLiveGate({ ALLOW_LIVE_TRADING: 'true', VERCEL_ENV: 'Production' }).allowed, true);
  });

  // 스위치가 꺼져 있으면 환경과 무관하게 막힌다.
  test('스위치가 꺼져 있으면 Production에서도 막힌다', () => {
    for (const env of [P, V, D, undefined]) {
      const g = judgeLiveGate({ VERCEL_ENV: env as any });
      eq(g.allowed, false, `env=${env}에서 열렸다`);
      eq(g.unlocked, false);
    }
  });

  // 'true' 문자열만 켜진 것으로 본다. '1'이나 'yes'를 켜짐으로 읽으면
  // 오타 하나가 실거래를 연다.
  test('true 문자열만 켜진 것으로 본다', () => {
    for (const v of ['1', 'yes', 'TRUE', 'True', '']) {
      eq(judgeLiveGate({ ALLOW_LIVE_TRADING: v, VERCEL_ENV: P }).allowed, false,
        `ALLOW_LIVE_TRADING='${v}'가 켜짐으로 읽혔다`);
    }
  });

  test('막힌 이유는 언제나 비어 있지 않다', () => {
    const cases = [
      {}, { ALLOW_LIVE_TRADING: 'true' },
      { ALLOW_LIVE_TRADING: 'true', VERCEL_ENV: V },
      { ALLOW_LIVE_TRADING: 'true', VERCEL_ENV: D },
    ];
    for (const c of cases) {
      const g = judgeLiveGate(c as any);
      assert(g.reason.length > 10, '이유가 비어 있다: ' + JSON.stringify(c));
    }
  });
}
