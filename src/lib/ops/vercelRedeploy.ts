// src/lib/ops/vercelRedeploy.ts
//
// **Vercel만 옛 코드로 떠 있을 때, 사람이 대시보드를 열지 않고 고친다.**
//
// 무엇을 보고 만들었나
// ────────────────────
// main c61271eb가 머지되고 6시간 36분 뒤의 실측이다:
//
//     main   c61271e
//     fly    c61271e   heartbeat 3초 전 · alive · main 락
//     vercel ae06912   ← 움직이지 않았다
//     migrations pending 0
//
// 전파 지연이 아니다. **Vercel 배포가 아예 일어나지 않았거나 실패한 것**이고,
// 그동안 워커는 새 코드로 돌면서 웹에는 없는 경로를 두드리고 있었다.
// `deployment-check`는 이것을 정확히 잡아냈지만, 고치는 일은 사람이
// 대시보드에서 해야 했다 — 자동화할 수 있는 절차를 사람에게 넘긴 것이다.
//
// **재배포를 아무 때나 누르면 안 되는 이유**
// ──────────────────────────────────────────
// MISMATCH는 한 가지 고장이 아니다. Fly가 뒤처졌을 수도, 마이그레이션이
// 승인 대기일 수도, 워커가 죽었을 수도 있다. 그때 Vercel을 다시 배포하면
// **고장은 그대로인데 빨강만 사라진다** — 그게 제일 나쁘다.
//
// 그래서 여기서 통과시키는 것은 **Vercel만 뒤처진 것이 증명된 경우 하나뿐**이다.
// 나머지는 전부 서로 다른 코드로 거절한다. "왜 안 눌렀는가"가 한 칸에
// 뭉뚱그려지면 다음 사람이 그 칸을 못 읽는다.
//
// **모르는 것을 skew로 적지 않는다.** 세 SHA 중 하나라도 못 읽었으면
// UNKNOWN이고, UNKNOWN은 "다르다"가 아니다.

/** 왜 눌렀는지 / 왜 안 눌렀는지. 한 칸에 뭉치지 않는다 */
export type RedeployCode =
  /** Vercel만 뒤처진 것이 증명됐다 — 깨운다 */
  | 'FIRE'
  /** hook이 없다. 이 경우 아무것도 하지 않는다 (기존 동작 그대로) */
  | 'SKIP_NO_HOOK'
  /** 이미 같다 */
  | 'SKIP_MATCHED'
  /** 세 SHA 중 못 읽은 것이 있다. **모름은 통과도 skew도 아니다** */
  | 'SKIP_UNKNOWN'
  /** Fly도 main과 다르다 — 배포 전체가 안 끝난 것이라 Vercel 문제가 아니다 */
  | 'SKIP_NOT_VERCEL_ONLY'
  /** 적용 안 된 마이그레이션이 있다. 재배포로 덮지 않는다 */
  | 'SKIP_MIGRATIONS_PENDING'
  /** 워커가 살아 있지 않다. 재배포로 덮지 않는다 */
  | 'SKIP_WORKER'
  /** 같은 SHA로 이미 여러 번 눌렀다 */
  | 'SKIP_ATTEMPTS_EXHAUSTED'
  /** 방금 눌렀다. 배포가 끝날 시간을 준다 */
  | 'SKIP_COOLDOWN';

export interface RedeployDecision {
  code: RedeployCode;
  /** hook을 실제로 깨울 것인가 */
  fire: boolean;
  reason: string;
}

export interface RedeployLimits {
  /** 같은 SHA에 대해 최대 몇 번까지 깨울 것인가 */
  maxAttempts: number;
  /** 직전 시도로부터 이만큼은 기다린다 (ms) */
  cooldownMs: number;
}

export const DEFAULT_LIMITS: RedeployLimits = { maxAttempts: 3, cooldownMs: 10 * 60_000 };

