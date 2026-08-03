// src/lib/http/errorText.test.ts
//
// 이 테스트가 막는 것
// ───────────────────
// **기계 코드가 그대로 화면에 뜨는 것.**
//
// 게이트아이오 연결로 USDⓈ-M 주문을 눌렀더니 토스트에 `not_binance`
// 한 단어가 떴다. 무엇이 잘못됐는지도, 무엇을 해야 하는지도 없다.
// 라우트를 세어 보니 사람 문장 없이 코드만 돌려주는 자리가 464곳이었다.
//
// 동시에 반대쪽도 막는다: **서버가 공들여 쓴 문장을 사전으로 덮는 것.**
// 라우트가 상황에 맞게 쓴 말이 일반 사전보다 정확하다.

import { test, eq, assert } from '../../test/harness';
import { humanError, errorTextOf, looksLikeCode } from './errorText';

export function runErrorTextTests() {
  console.log('[오류 문구 — 기계 코드를 사람에게 던지지 않는다]');

  // ── 코드 판정 ────────────────────────────────────────
  test('snake_case·SCREAMING은 코드다', () => {
    eq(looksLikeCode('not_binance'), true);
    eq(looksLikeCode('auth_required'), true);
    eq(looksLikeCode('RLS_DENIED'), true);
    eq(looksLikeCode('kill.switch:active'), true);
  });

  test('한글이나 띄어쓰기가 있으면 사람 말이다', () => {
    eq(looksLikeCode('연결을 찾을 수 없습니다'), false);
    eq(looksLikeCode('Order type not supported'), false);
    eq(looksLikeCode('실거래가 잠겨 있습니다'), false);
  });

  test('빈 값은 코드가 아니다', () => {
    eq(looksLikeCode(''), false);
    eq(looksLikeCode('   '), false);
  });

  // ── **이 파일의 이유** ───────────────────────────────
  test('아는 코드는 한국어 문장이 된다', () => {
    const t = humanError('not_binance');
    assert(/[가-힣]/.test(t), '한국어가 아니다: ' + t);
    assert(t !== 'not_binance', '코드가 그대로 나왔다');
  });

  test('문장은 무엇을 해야 하는지까지 적는다', () => {
    // "인증 필요"만 적으면 사용자는 이미 로그인했다고 생각하고 멈춘다.
    assert(humanError('auth_required').includes('로그인'), humanError('auth_required'));
    assert(humanError('connection_not_found').length > 10, '너무 짧다');
  });

  test('가장 흔한 코드 넷은 반드시 문장이 있다', () => {
    // 464곳 중 191곳이 이 넷이었다.
    for (const c of ['supabase_not_configured', 'auth_required', 'invalid_json', 'connection_not_found']) {
      const t = humanError(c);
      assert(/[가-힣]/.test(t) && !t.includes('코드:'), `${c}에 문장이 없다: ${t}`);
    }
  });

  // 사용자가 고칠 수 없는 것은 그렇다고 말한다. "다시 시도하세요"라고
  // 적으면 될 때까지 누르게 된다.
  test('서버 설정 문제는 사용자 탓으로 돌리지 않는다', () => {
    const t = humanError('supabase_not_configured');
    assert(t.includes('관리자') || t.includes('설정'), t);
  });

  // ── 서버 문장을 덮지 않는다 ─────────────────────────
  test('이미 사람 말이면 그대로 둔다', () => {
    const s = '이 연결은 gate입니다 — 바이낸스 연결로만 나갑니다';
    eq(humanError(s), s);
  });

  test('영어 문장도 그대로 둔다 — 거래소 원문이다', () => {
    const s = '[-4120] Order type not supported for this endpoint.';
    eq(humanError(s), s);
  });

  // ── 모르는 코드 ─────────────────────────────────────
  //
  // 원문을 지우면 사용자가 캡처를 보내와도 원인을 좁힐 수 없다.
  test('모르는 코드는 문장으로 감싸되 코드를 남긴다', () => {
    const t = humanError('some_new_code_2026');
    assert(/[가-힣]/.test(t), '문장이 아니다: ' + t);
    assert(t.includes('some_new_code_2026'), '원문을 지웠다: ' + t);
  });

  test('빈 값이면 기본 문장', () => {
    eq(humanError(null), '처리하지 못했습니다');
    eq(humanError(undefined), '처리하지 못했습니다');
    eq(humanError(''), '처리하지 못했습니다');
    eq(humanError('  '), '처리하지 못했습니다');
    eq(humanError(null, '주문 실패'), '주문 실패');
  });

  test('대소문자만 달라도 알아본다', () => {
    assert(/[가-힣]/.test(humanError('Unauthorized')), humanError('Unauthorized'));
  });

  // ── 응답 본문에서 한 줄 고르기 ──────────────────────
  //
  // message가 우선이다 — 라우트가 상황에 맞게 쓴 말이 사전보다 정확하다.
  test('message가 있으면 그것을 쓴다', () => {
    eq(errorTextOf({ error: 'not_binance', message: '이 연결은 gate입니다' }), '이 연결은 gate입니다');
  });

  test('message가 비어 있으면 error를 사람 말로 바꾼다', () => {
    const t = errorTextOf({ error: 'not_binance', message: '   ' });
    assert(/[가-힣]/.test(t) && t !== '   ', t);
  });

  test('둘 다 없으면 기본 문장', () => {
    eq(errorTextOf({}), '처리하지 못했습니다');
    eq(errorTextOf(null, '주문 실패'), '주문 실패');
  });

  // 숫자·객체가 들어와도 화면이 [object Object]를 띄우면 안 된다.
  test('이상한 값이 와도 문장이 나온다', () => {
    const t = errorTextOf({ error: { code: 1 } });
    assert(!t.includes('[object'), t);
    assert(t.length > 0);
  });

  // ── **다음 거래소가 늘어도 새지 않게** ─────────────────
  //
  // 친구들이 토스·하나증권·KB증권을 쓴다. 거래소가 늘면 라우트가 늘고,
  // 라우트가 늘면 새 코드가 생긴다. 사전에 없는 코드가 화면에 그대로
  // 뜨는 일을 구조로 막아야 한다.
  //
  // humanError는 모르는 코드도 문장으로 감싸므로 **사전에 없어도**
  // 사람 말이 나온다. 이 성질이 깨지면 여기서 걸린다.
  test('사전에 없는 코드도 절대 코드만으로 나오지 않는다', () => {
    for (const c of ['toss_not_linked', 'KB_SESSION_EXPIRED', 'hana.order.rejected',
                     'brand_new_code', 'X', 'a_b_c_d_e']) {
      const t = humanError(c);
      assert(/[가-힣]/.test(t), `${c}가 한국어 없이 나왔다: ${t}`);
      assert(t !== c, `${c}가 그대로 나왔다`);
    }
  });

  // 사전에 넣은 문장은 전부 한국어여야 한다. 영어를 섞어 두면
  // 사용자가 읽다가 멈춘다.
  test('사전의 모든 문장은 한국어다', () => {
    const codes = ['auth_required', 'supabase_not_configured', 'invalid_json',
                   'connection_not_found', 'missing_connectionId', 'not_binance',
                   'withdrawal_key_blocked', 'decrypt_failed', 'kill_switch_active',
                   'plan_rejected', 'table_missing', 'save_failed'];
    for (const c of codes) {
      const t = humanError(c);
      assert(/[가-힣]/.test(t), `${c}: ${t}`);
      assert(!t.includes('코드:'), `${c}가 사전에 없다 — 흔한 코드는 문장을 넣어야 한다`);
    }
  });
}
