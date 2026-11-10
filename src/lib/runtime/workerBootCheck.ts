// src/lib/runtime/workerBootCheck.ts
//
// **"뜨는가"와 "매매하는가"를 가르는 한 스위치.**
//
// 무엇이 문제였나
// ───────────────
// 워커는 실 `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` + 암호화 키를
// 받는 순간 `tick()`에 들어가고, 그 안에서 `processPendingJobs()`가
// **락과 무관하게 항상** 돈다. 즉 지금까지는
//
//   부팅을 확인하는 방법 = 실제로 일을 시작시키는 것
//
// 이것뿐이었다. 호스팅을 옮길 때(Fly → Railway 등) "일단 떠 보기"를
// 할 수가 없다. 그래서 환경변수를 넣는 순간이 곧 매매 시작이 된다.
//
// 이 모듈이 하는 일
// ─────────────────
// `WORKER_BOOT_CHECK`가 켜져 있으면 워커는 **필수 환경변수만 확인하고
// 종료한다.** DB에 연결하지 않고, 쓰지 않고, 거래소를 부르지 않고,
// `tick()`에 들어가지 않는다.
//
// 통과는 "부팅 가능"만 뜻한다 — **"매매 가능"을 뜻하지 않는다.**
// 그 둘을 한 단어로 묶는 것이 이 파일이 막으려는 것이다.

/** 이 값들이 없으면 워커는 돌아도 아무것도 할 수 없다 */
export interface RequiredEnvRule {
  /** 사람에게 보여 줄 이름 */
  readonly label: string;
  /** 이 중 하나라도 값이 있으면 충족 */
  readonly anyOf: readonly string[];
}

/**
 * 필수 환경변수 규칙. **한 곳에만 둔다.**
 *
 * `startupChecks()`와 부팅 점검이 각자 목록을 들고 있으면 언젠가 갈리고,
 * 그때 갈리는 쪽은 "없어도 뜨는" 쪽이다.
 */
export const REQUIRED_ENV: readonly RequiredEnvRule[] = [
  { label: 'SUPABASE_URL', anyOf: ['SUPABASE_URL'] },
  { label: 'SUPABASE_SERVICE_ROLE_KEY', anyOf: ['SUPABASE_SERVICE_ROLE_KEY'] },
  // 두 이름을 모두 받는다. 저장소 안에 둘 다 돌아다닌다.
  { label: 'EXCHANGE_ENCRYPTION_KEY (또는 ENCRYPTION_KEY)', anyOf: ['EXCHANGE_ENCRYPTION_KEY', 'ENCRYPTION_KEY'] },
];

/** 값이 있다고 볼 수 있는가. 빈 문자열·공백은 **없는 것**이다 */
function present(v: unknown): boolean {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * 비어 있는 필수 환경변수의 **이름**을 돌려준다. 값은 절대 돌려주지 않는다.
 *
 * 빈 배열이면 전부 있다는 뜻이다.
 */
export function missingRequiredEnv(env: Record<string, unknown> | undefined | null): string[] {
  const e = env ?? {};
  return REQUIRED_ENV
    .filter(rule => !rule.anyOf.some(k => present(e[k])))
    .map(rule => rule.label);
}

/**
 * 부팅 점검 모드인가.
 *
 * **기본은 꺼짐이다.** 운영 부팅이 이 스위치 때문에 조용히 일을 멈추는
 * 쪽이 훨씬 위험하므로, 알 수 없는 값은 꺼진 것으로 읽는다.
 */
export function bootCheckRequested(env: Record<string, unknown> | undefined | null): boolean {
  const raw = (env ?? {}).WORKER_BOOT_CHECK;
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'on', 'yes', 'y'].includes(raw.trim().toLowerCase());
}

/** 부팅 점검이 끝났을 때 사람이 읽을 줄. 통과를 '매매 가능'으로 읽지 않게 적는다 */
export const BOOT_CHECK_MARKER = '[worker] 부팅 점검 모드';
export const BOOT_CHECK_PASS =
  '✅ 부팅 점검 통과 — 필수 환경변수가 있습니다. '
  + '이것은 "부팅 가능"이며 **"매매 가능"을 뜻하지 않습니다** (DB 연결 0 · 주문 0 · tick 0).';
