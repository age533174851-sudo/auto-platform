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
