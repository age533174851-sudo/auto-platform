// 첫 화면이 거짓말을 하지 않는가.
//
// 아래 케이스들은 전부 "이렇게 표시하면 사용자가 돈을 잃거나, 돌고 있는
// 자동매매를 멈춘 줄 안다"는 자리들이다. 하나하나 못박는다.
import { test, assert, eq } from '../../test/harness';
import { cockpitVerdict, cockpitEnvBadge, snapshotSignature } from './autoCockpit';

/** 전부 통과한 전역 관문. 안 주면 '확인 못 함'이라 ARMED가 되지 않는다 */
const okGates = [
  { id: 'admin', label: '자동 실행 열쇠', state: 'ok' },
  { id: 'cron', label: '크론 열쇠', state: 'ok' },
];

const row = (o: any = {}) => ({
  symbol: 'BTCUSDT', enabled: true, mode: 'TESTNET',
  connectionState: 'OK', strategyRunnable: true,
  runtime: { state: 'WATCHING', reason: '정상 평가 중' },
  ...o,
});

export function runAutoCockpitTests() {
  // ── CASE B — 못 읽은 것은 0도 꺼짐도 아니다 ──
  test('예약을 못 읽으면 UNKNOWN이고 개수는 null이다', () => {
    for (const v of [null, undefined, 'nope' as any, 0 as any]) {
      const r = cockpitVerdict(v as any, '로그인이 필요합니다');
      eq(r.state, 'UNKNOWN');
      eq(r.activeCount, null);
      eq(r.liveCount, null);
      eq(r.env, null);
      assert(!/꺼|OFF|없습니다$/.test(r.headline), `못 읽었는데 꺼짐처럼 말한다: ${r.headline}`);
    }
  });

  test('못 읽은 이유를 그대로 보여 준다', () => {
    eq(cockpitVerdict(null, '로그인이 필요합니다').detail, '로그인이 필요합니다');
  });

  test('빈 배열과 null은 다른 뜻이다', () => {
    assert(cockpitVerdict([], '', okGates).state !== cockpitVerdict(null).state,
      '읽었는데 없는 것과 못 읽은 것이 같은 상태가 됐다');
  });

  // ── CASE C — 켜진 것이 0이면 OFF, 그러나 환경을 지어내지 않는다 ──
  test('켜진 예약이 없으면 OFF이고 환경 배지를 그리지 않는다', () => {
    const r = cockpitVerdict([row({ enabled: false }), row({ enabled: false })], '', okGates);
    eq(r.state, 'OFF');
    eq(r.activeCount, 0);
    eq(r.env, null);
    eq(cockpitEnvBadge(r), null);
    assert(!/실행|켜져 있습니다/.test(r.headline), `꺼져 있는데 실행처럼 말한다: ${r.headline}`);
  });

  // ── CASE A · D — 켜짐은 '나갈 수 있음'이 아니다 ──
  test('연결을 다시 묶어야 하면 켜져 있어도 BLOCKED다', () => {
    const r = cockpitVerdict([row({ needsRebind: true, connectionNote: '연결이 사라졌습니다' })], '', okGates);
    eq(r.state, 'BLOCKED');
    assert(r.blockers.length === 1 && /사라졌습니다/.test(r.blockers[0].why), '사유가 없다');
  });

  test('연결 상태가 OK가 아니면 BLOCKED다', () => {
    eq(cockpitVerdict([row({ connectionState: 'MISSING' })], '', okGates).state, 'BLOCKED');
    eq(cockpitVerdict([row({ connectionState: 'STALE' })], '', okGates).state, 'BLOCKED');
  });

  test('전략이 지금 코드로 못 돌면 BLOCKED다', () => {
    eq(cockpitVerdict([row({ strategyRunnable: false, strategyNote: '이 버전은 못 돕니다' })], '', okGates).state, 'BLOCKED');
  });

  test('실행기가 끊겼으면(STALE) 켜져 있어도 BLOCKED다', () => {
    const r = cockpitVerdict([row({ runtime: { state: 'STALE', reason: '워커 12분째 무응답' } })], '', okGates);
    eq(r.state, 'BLOCKED');
    assert(/12분/.test(r.detail), `왜 막혔는지 안 적었다: ${r.detail}`);
  });

  test('막힌 상태에서 "실행중"이라고 쓰지 않는다', () => {
    const r = cockpitVerdict([row({ runtime: { state: 'BLOCKED', reason: '안전장치' } })], '', okGates);
    assert(!/실행중|실행 중/.test(r.headline + r.detail), `막혔는데 실행중이라 쓴다: ${r.headline}`);
  });

  // ── CASE E — 환경이 섞이면 가장 위험한 쪽 ──
  test('실전 예약이 하나라도 켜져 있으면 첫 화면은 LIVE다', () => {
    const r = cockpitVerdict([row({ mode: 'TESTNET' }), row({ symbol: 'ETHUSDT', mode: 'LIVE_LIMITED' })], '', okGates);
    eq(r.env, 'LIVE');
    eq(r.liveCount, 1);
    eq(r.tone, 'live');
    assert(/실전/.test(r.headline), `실전이 걸려 있는데 머리말에 없다: ${r.headline}`);
    assert(/실전 1개/.test(r.detail), `실전 개수를 안 적었다: ${r.detail}`);
  });

  test('꺼 둔 실전 예약 때문에 화면이 실전이 되지 않는다', () => {
    const r = cockpitVerdict([row({ mode: 'TESTNET' }), row({ mode: 'LIVE', enabled: false })], '', okGates);
    eq(r.env, 'TESTNET');
    eq(r.liveCount, 0);
  });

  // ── CASE F — 감시 중은 실패가 아니다 ──
  test('감시 중·진입함·첫 평가 대기는 막힌 것이 아니다', () => {
    for (const st of ['WATCHING', 'ENTERED', 'NEVER_RAN', 'UNKNOWN']) {
      const r = cockpitVerdict([row({ runtime: { state: st, reason: '' } })], '', okGates);
      eq(r.state, 'ARMED');
    }
  });

  // ── 정상 ──
  test('켜져 있고 막힌 것이 없으면 ARMED이고 개수를 말한다', () => {
    const r = cockpitVerdict([row(), row({ symbol: 'ETHUSDT' })], '', okGates);
    eq(r.state, 'ARMED');
    eq(r.activeCount, 2);
    eq(r.env, 'TESTNET');
    assert(/2개/.test(r.detail), `개수를 안 적었다: ${r.detail}`);
  });

  test('실전은 테스트넷과 같은 색을 쓰지 않는다', () => {
    const live = cockpitVerdict([row({ mode: 'LIVE' })], '', okGates);
    const test = cockpitVerdict([row({ mode: 'TESTNET' })], '', okGates);
    assert(live.tone !== test.tone, '실전과 테스트넷이 같은 색이다');
  });

  test('어떤 상태에서도 머리말과 설명이 비어 있지 않다', () => {
    const cases = [
      cockpitVerdict(null), cockpitVerdict([], '', okGates),
      cockpitVerdict([row()], '', okGates), cockpitVerdict([row({ connectionState: 'MISSING' })], '', okGates),
    ];
    for (const r of cases) {
      assert(r.headline.length > 0, '머리말이 비었다');
      assert(r.detail.length > 0, '설명이 비었다');
    }
  });

  test('막힌 상태에는 다음에 할 일이 있다', () => {
    for (const r of [cockpitVerdict(null), cockpitVerdict([], '', okGates), cockpitVerdict([row({ connectionState: 'MISSING' })], '', okGates)]) {
      assert(r.nextAction.length > 0, `${r.state}: 다음에 할 일이 없다`);
    }
  });

  test('환경 배지는 켜진 예약이 있을 때만 나온다', () => {
    eq(cockpitEnvBadge(cockpitVerdict(null)), null);
    eq(cockpitEnvBadge(cockpitVerdict([], '', okGates)), null);
    eq(cockpitEnvBadge(cockpitVerdict([row({ mode: 'LIVE' })], '', okGates)), 'LIVE');
  });

  // ── 전역 관문 ──
  //
  // 예약 줄만 보면 멀쩡한데 자동 실행 열쇠가 없으면 크론이 진입 엔진을
  // 부르지 못한다. 그때 첫 줄이 "실행 가능"이라고 하면, 바로 아래 안전
  // 점검의 "확인 못 함/막힘"과 한 화면에서 서로 다른 말을 하게 된다.
  const gate = (id: string, state: string, label = id) => ({ id, label, state });

  test('A. 자동 실행 열쇠가 없으면 켜져 있어도 ARMED가 아니다', () => {
    const r = cockpitVerdict([row()], '', [gate('admin_secret', 'bad', '자동 실행 열쇠')]);
    eq(r.state, 'BLOCKED');
    assert(r.blockers.some(b => /자동 실행 열쇠/.test(b.why)), '사유에 관문이 없다');
  });

  test('B. 실전 잠금이 안 풀렸으면 LIVE 예약이 켜져 있어도 ARMED가 아니다', () => {
    const r = cockpitVerdict([row({ mode: 'LIVE' })], '', [gate('live_unlock', 'bad', '실전 잠금')]);
    eq(r.state, 'BLOCKED');
    eq(r.env, 'LIVE');
  });

  test('C. 실전 모드인데 연결이 테스트넷이면 ARMED가 아니다', () => {
    const r = cockpitVerdict([row({ mode: 'LIVE' })], '', [gate('conn_dest', 'bad', '연결 목적지')]);
    eq(r.state, 'BLOCKED');
  });

  test('D. 전역 점검에 확인 못 한 것이 있으면 "실행 가능"이라 하지 않는다', () => {
    const r = cockpitVerdict([row()], '', [gate('ok1', 'ok'), gate('runs', 'unknown', '실행 기록')]);
    eq(r.state, 'UNCONFIRMED');
    assert(!/조건이 맞으면 주문이 나갑니다/.test(r.detail), `확인 못 했는데 실행 가능처럼 말한다: ${r.detail}`);
    assert(/확인하지 못했습니다/.test(r.headline), r.headline);
  });

  test('D-2. 전역 점검을 아예 못 받으면 ARMED로 올리지 않는다', () => {
    // health를 안 주는 것은 "전부 정상"이 아니라 "모른다"이다.
    eq(cockpitVerdict([row()]).state, 'UNCONFIRMED');
    eq(cockpitVerdict([row()], '', null).state, 'UNCONFIRMED');
  });

  test('E. 막힌 관문이 있으면 그 이름이 첫 줄 사유에 나온다', () => {
    const r = cockpitVerdict([row()], '', [gate('exit_monitor', 'bad', '청산 감시')]);
    assert(/청산 감시/.test(r.detail) || r.blockers.some(b => /청산 감시/.test(b.why)),
      `막은 항목 이름이 없다: ${r.detail}`);
  });

  // ── runtime UNKNOWN 과 execution authority UNKNOWN 은 다르다 ──
  test('마지막 판단을 모르는 것과 실행 권한을 모르는 것은 다르다', () => {
    // 마지막 판단만 모름 — 관문이 전부 ok면 실행 가능이라고 말해도 된다.
    eq(cockpitVerdict([row({ runtime: { state: 'UNKNOWN', reason: '' } })], '', okGates).state, 'ARMED');
    // 실행 권한을 모름 — 줄이 멀쩡해도 실행 가능이라고 말하지 않는다.
    eq(cockpitVerdict([row()], '', [gate('admin_secret', 'unknown', '자동 실행 열쇠')]).state, 'UNCONFIRMED');
  });

  // ── 첫 화면이 답해야 하는 6가지 ──
  test('첫 화면 판정이 대상과 마지막 판단을 들고 있다', () => {
    const r = cockpitVerdict(
      [row({ symbol: 'BTCUSDT', runtime: { state: 'WATCHING', reason: '진입 조건 대기', lastEvaluationAtMs: 200 } }),
       row({ symbol: 'ETHUSDT', runtime: { state: 'ENTERED', reason: '진입했습니다', lastEvaluationAtMs: 300 } })],
      '', okGates);
    eq(r.targets.length, 2);
    assert(r.targets.includes('BTCUSDT') && r.targets.includes('ETHUSDT'), r.targets.join(','));
    // 가장 최근에 평가된 줄이 마지막 판단이다
    assert(/ETHUSDT/.test(String(r.lastDecision)), `마지막 판단이 최신이 아니다: ${r.lastDecision}`);
  });

  test('마지막 판단이 없으면 null이다 — 거래 없음으로 적지 않는다', () => {
    const r = cockpitVerdict([row({ runtime: { state: '', reason: '' } })], '', okGates);
    eq(r.lastDecision, null);
  });

  test('못 읽었거나 꺼져 있으면 대상도 마지막 판단도 지어내지 않는다', () => {
    for (const r of [cockpitVerdict(null), cockpitVerdict([])]) {
      eq(r.targets.length, 0);
      eq(r.lastDecision, null);
    }
  });

  // ── 스냅샷 서명 ──
  test('의미가 같으면 서명이 같다 — 새 배열이어도', () => {
    const a = snapshotSignature([row()], '', [{ id: 'x', state: 'ok' }]);
    const b = snapshotSignature([row()], '', [{ id: 'x', state: 'ok' }]);
    eq(a, b);
  });

  test('점검 상태가 바뀌면 서명이 바뀐다', () => {
    const ok = snapshotSignature([row()], '', [{ id: 'x', state: 'ok' }]);
    const bad = snapshotSignature([row()], '', [{ id: 'x', state: 'bad' }]);
    const unk = snapshotSignature([row()], '', [{ id: 'x', state: 'unknown' }]);
    assert(ok !== bad && bad !== unk && ok !== unk, '점검 변화가 서명에 안 나온다');
  });

  test('예약이 바뀌면 서명이 바뀐다', () => {
    const base = snapshotSignature([row()], '', []);
    assert(base !== snapshotSignature([row({ enabled: false })], '', []), 'enabled 변화가 안 잡힌다');
    assert(base !== snapshotSignature([row({ mode: 'LIVE' })], '', []), 'mode 변화가 안 잡힌다');
    assert(base !== snapshotSignature([row({ connectionState: 'MISSING' })], '', []), '연결 변화가 안 잡힌다');
    assert(base !== snapshotSignature([row({ runtime: { state: 'STALE', reason: 'x' } })], '', []), 'runtime 변화가 안 잡힌다');
  });

  test('못 읽음과 빈 목록은 서명도 다르다', () => {
    assert(snapshotSignature(null, '읽기 실패', null) !== snapshotSignature([], '', []),
      'null과 []가 같은 서명이다');
  });

  test('서명은 시각에 흔들리지 않는다', () => {
    // 시각처럼 매번 변하는 값이 들어가면 이 함수는 아무것도 막지 못한다.
    const a = snapshotSignature([row()], '', [{ id: 'x', state: 'ok' }]);
    const b = snapshotSignature([row()], '', [{ id: 'x', state: 'ok' }]);
    const c = snapshotSignature([row()], '', [{ id: 'x', state: 'ok' }]);
    assert(a === b && b === c, '같은 입력인데 서명이 흔들린다');
    assert(!/\d{10,}/.test(a), `서명에 타임스탬프가 들어갔다: ${a}`);
  });
}
