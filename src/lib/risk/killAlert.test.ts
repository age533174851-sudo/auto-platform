// src/lib/risk/killAlert.test.ts
//
// **알림 문구를 고정한다.**
//
// 이 문구들은 사람이 읽고 "정리됐구나" 하고 거래소를 안 보는 자리다.
// 그래서 여기서 가장 위험한 실패는 "안 됐다"가 아니라 **"됐다고 말하는 것"**이다.
//
// 실제로 네 가지가 동시에 거짓이었다:
//   · 실행자   — Worker가 아니라 이 요청이 실행한다
//   · 시점     — "실행 예정"이 아니라 실행한 뒤에 나가는 알림이다
//   · 조합     — 기본 `BC`는 포지션을 닫지 않는데 "Close All"이라 적었다
//   · 거래소   — Gate 연결인데 'Binance'로 하드코딩돼 있었다
//
// 그리고 잔여 알림은 `clean === false` 하나로 조회 실패(UNKNOWN)까지
// "남아있습니다"라고 단정했다.
import { test, assert, eq } from '../../test/harness';
import { killTriggerAlert, reconcileAlert, exchangeLabel, intendedActions } from './killAlert';

/** payload 전체를 한 줄로 — "어디에도 안 나온다"를 확인하는 데 쓴다 */
function flat(a: any): string {
  return JSON.stringify(a);
}

