// src/lib/engine/managedPosition.test.ts
//
// **줄이 있다고 포지션이 열려 있는 것이 아니다.**
//
// `live_orders`는 의도 장부다 — 보내기 전에 먼저 적고(INTENT), 응답을
// 못 받으면 UNKNOWN으로 남는다. 그 줄을 "열린 포지션"으로 읽으면
// 없는 포지션의 손절을 옮기게 된다.
//
// 그리고 거래소 선물은 net position이라, 같은 계좌·종목을 두 전략이
// 주장하면 그 포지션이 누구 것인지 증명할 수 없다.
import { test, assert, eq } from '../../test/harness';
import { managedCandidates, mayActOn, mutationKeyOf } from './managedPosition';

const T = '2026-08-27T09:00:00.000Z';

function row(o: any = {}) {
  return {
    id: o.id ?? 'ord-1',
    connection_id: 'conn-bn', exchange: 'binance',
    symbol: 'BTCUSDT', side: 'BUY',
    avg_price: 100, stop_loss: 90,
    status: 'FILLED', reduce_only: false,
    acked_at: T, created_at: '2026-08-27T08:00:00.000Z',
    signal_id: '[s:scalp]sig-1',
    sl_order_id: 'sl-1', tp_order_id: null,
    ...o,
  };
}

