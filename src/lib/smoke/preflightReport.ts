// src/lib/smoke/preflightReport.ts
//
// **주문만 빼고, 실주문 스모크가 거치는 관문을 전부 거친 결과표.**
//
// 왜 필요한가
// ───────────
// PR #335가 스모크 **시작**을 무인으로 열었다. 그런데 "시작해도 되는
// 상태인가"를 확인하는 길은 아직 브라우저뿐이다 —
// `/api/binance/futures/diagnose`도 `/api/exchange/testnet-check`도
// 사람의 JWT를 요구한다. 그래서 실주문 명령을 누르기 전에 확인하려면
// 여전히 화면을 열어야 했고, 그 확인을 건너뛰면 **실주문으로 설정
// 문제를 발견하게 된다.** 배관을 확인하려고 배관에 물을 흘리는 셈이다.
//
// 여기서 하는 일은 **판정이 아니라 모으기**다. 판정은 전부 이미 있는
// 정본 함수들이 한다(`smokeTestnetVerdict` · `unresolvedExposureBlock` ·
// `killSwitchGate` · `liquidationGuard` · `preflightVerdict`). 같은
// 판단을 두 벌 두면 언젠가 갈린다 — 그러면 사전 점검이 초록인데
// 실제 시작은 막히는, 가장 쓸모없는 결과가 나온다.
//
// SKIPPED는 PASS가 아니다
// ───────────────────────
// 앞 단계가 막혀 뒤를 보지 못한 경우를 `SKIPPED`로 적는다. 그 줄이
// 하나라도 있으면 `ready`는 false다. **확인하지 못한 것을 통과로
// 적지 않는다.**

export type PreflightState = 'PASS' | 'FAIL' | 'UNKNOWN' | 'SKIPPED';

export interface PreflightCheck {
  id: PreflightCheckId;
  title: string;
  state: PreflightState;
  detail: string;
}

export type PreflightCheckId =
  /** 이 연결이 이 사용자 것인가 (자격증명을 읽었는가) */
  | 'CONNECTION_OWNED'
  /** 테스트넷임이 **확인**됐는가. null은 확인이 아니다 */
  | 'TESTNET_VERIFIED'
  /** 스모크 장부를 끝까지 읽었는가 (상한에 닿으면 읽은 것이 아니다) */
  | 'LEDGER_READABLE'
  /** 연결 단위로 정리되지 않은 노출이 없는가 */
  | 'NO_UNRESOLVED_EXPOSURE'
  /** 킬스위치가 꺼져 있는가 */
  | 'KILL_SWITCH_OFF'
  /** 청산 정책과 청산가 관문을 통과하는가 */
  | 'EXIT_POLICY_OK'
  /** 이 종목에 기존 포지션·조건부 주문이 없는가 */
  | 'SYMBOL_CLEAR'
  /** 묶음 표(smoke_runs)가 있는가 — 마이그레이션 053 */
  | 'RUN_TABLE_PRESENT';

/**
 * 모은 사실. **각 항목의 `null`은 "앞이 막혀 못 봤다"는 뜻**이고
 * SKIPPED가 된다. 보긴 봤는데 모르겠으면 그 항목 안에서 말한다.
 */
export interface PreflightFacts {
  creds: { ok: boolean; detail: string } | null;
  testnet: { ok: boolean; reason: string } | null;
  ledger: { readable: boolean; reason: string } | null;
  exposure: { blocked: boolean; code: string; reason: string } | null;
  killSwitch: { allowed: boolean; message: string } | null;
  exitPolicy: { ok: boolean; reason: string } | null;
  symbol: { ok: boolean; code: string; reason: string } | null;
  runTable: { present: boolean; reason: string } | null;
}

export interface PreflightReport {
  /** 전부 PASS일 때만 true. 하나라도 아니면 false */
  ready: boolean;
  checks: PreflightCheck[];
  /** PASS가 아닌 줄의 사유. 사람이 고칠 순서대로 */
  blockers: string[];
  summary: string;
}

const SKIP = '앞 단계가 막혀 확인하지 못했습니다';