export function runKillAlertTests() {
  console.log('\n📣 킬스위치 알림 문구 (한 적 없는 일을 적지 않는다)');

  // ══ ① 조합: BC는 포지션을 닫지 않는다 ══
  test('BC 알림에 Close All이 나오지 않는다 — D가 없으면 포지션을 닫지 않는다', () => {
    const a = killTriggerAlert({
      actionMode: 'BC', exchange: 'binance', testnet: true,
      reason: '일일 한도 초과', equity: 1000, exec: { ran: true },
    });
    const s = flat(a);
    assert(!/Close All/i.test(s), `BC인데 Close All이 나왔다: ${s}`);
    assert(!s.includes('포지션 종료'), `BC는 포지션을 닫지 않는다: ${s}`);
    assert(s.includes('미체결 취소'), '취소는 실제로 한다');
    assert(s.includes('신규 주문 차단'), '차단은 언제나 한다');
  });

  test('ABCD처럼 D가 있으면 포지션 종료를 적는다 — 한 일을 안 적어도 거짓이다', () => {
    const a = killTriggerAlert({
      actionMode: 'ABCD', exchange: 'binance', testnet: false,
      reason: '월 한도 초과', equity: 500, exec: { ran: true },
    });
    assert(flat(a).includes('포지션 종료'), 'D가 있으면 종료가 의도에 있다');
  });

  test('intendedActions는 조합 그대로만 말한다', () => {
    eq(intendedActions('B'), '신규 주문 차단', 'B만');
    eq(intendedActions('BC'), '신규 주문 차단 · 미체결 취소', 'BC');
    eq(intendedActions('BCD'), '신규 주문 차단 · 미체결 취소 · 포지션 종료', 'BCD');
    eq(intendedActions(null), '신규 주문 차단', '조합을 모르면 확실한 것만');
  });

  // ══ ② 실행자·시점 ══
  test('직접 실행 경로 알림에 "Worker ... 실행 예정"이 나오지 않는다', () => {
    for (const mode of ['BC', 'ABCD']) {
      for (const ran of [true, false]) {
        const s = flat(killTriggerAlert({
          actionMode: mode, exchange: 'binance', testnet: true,
          reason: '한도 초과', equity: 100, exec: { ran, message: ran ? 'ok' : '키 없음' },
        }));
        assert(!s.includes('Worker'), `Worker가 실행한다고 적었다 (${mode}/${ran}): ${s}`);
        assert(!s.includes('실행 예정'), `이미 실행한 뒤인데 "실행 예정"이라 적었다 (${mode}/${ran})`);
      }
    }
  });

  test('실행하지 못했으면 실행했다고 적지 않는다', () => {
    const a = killTriggerAlert({
      actionMode: 'BCD', exchange: 'gate', testnet: false,
      reason: '한도 초과', equity: 10, exec: { ran: false, message: 'API 키를 읽지 못했습니다' },
    });
    eq(a.fields.Executed, '실행하지 못함', '실행 실패');
    assert(a.message.includes('실행하지 못했습니다'), '문구에도 실패가 드러나야 한다');
    assert(a.message.includes('거래소에서 직접 확인'), '사람이 볼 곳을 알려 준다');
    assert(String(a.fields.Error || '').includes('API 키'), '이유를 싣는다');
  });

  test('접수를 "완료"라고 적지 않는다 — 확인은 잔여 알림이 따로 한다', () => {
    const a = killTriggerAlert({
      actionMode: 'BCD', exchange: 'binance', testnet: true,
      reason: '한도 초과', equity: 10, exec: { ran: true },
    });
    const s = flat(a);
    assert(!s.includes('종료 완료'), `확인한 적 없는 완료를 주장했다: ${s}`);
    assert(!s.includes('청산 완료'), '같은 이유');
    assert(a.message.includes('확인 중'), '아직 확인 중이라고 적는다');
    eq(a.fields.Executed, '실행함 (결과 확인 중)', '실행까지만 말한다');
  });

  // ══ ③ 거래소 이름 ══
  test('Gate 연결이 Binance로 표시되지 않는다', () => {
    const a = killTriggerAlert({
      actionMode: 'BC', exchange: 'gate', testnet: false,
      reason: '한도 초과', equity: 1, exec: { ran: true },
    });
    eq(a.exchange, 'Gate.io', 'Gate 연결');
    assert(!flat(a).includes('Binance'), 'Gate인데 Binance가 나왔다');

    const r = reconcileAlert({
      leftover: { code: 'REMAINS', expectedClosed: true, reason: '남아 있습니다' } as any,
      exchange: 'gate', testnet: false, positions: 1, orders: 0,
    });
    eq(r!.exchange, 'Gate.io', '잔여 알림도 같은 거래소');
    assert(!flat(r).includes('Binance'), '잔여 알림에 Binance가 나왔다');
  });

  test('거래소를 모르면 지어내지 않는다', () => {
    eq(exchangeLabel(null), '알 수 없음', 'null');
    eq(exchangeLabel(''), '알 수 없음', '빈 문자열');
    eq(exchangeLabel('gate.io'), 'Gate.io', '표기 흔들림');
    eq(exchangeLabel('BINANCE'), 'Binance', '대문자');
  });

  // ══ ④ UNKNOWN과 REMAINS를 가른다 ══
  test('UNKNOWN reconcile이 "남아있습니다"로 표시되지 않는다', () => {
    const a = reconcileAlert({
      leftover: { code: 'UNKNOWN', expectedClosed: true, reason: '확인 실패' } as any,
      exchange: 'binance', testnet: true, positions: null, orders: null,
    });
    assert(a != null, 'UNKNOWN도 알림은 나가야 한다 — 조용히 넘어가면 아무도 안 본다');
    eq(a!.eventType, 'reconcile_unknown', '남은 것이 확인된 것과 다른 사건이다');
    assert(!a!.message.includes('남아있습니다'), `UNKNOWN을 REMAINS로 적었다: ${a!.message}`);
    assert(!a!.message.includes('확인됐습니다'), '확인한 적이 없다');
    assert(a!.message.includes('확인하지 못했습니다'), '못 읽었다고 적는다');
    assert(a!.message.includes('남은 것이 없다는 뜻이 아닙니다'), '통과로 읽히면 안 된다');
    // **못 읽은 것을 0으로 적지 않는다.**
    eq(a!.fields.Positions, '확인 못 함', '포지션');
    eq(a!.fields.Orders, '확인 못 함', '미체결');
  });

  test('판정 자체가 없어도 UNKNOWN으로 다룬다', () => {
    const a = reconcileAlert({ leftover: null, exchange: 'binance', testnet: true, positions: null, orders: null });
    eq(a!.eventType, 'reconcile_unknown', '없는 판정을 통과로 읽지 않는다');
  });

  test('REMAINS는 실제 잔여 경고가 나온다', () => {
    const a = reconcileAlert({
      leftover: { code: 'REMAINS', expectedClosed: true, reason: '포지션 2 · 미체결 3' } as any,
      exchange: 'binance', testnet: false, positions: 2, orders: 3,
    });
    assert(a != null, '남아 있으면 반드시 알린다');
    eq(a!.eventType, 'reconcile_fail', '잔여 확인');
    assert(a!.message.includes('잔여 포지션/주문이 확인됐습니다'), `잔여 경고 문구: ${a!.message}`);
    eq(a!.fields.Positions, 2, '실제 수치');
    eq(a!.fields.Orders, 3, '실제 수치');
    eq(a!.mode, 'LIVE', '실전');
  });

  test('CLEAR면 알림이 없다 — 아무 일 없는데 경고하지 않는다', () => {
    const a = reconcileAlert({
      leftover: { code: 'CLEAR', expectedClosed: false, reason: '미체결 0 확인' } as any,
      exchange: 'binance', testnet: true, positions: 0, orders: 0,
    });
    eq(a, null, '보낼 알림이 없다');
  });

  // ══ 그 밖에: 0으로 채우지 않는다 ══
  test('총자산을 못 읽으면 0 USDT라고 적지 않는다', () => {
    const a = killTriggerAlert({
      actionMode: 'BC', exchange: 'binance', testnet: true,
      reason: '한도 초과', equity: null, exec: { ran: true },
    });
    eq(a.fields.Equity, '확인 못 함', '0은 "전액 손실"로 읽힌다');
  });

  test('TESTNET과 LIVE를 섞지 않는다', () => {
    eq(killTriggerAlert({ actionMode: 'BC', exchange: 'binance', testnet: true,
      reason: 'x', equity: 1, exec: { ran: true } }).mode, 'TESTNET', '테스트넷');
    eq(killTriggerAlert({ actionMode: 'BC', exchange: 'binance', testnet: false,
      reason: 'x', equity: 1, exec: { ran: true } }).mode, 'LIVE', '실전');
  });
}
