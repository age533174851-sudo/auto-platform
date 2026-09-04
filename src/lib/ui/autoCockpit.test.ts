// 첫 화면이 거짓말을 하지 않는가.
//
// 아래 케이스들은 전부 "이렇게 표시하면 사용자가 돈을 잃거나, 돌고 있는
// 자동매매를 멈춘 줄 안다"는 자리들이다. 하나하나 못박는다.
import { test, assert, eq } from '../../test/harness';
import { cockpitVerdict, cockpitEnvBadge } from './autoCockpit';

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
    assert(cockpitVerdict([]).state !== cockpitVerdict(null).state,
      '읽었는데 없는 것과 못 읽은 것이 같은 상태가 됐다');
  });

  // ── CASE C — 켜진 것이 0이면 OFF, 그러나 환경을 지어내지 않는다 ──
  test('켜진 예약이 없으면 OFF이고 환경 배지를 그리지 않는다', () => {
    const r = cockpitVerdict([row({ enabled: false }), row({ enabled: false })]);
    eq(r.state, 'OFF');
    eq(r.activeCount, 0);
    eq(r.env, null);
    eq(cockpitEnvBadge(r), null);
    assert(!/실행|켜져 있습니다/.test(r.headline), `꺼져 있는데 실행처럼 말한다: ${r.headline}`);
  });

  // ── CASE A · D — 켜짐은 '나갈 수 있음'이 아니다 ──
  test('연결을 다시 묶어야 하면 켜져 있어도 BLOCKED다', () => {
    const r = cockpitVerdict([row({ needsRebind: true, connectionNote: '연결이 사라졌습니다' })]);
    eq(r.state, 'BLOCKED');
    assert(r.blockers.length === 1 && /사라졌습니다/.test(r.blockers[0].why), '사유가 없다');
  });

  test('연결 상태가 OK가 아니면 BLOCKED다', () => {
    eq(cockpitVerdict([row({ connectionState: 'MISSING' })]).state, 'BLOCKED');
    eq(cockpitVerdict([row({ connectionState: 'STALE' })]).state, 'BLOCKED');
  });

  test('전략이 지금 코드로 못 돌면 BLOCKED다', () => {
    eq(cockpitVerdict([row({ strategyRunnable: false, strategyNote: '이 버전은 못 돕니다' })]).state, 'BLOCKED');
  });

  test('실행기가 끊겼으면(STALE) 켜져 있어도 BLOCKED다', () => {
    const r = cockpitVerdict([row({ runtime: { state: 'STALE', reason: '워커 12분째 무응답' } })]);
    eq(r.state, 'BLOCKED');
    assert(/12분/.test(r.detail), `왜 막혔는지 안 적었다: ${r.detail}`);
  });

  test('막힌 상태에서 "실행중"이라고 쓰지 않는다', () => {
    const r = cockpitVerdict([row({ runtime: { state: 'BLOCKED', reason: '안전장치' } })]);
    assert(!/실행중|실행 중/.test(r.headline + r.detail), `막혔는데 실행중이라 쓴다: ${r.headline}`);
  });

  // ── CASE E — 환경이 섞이면 가장 위험한 쪽 ──
  test('실전 예약이 하나라도 켜져 있으면 첫 화면은 LIVE다', () => {
    const r = cockpitVerdict([row({ mode: 'TESTNET' }), row({ symbol: 'ETHUSDT', mode: 'LIVE_LIMITED' })]);
    eq(r.env, 'LIVE');
    eq(r.liveCount, 1);
    eq(r.tone, 'live');
    assert(/실전/.test(r.headline), `실전이 걸려 있는데 머리말에 없다: ${r.headline}`);
    assert(/실전 1개/.test(r.detail), `실전 개수를 안 적었다: ${r.detail}`);
  });

  test('꺼 둔 실전 예약 때문에 화면이 실전이 되지 않는다', () => {
    const r = cockpitVerdict([row({ mode: 'TESTNET' }), row({ mode: 'LIVE', enabled: false })]);
    eq(r.env, 'TESTNET');
    eq(r.liveCount, 0);
  });

  // ── CASE F — 감시 중은 실패가 아니다 ──
  test('감시 중·진입함·첫 평가 대기는 막힌 것이 아니다', () => {
    for (const st of ['WATCHING', 'ENTERED', 'NEVER_RAN', 'UNKNOWN']) {
      const r = cockpitVerdict([row({ runtime: { state: st, reason: '' } })]);
      eq(r.state, 'ARMED');
    }
  });

  // ── 정상 ──
  test('켜져 있고 막힌 것이 없으면 ARMED이고 개수를 말한다', () => {
    const r = cockpitVerdict([row(), row({ symbol: 'ETHUSDT' })]);
    eq(r.state, 'ARMED');
    eq(r.activeCount, 2);
    eq(r.env, 'TESTNET');
    assert(/2개/.test(r.detail), `개수를 안 적었다: ${r.detail}`);
  });

  test('실전은 테스트넷과 같은 색을 쓰지 않는다', () => {
    const live = cockpitVerdict([row({ mode: 'LIVE' })]);
    const test = cockpitVerdict([row({ mode: 'TESTNET' })]);
    assert(live.tone !== test.tone, '실전과 테스트넷이 같은 색이다');
  });

  test('어떤 상태에서도 머리말과 설명이 비어 있지 않다', () => {
    const cases = [
      cockpitVerdict(null), cockpitVerdict([]),
      cockpitVerdict([row()]), cockpitVerdict([row({ connectionState: 'MISSING' })]),
    ];
    for (const r of cases) {
      assert(r.headline.length > 0, '머리말이 비었다');
      assert(r.detail.length > 0, '설명이 비었다');
    }
  });

  test('막힌 상태에는 다음에 할 일이 있다', () => {
    for (const r of [cockpitVerdict(null), cockpitVerdict([]), cockpitVerdict([row({ connectionState: 'MISSING' })])]) {
      assert(r.nextAction.length > 0, `${r.state}: 다음에 할 일이 없다`);
    }
  });

  test('환경 배지는 켜진 예약이 있을 때만 나온다', () => {
    eq(cockpitEnvBadge(cockpitVerdict(null)), null);
    eq(cockpitEnvBadge(cockpitVerdict([])), null);
    eq(cockpitEnvBadge(cockpitVerdict([row({ mode: 'LIVE' })])), 'LIVE');
  });
}