export interface RedeployInput {
  /** hook 주소가 설정돼 있는가. **값은 여기까지 오지 않는다** */
  hookConfigured: boolean;
  mainSha: string | null;
  vercelSha: string | null;
  flySha: string | null;
  /** 아직 적용되지 않은 마이그레이션 수. **못 읽었으면 null** */
  pendingCount: number | null;
  /** 워커 heartbeat가 살아 있는가. **못 읽었으면 null** */
  workerAlive: boolean | null;
  /** 같은 SHA로 지금까지 깨운 횟수. **세지 못했으면 null** */
  attempts: number | null;
  /** 마지막으로 깨운 시각 (ISO). 없으면 null */
  lastAttemptIso: string | null;
  /** 지금 (ms) */
  now: number;
  limits?: Partial<RedeployLimits>;
}

const norm = (v: string | null | undefined): string | null => {
  const s = String(v ?? '').trim().toLowerCase();
  return s ? s : null;
};
const short = (v: string | null): string => (v ? v.slice(0, 7) : '?');

/**
 * hook을 깨울 것인가.
 *
 * **순서가 계약이다.** hook 없음 → 모름 → 이미 같음 → Vercel만인가 →
 * 마이그레이션 → 워커 → 횟수 → 쿨다운. 앞의 것이 참이면 뒤는 보지 않는다.
 * 이 순서 때문에 "마이그레이션이 밀렸는데 재배포로 덮었다"가 생길 수 없다.
 */
export function redeployDecision(i: RedeployInput): RedeployDecision {
  const lim = { ...DEFAULT_LIMITS, ...(i.limits ?? {}) };
  const no = (code: RedeployCode, reason: string): RedeployDecision => ({ code, fire: false, reason });

  if (!i.hookConfigured) {
    return no('SKIP_NO_HOOK',
      'Deploy Hook이 설정되지 않았습니다 — 아무것도 하지 않습니다(기존 동작 그대로)');
  }

  const main = norm(i.mainSha);
  const vercel = norm(i.vercelSha);
  const fly = norm(i.flySha);
  if (!main || !vercel || !fly) {
    // **읽지 못한 것을 "다르다"로 적지 않는다.** 모르는 채로 누르면
    // 고장이 아닌 날에도 배포가 돈다.
    return no('SKIP_UNKNOWN',
      `SHA를 다 읽지 못했습니다 (main ${short(main)} · vercel ${short(vercel)} · fly ${short(fly)})`
      + ' — 모르는 것을 어긋남으로 적지 않습니다');
  }

  if (vercel === main) {
    return no('SKIP_MATCHED', `Vercel이 이미 main(${short(main)})입니다`);
  }

  if (fly !== main) {
    // Fly까지 뒤처졌으면 배포 자체가 안 끝난 것이다. Vercel만 다시
    // 밀어 봐야 나머지 절반은 그대로다.
    return no('SKIP_NOT_VERCEL_ONLY',
      `Fly도 main과 다릅니다 (fly ${short(fly)} · main ${short(main)})`
      + ' — Vercel만 뒤처진 경우가 아니므로 재배포로 덮지 않습니다');
  }

  if (i.pendingCount == null) {
    return no('SKIP_UNKNOWN',
      '남은 마이그레이션 수를 읽지 못했습니다 — 확인하지 못한 것을 0으로 적지 않습니다');
  }
  if (i.pendingCount > 0) {
    return no('SKIP_MIGRATIONS_PENDING',
      `적용되지 않은 마이그레이션이 ${i.pendingCount}개 있습니다`
      + ' — 스키마가 밀린 것을 재배포로 가리지 않습니다');
  }

  if (i.workerAlive !== true) {
    return no('SKIP_WORKER',
      i.workerAlive == null
        ? '워커 상태를 읽지 못했습니다 — 확인하지 못한 것을 정상으로 적지 않습니다'
        : '워커 heartbeat가 살아 있지 않습니다 — 워커 고장을 재배포로 가리지 않습니다');
  }

  if (i.attempts == null) {
    // **한도를 모르는 채로 누르지 않는다.** 세지 못했다는 것은 "0번"이
    // 아니라 "모른다"이고, 모르는 채로 누르면 무한 반복을 막을 방법이 없다.
    return no('SKIP_UNKNOWN',
      '같은 SHA로 몇 번 깨웠는지 세지 못했습니다 — 한도를 모르는 채로 누르지 않습니다');
  }
  if (i.attempts >= lim.maxAttempts) {
    return no('SKIP_ATTEMPTS_EXHAUSTED',
      `같은 SHA(${short(main)})로 이미 ${i.attempts}번 깨웠습니다`
      + ` (한도 ${lim.maxAttempts}) — 눌러서 안 되는 것은 눌러도 안 됩니다`);
  }

  if (i.lastAttemptIso) {
    const last = Date.parse(i.lastAttemptIso);
    if (Number.isFinite(last)) {
      const waited = i.now - last;
      if (waited < lim.cooldownMs) {
        const left = Math.ceil((lim.cooldownMs - waited) / 1000);
        return no('SKIP_COOLDOWN',
          `직전 시도로부터 ${Math.floor(waited / 1000)}초밖에 지나지 않았습니다`
          + ` — ${left}초 더 기다립니다(배포가 끝날 시간)`);
      }
    }
  }

  return {
    code: 'FIRE', fire: true,
    reason: `Vercel만 뒤처졌습니다 (main·fly ${short(main)} · vercel ${short(vercel)})`
      + ` — 재배포를 깨웁니다 (${i.attempts + 1}/${lim.maxAttempts})`,
  };
}

