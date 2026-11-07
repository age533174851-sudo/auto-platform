// src/lib/engine/testnetDiagnoseVerdict.ts
//
// **TESTNET 진단 항목의 판정 정본.** 조회하지 않고, 판단만 한다.
//
// 왜 이 파일이 필요한가
// ────────────────────
// 진단이 항목마다 `ok: boolean`만 돌려주고 있었다. 그래서 세 가지가
// 한 칸에 뭉개졌다:
//
//     확인했고 맞다 · 확인했고 틀리다 · **확인하지 못했다**
//
// 셋 중 마지막이 `ok:false`로 적히면 화면에 ❌로 뜨고, 사람은 "틀렸다"로
// 읽는다. 반대로 어딘가에서 기본값을 통과로 잡으면 **모르는 것이 초록이
// 된다.** 이 저장소가 반복해서 막아 온 형태다 — 확인하지 못한 것을
// 통과로 적지 않는다.
//
// 그래서 상태를 셋으로 가른다. `PASS`/`FAIL`/`UNKNOWN`.
//
// ★ 이 파일은 **import이 0개**다. 검사기가 Node 타입 없이 모듈만 올려
//   실제로 불러 보는 탐침 컴파일을 하기 때문이다. 여기에 의존을 하나
//   넣으면 이 파일을 쓰는 사슬 전체의 검사가 조용히 꺼진다 (실제로
//   `holdExtension.ts`에서 그렇게 일곱 자리가 꺼졌다).
//
// ★ 이 파일은 거래소를 부르지 않는다. 설정을 바꾸지 않는다. 바꾸는
//   수단이 타입에 없다 — 입력은 이미 읽어 온 사실뿐이다.

/** 진단 한 항목의 상태. **UNKNOWN은 FAIL도 PASS도 아니다** */
export type DiagnoseStatus = 'PASS' | 'FAIL' | 'UNKNOWN';

export interface DiagnoseItemVerdict<C extends string> {
  status: DiagnoseStatus;
  /** 기계가 읽는 코드. 문구가 바뀌어도 이것은 안 바뀐다 */
  code: C;
  /** 사람에게 보여 줄 한 줄. **값·키·시크릿은 절대 들어가지 않는다** */
  reason: string;
}

// ── ① 포지션 모드 ──
//
//   ONE_WAY가 아니면 왜 FAIL인가: 긴급 종료 경로(`planKillClose`)가
//   HEDGE에서 `BLOCKED_HEDGE`로 멈춘다. 즉 HEDGE 계좌에서 100배로
//   진입하면 **자동 종료 수단이 없는 포지션**이 된다. 진입 전에 막는
//   것이 맞다. 이 판정은 그 사실을 옮겨 적는 것이고 새로 만드는 문턱이
//   아니다.

export type PositionModeCode =
  /** 단방향 — Exact100X가 전제하는 모드다 */
  | 'ONE_WAY'
  /** 양방향 — 긴급 종료가 BLOCKED_HEDGE로 멈춘다 */
  | 'HEDGE'
  /** 못 읽었다. **단방향으로 추정하지 않는다** */
  | 'MODE_UNKNOWN';

/**
 * 포지션 모드 판정.
 *
 * `getFuturesPositionMode`는 못 읽으면 `mode: null`을 준다. 그 null을
 * 여기서 ONE_WAY로 메우지 않는다 — 틀린 모드로 주문을 만들면 거부가
 * 아니라 **반대 포지션**이 열릴 수 있다.
 */
export function positionModeVerdict(
  i: { mode?: 'ONE_WAY' | 'HEDGE' | null; error?: string | null } | null | undefined,
): DiagnoseItemVerdict<PositionModeCode> {
  const mode = i?.mode;
  if (mode === 'ONE_WAY') {
    return { status: 'PASS', code: 'ONE_WAY', reason: '단방향 모드입니다' };
  }
  if (mode === 'HEDGE') {
    return {
      status: 'FAIL', code: 'HEDGE',
      reason: '양방향(헤지) 모드입니다 — 이 모드에서는 긴급 종료가'
        + ' BLOCKED_HEDGE로 멈춥니다. 자동 종료 수단이 없는 포지션이 됩니다',
    };
  }
  // null · undefined · 그 밖의 값 전부 여기로 떨어진다.
  return {
    status: 'UNKNOWN', code: 'MODE_UNKNOWN',
    reason: '포지션 모드를 확인하지 못했습니다 — 단방향으로 추정하지 않습니다'
      + (i?.error ? ` (${i.error})` : ''),
  };
}

