// src/lib/ops/secretSync.ts
//
// **"시크릿 동기화해" 한 마디로 끝나게 한다.**
//
// 지금까지 무엇을 사람이 했나
// ───────────────────────────
// `sync-secrets` 워크플로는 있었지만 하는 일이 반쪽이었다:
//
//   · Fly에는 밀어 넣는다 — 다만 사람이 `apply: true`로 손수 돌려야 한다
//   · **Vercel에는 아무것도 하지 않는다.** "관리 토큰이 없습니다"만 적는다
//   · 밀어 넣은 뒤 **실제로 맞았는지 확인하지 않는다.**
//     `flyctl secrets set`이 0을 돌려주면 성공으로 적는다
//
// 마지막이 이 저장소에서 가장 비싼 고장이었다. 2026-08-19에 워커는
// 멀쩡히 돌고 배포는 성공이고 Fly는 started라고 하는데 화면은 아무것도
// 못 봤다 — 다른 데이터베이스를 보고 있었다. 사흘을 잃었다.
//
// **밀어 넣은 것과 맞은 것은 다르다.** 그래서 이 파일의 마지막 판정은
// "밀어 넣었는가"가 아니라 **"지문이 실제로 같아졌는가"**다.
//
// 롤백이 없는 이유
// ────────────────
// 되돌릴 곳이 없다. GitHub Secrets가 유일한 기준이고, 이전 값은
// **아무도 갖고 있지 않다** — Fly도 Vercel도 지문(다이제스트)만 준다.
// "이전 값으로 되돌렸습니다"라고 적으려면 그 값을 어딘가 보관해야 하고,
// 그건 비밀을 한 곳 더 늘리는 일이다.
//
// 그래서 되돌리는 대신 **틀렸다는 것을 크게 말하고 신규 진입을 막는다.**
// 이미 열린 포지션의 청산·보호는 계속 돈다 — 못 여는 것은 불편이고
// 못 닫는 것은 사고다.
//
// 값은 다루지 않는다
// ─────────────────
// 이 파일에는 비밀 값이 들어오지 않는다. **지문만 오간다.**

/** 웹과 워커가 반드시 같아야 하는 것들 */
export const SYNCED_NAMES = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'EXCHANGE_ENCRYPTION_KEY',
  'ADMIN_SECRET',
] as const;
export type SyncedName = typeof SYNCED_NAMES[number];

export type Destination = 'vercel' | 'fly';

export type StepCode =
  /** 기준값이 GitHub Secrets에 없다 — 사람이 한 번 넣어야 한다 */
  | 'SOURCE_MISSING'
  /** 밀어 넣을 자격이 없다 — 최초 권한 연결이 안 됐다 */
  | 'NO_CREDENTIAL'
  /** 이미 같다 — 밀어 넣지 않는다 */
  | 'ALREADY_SAME'
  /** 밀어 넣어야 한다 */
  | 'PUSH'
  /** 지문을 못 읽어 같은지 다른지 모른다 */
  | 'UNKNOWN';

export interface SyncStep {
  name: SyncedName;
  destination: Destination;
  code: StepCode;
  reason: string;
  /** 이 값이 어긋나면 무슨 일이 나는가 */
  consequence: string;
}

const CONSEQUENCE: Record<SyncedName, string> = {
  SUPABASE_URL:
    '워커가 다른 데이터베이스에 씁니다 — 워커는 멀쩡히 도는데 화면은 아무것도 못 봅니다',
  SUPABASE_SERVICE_ROLE_KEY:
    '워커가 표를 읽고 쓰지 못합니다 — 주문 기록이 남지 않습니다',
  EXCHANGE_ENCRYPTION_KEY:
    '저장된 거래소 키를 풀지 못합니다 — 증상은 "키가 틀렸다"로 보여서 사람이 거래소에서 키를 다시 발급받게 됩니다',
  ADMIN_SECRET:
    '워커가 웹의 청산 감시를 부르지 못합니다 — 트레일링·본전이동·시간청산이 돌지 않습니다',
};

/** 지문 하나를 비교한다. **한쪽이라도 없으면 "같다"고 말하지 않는다** */
function same(a: string | null | undefined, b: string | null | undefined): boolean | null {
  const x = String(a ?? '').trim(), y = String(b ?? '').trim();
  if (!x || !y) return null;
  return x === y;
}

export interface SyncPlanInput {
  /** GitHub Secrets 기준 지문. 값이 아니라 지문이다. 없으면 null */
  sourceFp: Partial<Record<SyncedName, string | null>>;
  /** 지금 Vercel(웹)이 들고 있는 지문. **못 읽었으면 undefined** */
  vercelFp?: Partial<Record<SyncedName, string | null>>;
  /** 지금 Fly(워커)가 들고 있는 지문 */
  flyFp?: Partial<Record<SyncedName, string | null>>;
  canPushVercel: boolean;
  canPushFly: boolean;
}

