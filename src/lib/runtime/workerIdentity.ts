// src/lib/runtime/workerIdentity.ts
//
// **워커가 어디서 도는지는 워커가 안다. 사람이 알려 줄 일이 아니다.**
//
// 지금까지 화면의 공급자 이름은 두 번 틀렸다.
//
//   1. 화면 파일에 `Railway`라고 **글자로 박혀** 있었다. Fly로 옮긴 뒤에도
//      그 문구가 남아, 실제로는 Fly 워커가 살아 있는데 화면은
//      "Worker (Railway) · 없음"이라고 말했다.
//   2. 그 다음엔 `WORKER_PROVIDER` 환경변수로 옮겼다. 이번엔 **아무도 안
//      넣어서** 화면이 계속 '실행기'라고만 적었다.
//
// 두 번 다 같은 뿌리다 — **사실을 아는 쪽이 적지 않았다.** 워커는 자기가
// Fly 위에 있는지 안다. Fly가 `FLY_APP_NAME`·`FLY_MACHINE_ID`·
// `FLY_REGION`을 넣어 주기 때문이다. 그 값을 워커가 heartbeat에 적으면
// 사람이 넣을 것도, 화면이 지어낼 것도 없다.
//
// 모르면 모른다고 한다
// ────────────────────
// 아무 표시도 없으면 `null`이다. **heartbeat 행이 있다는 사실만으로
// 'Fly'라고 적지 않는다** — 그건 'Railway'라고 박아 둔 것과 똑같은
// 종류의 거짓말이고, 지금 맞고 나중에 틀린다.

export type WorkerProvider = 'FLY' | 'RAILWAY' | 'RENDER' | 'LOCAL' | null;

export interface WorkerIdentity {
  provider: WorkerProvider;
  /** 사람이 읽는 이름. 모르면 '실행기'(언제나 참인 말) */
  providerLabel: string;
  region: string | null;
  machineId: string | null;
  gitSha: string | null;
}

const PROVIDER_LABEL: Record<string, string> = {
  FLY: 'Fly', RAILWAY: 'Railway', RENDER: 'Render', LOCAL: '로컬',
};

/** 값이 실제로 들어 있는가. 빈 문자열은 없는 것으로 본다 */
function val(env: Record<string, any>, key: string): string | null {
  const v = String(env?.[key] ?? '').trim();
  return v ? v : null;
}

/**
 * 이 프로세스는 어디서 도는가.
 *
 * 플랫폼이 스스로 넣어 주는 변수만 본다. **`WORKER_PROVIDER` 같은
 * 사람이 넣는 값은 보지 않는다** — 사람이 넣는 값은 사람이 안 넣거나
 * 틀리게 넣는다. 실제로 둘 다 겪었다.
 */
export function detectProvider(env: Record<string, any>): WorkerProvider {
  const e = env || {};
  if (val(e, 'FLY_APP_NAME') || val(e, 'FLY_MACHINE_ID') || val(e, 'FLY_ALLOC_ID')) return 'FLY';
  if (val(e, 'RAILWAY_SERVICE_ID') || val(e, 'RAILWAY_PROJECT_ID') || val(e, 'RAILWAY_ENVIRONMENT')) return 'RAILWAY';
  if (val(e, 'RENDER_SERVICE_ID') || val(e, 'RENDER_INSTANCE_ID')) return 'RENDER';
  // 컨테이너 표시가 하나도 없으면 사람 컴퓨터일 가능성이 높다. 다만
  // **추측하지 않는다** — NODE_ENV가 production이면 어딘가의 서버다.
  if (String(e.NODE_ENV ?? '') !== 'production') return 'LOCAL';
  return null;
}

export function workerIdentityOf(env: Record<string, any>): WorkerIdentity {
  const e = env || {};
  const provider = detectProvider(e);
  return {
    provider,
    providerLabel: provider ? (PROVIDER_LABEL[provider] || provider) : '실행기',
    region: val(e, 'FLY_REGION') || val(e, 'RAILWAY_REGION') || val(e, 'RENDER_REGION') || null,
    machineId: val(e, 'FLY_MACHINE_ID') || val(e, 'FLY_ALLOC_ID')
      || val(e, 'RAILWAY_REPLICA_ID') || val(e, 'RENDER_INSTANCE_ID') || null,
    // 비어 있으면 **"같음"이 아니라 "모름"이다**
    gitSha: val(e, 'GIT_SHA') || val(e, 'RAILWAY_GIT_COMMIT_SHA') || val(e, 'RENDER_GIT_COMMIT') || null,
  };
}

// ── 지문 ──
//
// 값은 절대 내보내지 않는다. 웹과 워커가 각자 자기 값의 지문을 적고,
// 둘을 비교하면 **같은 것을 보고 있는지**를 값 없이 확인할 수 있다.

export function fingerprintPair(a: string | null | undefined, b: string | null | undefined):
  'SAME' | 'DIFFERENT' | 'UNKNOWN' {
  const x = String(a ?? '').trim(), y = String(b ?? '').trim();
  if (!x || !y) return 'UNKNOWN';   // 한쪽이라도 없으면 "같다"고 말하지 않는다
  return x === y ? 'SAME' : 'DIFFERENT';
}