// ── ② 격리 · 배율 ──
//
//   기대 배율을 **이 파일에 적지 않는다.** 정본은 실행 프로필
//   (`EXACT_100X`의 `MAX_LEV_100X.leverage`)이고, 부르는 쪽이 그것을
//   넘긴다. 여기에 100을 적어 두면 숫자가 두 곳에 생기고 언젠가 갈린다.

export type IsolationCode =
  | 'READY'
  /** 격리가 아니다 (교차 등) */
  | 'MARGIN_NOT_ISOLATED'
  /** 격리는 맞는데 배율이 다르다 */
  | 'LEVERAGE_MISMATCH'
  /** 조회 실패·빈 칸·해석 불가. **맞는 것으로 추정하지 않는다** */
  | 'SETTINGS_UNKNOWN';

export interface IsolationFacts {
  /** 조회 자체가 성공했는가. false면 아래 값들을 보지 않는다 */
  read: boolean;
  /** 거래소가 보고한 마진 타입 원문 (대소문자 무관) */
  marginType?: string | null;
  /** 거래소가 보고한 배율 */
  leverage?: number | null;
  /** 실행 프로필이 요구하는 배율. 부르는 쪽이 정본에서 가져온다 */
  expectedLeverage: number;
}

/**
 * 이 심볼이 "격리 + 요구 배율"로 맞춰져 있는가.
 *
 * ★ 순서가 의미를 가진다. 조회 실패를 먼저 걸러야 빈 값을 "격리가
 *   아니다"로 적지 않는다 — 그것은 모르는 것을 틀렸다고 적는 일이다.
 */
export function isolationVerdict(
  i: IsolationFacts | null | undefined,
): DiagnoseItemVerdict<IsolationCode> {
  const unknown = (why: string): DiagnoseItemVerdict<IsolationCode> =>
    ({ status: 'UNKNOWN', code: 'SETTINGS_UNKNOWN', reason: why });

  if (i?.read !== true) return unknown('격리·배율 설정을 조회하지 못했습니다');

  const raw = String(i.marginType ?? '').trim().toLowerCase();
  if (!raw) return unknown('거래소가 마진 타입을 보고하지 않았습니다');

  const lev = i.leverage;
  const expected = i.expectedLeverage;
  // 기대 배율이 쓸 수 없는 값이면 **비교 자체가 성립하지 않는다.**
  // 0이나 NaN을 기대값으로 받아 "일치한다"고 적으면 안 된다.
  if (!Number.isFinite(expected) || !(expected > 0)) {
    return unknown('요구 배율을 해석하지 못했습니다');
  }

  // 격리인가. 바이낸스는 'isolated' / 'cross'(또는 'crossed')를 준다.
  const isolated = raw === 'isolated';
  const crossed = raw === 'cross' || raw === 'crossed';
  if (!isolated) {
    // 아는 값이면 틀렸다고 적고, 모르는 값이면 모른다고 적는다.
    return crossed
      ? { status: 'FAIL', code: 'MARGIN_NOT_ISOLATED',
          reason: '교차 마진입니다 — Exact100X는 격리를 전제합니다' }
      : unknown(`마진 타입을 해석하지 못했습니다 (${raw})`);
  }

  if (!Number.isFinite(lev as number) || lev == null) {
    return unknown('거래소가 배율을 보고하지 않았습니다');
  }
  if (lev !== expected) {
    return {
      status: 'FAIL', code: 'LEVERAGE_MISMATCH',
      reason: `배율이 ${lev}배입니다 — 요구값은 ${expected}배입니다`,
    };
  }
  return { status: 'PASS', code: 'READY', reason: `격리 · ${expected}배입니다` };
}

// ── ③ 출금 권한의 **증거 수준** ──
//
//   DB의 `has_withdrawal=false`를 "거래소가 확인해 줬다"로 읽으면 안
//   된다. binance+testnet 등록 경로(`router.ts`)는 그 값을 거래소에
//   묻지 않고 **상수 false로 적는다** ("출금 권한은 테스트넷에서
//   의미가 없다"는 주석과 함께). 의도는 방어 가능하지만, 기록을
//   확인된 사실처럼 보여 주는 것은 다른 문제다.
//
//   그래서 여기서는 **값이 아니라 증거 수준**을 판정한다. 저장 로직과
//   스키마는 건드리지 않는다 (이번 승인 범위가 아니다).

