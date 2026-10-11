// src/lib/engine/reconcileLedgerStatus.test.ts
import { test, eq, assert } from '../../test/harness';
import {
  ledgerStatusOf, ledgerStatusOfBinance, ledgerStatusOfGate, ledgerStatusOfGateSpot,
  withFillEvidence,
} from './reconcileLedgerStatus';
import { spotFillOf } from '../exchanges/binance';
import { fromExchangeStatus } from './orderLifecycle';
import { RECONCILE_TARGET_STATUSES } from './pendingReconcile';
import { UNRESOLVED_ENTRY_STATUSES, ACCEPTED_ENTRY_STATUSES } from './maxOpenPositionsGate';
import {
  HOLDING_EVIDENCE_STATUSES, PROVEN_FILL_STATUSES, isProvenFill,
} from './holdingEvidence';

export function runReconcileLedgerStatusTests() {
  // ── 이 파일이 막는 결함 ──
  //
  //   대조가 "알았다"고 한 것을 쓰는 쪽이 "끝났다"로 읽었다. 거래소가
  //   `NEW`(아직 열려 있음)를 돌려줘도 장부에는 `RECONCILED`가 적혔고,
  //   RECONCILED는 다시 조회되지 않으므로 그 주문은 영원히 추적에서
  //   빠졌다.

  test('★ 거래소에 아직 살아 있는 주문을 끝났다고 적지 않는다', () => {
    // 거래소 NEW → 판정 ACKED
    eq(fromExchangeStatus('NEW'), 'ACKED');
    const d = ledgerStatusOf('ACKED');
    eq(d.status, 'ACKED');
    eq(d.terminal, false);
    assert(d.status !== 'RECONCILED', 'NEW를 RECONCILED로 적으면 추적이 끊긴다');
  });

  test('★ 부분 체결은 종료가 아니다 — 남은 수량이 거래소에 열려 있다', () => {
    eq(fromExchangeStatus('PARTIALLY_FILLED'), 'PARTIAL');
    const d = ledgerStatusOf('PARTIAL');
    eq(d.terminal, false);
    // 장부 어휘에 PARTIAL이 없으므로 '접수됨'으로 둔다.
    eq(d.status, 'ACKED');
    assert(d.status !== 'FILLED', '부분 체결을 전량 체결로 적지 않는다');
    assert(d.status !== 'RECONCILED', '열려 있는 잔량을 종료로 적지 않는다');
  });

  test('★ 끝난 것만 종료로 적는다', () => {
    const same = (state: string, status: string) => {
      const d = ledgerStatusOf(state);
      eq(d.status, status, `${state} → ${d.status} (기대 ${status})`);
      eq(d.terminal, true, `${state}는 종료로 적어야 한다`);
    };
    same('FILLED', 'FILLED');
    same('FAILED', 'FAILED');
    same('REJECTED', 'REJECTED');
    // 취소·만료는 끝났지만 체결 여부를 단정하지 않는다.
    eq(fromExchangeStatus('CANCELED'), 'CANCELED');
    eq(fromExchangeStatus('EXPIRED'), 'CANCELED');
    same('CANCELED', 'RECONCILED');
    // 주문 미발견 + 유예 경과
    same('RECONCILED', 'RECONCILED');
  });

  test('★ 모르는 상태를 종료로 적지 않는다', () => {
    for (const s of ['', null, undefined, 'WHAT', 'SENT', 'UNKNOWN', 'PROTECTED', 'CLOSED']) {
      const d = ledgerStatusOf(s as any);
      eq(d.terminal, false);
      assert(d.status !== 'RECONCILED' && d.status !== 'FILLED',
        `모르는 상태(${String(s)})를 확정으로 적으면 안 된다`);
    }
  });

  test('★ 거래소가 돌려줄 수 있는 모든 상태가 분류된다', () => {
    // EXCHANGE_MAP이 넓어지면 이 시험이 분류를 강제한다.
    for (const raw of ['NEW', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'REJECTED',
                       'EXPIRED', 'EXPIRED_IN_MATCH']) {
      const mapped = fromExchangeStatus(raw);
      assert(mapped != null, `${raw}가 EXCHANGE_MAP에서 빠졌다`);
      const d = ledgerStatusOf(mapped!);
      assert(d.status !== 'UNKNOWN',
        `${raw} → ${mapped}가 분류되지 않아 UNKNOWN으로 떨어졌다`);
    }
  });

  test('★ 종료가 아닌 상태는 반드시 다시 조회되는 상태여야 한다', () => {
    // 여기가 이 결함의 핵심이다. terminal=false인데 대조 대상이 아니면
    // 그 주문은 영원히 방치된다.
    const targets = new Set<string>(RECONCILE_TARGET_STATUSES as readonly string[]);
    for (const s of ['ACKED', 'PARTIAL', 'WHAT', '', 'SENT']) {
      const d = ledgerStatusOf(s as any);
      if (d.terminal) continue;
      assert(targets.has(d.status),
        `${s} → ${d.status}는 종료가 아닌데 대조 대상이 아니다 — 방치된다`);
    }
  });

  test('★ 종료가 아닌 상태는 계좌 용량 관문이 세는 상태여야 한다', () => {
    // RECONCILED가 두 목록에 모두 없다는 사실이 이 결함을 위험하게
    // 만들었다 — 살아 있는 주문이 진입 잠금을 풀어 줬다.
    const counted = new Set<string>([
      ...(UNRESOLVED_ENTRY_STATUSES as readonly string[]),
      ...(ACCEPTED_ENTRY_STATUSES as readonly string[]),
    ]);
    for (const s of ['ACKED', 'PARTIAL']) {
      const d = ledgerStatusOf(s);
      assert(!d.terminal, `${s}는 종료가 아니다`);
      assert(counted.has(d.status),
        `${s} → ${d.status}는 용량 관문이 세지 않는다 — 중복 진입이 열린다`);
    }
    // 반대 방향 확인: RECONCILED는 관문이 세지 않는다. 그래서 종료가
    // 확정된 것에만 써야 한다.
    assert(!counted.has('RECONCILED'),
      'RECONCILED가 관문에 들어왔다면 이 시험의 전제를 다시 써야 한다');
  });
}