export interface SyncPlanResult {
  steps: SyncStep[];
  /** 실제로 밀어 넣을 것 */
  push: Array<{ name: SyncedName; destination: Destination }>;
  /** 사람이 한 번 해 줘야 풀리는 것들 */
  bootstrap: string[];
}

/**
 * 무엇을 어디에 밀어 넣을 것인가.
 *
 * **이미 같은 것은 밀지 않는다.** 미는 것은 재시작을 뜻하고, 재시작은
 * 그 순간 열려 있는 포지션의 감시를 잠깐 끊는다. 이유 없이 하지 않는다.
 *
 * **모르는 것은 민다.** 지문을 못 읽었다면 같다는 증거가 없다 —
 * 여기서 "아마 같겠지"로 넘기면 사흘을 잃는 그 고장이 그대로 남는다.
 */
export function syncPlanOf(i: SyncPlanInput): SyncPlanResult {
  const steps: SyncStep[] = [];
  const push: Array<{ name: SyncedName; destination: Destination }> = [];
  const bootstrap: string[] = [];

  const dests: Array<{ d: Destination; can: boolean; fp?: Partial<Record<SyncedName, string | null>>; token: string }> = [
    { d: 'vercel', can: !!i?.canPushVercel, fp: i?.vercelFp, token: 'VERCEL_TOKEN' },
    { d: 'fly', can: !!i?.canPushFly, fp: i?.flyFp, token: 'FLY_API_TOKEN' },
  ];

  for (const name of SYNCED_NAMES) {
    const src = i?.sourceFp?.[name] ?? null;
    for (const { d, can, fp, token } of dests) {
      const consequence = CONSEQUENCE[name];
      if (!src) {
        steps.push({ name, destination: d, code: 'SOURCE_MISSING',
          reason: `기준값이 GitHub Secrets에 없습니다 — 사람이 한 번 넣어야 합니다`, consequence });
        if (!bootstrap.includes(`GitHub Secrets에 ${name}을(를) 넣어 주세요`)) {
          bootstrap.push(`GitHub Secrets에 ${name}을(를) 넣어 주세요`);
        }
        continue;
      }
      if (!can) {
        steps.push({ name, destination: d, code: 'NO_CREDENTIAL',
          reason: `${d}에 밀어 넣을 자격이 없습니다 (${token})`, consequence });
        const msg = `${d}에 ${token}을(를) 한 번 연결해 주세요`;
        if (!bootstrap.includes(msg)) bootstrap.push(msg);
        continue;
      }
      const eq = same(src, fp?.[name]);
      if (eq === true) {
        steps.push({ name, destination: d, code: 'ALREADY_SAME',
          reason: '이미 같습니다 — 재시작시키지 않습니다', consequence });
        continue;
      }
      if (eq === null) {
        // **모르는 것을 같다고 하지 않는다.** 밀어서 확실하게 만든다.
        steps.push({ name, destination: d, code: 'UNKNOWN',
          reason: `${d} 쪽 지문을 읽지 못했습니다 — 같다는 증거가 없으므로 밀어 넣습니다`, consequence });
        push.push({ name, destination: d });
        continue;
      }
      steps.push({ name, destination: d, code: 'PUSH',
        reason: '지문이 다릅니다', consequence });
      push.push({ name, destination: d });
    }
  }

  return { steps, push, bootstrap };
}

// ── 밀어 넣은 뒤 ──────────────────────────────────────────

export type VerifyCode =
  /** 웹·워커·기준이 전부 같다 */
  | 'SYNCED'
  /** 아직 다르다 */
  | 'MISMATCH'
  /** 워커가 아직 새 값으로 안 떴다 — 조금 더 기다리면 된다 */
  | 'WORKER_STALE'
  /** 확인하지 못했다. **맞았다는 뜻이 아니다** */
  | 'UNKNOWN';

export interface VerifyResult {
  code: VerifyCode;
  /** 아직 어긋난 이름들 */
  mismatched: string[];
  reason: string;
}

/**
 * 실제로 맞았는가.
 *
 * **`flyctl secrets set`이 0을 돌려준 것은 "맞았다"가 아니다.**
 * 그건 "명령을 받았다"이다. 이 저장소가 사흘을 잃은 고장이 정확히 그
 * 구분이 무너져서 났다 — 로그에는 성공이 남고 워커는 다른 DB를 봤다.
 *
 * 그래서 밀어 넣은 값이 아니라 **실행 중인 두 프로세스가 실제로 들고
 * 있는 지문**을 본다(`/api/system/runtime-health`).
 */