export type WithdrawalEvidenceCode =
  /** 선언값이 켜져 있다 — 쓸 수 없는 키다 */
  | 'DECLARED_PRESENT'
  /** TESTNET 등록 경로가 거래소에 묻지 않고 상수로 적은 값이다 */
  | 'NOT_VERIFIED_TESTNET_CONSTANT'
  /** 선언값이 비어 있다 (null/undefined) */
  | 'NOT_DECLARED';

/**
 * 출금 비허용이 **확인된 사실인가**.
 *
 * TESTNET에서는 `false`가 확인의 결과가 아니라 상수이므로 `UNKNOWN`이다.
 * 이 항목은 진단을 막지 않지만(테스트넷 자금은 실물이 아니다) **초록으로
 * 적지도 않는다.**
 */
export function withdrawalEvidence(
  i: { testnet?: boolean | null; declaredHasWithdrawal?: boolean | null } | null | undefined,
): DiagnoseItemVerdict<WithdrawalEvidenceCode> {
  if (i?.declaredHasWithdrawal === true) {
    return {
      status: 'FAIL', code: 'DECLARED_PRESENT',
      reason: '출금 권한이 있는 키로 기록돼 있습니다 — 자동매매에 쓸 수 없습니다',
    };
  }
  if (i?.declaredHasWithdrawal !== false) {
    return {
      status: 'UNKNOWN', code: 'NOT_DECLARED',
      reason: '출금 권한 기록이 비어 있습니다 — 비허용으로 추정하지 않습니다',
    };
  }
  // 여기부터 declaredHasWithdrawal === false.
  return {
    status: 'UNKNOWN', code: 'NOT_VERIFIED_TESTNET_CONSTANT',
    reason: '기록은 출금 비허용이지만 **거래소에 확인한 값이 아닙니다**'
      + ' — TESTNET 등록 경로가 상수로 적습니다. 실제 키 설정은 거래소에서 확인하세요',
  };
}

// ── ④ 전체 판정 ──

export type OverallDiagnoseVerdict = 'READY' | 'BLOCKED' | 'UNKNOWN';

export interface OverallDiagnose {
  verdict: OverallDiagnoseVerdict;
  pass: number;
  fail: number;
  unknown: number;
}

/**
 * 항목들을 모아 한 줄로 답한다.
 *
 * ★ **UNKNOWN이 하나라도 있으면 READY가 아니다.** 이것이 이 함수의
 *   존재 이유다. 예전 진단은 `successRate === 100`으로 ready를 적었고,
 *   거기서 "확인하지 못함"은 분모만 늘렸다 — 즉 모르는 것이 있을 때
 *   ready가 아니긴 했지만 **이유가 FAIL과 구별되지 않았다.**
 *
 * ★ 항목이 하나도 없으면 READY가 아니다. 아무것도 확인하지 않은 것은
 *   통과가 아니다.
 */
export function overallDiagnoseVerdict(
  items: readonly { status?: DiagnoseStatus | null }[] | null | undefined,
): OverallDiagnose {
  const list = Array.isArray(items) ? items : [];
  let pass = 0, fail = 0, unknown = 0;
  for (const it of list) {
    if (it?.status === 'PASS') { pass += 1; continue; }
    if (it?.status === 'FAIL') { fail += 1; continue; }
    // 상태가 없는 항목도 모르는 것으로 센다. 빠뜨린 칸이 통과가 되지 않게.
    unknown += 1;
  }
  const verdict: OverallDiagnoseVerdict =
    fail > 0 ? 'BLOCKED'
      : unknown > 0 ? 'UNKNOWN'
        : pass > 0 ? 'READY' : 'UNKNOWN';
  return { verdict, pass, fail, unknown };
}

/** `ok` 한 칸만 읽는 옛 화면을 위한 변환. **UNKNOWN은 통과가 아니다** */
export function statusToOk(status: DiagnoseStatus | null | undefined): boolean {
  return status === 'PASS';
}
