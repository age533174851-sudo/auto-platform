// src/lib/exchanges/positionRiskProvenance.test.ts
//
// **포지션 조회는 한 번의 왕복이 아니다.**
//
// v2가 실패하면 v3를, 그 뒤 마진 모드를 채우려고 `/fapi/v3/account`까지
// 부른다. 그래서 부르는 쪽이 호출 **전에** 찍은 시각을 "받은 시각"이라고
// 적으면 왕복 두세 번만큼 앞선 값이 기록된다.
//
// ⑤B-0의 목적이 나중 문턱을 유도할 **정확한 관측**을 모으는 것이므로
// 이건 이름 문제가 아니라 데이터 오염이다. 여기서 경계를 못으로 박는다.
import { test, assert, eq } from '../../test/harness';
import { readPositionRiskWithProvenance } from './positionRiskRead';

const ROW = {
  symbol: 'BTCUSDT', positionAmt: '0.2', marginType: 'isolated', leverage: '100',
  liquidationPrice: '49700', entryPrice: '50000', markPrice: '50010',
  updateTime: '1779999000000',
};
/** v3 응답에는 marginType·leverage가 없다 */
const ROW3 = { ...ROW, marginType: undefined, leverage: undefined };
const ACCT = { positions: [{ symbol: 'BTCUSDT', isolated: true, leverage: '100' }] };

/** 시각을 호출마다 100씩 전진시킨다 — 경계가 섞이면 바로 드러난다 */
function clock() {
  let t = 1_000;
  return () => (t += 100);
}