export function runHoldingEvidenceTests() {
  const set = new Set<string>(HOLDING_EVIDENCE_STATUSES as readonly string[]);

  test('★ 보유 판정은 거래소에 열려 있는 주문을 놓치지 않는다', () => {
    // 대조가 열린 주문을 ACKED로 남기도록 고쳤으므로, 보유 목록이
    // ACKED를 빼면 부분 체결된 포지션이 "아무도 안 들고 있다"가 된다.
    assert(set.has('ACKED'), 'ACKED가 빠지면 부분 체결 포지션이 사라진다');
    assert(set.has('FILLED'), 'FILLED가 빠지면 체결이 사라진다');
    assert(set.has('RECONCILED'), 'RECONCILED가 빠지면 종료 주문의 수량이 사라진다');
  });

  test('★ 닿았는지도 모르는 상태를 보유로 세지 않는다', () => {
    // 세면 영구히 진입이 막힌다. 그쪽은 용량 관문이 따로 막는다.
    for (const s of ['INTENT', 'SENT', 'UNKNOWN', 'REJECTED', 'FAILED']) {
      assert(!set.has(s), `${s}를 보유로 세면 안 된다`);
    }
  });

  test('★ 대조가 남기는 비종료 상태는 전부 보유 목록에 있다', () => {
    for (const st of ['ACKED', 'PARTIAL']) {
      const d = ledgerStatusOf(st);
      if (d.terminal) continue;
      assert(set.has(d.status),
        `${st} → ${d.status}가 보유 목록에 없다 — 열린 포지션이 보이지 않는다`);
    }
  });
}