/** 깨운 뒤의 결말 */
export type RedeployOutcomeCode =
  /** 다시 읽었더니 Vercel이 main이다. **이것만이 성공이다** */
  | 'VERIFIED'
  /** hook은 받아들여졌는데 기다리는 동안 SHA가 바뀌지 않았다 */
  | 'FIRED_NOT_VERIFIED'
  /** hook 호출 자체가 실패했다 */
  | 'HOOK_FAILED';

export interface RedeployOutcome {
  code: RedeployOutcomeCode;
  ok: boolean;
  reason: string;
}

/**
 * **hook이 200을 줬다는 것은 "요청을 받았다"는 뜻이지 "배포됐다"는 뜻이 아니다.**
 *
 * 이 저장소는 정확히 그 혼동으로 #136에서 하루를 잃었다 — 배포 실행 기록은
 * 초록인데 운영에는 옛 코드가 떠 있었다. 그래서 성공은 **다시 읽은 Vercel
 * SHA가 main과 같을 때**만이다.
 */
export function redeployOutcome(i: {
  hookOk: boolean;
  hookStatus: number | null;
  mainSha: string | null;
  /** 기다린 뒤 다시 읽은 값. **못 읽었으면 null** */
  vercelShaAfter: string | null;
  waitedSec: number;
}): RedeployOutcome {
  if (!i.hookOk) {
    return { code: 'HOOK_FAILED', ok: false,
      reason: `Deploy Hook 호출이 실패했습니다 (HTTP ${i.hookStatus ?? '없음'})` };
  }
  const main = norm(i.mainSha);
  const after = norm(i.vercelShaAfter);
  if (main && after && after === main) {
    return { code: 'VERIFIED', ok: true,
      reason: `Vercel이 main(${short(main)})으로 바뀐 것을 확인했습니다 (${i.waitedSec}초 기다림)` };
  }
  return { code: 'FIRED_NOT_VERIFIED', ok: false,
    reason: `재배포는 요청됐지만 ${i.waitedSec}초 안에 Vercel이 main으로 바뀌지 않았습니다`
      + ` (vercel ${short(after)} · main ${short(main)}) — 호출 성공을 배포 성공으로 적지 않습니다` };
}