// ── 숫자로 읽는 환경변수 ──────────────────────────────────────
//
// **오타 하나가 조용히 동작을 바꾼다.** 호스팅을 옮길 때 이 7개를 손으로
// 다시 타이핑하므로, 이건 "일어날 수도 있는 일"이 아니라 Railway 이전의
// 기본 위험이다. 그리고 지금 이걸 보는 검사기가 **하나도 없다.**
//
// 실제로 재어 본 것 (빌드된 `worker/dist/worker/src/supabase.js`를 그대로 호출):
//
//   WORKER_POLL_SEC=abc
//     → POLL_SEC = Math.max(1, Math.min(15, parseInt('abc', 10))) = **NaN**
//     → acquireLock(..., NaN): `new Date(now + NaN).toISOString()`이
//       **그 함수의 try 바깥(선언부)에서** RangeError를 던진다
//       (ttlSec=12 → 반환 false · ttlSec=NaN → 예외가 밖으로 나옴, 둘 다 측정)
//     → tick()의 `catch { isMain = true }`가 그걸 받는다
//     → **모든 워커가 자기를 main이라고 믿는다** — 중복 main 진입
//     → 덤으로 `sleep(Math.max(500, NaN))` = `sleep(NaN)` ≈ 0ms → 전속 회전
//
//   LEDGER_SYNC_INTERVAL_MS=abc · EQUITY_SNAPSHOT_INTERVAL_MS=abc
//     → `now - last < NaN`이 **항상 false** → "너무 이르다"가 뒤집혀
//       15분마다가 아니라 **매 tick** 돈다
//
//   EXIT_MONITOR / PAPER_EXIT / CHALLENGE_SWEEP / SCHEDULED_EXIT_INTERVAL_MS
//     → `exitMonitorPlan`의 `Number.isFinite` 가드가 기본값으로 되돌린다.
//       동작은 안전하지만 **사람은 자기 설정이 무시된 줄 모른다.**
//
// 왜 기본값으로 덮지 않는가
// ─────────────────────────
// 조용히 되돌리면 오타는 영원히 남고, 그 환경은 "내가 적은 간격으로
// 돈다"고 잘못 믿는다. 체크리스트를 자동으로 눌러 주는 것보다 **그 칸을
// 없애는 쪽**이 낫다.
//
// 왜 읽는 방식을 규칙에 적는가
// ────────────────────────────
// `WORKER_POLL_SEC`은 `parseInt`로 읽고(`'7s'` → 7) 나머지는 `Number`로
// 읽는다(`'7s'` → NaN). 검사기가 한 가지 방식으로만 재면 **실제 동작과
// 다른 판정**을 내린다. 그래서 규칙이 읽는 방식을 같이 들고 있고,
// `scripts/worker-boot-check.test.mjs`가 이 표와 **`worker/src/*.ts` 전부**의
// 실제 코드가 어긋나지 않는지 파일을 읽어서 확인한다.
//
// 왜 한 파일이 아니라 전부인가 — 탐침으로 재어 봤다. `index.ts`만 훑던
// 동안에는 `redis.ts`에 `Number(process.env.X)`를 더해도 대조 시험이
// **9/9로 통과했다.** 같은 판단이 두 경로에 있으면 언젠가 갈린다.
//
// 이 표는 **워커의** 칸만 덮는다. 웹(`src/`)의 env는 다른 표면이고 이
// 부팅 점검이 보지 않는다 — 우연이 아니라 범위다.

/**
 * 숫자 환경변수를 워커가 실제로 어떻게 읽는지.
 *
 * 세 방식이 **같은 문자열을 다르게 읽는다.** 그래서 규칙이 방식을 들고
 * 있어야 검사기가 실제 동작과 같은 판정을 낸다:
 *
 *   '7s'   → parseInt 7 · Number NaN · parseFloat 7
 *   '1.5'  → parseInt 1 · Number 1.5 · parseFloat 1.5
 *   'abc'  → 셋 다 NaN
 */
export type NumericParse = 'parseInt' | 'Number' | 'parseFloat';

export interface NumericEnvRule {
  readonly name: string;
  /** 워커 코드가 쓰는 방식 그대로 */
  readonly parse: NumericParse;
  /** 이 값보다 작으면 거부한다 */
  readonly min: number;
}

/** 워커가 숫자로 읽는 환경변수 전부. 하나라도 빠지면 그 칸이 다시 조용해진다 */
export const NUMERIC_ENV: readonly NumericEnvRule[] = [
  { name: 'WORKER_POLL_SEC', parse: 'parseInt', min: 1 },
  { name: 'EXIT_MONITOR_INTERVAL_MS', parse: 'Number', min: 1 },
  { name: 'PAPER_EXIT_INTERVAL_MS', parse: 'Number', min: 1 },
  { name: 'CHALLENGE_SWEEP_INTERVAL_MS', parse: 'Number', min: 1 },
  { name: 'SCHEDULED_EXIT_INTERVAL_MS', parse: 'Number', min: 1 },
  { name: 'LEDGER_SYNC_INTERVAL_MS', parse: 'Number', min: 1 },
  { name: 'EQUITY_SNAPSHOT_INTERVAL_MS', parse: 'Number', min: 1 },
];

/**
 * **있는데 숫자가 아닌** 환경변수의 이름과 이유를 돌려준다.
 *
 * 없는 것은 문제가 아니다 — 전부 기본값이 있다. 문제는 **있는데 숫자가
 * 아닌 것**이고, 그건 지금 아무 데서도 걸리지 않는다.
 *
 * 값은 돌려주지 않는다. 글자 수만 적는다 — 시크릿을 숫자 칸에 잘못
 * 붙여 넣었을 때도 로그에 값이 남아서는 안 된다.
 */
/**
 * 문자열을 **워커가 읽는 방식 그대로** 숫자로 읽는다.
 *
 * 따로 내보내는 이유: 지금 `parseFloat` 를 쓰는 칸이 하나도 없어서, 표를
 * 통해서만 부르면 그 가지는 **아무 시험도 지나가지 않는 죽은 코드**가 된다.
 * 여기서 직접 셋 다 센다.
 */
export function readNumeric(text: string, parse: NumericParse): number {
  if (parse === 'parseInt') return parseInt(text, 10);
  if (parse === 'parseFloat') return parseFloat(text);
  return Number(text);
}

export function invalidNumericEnv(
  env: Record<string, unknown> | undefined | null,
): { name: string; reason: string }[] {
  const e = env ?? {};
  const bad: { name: string; reason: string }[] = [];
  for (const rule of NUMERIC_ENV) {
    const raw = e[rule.name];
    if (!present(raw)) continue;            // 없는 것은 기본값으로 간다
    const text = String(raw).trim();
    const n = readNumeric(text, rule.parse);
    if (!Number.isFinite(n)) {
      bad.push({ name: rule.name, reason: `숫자로 읽히지 않습니다 (${text.length}자)` });
      continue;
    }
    if (n < rule.min) {
      bad.push({ name: rule.name, reason: `${rule.min} 미만입니다 (${n})` });
    }
  }
  return bad;
}
