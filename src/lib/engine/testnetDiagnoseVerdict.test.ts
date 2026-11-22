// src/lib/engine/testnetDiagnoseVerdict.test.ts
//
// **확인하지 못한 것을 통과로 적지 않는가.**
//
// 이 파일이 지키는 것의 대부분은 "하지 않는다"다: 모르는 모드를
// 단방향으로 메우지 않는다, 조회 실패를 "격리가 아니다"로 적지
// 않는다, 상수 false를 "거래소가 확인했다"로 적지 않는다, UNKNOWN이
// 하나라도 있으면 READY를 적지 않는다.
import { test, assert, eq } from '../../test/harness';
import {
  positionModeVerdict, isolationVerdict, withdrawalEvidence,
  clockSkewVerdict, overallDiagnoseVerdict, statusToOk,
} from './testnetDiagnoseVerdict';
import { summarizeTestnetOpenOrders, summarizeTestnetOpenPositions } from './testnetVenueEvidence';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function runTestnetDiagnoseVerdictTests() {

  // ── ① 포지션 모드 ──

  test('모드 ① 단방향만 통과다', () => {
    const v = positionModeVerdict({ mode: 'ONE_WAY' });
    eq(v.status, 'PASS'); eq(v.code, 'ONE_WAY');
  });

  test('모드 ② 양방향은 실패다 — 긴급 종료가 멈추는 모드다', () => {
    const v = positionModeVerdict({ mode: 'HEDGE' });
    eq(v.status, 'FAIL'); eq(v.code, 'HEDGE');
    assert(/BLOCKED_HEDGE/.test(v.reason), '왜 막는지 이유에 적는다');
  });

  test('★ 모드 ③ null은 단방향이 아니다 (UNKNOWN)', () => {
    for (const m of [null, undefined] as any[]) {
      const v = positionModeVerdict({ mode: m });
      eq(v.status, 'UNKNOWN', '모르는 모드를 통과로 적지 않는다');
      eq(v.code, 'MODE_UNKNOWN');
    }
  });

  test('★ 모드 ④ 입력 자체가 없어도 UNKNOWN이다', () => {
    for (const i of [null, undefined, {} as any] as any[]) {
      eq(positionModeVerdict(i).status, 'UNKNOWN');
    }
  });

  test('모드 ⑤ 엉뚱한 문자열을 단방향으로 읽지 않는다', () => {
    const v = positionModeVerdict({ mode: 'one_way' as any });
    eq(v.status, 'UNKNOWN', '대소문자가 다른 값은 추측하지 않는다');
  });

  test('모드 ⑥ 조회 오류 원문을 이유에 남긴다', () => {
    const v = positionModeVerdict({ mode: null, error: '-2015 거부' });
    assert(/-2015/.test(v.reason), '원인을 지우지 않는다');
  });

  // ── ② 격리 · 배율 ──

  const iso = (over: any = {}) => isolationVerdict({
    read: true, marginType: 'isolated', leverage: 100, expectedLeverage: 100, ...over });

  test('격리 ① 격리 + 요구 배율이면 통과다', () => {
    const v = iso();
    eq(v.status, 'PASS'); eq(v.code, 'READY');
  });

  test('★ 격리 ② 조회 실패는 "격리가 아니다"가 아니다 (UNKNOWN)', () => {
    const v = iso({ read: false, marginType: null, leverage: null });
    eq(v.status, 'UNKNOWN'); eq(v.code, 'SETTINGS_UNKNOWN');
  });

  test('격리 ③ 교차 마진은 실패다', () => {
    for (const mt of ['cross', 'crossed', 'CROSSED']) {
      const v = iso({ marginType: mt });
      eq(v.status, 'FAIL', mt); eq(v.code, 'MARGIN_NOT_ISOLATED');
    }
  });

  test('★ 격리 ④ 모르는 마진 타입은 실패가 아니라 UNKNOWN이다', () => {
    const v = iso({ marginType: 'something_new' });
    eq(v.status, 'UNKNOWN', '해석하지 못한 값을 틀렸다고 적지 않는다');
  });

  test('★ 격리 ⑤ 빈 마진 타입은 UNKNOWN이다', () => {
    for (const mt of ['', '   ', null, undefined] as any[]) {
      eq(iso({ marginType: mt }).status, 'UNKNOWN', String(mt));
    }
  });

  test('★ 격리 ⑤-b 빈 칸과 모르는 값의 **이유가 다르다**', () => {
    // 상태(UNKNOWN)만 보면 둘이 같다. 그래서 빈 칸 가드를 지워도
    // 아래 `!isolated` 분기가 같은 UNKNOWN을 만들어 변이가 새 나갔다
    // (TD-4). 운영자에게는 "거래소가 안 보냈다"와 "우리가 못 읽었다"가
    // 다른 사실이므로, 그 구분을 시험으로 고정한다.
    const empty = iso({ marginType: '' });
    const weird = iso({ marginType: 'something_new' });
    eq(empty.status, 'UNKNOWN'); eq(weird.status, 'UNKNOWN');
    assert(/보고하지 않았습니다/.test(empty.reason),
      `빈 칸의 이유가 "보고하지 않았습니다"가 아니다: ${empty.reason}`);
    assert(/해석하지 못했습니다/.test(weird.reason),
      `모르는 값의 이유가 "해석하지 못했습니다"가 아니다: ${weird.reason}`);
    assert(empty.reason !== weird.reason, '두 이유가 같아졌다 — 구분이 사라졌다');
  });

  test('격리 ⑥ 배율이 다르면 실패다', () => {
    const v = iso({ leverage: 20 });
    eq(v.status, 'FAIL'); eq(v.code, 'LEVERAGE_MISMATCH');
    assert(/20/.test(v.reason) && /100/.test(v.reason), '양쪽 값을 적는다');
  });

  test('★ 격리 ⑦ 배율을 못 읽으면 UNKNOWN이다 (0으로 메우지 않는다)', () => {
    for (const lev of [null, undefined, Number.NaN] as any[]) {
      const v = iso({ leverage: lev });
      eq(v.status, 'UNKNOWN', String(lev));
    }
  });

  test('★ 격리 ⑧ 요구 배율이 쓸 수 없으면 비교하지 않는다', () => {
    // 정본에서 못 읽었을 때 0·NaN·undefined가 넘어올 수 있다.
    // 그것을 "일치한다"로 읽으면 100배가 아닌 계좌가 초록이 된다.
    for (const exp of [0, Number.NaN, undefined, null, -1] as any[]) {
      const v = iso({ expectedLeverage: exp, leverage: exp });
      eq(v.status, 'UNKNOWN', String(exp));
    }
  });

  test('★ 격리 ⑨ 입력이 없어도 UNKNOWN이다', () => {
    for (const i of [null, undefined, {} as any] as any[]) {
      eq(isolationVerdict(i).status, 'UNKNOWN');
    }
  });

  test('격리 ⑩ 대문자 ISOLATED도 받는다', () => {
    eq(iso({ marginType: 'ISOLATED' }).status, 'PASS');
  });

  // ── ③ 출금 권한 증거 수준 ──

  test('★ 출금 ① 기록된 false는 "거래소 확인"이 아니다 (UNKNOWN)', () => {
    const v = withdrawalEvidence({ testnet: true, declaredHasWithdrawal: false });
    eq(v.status, 'UNKNOWN', '상수를 초록으로 적지 않는다');
    eq(v.code, 'NOT_VERIFIED_TESTNET_CONSTANT');
    assert(/거래소에 확인한 값이 아닙니다/.test(v.reason), '왜 모르는지 적는다');
  });

  test('출금 ② 권한이 켜져 있으면 실패다', () => {
    const v = withdrawalEvidence({ testnet: true, declaredHasWithdrawal: true });
    eq(v.status, 'FAIL'); eq(v.code, 'DECLARED_PRESENT');
  });

  test('★ 출금 ③ 기록이 비어 있으면 비허용으로 추정하지 않는다', () => {
    for (const d of [null, undefined] as any[]) {
      const v = withdrawalEvidence({ testnet: true, declaredHasWithdrawal: d });
      eq(v.status, 'UNKNOWN'); eq(v.code, 'NOT_DECLARED');
    }
  });

  test('★ 출금 ④ 어떤 입력에서도 PASS가 나오지 않는다', () => {
    // 거래소에 묻는 경로가 없으므로 이 항목은 지금 통과할 수 없다.
    // 통과가 나오기 시작하면 그것은 증거가 생겼다는 뜻이고,
    // 그때 이 시험이 먼저 빨개져야 한다.
    for (const d of [true, false, null, undefined] as any[]) {
      for (const t of [true, false, null] as any[]) {
        const v = withdrawalEvidence({ testnet: t, declaredHasWithdrawal: d });
        assert(v.status !== 'PASS', `PASS가 나왔다 (${String(t)}/${String(d)})`);
      }
    }
    eq(withdrawalEvidence(null as any).status, 'UNKNOWN');
  });

  // ── ④ 전체 판정 ──

  test('전체 ① 전부 PASS면 READY다', () => {
    const r = overallDiagnoseVerdict([{ status: 'PASS' }, { status: 'PASS' }]);
    eq(r.verdict, 'READY'); eq(r.pass, 2); eq(r.fail, 0); eq(r.unknown, 0);
  });

  test('★ 전체 ② UNKNOWN이 하나라도 있으면 READY가 아니다', () => {
    const r = overallDiagnoseVerdict([{ status: 'PASS' }, { status: 'UNKNOWN' }]);
    eq(r.verdict, 'UNKNOWN', '모르는 것이 있는데 통과로 적지 않는다');
    eq(r.unknown, 1);
  });

  test('전체 ③ FAIL이 UNKNOWN보다 앞선다 (BLOCKED)', () => {
    const r = overallDiagnoseVerdict([
      { status: 'PASS' }, { status: 'UNKNOWN' }, { status: 'FAIL' }]);
    eq(r.verdict, 'BLOCKED'); eq(r.fail, 1); eq(r.unknown, 1);
  });

  test('★ 전체 ④ 상태 칸이 없는 항목은 UNKNOWN으로 센다', () => {
    const r = overallDiagnoseVerdict([{ status: 'PASS' }, {} as any, { status: null }]);
    eq(r.verdict, 'UNKNOWN');
    eq(r.unknown, 2, '빠뜨린 칸이 통과가 되지 않게 한다');
  });

  test('★ 전체 ⑤ 항목이 없으면 READY가 아니다', () => {
    for (const x of [[], null, undefined] as any[]) {
      eq(overallDiagnoseVerdict(x).verdict, 'UNKNOWN',
        '아무것도 확인하지 않은 것은 통과가 아니다');
    }
  });

  test('★ statusToOk — UNKNOWN은 ok가 아니다', () => {
    eq(statusToOk('PASS'), true);
    eq(statusToOk('FAIL'), false);
    eq(statusToOk('UNKNOWN'), false, '모르는 것을 ok로 넘기지 않는다');
    eq(statusToOk(null), false);
    eq(statusToOk(undefined), false);
  });

  // ── ⑤ 정본이 순수한가 (검사기 탐침 컴파일이 깨지지 않게) ──

  test('★ 판정 정본은 import·process.env가 0이다', () => {
    const src = readFileSync(
      resolve(process.cwd(), 'src/lib/engine/testnetDiagnoseVerdict.ts'), 'utf8');
    eq(/^import /m.test(src), false, 'import이 생기면 탐침 컴파일 사슬이 꺼진다');
    eq(src.includes('process.env'), false, '주변 상태를 직접 집지 않는다');
  });

  // ── ⑥ 실제 거래소 조회와 낡은 DB 미결 장부를 혼동하지 않는가 ──
  test('★ Binance 미체결 조회 실패는 0건이 아니라 UNKNOWN', () => {
    const v = summarizeTestnetOpenOrders({ success: false, orders: [] });
    eq(v.code, 'UNKNOWN');
    eq(v.openOrderCount, null);
    eq(v.openCloseIntentCount, null);
    eq(summarizeTestnetOpenOrders(null).code, 'UNKNOWN');
    eq(summarizeTestnetOpenOrders({ success: true, orders: null }).code, 'UNKNOWN');
  });

  test('★ Binance 미체결 주문 성공·빈 배열은 검증된 0건', () => {
    const v = summarizeTestnetOpenOrders({ success: true, orders: [] });
    eq(v.code, 'VERIFIED');
    eq(v.openOrderCount, 0);
    eq(v.openCloseIntentCount, 0);
    eq(v.bySymbol.length, 0);
    eq(v.source, 'BINANCE_TESTNET_OPEN_ORDERS');
  });

  test('★ reduceOnly/closePosition 둘 중 하나라도 참이면 청산 의도 후보', () => {
    const snapshot = summarizeTestnetOpenOrders({ success: true, orders: [
      { symbol: 'BTCUSDT', reduceOnly: true, closePosition: false, orderId: 'secret-one' },
      { symbol: 'BTCUSDT', reduceOnly: false, closePosition: true, orderId: 'secret-two' },
      { symbol: 'BTCUSDT', reduceOnly: false, closePosition: false, orderId: 'secret-three' },
      { symbol: 'ETHUSDT', reduceOnly: true, closePosition: true, orderId: 'secret-four' },
    ] });
    eq(snapshot.code, 'VERIFIED');
    eq(snapshot.openOrderCount, 4);
    eq(snapshot.openCloseIntentCount, 3);
    eq(snapshot.bySymbol.length, 2);
    eq(snapshot.bySymbol[0].symbol, 'BTCUSDT');
    eq(snapshot.bySymbol[0].closeIntents, 2);
    eq(snapshot.bySymbol[1].symbol, 'ETHUSDT');
    eq(snapshot.bySymbol[1].closeIntents, 1);
    assert(!JSON.stringify(snapshot).includes('secret-one'),
      '주문 ID는 진단 응답에 출력하지 않는다');
  });

  test('★ Binance 알 수 없는 주문/포지션 응답은 추측하지 않는다', () => {
    eq(summarizeTestnetOpenOrders({ success: true,
      orders: [{ symbol: 'BTCUSDT', reduceOnly: null, closePosition: false }] }).code,
    'UNKNOWN');
    eq(summarizeTestnetOpenPositions({ success: false, positions: [] }).openPositionCount, null);
    eq(summarizeTestnetOpenPositions({ success: true, positions: [] }).openPositionCount, 0);
    const p = summarizeTestnetOpenPositions({ success: true, positions: [
      { symbol: 'BTCUSDT', amount: 0.01 }, { symbol: 'BTCUSDT', amount: 0.02 },
      { symbol: 'ETHUSDT', amount: 0.03 },
    ] });
    eq(p.openPositionCount, 3);
    eq(p.symbols.join(','), 'BTCUSDT,ETHUSDT');
    eq(p.source, 'BINANCE_TESTNET_POSITION_RISK');
  });

  // ── ④ 서버 시각 오차 ──
  //
  //   여기서 지키는 것: 서버 시각을 못 읽은 것을 **오차 0으로 적지
  //   않는다**, 왕복이 길어 결론이 안 나는 것을 **통과로 적지 않는다**,
  //   허용 오차를 받지 못하면 **비교 자체를 하지 않는다**.

  const T0 = 1_700_000_000_000;
  const TOL = 5_000;

  test('시계 ① 왕복이 짧고 오차가 작으면 통과다 — 구간을 함께 적는다', () => {
    const v = clockSkewVerdict({
      serverTimeMs: T0, sentAtMs: T0 - 10, receivedAtMs: T0 + 10, toleranceMs: TOL,
    });
    eq(v.status, 'PASS'); eq(v.code, 'IN_TOLERANCE');
    eq(v.roundTripMs, 20);
    assert(v.rangeMs?.[0] === -10 && v.rangeMs?.[1] === 10,
      '오차가 들어갈 수 있는 구간을 적는다 — 한 점으로 단정하지 않는다');
  });

  test('★ 시계 ② 서버 시각을 못 읽으면 오차 0이 아니라 UNKNOWN이다', () => {
    for (const st of [null, undefined, 0, NaN, -1] as any[]) {
      const v = clockSkewVerdict({
        serverTimeMs: st, sentAtMs: T0, receivedAtMs: T0 + 5, toleranceMs: TOL,
      });
      eq(v.status, 'UNKNOWN', `서버 시각 ${String(st)}`);
      eq(v.code, 'SERVER_TIME_UNREAD');
      eq(v.rangeMs, null, '재지 못한 구간을 지어내지 않는다');
      eq(v.roundTripMs, 5, '왕복은 쟀으므로 그것은 남긴다');
    }
  });

  test('★ 시계 ③ 허용 오차를 받지 못하면 비교하지 않는다', () => {
    for (const t of [undefined, null, 0, -1, NaN] as any[]) {
      const v = clockSkewVerdict({
        // 오차가 분명히 있는 입력이다. 그래도 허용선을 모르면 판정하지 않는다.
        serverTimeMs: T0 + 500, sentAtMs: T0, receivedAtMs: T0, toleranceMs: t,
      });
      eq(v.status, 'UNKNOWN', `허용 오차 ${String(t)}`);
      eq(v.code, 'TOLERANCE_UNUSABLE');
    }
  });

  test('시계 ④ 구간이 전부 허용선 밖이면 실패다 — 키 문제가 아니라고 적는다', () => {
    const v = clockSkewVerdict({
      serverTimeMs: T0 + 20_000, sentAtMs: T0, receivedAtMs: T0 + 30, toleranceMs: TOL,
    });
    eq(v.status, 'FAIL'); eq(v.code, 'SKEW_OUT_OF_TOLERANCE');
    assert(/-1021/.test(v.reason), '거부 코드를 적는다');
    assert(/키 문제가 아닙니다/.test(v.reason),
      '멀쩡한 키를 다시 발급하게 만들지 않는다');
  });

  test('★ 시계 ⑤ 왕복이 길어 허용선을 걸치면 통과도 실패도 아니다', () => {
    const v = clockSkewVerdict({
      serverTimeMs: T0, sentAtMs: T0 - 12_000, receivedAtMs: T0 + 12_000, toleranceMs: TOL,
    });
    eq(v.status, 'UNKNOWN', '느린 회선에서 "시계가 맞다"가 공짜로 나오지 않는다');
    eq(v.code, 'MEASUREMENT_INCONCLUSIVE');
    assert(v.rangeMs != null, '구간은 적는다 — 사람이 다시 잴 수 있게');
    assert(/다시 재세요/.test(v.reason), '다음 할 일을 적는다');
  });

  test('★ 시계 ⑥ 받은 시각이 보낸 시각보다 앞이면 측정이 성립하지 않는다', () => {
    const v = clockSkewVerdict({
      serverTimeMs: T0, sentAtMs: T0 + 10, receivedAtMs: T0, toleranceMs: TOL,
    });
    eq(v.status, 'UNKNOWN'); eq(v.code, 'LOCAL_WINDOW_UNUSABLE');
  });

  test('★ 시계 ⑦ 모르는 오차가 섞이면 전체 판정이 READY가 아니다', () => {
    const r = overallDiagnoseVerdict([{ status: 'PASS' }, clockSkewVerdict(null)]);
    eq(r.verdict, 'UNKNOWN'); eq(r.unknown, 1);
    eq(statusToOk(clockSkewVerdict(null).status), false);
  });

  test('★ 시계 ⑧ 판정은 시계를 맞추지도 거래소를 부르지도 않는다', () => {
    const src = readFileSync(
      resolve(process.cwd(), 'src/lib/engine/testnetDiagnoseVerdict.ts'), 'utf8');
    for (const bad of ['fetch(', 'Date.now', 'setSystemTime', 'execSync']) {
      eq(src.includes(bad), false, `${bad}가 판정 정본에 있다 — 입력은 이미 재어 온 숫자뿐이다`);
    }
  });

  test('★ 판정 정본은 기대 배율을 스스로 적지 않는다', () => {
    const src = readFileSync(
      resolve(process.cwd(), 'src/lib/engine/testnetDiagnoseVerdict.ts'), 'utf8');
    // 주석은 걷어내고 코드만 본다.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    eq(/\b100\b/.test(code), false,
      '배율 숫자가 여기 있으면 프리셋 표와 갈린다 — 인자로 받는다');
  });
}
