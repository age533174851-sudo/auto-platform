// src/lib/exchanges/authError.test.ts
//
// **-2015가 났을 때 셋 중 무엇인지 알아낸다.**
//
// 실제로 있었던 일
// ────────────────
// 화면에 잔고 4,997.21 USDT가 떠 있는데 주문은 -2015로 막혔다. 앱은
// "원인은 셋 중 하나입니다"라고 셋을 나열했다. 그런데 그 화면 자체가
// 이미 답을 갖고 있었다 — 잔고가 보인다는 것은 같은 키·같은 서버로
// 읽기 요청이 성공했다는 뜻이다.
//
// 바이낸스 선물 키의 권한은 계층이다:
//   · /fapi/v2/balance — 읽기면 된다
//   · /fapi/v1/order   — 거래(TRADE)가 필요하다
//
// 환경이 틀렸거나 IP가 막혔다면 **읽기부터 막힌다.** 읽기가 되는데
// 주문만 막혔다면 남는 원인은 하나뿐이다.
//
// 이 테스트가 막는 것: 알 수 있는데도 "셋 중 하나"로 떠넘기는 것,
// 그리고 **모르는데 아는 척하는 것**(읽기도 막혔을 때 권한이라고 단정).

import { test, assert } from '../../test/harness';
import { explainFuturesAuthError, narrowFuturesAuthError } from './binance';

const AUTH_ERR = '[-2015] Invalid API-key, IP, or permissions for action';

const readOk = async () => ({ success: true });
const readFail = async () => ({ success: false, message: AUTH_ERR });
const readThrows = async () => { throw new Error('네트워크 없음'); };

export function runAuthErrorTests() {
  console.log('[인증 오류 — 알 수 있는 것은 알아낸다]');

  test('인증 오류가 아니면 원문을 그대로 둔다', async () => {
    const out = await narrowFuturesAuthError('[-1121] Invalid symbol', true, readOk);
    assert(out.includes('Invalid symbol'), out);
    assert(!out.includes('선물 거래 권한'), '엉뚱한 진단을 붙였다');
  });

  // ── **이 파일의 이유** ──────────────────────────────
  test('읽기가 되면 권한 문제로 단정한다', async () => {
    const out = await narrowFuturesAuthError(AUTH_ERR, true, readOk);
    assert(out.includes('선물 거래 권한이 꺼져 있습니다'), out);
    // '원인은 셋 중 하나입니다' 목록이 사라져야 한다. 설명문 안의
    // '그 셋 중 하나라도 틀렸다면'은 근거이지 떠넘기기가 아니다.
    assert(!out.includes('원인은 셋 중 하나입니다'), '알 수 있는데도 셋으로 떠넘겼다');
    assert(!/^\s*1\. /m.test(out), '번호 매긴 후보 목록이 남아 있다');
  });

  test('문단이 빈 줄로 나뉜다 — 한 덩어리로 뭉치지 않는다', async () => {
    const out = await narrowFuturesAuthError(AUTH_ERR, true, readOk);
    assert(out.includes('\n\n'), '빈 줄이 없어 화면에서 읽기 어렵다');
  });

  test('단정할 때는 왜 그렇게 아는지 적는다', async () => {
    const out = await narrowFuturesAuthError(AUTH_ERR, true, readOk);
    assert(out.includes('잔고 조회는 성공'), '근거를 안 적었다: ' + out);
  });

  test('고치는 방법까지 적는다', async () => {
    const out = await narrowFuturesAuthError(AUTH_ERR, true, readOk);
    assert(out.includes('Futures'), 'Futures 권한을 켜라는 말이 없다');
  });

  test('테스트넷이면 테스트넷 키 관리 주소를 알려준다', async () => {
    const t = await narrowFuturesAuthError(AUTH_ERR, true, readOk);
    const l = await narrowFuturesAuthError(AUTH_ERR, false, readOk);
    assert(t.includes('testnet.binancefuture.com'), t);
    assert(!l.includes('testnet.binancefuture.com'), '실전인데 테스트넷 주소를 안내했다');
  });

  // ── **모르는 것을 아는 척하지 않는다** ──────────────
  //
  // 읽기도 막혔으면 환경이나 IP다. 그때 권한이라고 단정하면 사용자는
  // 권한만 뒤지다가 진짜 원인을 못 찾는다.
  test('읽기도 막히면 권한이라고 단정하지 않는다', async () => {
    const out = await narrowFuturesAuthError(AUTH_ERR, true, readFail);
    assert(!out.includes('선물 거래 권한이 꺼져 있습니다'), '근거 없이 단정했다: ' + out);
  });

  test('읽기도 막히면 남은 후보를 좁혀 준다', async () => {
    const out = await narrowFuturesAuthError(AUTH_ERR, true, readFail);
    assert(out.includes('2번'), '무엇이 아닌지를 안 적었다: ' + out);
    assert(out.includes('원인은 셋 중 하나입니다'), '원래 목록이 사라졌다');
  });

  // 확인 자체가 실패하면 확인 못 한 것이다. 통과로도 실패로도 세지 않는다.
  test('확인 요청이 던져도 권한이라고 단정하지 않는다', async () => {
    const out = await narrowFuturesAuthError(AUTH_ERR, true, readThrows);
    assert(!out.includes('선물 거래 권한이 꺼져 있습니다'), '확인 못 했는데 단정했다');
    assert(out.includes('원인은 셋 중 하나입니다'), out);
  });

  // ── 기존 설명은 그대로 남는다 ───────────────────────
  test('셋을 나열하는 쪽은 여전히 셋을 적는다', () => {
    const out = explainFuturesAuthError(AUTH_ERR, true);
    assert(out.includes('1.') && out.includes('2.') && out.includes('3.'), out);
    assert(out.includes('demo-fapi.binance.com'), '어느 서버에 요청했는지 안 적었다');
  });

  test('실전이면 실전 서버를 적는다', () => {
    const out = explainFuturesAuthError(AUTH_ERR, false);
    assert(out.includes('fapi.binance.com (실전)'), out);
  });
}