export function syncVerify(i: {
  sourceFp: Partial<Record<SyncedName, string | null>>;
  /** 지금 돌고 있는 웹이 들고 있는 지문 */
  webFp: { SUPABASE_URL?: string | null; EXCHANGE_ENCRYPTION_KEY?: string | null } | null | undefined;
  /** 워커가 마지막으로 적은 지문 */
  workerFp: { SUPABASE_URL?: string | null; EXCHANGE_ENCRYPTION_KEY?: string | null } | null | undefined;
  /** 워커 기록이 배포보다 오래됐는가 */
  workerStale?: boolean;
}): VerifyResult {
  if (!i?.webFp || !i?.workerFp) {
    return { code: 'UNKNOWN', mismatched: [],
      reason: '웹 또는 워커의 지문을 읽지 못했습니다 — 맞았다는 뜻이 아닙니다' };
  }

  // 웹·워커가 실제로 들고 있는 것만 비교할 수 있다. 나머지 둘
  // (SERVICE_ROLE_KEY · ADMIN_SECRET)은 어느 쪽도 지문을 노출하지 않는다.
  const checkable: SyncedName[] = ['SUPABASE_URL', 'EXCHANGE_ENCRYPTION_KEY'];
  const mismatched: string[] = [];
  let unknown = false;

  for (const n of checkable) {
    const src = i.sourceFp?.[n] ?? null;
    const web = (i.webFp as any)[n] ?? null;
    const wk = (i.workerFp as any)[n] ?? null;
    const webOk = src ? same(src, web) : same(web, wk);
    const wkOk = src ? same(src, wk) : same(web, wk);
    if (webOk === null || wkOk === null) { unknown = true; continue; }
    if (!webOk) mismatched.push(`${n}(웹)`);
    if (!wkOk) mismatched.push(`${n}(워커)`);
  }

  if (mismatched.length > 0) {
    if (i?.workerStale && mismatched.every(m => m.endsWith('(워커)'))) {
      return { code: 'WORKER_STALE', mismatched,
        reason: '워커가 아직 새 값으로 다시 뜨지 않았습니다 — 재배포가 끝나면 다시 확인합니다' };
    }
    return { code: 'MISMATCH', mismatched,
      reason: `밀어 넣었는데도 ${mismatched.join(', ')}의 지문이 다릅니다 — `
        + '되돌릴 이전 값은 아무도 갖고 있지 않으므로(지문만 남습니다) '
        + '신규 진입을 막고 사람이 봐야 합니다' };
  }
  if (unknown) {
    return { code: 'UNKNOWN', mismatched: [],
      reason: '일부 지문을 읽지 못했습니다 — 맞았다는 뜻이 아닙니다' };
  }
  return { code: 'SYNCED', mismatched: [], reason: '웹과 워커가 같은 값을 들고 있습니다' };
}

export type SyncOutcome = 'READY' | 'SELF_HEALED' | 'BOOTSTRAP_REQUIRED' | 'BLOCKED';

export interface SyncReport {
  outcome: SyncOutcome;
  /** 신규 진입을 허용하는가. **청산·보호는 이 값과 무관하게 계속 돈다** */
  entryAllowed: boolean;
  summary: string;
  /** 사람이 해야 할 일. 비어 있는 것이 목표다 */
  humanTodo: string[];
}

/**
 * 한 번의 동기화가 어떻게 끝났는가.
 *
 * **네 가지 말고 다른 상태를 만들지 않는다.** 보고에 "대체로 잘 됐습니다"
 * 같은 것이 생기면 그 뒤로 아무도 안 본다.
 */
export function syncReport(i: {
  plan: SyncPlanResult;
  pushed: number;
  verify: VerifyResult | null;
}): SyncReport {
  const bootstrap = i?.plan?.bootstrap ?? [];

  // 자격이나 기준값이 없어 아예 못 민 것이 있으면, 나머지가 맞았는지와
  // 무관하게 **사람이 한 번 해 줘야 한다.**
  if (bootstrap.length > 0) {
    return {
      outcome: 'BOOTSTRAP_REQUIRED', entryAllowed: true,
      summary: `${bootstrap.length}가지는 최초 권한 연결이 없어 자동으로 맞추지 못했습니다`,
      humanTodo: bootstrap,
    };
  }
  if (!i?.verify) {
    return {
      outcome: 'BLOCKED', entryAllowed: false,
      summary: '밀어 넣은 뒤 확인하지 못했습니다 — 맞았다는 뜻이 아닙니다',
      humanTodo: ['/api/system/runtime-health 에서 웹·워커 지문을 확인해 주세요'],
    };
  }
  if (i.verify.code === 'MISMATCH') {
    return {
      outcome: 'BLOCKED', entryAllowed: false,
      summary: i.verify.reason,
      humanTodo: ['GitHub Secrets의 값 자체가 맞는지 확인해 주세요 — '
        + '밀어 넣기는 성공했는데 지문이 다르면 기준값이 틀린 것입니다'],
    };
  }
  if (i.verify.code === 'UNKNOWN' || i.verify.code === 'WORKER_STALE') {
    return {
      outcome: 'BLOCKED', entryAllowed: false,
      summary: i.verify.reason,
      humanTodo: [],
    };
  }
  if (Number(i?.pushed) > 0) {
    return {
      outcome: 'SELF_HEALED', entryAllowed: true,
      summary: `${i.pushed}개를 맞추고 지문으로 확인했습니다`,
      humanTodo: [],
    };
  }
  return {
    outcome: 'READY', entryAllowed: true,
    summary: '이미 전부 같습니다 — 아무것도 재시작시키지 않았습니다',
    humanTodo: [],
  };
}