export function runManagedPositionTests() {
  console.log('\n🧾 전략 공통 열린 포지션 (줄이 있다고 열린 것이 아니다)');

  // ══ 세 전략이 다 올라온다 ══
  test('scalp · my-original-v1 포지션이 감시 후보에 오른다', () => {
    const { positions } = managedCandidates([
      row({ id: 'a', signal_id: '[s:scalp]s1' }),
      row({ id: 'b', connection_id: 'conn-gt', exchange: 'gate', symbol: 'ETHUSDT',
            signal_id: '[s:my-original-v1]s2' }),
    ]);
    eq(positions.length, 2, '둘 다 후보다');
    eq(positions[0].strategyId, 'scalp', 'scalp');
    eq(positions[1].strategyId, 'my-original-v1', '원본 v1');
    eq(positions[1].exchange, 'gate', '거래소도 줄에서 읽는다');
  });

  test('strategy_id 칼럼이 있으면 그걸 쓴다 — 문자열을 새로 파싱하지 않는다', () => {
    const { positions } = managedCandidates([row({ strategy_id: 'daily-ladder', signal_id: 'no-tag' })]);
    eq(positions[0].strategyId, 'daily-ladder', '칼럼 우선');
  });

  // ══ 줄이 있다고 열린 것이 아니다 ══
  test('UNKNOWN 주문은 후보가 아니다 — 진입도 미진입도 아니다', () => {
    const { positions, skipped } = managedCandidates([row({ status: 'UNKNOWN' })]);
    eq(positions.length, 0, '대조 전에는 손대지 않는다');
    assert(skipped.some(s => s.code === 'NOT_ENTERED'), '이유를 남긴다');
  });

  test('INTENT · SENT · REJECTED도 후보가 아니다', () => {
    for (const st of ['INTENT', 'SENT', 'REJECTED', 'FAILED']) {
      eq(managedCandidates([row({ status: st })]).positions.length, 0, st);
    }
  });

  test('청산 주문(reduce_only)은 진입이 아니다', () => {
    eq(managedCandidates([row({ reduce_only: true })]).positions.length, 0, '진입으로 세지 않는다');
  });

  // ══ 추측하지 않는다 ══
  test('연결이 없으면 추측하지 않는다', () => {
    const { positions, skipped } = managedCandidates([row({ connection_id: null })]);
    eq(positions.length, 0, '어느 계좌인지 모른다');
    assert(skipped.some(s => s.code === 'NO_CONNECTION'), '이유');
  });

  test('모르는 거래소를 바이낸스로 읽지 않는다', () => {
    const { positions, skipped } = managedCandidates([row({ exchange: 'okx' })]);
    eq(positions.length, 0, '지어내지 않는다');
    assert(skipped.some(s => s.code === 'NO_VENUE'), '이유');
  });

  test('손절이 없으면 R을 정의할 수 없어 후보가 아니다', () => {
    eq(managedCandidates([row({ stop_loss: null })]).positions.length, 0, '1R이 없다');
  });

  // ══ 시간청산의 기준시각 ══
  test('진입 시각은 acked_at이다 — created_at은 INTENT 시점이라 쓰지 않는다', () => {
    const { positions } = managedCandidates([row()]);
    eq(positions[0].openedAt, Date.parse(T), '체결 시각');
    assert(positions[0].openedAt !== Date.parse('2026-08-27T08:00:00.000Z'),
      'created_at을 쓰면 보유 시간이 한 시간 부풀어 시간청산이 앞당겨진다');
  });

  test('acked_at이 없으면 보유 시간을 세지 않는다 — created_at으로 대체하지 않는다', () => {
    const { positions, skipped } = managedCandidates([row({ acked_at: null })]);
    eq(positions.length, 0, '추측하지 않는다');
    assert(skipped.some(s => s.code === 'NO_ENTRY_TIME'), '이유');
  });

  // ══ 소유권 ══
  test('같은 계좌·종목을 두 전략이 주장하면 손대지 않는다 — net position이다', () => {
    const { positions } = managedCandidates([
      row({ id: 'a', signal_id: '[s:scalp]s1' }),
      row({ id: 'b', signal_id: '[s:my-original-v1]s2' }),
    ]);
    eq(positions.length, 2, '후보로는 둘 다 나온다');
    for (const p of positions) {
      eq(p.ownership.code, 'OWNERSHIP_AMBIGUOUS', '누구 것인지 증명할 수 없다');
      assert(!mayActOn(p), '**주문을 내지 않는다**');
    }
    assert(positions[0].ownership.claimants.length === 2, '누가 주장하는지 남긴다');
  });

  test('계좌가 다르면 같은 종목이어도 애매하지 않다', () => {
    const { positions } = managedCandidates([
      row({ id: 'a', connection_id: 'conn-bn', signal_id: '[s:scalp]s1' }),
      row({ id: 'b', connection_id: 'conn-gt', exchange: 'gate', signal_id: '[s:my-original-v1]s2' }),
    ]);
    for (const p of positions) eq(p.ownership.code, 'OWNED', '다른 계좌는 다른 포지션이다');
  });

  test('같은 전략의 줄이 둘이면 애매하지 않다', () => {
    const { positions } = managedCandidates([
      row({ id: 'a', signal_id: '[s:scalp]s1' }),
      row({ id: 'b', signal_id: '[s:scalp]s2' }),
    ]);
    for (const p of positions) eq(p.ownership.code, 'OWNED', '주인은 하나다');
  });

  test('전략 표식이 없으면 주인을 모른다 — 아무에게나 귀속시키지 않는다', () => {
    const { positions } = managedCandidates([row({ signal_id: 'plain', strategy_id: null })]);
    eq(positions[0].ownership.code, 'OWNER_UNKNOWN', '모른다');
    assert(!mayActOn(positions[0]), '손대지 않는다');
  });

  // ══ 중복 방지 열쇠 ══
  test('중복 방지 열쇠는 계좌까지 포함한다 — 종목만으로 만들지 않는다', () => {
    const a = mutationKeyOf({ connectionId: 'c1', symbol: 'BTCUSDT', side: 'LONG' });
    const b = mutationKeyOf({ connectionId: 'c2', symbol: 'BTCUSDT', side: 'LONG' });
    assert(a !== b, '다른 계좌의 같은 종목은 다른 포지션이다');
    eq(a, mutationKeyOf({ connectionId: 'c1', symbol: 'BTCUSDT', side: 'LONG' }), '같은 자리는 같은 열쇠');
  });

  test('보호주문 번호를 모으고 "null" 문자열을 거른다', () => {
    const { positions } = managedCandidates([row({ sl_order_id: 'sl-9', tp_order_id: 'null' })]);
    eq(positions[0].ownedProtectionIds.length, 1, '쓸 수 있는 것만');
    eq(positions[0].ownedProtectionIds[0], 'sl-9', '그 번호');
  });

  test('빈 목록·null을 던지지 않는다', () => {
    eq(managedCandidates(null).positions.length, 0, 'null');
    eq(managedCandidates([]).positions.length, 0, '빈 목록');
  });

  // ══════════ ★ 무손절 계약이 감시 후보에 오른다 (100X) ══════════
  //
  // 예전에는 손절가가 없다는 이유로 이 줄이 `NO_STOP`으로 빠졌다. 그래서
  // 고정 손절을 쓰지 않기로 한 포지션이 **감시되지 않았고**, 시간 청산까지
  // 닿지 못했다. 열려 있는데 아무도 안 보는 포지션이 되는 것이다.

  test('★ NO_FIXED_SL이라고 적힌 줄은 손절가가 없어도 후보에 오른다', () => {
    const { positions, skipped } = managedCandidates([
      row({ stop_loss: null, stop_policy: 'NO_FIXED_SL', sl_order_id: null }),
    ]);
    eq(positions.length, 1, '무손절 포지션이 후보에서 빠졌습니다');
    eq(positions[0].stopPolicy, 'NO_FIXED_SL');
    eq(positions[0].stopLoss, null, '없는 손절을 숫자로 채웠습니다');
    eq(skipped.find(s => s.code === 'NO_STOP'), undefined, 'NO_STOP으로 빠졌습니다');
  });

  test('★ 손절가가 없다는 사실만으로는 무손절 계약으로 보지 않는다', () => {
    // 손절을 걸다 실패한 주문도 이 모양이다. 둘은 다루는 법이 정반대라
    // **적혀 있을 때만** 무손절로 읽는다.
    const { positions, skipped } = managedCandidates([
      row({ stop_loss: null, stop_policy: null, sl_order_id: null }),
    ]);
    eq(positions.length, 0, '정책 없는 무손절 줄이 후보에 올랐습니다');
    assert(skipped.some(s => s.code === 'NO_STOP'), 'NO_STOP으로 빠지지 않았습니다');
  });

  test('FIXED_SL이라고 적혀 있으면 예전 규칙 그대로다', () => {
    eq(managedCandidates([row({ stop_policy: 'FIXED_SL' })]).positions.length, 1);
    eq(managedCandidates([row({ stop_loss: null, stop_policy: 'FIXED_SL' })]).positions.length, 0);
  });

  test('무손절 계약에 손절가가 같이 적혀 있으면 정책을 따르고 사실을 남긴다', () => {
    const { positions, skipped } = managedCandidates([
      row({ stop_loss: 90, stop_policy: 'NO_FIXED_SL' }),
    ]);
    eq(positions.length, 1);
    eq(positions[0].stopLoss, null, '정책보다 값을 믿었습니다');
    assert(skipped.some(s => s.code === 'POLICY_STOP_CONFLICT'), '모순을 기록하지 않았습니다');
  });

  test('정책 칸이 없던 예전 줄은 동작이 바뀌지 않는다', () => {
    // `078` 이전에 쓰인 줄에는 이 칸이 아예 없다.
    const r: any = row(); delete r.stop_policy;
    const { positions } = managedCandidates([r]);
    eq(positions.length, 1);
    eq(positions[0].stopPolicy, null);
    eq(positions[0].stopLoss, 90);
  });

  // ══════════ ★ 과거 주문이 새 포지션을 닫지 못한다 ══════════
  //
  // 무엇이 고장이었나
  // ─────────────────
  // 중복 제거가 **판단 뒤**에 있었고(`done`), 그 등록은 "조치가 있을 때"만
  // 일어났다. 그래서:
  //
  //   1시간 전 새 진입   → 아직 6시간 안 됨 → NONE → done에 안 들어감
  //   7시간 전 과거 주문 → 같은 계좌·종목·방향·전략 → 시간 초과 → **청산**
  //
  // 각 줄의 `acked_at`은 정확했다. 문제는 **어느 줄이 현재 포지션을
  // 대표하는가**였고, `acked_at`을 쓴다는 것만으로는 막히지 않았다.

  test('★ 같은 전략의 오래된 줄은 후보에서 빠진다 (조기 청산 방지)', () => {
    const NEW = '2026-08-27T11:00:00.000Z';   // 1시간 전
    const OLD = '2026-08-27T05:00:00.000Z';   // 7시간 전
    const { positions, skipped } = managedCandidates([
      row({ id: 'new', acked_at: NEW }),
      row({ id: 'old', acked_at: OLD }),
    ]);
    eq(positions.length, 1, '같은 자리를 두 줄이 대표했습니다');
    eq(positions[0].orderId, 'new', '★ 오래된 줄이 선택됐습니다 — 조기 청산이 납니다');
    assert(skipped.some(s => s.code === 'STALE_DUPLICATE'),
      '밀려난 줄이 기록되지 않았습니다');
  });

  test('★ 순서를 뒤집어 넣어도 최신이 선택된다 (정렬에 기대지 않는다)', () => {
    const NEW = '2026-08-27T11:00:00.000Z';
    const OLD = '2026-08-27T05:00:00.000Z';
    const a = managedCandidates([row({ id: 'old', acked_at: OLD }), row({ id: 'new', acked_at: NEW })]);
    eq(a.positions.length, 1);
    eq(a.positions[0].orderId, 'new', '★ 입력 순서가 결과를 바꿨습니다');
  });

  test('전략이 다르면 합치지 않는다 — 충돌로 드러내야 한다', () => {
    const { positions } = managedCandidates([
      row({ id: 'a', signal_id: '[s:scalp]s1', strategy_id: 'scalp' }),
      row({ id: 'b', signal_id: '[s:daily-ladder]s2', strategy_id: 'daily-ladder' }),
    ]);
    eq(positions.length, 2, '다른 전략의 주장이 합쳐졌습니다 — 충돌을 못 봅니다');
  });

  test('★ 무손절 계약에서도 과거 줄이 새 포지션을 닫지 못한다', () => {
    const NEW = '2026-08-27T11:00:00.000Z';
    const OLD = '2026-08-27T03:00:00.000Z';
    const { positions } = managedCandidates([
      row({ id: 'new', acked_at: NEW, stop_loss: null, stop_policy: 'NO_FIXED_SL', sl_order_id: null }),
      row({ id: 'old', acked_at: OLD, stop_loss: null, stop_policy: 'NO_FIXED_SL', sl_order_id: null }),
    ]);
    eq(positions.length, 1);
    eq(positions[0].orderId, 'new');
  });
}
