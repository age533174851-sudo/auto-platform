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
  overallDiagnoseVerdict, statusToOk,
} from './testnetDiagnoseVerdict';
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
