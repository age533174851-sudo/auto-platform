// src/lib/engine/reconcileLedgerStatus.test.ts
import { test, eq, assert } from '../../test/harness';
import { ledgerStatusOf } from './reconcileLedgerStatus';
import { fromExchangeStatus } from './orderLifecycle';
import { RECONCILE_TARGET_STATUSES } from './pendingReconcile';
import { UNRESOLVED_ENTRY_STATUSES, ACCEPTED_ENTRY_STATUSES } from './maxOpenPositionsGate';
import { HOLDING_EVIDENCE_STATUSES } from './holdingEvidence';

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