export function runPositionRiskProvenanceTests() {
  console.log('\n🕐 포지션 조회 provenance — 실제 HTTP 경계와 같은가');

  test('★ v2 성공: started < received이고 둘 다 v2 왕복의 것이다', async () => {
    const calls: string[] = [];
    const r = await readPositionRiskWithProvenance('BTCUSDT',
      async (path) => { calls.push(path); return [ROW]; }, clock());
    eq(r.provenance.positionRiskSource, 'V2');
    eq(calls.join(','), '/fapi/v2/positionRisk', 'v2가 성공하면 더 부르지 않는다');
    const st = r.provenance.positionRiskRequestStartedAtMs;
    const rc = r.provenance.positionRiskReceivedAtMs;
    assert(st != null && rc != null, '두 시각이 다 있어야 한다');
    assert(st! < rc!, `★ 보낸 시각이 받은 시각보다 앞서야 한다 (${st} → ${rc})`);
    // ★ 요청 **전**에 찍은 값이 received로 들어가면 여기가 같아진다.
    assert(st !== rc, '★ 요청 전 시각이 received로 기록됐다');
    eq(r.provenance.accountRequestStartedAtMs, null, 'v2 성공이면 계정 조회가 없다');
    eq(r.provenance.accountReceivedAtMs, null);
    eq(r.risk?.liquidationPrice, 49_700);
  });

  test('★ v2 실패 → v3 성공: v2 시각을 v3 provenance로 재사용하지 않는다', async () => {
    const calls: string[] = [];
    const r = await readPositionRiskWithProvenance('BTCUSDT',
      async (path) => {
        calls.push(path);
        if (path === '/fapi/v2/positionRisk') throw new Error('[-1102] v2 down');
        if (path === '/fapi/v3/positionRisk') return [ROW3];
        return ACCT;
      }, clock());
    eq(r.provenance.positionRiskSource, 'V3');
    eq(calls.join(','),
      '/fapi/v2/positionRisk,/fapi/v3/positionRisk,/fapi/v3/account');
    const p = r.provenance;
    // v2는 1100에 시작했다. v3 시각은 그보다 **뒤**여야 한다.
    assert((p.positionRiskRequestStartedAtMs ?? 0) > 1_100,
      `★ v2의 시작 시각이 v3 provenance로 재사용됐다 (${p.positionRiskRequestStartedAtMs})`);
    assert((p.positionRiskReceivedAtMs ?? 0) > (p.positionRiskRequestStartedAtMs ?? 0));
  });

  test('★ 계정 응답 시각이 청산가 관측 시각을 덮지 않는다', async () => {
    const r = await readPositionRiskWithProvenance('BTCUSDT',
      async (path) => {
        if (path === '/fapi/v2/positionRisk') throw new Error('v2 down');
        if (path === '/fapi/v3/positionRisk') return [ROW3];
        return ACCT;
      }, clock());
    const p = r.provenance;
    // 청산가는 v3 positionRisk 응답에 들어 있다. 계정 조회는 그 **뒤**다.
    assert(p.positionRiskReceivedAtMs! < p.accountRequestStartedAtMs!,
      '★ 청산가 관측 시각이 계정 조회 뒤로 밀렸다'
      + ` (${p.positionRiskReceivedAtMs} vs ${p.accountRequestStartedAtMs})`);
    assert(p.accountReceivedAtMs! > p.accountRequestStartedAtMs!);
    // 마진 모드는 계정에서 왔다 — 그래도 청산가 시각은 그대로다.
    eq(r.risk?.marginType, 'isolated');
  });

  test('★ 계정 조회가 실패해도 청산가 provenance는 남는다', async () => {
    const r = await readPositionRiskWithProvenance('BTCUSDT',
      async (path) => {
        if (path === '/fapi/v2/positionRisk') throw new Error('v2 down');
        if (path === '/fapi/v3/positionRisk') return [ROW3];
        throw new Error('account down');
      }, clock());
    eq(r.provenance.positionRiskSource, 'V3');
    assert(r.provenance.positionRiskReceivedAtMs != null,
      '★ 계정 실패가 청산가 관측 시각까지 지웠다');
    eq(r.provenance.accountReceivedAtMs, null, '못 받은 것은 null이다');
    eq(r.risk?.liquidationPrice, 49_700, '청산가는 그대로 산다');
  });

  test('★ 둘 다 실패하면 source가 null이고 시각을 지어내지 않는다', async () => {
    const r = await readPositionRiskWithProvenance('BTCUSDT',
      async () => { throw new Error('down'); }, clock());
    eq(r.risk, null);
    eq(r.provenance.positionRiskSource, null);
    eq(r.provenance.positionRiskRequestStartedAtMs, null,
      '★ 실패한 요청의 시각을 관측 시각으로 적었다');
    eq(r.provenance.positionRiskReceivedAtMs, null);
    assert(!!r.error, '실패는 실패로 적는다');
  });

  test('★ updateTime은 그 이름 그대로 보존된다 — 청산가 시각이 아니다', async () => {
    const r = await readPositionRiskWithProvenance('BTCUSDT',
      async () => [ROW], clock());
    eq(r.risk?.positionUpdateTimeMs, 1_779_999_000_000);
    // 그 값이 provenance의 관측 시각으로 새지 않았다.
    assert(r.provenance.positionRiskReceivedAtMs !== 1_779_999_000_000,
      '★ updateTime이 청산가 관측 시각으로 승격됐다');
    for (const bad of ['liquidationExchangeTimeMs', 'liquidationObservedAtMs',
                       'liquidationCalculatedAtMs']) {
      eq(bad in (r.provenance as any), false, `★ ${bad} 칸을 만들었다`);
    }
  });

  // ══════════════════════════════════════════════════════════
  // 단조(monotonic) elapsed — wall-clock과 **다른 칸**이다
  // ══════════════════════════════════════════════════════════

  /** 단조 눈금을 호출마다 7씩 전진 — wall-clock(100)과 구별된다 */
  function mono() {
    let t = 0;
    return () => (t += 7);
  }

  test('★ elapsed는 단조 시계로 재고 epoch 차와 다르다', async () => {
    const r = await readPositionRiskWithProvenance('BTCUSDT',
      async () => [ROW], clock(), mono());
    const p = r.provenance;
    // wall-clock은 100씩, 단조는 7씩 — 섞였으면 값이 같아진다.
    eq(p.positionRiskElapsedMs, 7, '★ elapsed를 Date.now 차로 쟀다');
    const wall = (p.positionRiskReceivedAtMs ?? 0) - (p.positionRiskRequestStartedAtMs ?? 0);
    eq(wall, 100, 'wall-clock 차는 그대로 남는다');
    assert(p.positionRiskElapsedMs !== wall,
      '★ duration과 epoch 차가 같은 값이다 — 한쪽이 다른 쪽을 덮었다');
  });

  test('★ v2 실패 시간이 v3 elapsed에 들어가지 않는다', async () => {
    const r = await readPositionRiskWithProvenance('BTCUSDT',
      async (path) => {
        if (path === '/fapi/v2/positionRisk') throw new Error('v2 down');
        if (path === '/fapi/v3/positionRisk') return [ROW3];
        return ACCT;
      }, clock(), mono());
    const p = r.provenance;
    // 단조 눈금: helper0=7, v2:14→(실패), v3:21→28, acct:35→42, helper끝=49
    eq(p.positionRiskElapsedMs, 7, '★ v3 왕복만이어야 한다 (v2 시도 제외)');
    eq(p.accountElapsedMs, 7, '계정 왕복은 따로 센다');
    assert((p.helperElapsedMs ?? 0) > (p.positionRiskElapsedMs ?? 0),
      `★ helper 전체가 v3 왕복과 같다 — fallback 비용이 사라졌다`
      + ` (${p.helperElapsedMs} vs ${p.positionRiskElapsedMs})`);
  });

  test('★ 단조 시계가 없으면 duration을 **재지 않는다** — 0도 추정도 아니다', async () => {
    const r = await readPositionRiskWithProvenance('BTCUSDT',
      async () => [ROW], clock(), () => null);
    eq(r.provenance.positionRiskElapsedMs, null,
      '★ 단조 시계가 없는데 Date.now 차로 메웠다 — 오염된 줄을 구분할 수 없다');
    eq(r.provenance.helperElapsedMs, null);
    // epoch provenance는 그대로 남는다.
    assert(r.provenance.positionRiskReceivedAtMs != null);
  });

  test('★ duration 칸과 timestamp 칸의 이름이 섞이지 않는다', async () => {
    const r = await readPositionRiskWithProvenance('BTCUSDT',
      async () => [ROW], clock(), mono());
    for (const k of Object.keys(r.provenance)) {
      if (/ElapsedMs$/.test(k)) {
        assert(!/At(Ms)?$/.test(k), `★ duration 칸이 시각처럼 이름 지어졌다 (${k})`);
      }
      if (/AtMs$/.test(k)) {
        assert(!/Elapsed/.test(k), `★ 시각 칸이 duration처럼 이름 지어졌다 (${k})`);
      }
    }
  });

  // ── 못 읽은 수량을 0으로 적지 않는다 ──
  //
  //   RED는 이랬다. `shape()`가 수량을 이렇게 읽었다:
  //
  //       positionAmt: parseFloat(row.positionAmt ?? '0') || 0
  //
  //   `parseFloat('bad')`는 `NaN`이고 `NaN || 0`은 **0**이다. 그래서
  //   거래소가 깨진 본문을 주면 앱은 **"포지션 없음"을 관측한 것으로
  //   읽었다.** 그 뒤 손절 복구는 `수량 0 → 보호할 것 없음`으로 조용히
  //   끝나고 경고도 attention도 남지 않았다:
  //
  //       FAIL: ★★ Binance malformed: 손절 복구 조회 미확인은
  //             경고·attention이고 주문 0건 — 손절 복구 미확인이
  //             경고 없이 사라졌다
  //
  //   CLAUDE.md의 절대 규칙 그 자리다 — **UNKNOWN을 0으로 적지 않는다.**
  test('★★ 깨진 수량은 0이 아니라 미확인이다 (v2)', async () => {
    for (const bad of ['bad', '', '   ', 'NaN', 'Infinity', '-Infinity', null, undefined, {}, true]) {
      const r = await readPositionRiskWithProvenance('BTCUSDT',
        async () => [{ ...ROW, positionAmt: bad }], clock());
      eq(r.risk, null, `깨진 수량(${String(bad)})을 관측으로 인정했다`);
      assert(r.error != null, `미확인인데 원인이 비어 있다 (${String(bad)})`);
      // 0을 적었다면 여기가 0으로 잡힌다 — 그게 RED였다.
      assert(r.risk?.positionAmt !== 0, `깨진 수량을 0으로 적었다 (${String(bad)})`);
    }
  });

  test('★★ 앞부분만 숫자인 쓰레기를 수량으로 인정하지 않는다', async () => {
    // `parseFloat('0.003XYZ')`는 0.003을 준다. 그건 우리가 이해한
    // 본문이 아니다 — 이해하지 못한 것을 수량으로 쓰지 않는다.
    const r = await readPositionRiskWithProvenance('BTCUSDT',
      async () => [{ ...ROW, positionAmt: '0.003XYZ' }], clock());
    eq(r.risk, null, '앞부분만 맞는 본문을 수량으로 읽었다');
  });

  test('★★ 진짜 0과 음수는 그대로 관측이다 — 과잉 차단하지 않는다', async () => {
    for (const [raw, want] of [['0', 0], [0, 0], ['-0.2', -0.2], [0.2, 0.2], ['0.2', 0.2]] as const) {
      const r = await readPositionRiskWithProvenance('BTCUSDT',
        async () => [{ ...ROW, positionAmt: raw }], clock());
      assert(r.risk != null, `멀쩡한 수량(${String(raw)})을 미확인으로 막았다`);
      eq(r.risk!.positionAmt, want);
    }
  });

  test('★★ v2가 깨졌으면 v3로 넘어가고, 둘 다 깨지면 미확인이다', async () => {
    // v2 본문이 깨졌어도 v3가 멀쩡하면 그 관측을 쓴다 — 버리지 않는다.
    const calls: string[] = [];
    const ok = await readPositionRiskWithProvenance('BTCUSDT',
      async (path) => {
        calls.push(path);
        if (path === '/fapi/v2/positionRisk') return [{ ...ROW, positionAmt: 'bad' }];
        if (path === '/fapi/v3/positionRisk') return [ROW3];
        return ACCT;
      }, clock());
    eq(ok.provenance.positionRiskSource, 'V3', 'v2가 깨졌는데 v3로 가지 않았다');
    eq(ok.risk?.positionAmt, 0.2);
    assert(calls.includes('/fapi/v3/positionRisk'), 'v3를 부르지 않았다');

    // 둘 다 깨졌으면 관측이 없다.
    const bad = await readPositionRiskWithProvenance('BTCUSDT',
      async (path) => {
        if (path === '/fapi/v3/account') return ACCT;
        return [{ ...ROW, positionAmt: 'bad' }];
      }, clock());
    eq(bad.risk, null, '양쪽이 다 깨졌는데 관측을 만들어냈다');
    assert(/수량 증거가 유효하지 않습니다/.test(bad.error || ''),
      `원인이 수량 때문이라고 적혀 있지 않다: ${bad.error}`);
  });

  test('★★ 헤지 모드에서 깨진 줄이 멀쩡한 줄을 이기지 않는다', async () => {
    // 예전 `pick`은 `parseFloat(r.positionAmt) !== 0`으로 골랐다.
    // 깨진 줄은 `NaN !== 0`이므로 **먼저 뽑혔고**, 바로 뒤의 열린
    // 포지션을 가렸다.
    const r = await readPositionRiskWithProvenance('BTCUSDT',
      async () => [
        { ...ROW, positionAmt: 'bad' },
        { ...ROW, positionAmt: '-0.5' },
      ], clock());
    assert(r.risk != null, '깨진 줄이 멀쩡한 줄을 가렸다');
    eq(r.risk!.positionAmt, -0.5);
  });

  test('★ 이 정본은 네트워크도 crypto도 모른다 — 검사기가 돌릴 수 있어야 한다', async () => {
    const src = await import('./positionRiskRead');
    eq(typeof src.readPositionRiskWithProvenance, 'function');
    // 주입 없이 부를 수 없다 = 스스로 조회하지 않는다.
    eq(src.readPositionRiskWithProvenance.length >= 2, true);
  });
}