export function runFoundOrderLedgerTests() {
  // ── 이 파일이 막는 결함 ──
  //
  //   멱등 중복 감지는 거래소에서 같은 키의 주문을 **찾은** 자리다.
  //   찾으면 무조건 `RECONCILED`(끝남)를 적었다. 열려 있는 주문도,
  //   부분 체결 중인 주문도 종료로 적혔다. 그리고 상태가 FILLED이면
  //   수량 증거가 없어도 FILLED를 적었다.

  test('★ 찾은 주문이 NEW면 열려 있다고 적는다', () => {
    const d = ledgerStatusOfBinance('NEW', 0);
    eq(d.status, 'ACKED');
    eq(d.terminal, false);
    eq(d.needsAttention, false);
  });

  test('★ 부분 체결은 수량을 보존하며 열린 상태로 남는다', () => {
    const d = ledgerStatusOfBinance('PARTIALLY_FILLED', 0.004);
    eq(d.status, 'ACKED');
    eq(d.terminal, false);
    assert(d.status !== 'RECONCILED' && d.status !== 'FILLED');
  });

  test('★ 체결 증거가 없는 FILLED를 FILLED로 적지 않는다', () => {
    for (const q of [null, undefined, 0]) {
      const d = ledgerStatusOfBinance('FILLED', q as any);
      eq(d.status, 'ACKED', `수량 ${String(q)}에서 ${d.status}가 적혔다`);
      eq(d.terminal, false);
      eq(d.needsAttention, true);   // 모순이므로 사람이 봐야 한다
      assert(d.attentionReason != null);
    }
    // 증거가 있으면 FILLED다.
    const ok = ledgerStatusOfBinance('FILLED', 0.068);
    eq(ok.status, 'FILLED');
    eq(ok.terminal, true);
    eq(ok.needsAttention, false);
  });

  test('★ 취소·만료·거절은 구분해서 적고 수량 판단을 상태로 덮지 않는다', () => {
    eq(ledgerStatusOfBinance('CANCELED', 0.004).status, 'RECONCILED');
    eq(ledgerStatusOfBinance('CANCELED', 0.004).terminal, true);
    eq(ledgerStatusOfBinance('EXPIRED', 0).status, 'RECONCILED');
    eq(ledgerStatusOfBinance('REJECTED', 0).status, 'REJECTED');
    eq(ledgerStatusOfBinance('REJECTED', 0).terminal, true);
  });

  test('★ 찾았는데 상태를 해석하지 못하면 UNKNOWN이 아니라 ACKED다', () => {
    // 찾았다는 사실 자체가 "거래소가 갖고 있다"는 증거다. UNKNOWN은
    // "닿았는지도 모른다"는 뜻이라 거짓이 된다.
    for (const bad of ['', null, undefined, 'WHAT_IS_THIS']) {
      const d = ledgerStatusOfBinance(bad as any, 0);
      eq(d.status, 'ACKED');
      eq(d.terminal, false);
      eq(d.needsAttention, true);
      assert(d.attentionReason != null && d.attentionReason.length > 0);
    }
  });

  test('★ Gate 어휘를 바이낸스 어휘로 넣지 않는다', () => {
    // Gate의 status는 open/finished뿐이다. 바이낸스 표에 넣으면 전부
    // 해석 불가가 되고, 그래서 예전 경로는 'NEW'를 지어냈다.
    eq(fromExchangeStatus('open'), null);
    eq(fromExchangeStatus('finished'), null);

    eq(ledgerStatusOfGate({ status: 'open' }).status, 'ACKED');
    eq(ledgerStatusOfGate({ status: 'open' }).terminal, false);

    const filled = ledgerStatusOfGate({ status: 'finished', finishAs: 'filled', filledQty: 3 });
    eq(filled.status, 'FILLED');
    eq(filled.terminal, true);

    // 체결로 끝났다는데 수량 증거가 없다 — 적지 않는다.
    const noEvidence = ledgerStatusOfGate({ status: 'finished', finishAs: 'filled', filledQty: 0 });
    eq(noEvidence.status, 'ACKED');
    eq(noEvidence.needsAttention, true);

    // ioc로 한 계약도 못 붙고 끝났다: 끝난 것은 사실, 체결 0도 사실.
    // FAILED로 적으면 재시도가 열려 중복 체결의 문이 된다.
    const ioc = ledgerStatusOfGate({ status: 'finished', finishAs: 'ioc', filledQty: 0 });
    eq(ioc.status, 'RECONCILED');
    eq(ioc.terminal, true);
    assert(ioc.status !== 'FAILED', 'FAILED는 재시도가 열리는 상태다');

    eq(ledgerStatusOfGate({ status: 'finished', finishAs: 'cancelled', filledQty: 2 }).status, 'RECONCILED');
    // finish_as를 못 읽어도 끝난 것은 끝난 것이다 — RECONCILED의 뜻 그대로.
    eq(ledgerStatusOfGate({ status: 'finished' }).status, 'RECONCILED');

    const weird = ledgerStatusOfGate({ status: 'whatever' });
    eq(weird.status, 'ACKED');
    eq(weird.needsAttention, true);
  });

  test('★ 대조 경로도 같은 증거 규칙을 쓴다', () => {
    // 대조 쓰기는 상태를 verdict에서, 수량을 거래소 응답에서 받아 둘을
    // 따로 적었다. 그래서 `status: 'FILLED'` + `filled_qty: null`이라는
    // 모순이 가능했다 — 체결 증거 없이 FILLED를 적는 것이다.
    const g = withFillEvidence(ledgerStatusOf('FILLED'), null);
    eq(g.status, 'ACKED');
    eq(g.terminal, false);
    eq(g.needsAttention, true);

    // 체결이 아닌 판정은 수량과 무관하게 그대로 둔다.
    for (const st of ['RECONCILED', 'FAILED', 'REJECTED']) {
      const d = withFillEvidence(ledgerStatusOf(st), null);
      eq(d.terminal, true, `${st}가 비종료로 바뀌었다`);
      eq(d.needsAttention, false);
    }
    // 주문 미발견 + 유예 경과는 수량이 없어도 RECONCILED다.
    eq(withFillEvidence(ledgerStatusOf('RECONCILED'), null).status, 'RECONCILED');
  });

  test('★ 비종료로 적힌 것은 전부 다시 조회되고 용량 관문이 센다', () => {
    const targets = new Set<string>(RECONCILE_TARGET_STATUSES as readonly string[]);
    const counted = new Set<string>([
      ...(UNRESOLVED_ENTRY_STATUSES as readonly string[]),
      ...(ACCEPTED_ENTRY_STATUSES as readonly string[]),
    ]);
    const all = [
      ledgerStatusOfBinance('NEW', 0),
      ledgerStatusOfBinance('PARTIALLY_FILLED', 1),
      ledgerStatusOfBinance('FILLED', null),
      ledgerStatusOfBinance('???', 0),
      ledgerStatusOfGate({ status: 'open' }),
      ledgerStatusOfGate({ status: 'finished', finishAs: 'filled', filledQty: null }),
      ledgerStatusOfGate({ status: 'nope' }),
    ];
    for (const d of all) {
      if (d.terminal) continue;
      assert(targets.has(d.status), `${d.status}는 종료가 아닌데 대조 대상이 아니다 — 방치된다`);
      assert(counted.has(d.status), `${d.status}는 용량 관문이 세지 않는다 — 중복 진입이 열린다`);
    }
  });
}