/** 모으기만 한다. 판정은 넘겨받은 사실 안에 이미 들어 있다 */
export function buildPreflightReport(f: PreflightFacts): PreflightReport {
  const checks: PreflightCheck[] = [];
  const add = (id: PreflightCheckId, title: string, state: PreflightState, detail: string) =>
    checks.push({ id, title, state, detail });

  // ── 1. 연결 소유권 ──
  //
  // `loadFuturesCreds`가 `id`와 `user_id`를 **함께** 걸어 읽는다.
  // 남의 연결 id를 적으면 여기서 끝난다.
  if (f.creds == null) add('CONNECTION_OWNED', '연결 소유권', 'SKIPPED', SKIP);
  else add('CONNECTION_OWNED', '연결 소유권', f.creds.ok ? 'PASS' : 'FAIL', f.creds.detail);

  // ── 2. 테스트넷 확인 ──
  //
  // `is_testnet !== false`(저장소 일반 규칙)보다 좁다. 스모크는 없던
  // 주문을 새로 만들기 때문에, **확인되지 않음(null)도 거절**한다.
  if (f.testnet == null) add('TESTNET_VERIFIED', '테스트넷 확인', 'SKIPPED', SKIP);
  else add('TESTNET_VERIFIED', '테스트넷 확인', f.testnet.ok ? 'PASS' : 'FAIL', f.testnet.reason);

  // ── 3. 장부를 끝까지 읽었는가 ──
  if (f.ledger == null) add('LEDGER_READABLE', '스모크 장부 조회', 'SKIPPED', SKIP);
  else add('LEDGER_READABLE', '스모크 장부 조회',
    f.ledger.readable ? 'PASS' : 'FAIL', f.ledger.reason);

  // ── 4. 정리되지 않은 노출 ──
  //
  // 못 읽어서 막힌 것(`LEDGER_UNREADABLE` · `EXPOSURE_UNKNOWN`)과
  // 실제로 남아 있어서 막힌 것(`UNPROTECTED_UNRESOLVED`)을 **구분해
  // 적는다.** 둘 다 통과는 아니지만 사람이 할 일이 다르다.
  if (f.exposure == null) add('NO_UNRESOLVED_EXPOSURE', '미해결 노출 0', 'SKIPPED', SKIP);
  else if (!f.exposure.blocked) add('NO_UNRESOLVED_EXPOSURE', '미해결 노출 0', 'PASS', f.exposure.reason);
  else add('NO_UNRESOLVED_EXPOSURE', '미해결 노출 0',
    f.exposure.code === 'UNPROTECTED_UNRESOLVED' ? 'FAIL' : 'UNKNOWN', f.exposure.reason);

  // ── 5. 킬스위치 ──
  if (f.killSwitch == null) add('KILL_SWITCH_OFF', '킬스위치', 'SKIPPED', SKIP);
  else add('KILL_SWITCH_OFF', '킬스위치',
    f.killSwitch.allowed ? 'PASS' : 'FAIL', f.killSwitch.message);

  // ── 6. 청산 정책·청산가 ──
  if (f.exitPolicy == null) add('EXIT_POLICY_OK', '청산 정책 · 청산가 관문', 'SKIPPED', SKIP);
  else add('EXIT_POLICY_OK', '청산 정책 · 청산가 관문',
    f.exitPolicy.ok ? 'PASS' : 'FAIL', f.exitPolicy.reason);

  // ── 7. 종목 사전 확인 ──
  //
  // `preflightVerdict`가 그대로 판정한다. 조회 실패는 `UNKNOWN`이고,
  // **그것은 "없음"이 아니다.**
  if (f.symbol == null) add('SYMBOL_CLEAR', '종목 사전 확인', 'SKIPPED', SKIP);
  else if (f.symbol.ok) add('SYMBOL_CLEAR', '종목 사전 확인', 'PASS', f.symbol.reason);
  else add('SYMBOL_CLEAR', '종목 사전 확인',
    f.symbol.code === 'UNKNOWN' ? 'UNKNOWN' : 'FAIL', f.symbol.reason);

  // ── 8. 묶음 표 ──
  //
  // 표가 없으면 시작 요청이 503으로 끝난다. 실주문 명령을 누른 뒤에
  // 알 일이 아니다.
  if (f.runTable == null) add('RUN_TABLE_PRESENT', '묶음 표(smoke_runs)', 'SKIPPED', SKIP);
  else add('RUN_TABLE_PRESENT', '묶음 표(smoke_runs)',
    f.runTable.present ? 'PASS' : 'FAIL', f.runTable.reason);

  const notPass = checks.filter((c) => c.state !== 'PASS');
  const ready = notPass.length === 0;

  return {
    ready,
    checks,
    blockers: notPass.map((c) => `${c.title}: ${c.detail}`),
    summary: ready
      ? `사전 점검 ${checks.length}항목 전부 통과 — 실주문 스모크를 시작해도 됩니다`
      : `${checks.length}항목 중 ${notPass.length}항목이 통과하지 못했습니다 `
        + `(${notPass.map((c) => `${c.title}=${c.state}`).join(' · ')}) — 주문을 내지 않습니다`,
  };
}
