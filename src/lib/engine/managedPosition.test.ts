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

  test('운영 live_orders처럼 strategy_id 칸이 없어도 signal_id에서 소유권을 읽는다', () => {
    const r: any = row({ signal_id: '[s:scalp]prod-shape' });
    delete r.strategy_id;
    const { positions } = managedCandidates([r]);
    eq(positions.length, 1, '후보를 잃지 않는다');
    eq(positions[0].strategyId, 'scalp', 'signal_id 표식 fallback');
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

  // ══════════════════════════════════════════════════════════
  // 고정 손절을 쓰지 않는 주문 — 인식은 하되 관리하지 않는다
  // ══════════════════════════════════════════════════════════
  //
  // 지금까지 이 주문들이 일반 생명주기에 안 들어간 것은 정책 때문이
  // 아니라 **우연**이었다 — 손절 값이 없어서 걸러졌을 뿐이다. 참고용
  // 값이 한 번 채워지면 그 우연은 끝난다. 아래 시험이 그 우연을 계약으로
  // 못박는다.
  console.log('\n🚫 고정 손절 없는 주문 — recognized != managed');

  /** deferred 목록에서 코드 하나 찾기 */
  const defOf = (r: any, code: string) => r.deferred.find((d: any) => d.code === code);

  // A
  test('FIXED_SL + 손절 값 → 평소처럼 관리한다', () => {
    const r = managedCandidates([row({ stop_policy: 'FIXED_SL', stop_loss: 90 })]);
    eq(r.positions.length, 1, '★ 고정 손절 주문이 관리에서 빠졌습니다');
    eq(r.positions[0].management.code, 'MANAGED');
    eq(mayActOn(r.positions[0]), true);
    eq(r.deferred.length, 0);
  });

  // B
  test('★ FIXED_SL + 손절 없음 → 관리하지 않고 유예로 적는다', () => {
    const r = managedCandidates([row({ stop_policy: 'FIXED_SL', stop_loss: null })]);
    eq(r.positions.length, 0, '★ 1R을 정의할 수 없는데 관리에 들어갔습니다');
    assert(!!defOf(r, 'FIXED_SL_MISSING_STOP'), '★ 고칠 것이 있는 상태가 조용히 사라졌습니다');
  });

  // C — 이 PR의 SSOT 코드
  test('★ NO_FIXED_SL + 손절 없음 → NO_FIXED_SL_EXIT_UNWIRED', () => {
    const r = managedCandidates([row({ stop_policy: 'NO_FIXED_SL', stop_loss: null })]);
    eq(r.positions.length, 0, '★ 고정 손절 없는 주문이 일반 생명주기에 들어갔습니다');
    const d = defOf(r, 'NO_FIXED_SL_EXIT_UNWIRED');
    assert(!!d, '★ 인식했다는 기록이 없습니다 — 그냥 사라진 줄이 됩니다');
    // **NO_STOP으로 뭉개지 않는다.** 둘은 다른 상태다.
    eq(r.skipped.find((x: any) => x.code === 'NO_STOP'), undefined,
      '★ 정책상 유예를 "손절 없음"으로 적었습니다');
  });

  // D — ★ 우연이 끝나는 자리
  test('★ NO_FIXED_SL + 손절 값이 있어도 관리하지 않는다 (우연 의존 제거)', () => {
    const r = managedCandidates([row({ stop_policy: 'NO_FIXED_SL', stop_loss: 90 })]);
    eq(r.positions.length, 0,
      '★ 참고용 손절 값이 채워지자 일반 생명주기가 이 포지션을 가져갔습니다');
    assert(!!defOf(r, 'NO_FIXED_SL_STOP_CONFLICT'), '계약과 장부가 어긋난 사실을 적어야 합니다');
  });

  // E · G
  test('stop_policy가 없는 옛 줄 + 손절 값 → 기존대로 관리한다', () => {
    const r = managedCandidates([row({ stop_loss: 90 })]);   // stop_policy 없음
    eq(r.positions.length, 1, '★ 정책이 안 적힌 legacy 줄을 통째로 막았습니다');
    eq(r.positions[0].management.code, 'MANAGED');
  });

  test('빈 문자열 정책도 "안 적힘"으로 본다', () => {
    const r = managedCandidates([row({ stop_policy: '', stop_loss: 90 })]);
    eq(r.positions.length, 1, '★ 빈 값을 모르는 정책으로 읽어 legacy 줄을 막았습니다');
  });

  // F
  test('정책 없음 + 손절 없음 → 기존 NO_STOP 의미 그대로', () => {
    const r = managedCandidates([row({ stop_loss: null })]);
    eq(r.positions.length, 0);
    assert(!!r.skipped.find((x: any) => x.code === 'NO_STOP'), 'NO_STOP은 그대로 남는다');
    eq(r.deferred.length, 0, '옛 줄을 새 유예 계층으로 옮기지 않는다');
  });

  // 7번 — 모르는 정책
  test('★ 모르는 정책 이름을 고정 손절로 읽지 않는다', () => {
    const r = managedCandidates([row({ stop_policy: 'SOMETHING_NEW', stop_loss: 90 })]);
    eq(r.positions.length, 0, '★ 모르는 정책을 추측해서 관리했습니다');
    assert(!!defOf(r, 'STOP_POLICY_UNKNOWN'), '모른다는 사실을 적어야 합니다');
  });

  // H
  test('★ 유예된 줄도 어느 계좌·종목·전략인지 남는다', () => {
    const r = managedCandidates([row({
      stop_policy: 'NO_FIXED_SL', stop_loss: null, id: 'ord-77',
      symbol: 'ETHUSDT', side: 'SELL', signal_id: '[s:scalp]sig-9',
    })]);
    const d = defOf(r, 'NO_FIXED_SL_EXIT_UNWIRED');
    eq(d.connectionId, 'conn-bn');
    eq(d.symbol, 'ETHUSDT');
    eq(d.side, 'SHORT');
    eq(d.strategyId, 'scalp', '★ 어느 전략의 노출인지 알 수 없으면 추적이 끊깁니다');
    eq(d.orderId, 'ord-77');
    assert(d.reason.length > 10, '사람이 읽을 사유가 있어야 합니다');
  });

  // ── ★★ net position 자리(seat) — 이 PR의 핵심 ──
  //
  //   거래소가 주는 것은 합쳐진 포지션 하나뿐이다. 고정 손절 없는 줄을
  //   목록에서 빼는 것만으로는, 같은 자리의 다른 줄이 그 노출까지 대신
  //   건드리는 것을 막지 못한다.

  // I — 다른 전략이 섞인 자리
  test('★ 같은 계좌·종목에 다른 전략의 FIXED_SL이 있어도 그 줄을 관리하지 않는다', () => {
    const r = managedCandidates([
      row({ id: 'a', stop_policy: 'NO_FIXED_SL', stop_loss: null, signal_id: '[s:scalp]a' }),
      row({ id: 'b', stop_policy: 'FIXED_SL', stop_loss: 90, signal_id: '[s:my-original-v1]b' }),
    ]);
    // 고정 손절 줄은 후보로는 남는다 — 인식은 한다.
    eq(r.positions.length, 1);
    const p = r.positions[0];
    eq(mayActOn(p), false,
      '★ 고정 손절 없는 줄을 버린 덕에 다른 전략 줄이 OWNED로 승격했습니다'
      + ' — 같은 net position이라 그쪽 노출까지 건드립니다');
    // 자리 주장이 손절 분류보다 먼저 등록돼야 두 전략이 다 보인다.
    eq(p.ownership.code, 'OWNERSHIP_AMBIGUOUS',
      '★ 걸러진 줄이 자리 주장에서도 사라졌습니다');
    eq(p.ownership.claimants.length, 2);
  });

  // J — ★ 같은 전략이 섞인 자리 (소유권만으로는 못 막는 경우)
  test('★ 같은 전략의 FIXED_SL과 섞여 있어도 그 자리를 관리하지 않는다', () => {
    const r = managedCandidates([
      row({ id: 'a', stop_policy: 'NO_FIXED_SL', stop_loss: null, signal_id: '[s:scalp]a' }),
      row({ id: 'b', stop_policy: 'FIXED_SL', stop_loss: 90, signal_id: '[s:scalp]b' }),
    ]);
    eq(r.positions.length, 1);
    const p = r.positions[0];
    // 주장자가 하나뿐이라 **소유권은 OWNED다.** 소유권만 보면 통과한다 —
    // 그래서 관리 판정이 따로 필요하다.
    eq(p.ownership.code, 'OWNED', '전략이 하나면 소유권은 분명하다');
    eq(p.management.code, 'NO_FIXED_SL_SEAT_DEFERRED');
    eq(mayActOn(p), false,
      '★ 소유권만 보고 통과시켰습니다 — 같은 자리의 고정 손절 없는 노출까지 움직입니다');
  });

  test('★ 정책 충돌(NO_FIXED_SL + 손절 값)도 자리를 유예시킨다', () => {
    const r = managedCandidates([
      row({ id: 'a', stop_policy: 'NO_FIXED_SL', stop_loss: 95, signal_id: '[s:scalp]a' }),
      row({ id: 'b', stop_policy: 'FIXED_SL', stop_loss: 90, signal_id: '[s:scalp]b' }),
    ]);
    eq(mayActOn(r.positions[0]), false, '★ 충돌한 줄은 자리를 유예시키지 않았습니다');
  });

  // K
  test('다른 계좌면 영향이 없다', () => {
    const r = managedCandidates([
      row({ id: 'a', connection_id: 'conn-A', stop_policy: 'NO_FIXED_SL', stop_loss: null }),
      row({ id: 'b', connection_id: 'conn-B', stop_policy: 'FIXED_SL', stop_loss: 90 }),
    ]);
    eq(r.positions.length, 1);
    eq(mayActOn(r.positions[0]), true, '★ 다른 계좌까지 유예시켰습니다 — 과잉 차단입니다');
  });

  // L
  test('다른 종목이면 영향이 없다', () => {
    const r = managedCandidates([
      row({ id: 'a', symbol: 'BTCUSDT', stop_policy: 'NO_FIXED_SL', stop_loss: null }),
      row({ id: 'b', symbol: 'ETHUSDT', stop_policy: 'FIXED_SL', stop_loss: 90 }),
    ]);
    eq(r.positions.length, 1);
    eq(r.positions[0].symbol, 'ETHUSDT');
    eq(mayActOn(r.positions[0]), true, '★ 다른 종목까지 유예시켰습니다');
  });

  test('★ 관리 판정이 없는 옛 모양 객체는 통과시키지 않는다', () => {
    // 유예를 우회하는 길을 열어 두지 않는다.
    eq(mayActOn({ ownership: { code: 'OWNED', reason: '', claimants: [] } } as any), false);
  });

  test('유예는 "대상 아님"과 섞이지 않는다', () => {
    const r = managedCandidates([
      row({ id: 'a', stop_policy: 'NO_FIXED_SL', stop_loss: null }),
      row({ id: 'b', symbol: 'ETHUSDT', reduce_only: true }),
    ]);
    eq(r.deferred.length, 1, '유예는 유예로');
    assert(!!r.skipped.find((x: any) => x.code === 'REDUCE_ONLY'), '대상 아님은 대상 아님으로');
  });
}