export function runProvenFillTests() {
  // ── 이 파일이 막는 결함 ──
  //
  //   모드 승급의 "완주한 거래 수"가 `['FILLED','RECONCILED']`를 셌다.
  //   `RECONCILED`는 최종 체결 결과를 **모르는** 상태다. 체결된 적 없는
  //   주문이 실전 승급의 근거가 됐다.

  test('★ 체결이 증명된 줄만 완주로 센다', () => {
    assert(isProvenFill({ status: 'FILLED', filled_qty: 0.068 }));
    assert(isProvenFill({ status: 'filled', filled_qty: '0.004' }), '대소문자·문자열도 같게 읽는다');
  });

  test('★ RECONCILED는 완주가 아니다', () => {
    // 최종 체결 결과를 모르는 상태다. 수량이 적혀 있어도 센다고 할 수 없다.
    assert(!isProvenFill({ status: 'RECONCILED', filled_qty: 0.068 }));
    assert(!(PROVEN_FILL_STATUSES as readonly string[]).includes('RECONCILED'));
  });

  test('★ 열려 있거나 닿았는지도 모르는 줄은 완주가 아니다', () => {
    for (const st of ['ACKED', 'SENT', 'INTENT', 'UNKNOWN', 'REJECTED', 'FAILED']) {
      assert(!isProvenFill({ status: st, filled_qty: 1 }), `${st}를 완주로 셌다`);
    }
  });

  test('★ 상태가 FILLED여도 수량 증거가 없으면 완주가 아니다', () => {
    // 증거 규칙이 없던 동안 status FILLED + filled_qty null이 함께 적힐
    // 수 있었다. 상태만 보면 그 줄이 성과가 된다.
    for (const q of [null, undefined, 0, '0', '', 'abc', -1]) {
      assert(!isProvenFill({ status: 'FILLED', filled_qty: q as any }),
        `수량 ${String(q)}를 체결 증거로 받았다`);
    }
  });

  test('★ 빈 줄을 완주로 세지 않는다', () => {
    for (const r of [null, undefined, {}, { status: '' }]) {
      assert(!isProvenFill(r as any));
    }
  });
}

export function runOtherVenueLedgerTests() {
  // ── 이 파일이 막는 결함 ──
  //
  //   COIN-M·현물 경로는 `success`면 **무조건** `status: 'FILLED'`를
  //   적었다. 지정가 대기 주문도 체결로 장부에 남았고, 미체결 주문의
  //   `avgPrice`가 `'0'`이라 **지정가가 체결가로** 적혔다. Gate 현물은
  //   장부에 FILLED를 적으면서 응답에는 REJECTED를 돌려줬다.

  test('★ Gate 현물 어휘는 Gate 선물과 다르다', () => {
    // open/closed/cancelled. finish_as가 없다.
    eq(ledgerStatusOfGateSpot({ status: 'open' }).status, 'ACKED');
    eq(ledgerStatusOfGateSpot({ status: 'open' }).terminal, false);
    eq(ledgerStatusOfGateSpot({ status: 'closed', filledQty: 0.5 }).status, 'FILLED');
    eq(ledgerStatusOfGateSpot({ status: 'closed', filledQty: 0.5 }).terminal, true);
    // 끝났는데 체결이 없다 — 체결로도 거부로도 적지 않는다.
    eq(ledgerStatusOfGateSpot({ status: 'closed', filledQty: 0 }).status, 'RECONCILED');
    eq(ledgerStatusOfGateSpot({ status: 'cancelled', filledQty: 0.2 }).status, 'RECONCILED');
  });

  test('★ IOC가 한 개도 안 붙었으면 거부가 아니라 "끝났고 체결 0"이다', () => {
    const d = ledgerStatusOfGateSpot({ status: 'closed', filledQty: 0, unfilled: true });
    eq(d.status, 'RECONCILED');
    eq(d.terminal, true);
    // REJECTED는 거래소가 거부했다는 뜻이다. 거부한 적이 없다.
    assert(d.status !== 'REJECTED' && d.status !== 'FILLED');
  });

  test('★ Gate 현물 상태를 해석하지 못하면 열린 것으로 두고 사람에게 올린다', () => {
    for (const st of ['', null, undefined, 'whatever']) {
      const d = ledgerStatusOfGateSpot({ status: st as any });
      eq(d.status, 'ACKED');
      eq(d.terminal, false);
      eq(d.needsAttention, true);
    }
  });

  test('★ 현물 응답에서 체결가를 지정가로 메우지 않는다', () => {
    // 지정가 대기 주문: fills가 비어 있고 d.price는 **지정가**다.
    const resting = spotFillOf({
      status: 'NEW', executedQty: '0', origQty: '0.01', price: '95000', fills: [],
    });
    eq(resting.qty, 0);
    eq(resting.price, null, '지정가가 체결가로 적혔다');
    eq(resting.exchangeStatus, 'NEW');
    // 그 응답으로 장부 상태를 정하면 접수(ACKED)다.
    eq(ledgerStatusOfBinance(resting.exchangeStatus, resting.qty).status, 'ACKED');
  });

  test('★ 현물 체결가는 가중평균이다 — 첫 조각 가격이 아니다', () => {
    const f = spotFillOf({
      status: 'FILLED', executedQty: '3',
      fills: [{ qty: '1', price: '100' }, { qty: '2', price: '130' }],
    });
    eq(f.qty, 3);
    eq(f.price, 120);   // (1·100 + 2·130) / 3 — 첫 조각이면 100이 된다
    eq(ledgerStatusOfBinance(f.exchangeStatus, f.qty).status, 'FILLED');
  });

  test('★ fills가 없으면 누적 체결금액으로 되돌리고, 그것도 없으면 모른다', () => {
    const byQuote = spotFillOf({ status: 'FILLED', executedQty: '2', cummulativeQuoteQty: '250' });
    eq(byQuote.price, 125);
    const nothing = spotFillOf({ status: 'FILLED', executedQty: '2' });
    eq(nothing.price, null);
    // 상태는 FILLED인데 가격을 모른다 — 수량 증거는 있으므로 FILLED다.
    eq(ledgerStatusOfBinance(nothing.exchangeStatus, nothing.qty).status, 'FILLED');
  });

  test('★ 요청 수량을 체결 수량으로 올리지 않는다', () => {
    // executedQty가 **없는** 응답. 예전에는 origQty가 그 자리에 들어갔다.
    const f = spotFillOf({ status: 'NEW', origQty: '0.01', price: '95000' });
    eq(f.qty, null, '요청 수량이 체결 수량으로 적혔다');
    const d = ledgerStatusOfBinance(f.exchangeStatus, f.qty);
    eq(d.status, 'ACKED');
    assert(!isProvenFill({ status: d.status, filled_qty: f.qty }));
  });

  test('★ 읽을 수 없는 값을 0으로 적지 않는다', () => {
    const f = spotFillOf({ status: 'NEW', executedQty: 'abc', fills: [{ qty: 'x', price: 'y' }] });
    eq(f.qty, null);
    eq(f.price, null);
  });
}
