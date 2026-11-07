// src/lib/engine/exitMonitorWake.ts
//
// ⑤B-3A-1.1 — **누가 깨웠는지, 예정보다 얼마나 늦었는지**의 정본.
//
// 무엇이 틀려 있었나
// ─────────────────
// exit-monitor 라우트는 이렇게 적고 있었다:
//
//     const runner = String(req.headers.get('x-traigo-source') || '').trim()
//       || 'manual';
//
// Worker는 `x-traigo-source: worker`, GitHub Actions는 `github-backup`을
// 보낸다. 그런데 **Vercel Cron은 `Authorization: Bearer <CRON_SECRET>`으로
// 인증하고 `x-traigo-source`를 보내지 않는다.** 그래서 실제 자동 Vercel
// cron 호출이 전부 `manual`로 적혔다.
//
// 이건 UNKNOWN이 아니라 **거짓 provenance**다. "확인하지 못한 것을 통과로
// 적지 않는다"와 같은 종류의 잘못이고, 더 나쁘다 — 모른다고 적는 대신
// 틀린 값을 적었다.
//
// 어떻게 고치는가
// ──────────────
// 인증 결과를 boolean으로 버리지 않는다. **어느 인증 경로로 들어왔는지**를
// 남기면, 헤더가 없어도 복원할 수 있는 최소 사실이 생긴다.
//
//     explicit x-traigo-source 있음  → 그 값 그대로 (worker / github-backup / manual)
//     없음 + CRON_BEARER             → 'cron-bearer'
//     없음 + ADMIN_HEADER            → 'unattributed-admin'
//     인증 실패                      → null (실행 자체가 없다)
//
// `manual`은 **실제 manual caller가 명시했을 때만** 쓴다.
//
// ★ 인증과 provenance는 별개다. 여기 있는 어떤 값도 인증 근거가 아니다.
//   Vercel 고유 user-agent나 헤더를 보더라도 그것만으로 인증하지 않는다 —
//   인증은 secret 비교(`CRON_SECRET` / `ADMIN_SECRET`)가 전부다.
//
// ★ 여기 있는 어떤 값도 **주문·청산 권한 판단에 쓰지 않는다.** telemetry
//   provenance 전용이다. cadence가 느리다는 이유로 청산을 앞당기는 따위의
//   일이 생기면 그 순간 이 파일은 실행 경로가 된다.

/** 어느 인증 경로로 들어왔는가. **값이 아니라 경로다** */
export type WakeAuthKind =
  /** Vercel Cron — `Authorization: Bearer <CRON_SECRET>` */
  | 'CRON_BEARER'
  /** Worker·수동 점검 — `x-admin-secret` */
  | 'ADMIN_HEADER'
  /** 어느 쪽도 맞지 않았다 — 실행되지 않는다 */
  | 'NONE';

export interface WakeAuth {
  ok: boolean;
  kind: WakeAuthKind;
}

/** 누가 불렀는지 명시하는 헤더 (058 `exit_monitor_runs.source`와 같은 정본) */
export const WAKE_SOURCE_HEADER = 'x-traigo-source';
/** 부른 쪽이 **실제로 쓰는** 간격. telemetry 전용 */
export const WAKE_INTERVAL_HEADER = 'x-traigo-exit-interval-ms';
/** 부른 쪽이 **정확히 계산할 수 있을 때만** 보내는 예정 시각(epoch ms). telemetry 전용 */
export const WAKE_EXPECTED_AT_HEADER = 'x-traigo-exit-expected-at-ms';

/**
 * Bearer cron으로 들어왔는데 source 헤더가 없을 때의 이름.
 *
 * `vercel-cron`이라고 쓰지 않는다. 이 secret path를 Vercel만 쓴다는 **계약이
 * 정본으로 적혀 있지 않기** 때문이다 — 같은 `CRON_SECRET`을 들고 부르는
 * 다른 호출자가 생기면 그 순간 거짓말이 된다. 확인한 사실은 "Bearer cron
 * 경로였다"까지다.
 */
export const WAKE_SOURCE_CRON_BEARER = 'cron-bearer';
/** admin secret으로 들어왔는데 자기가 누구인지 안 밝혔다 */
export const WAKE_SOURCE_UNATTRIBUTED_ADMIN = 'unattributed-admin';

/**
 * 누가 깨웠는가.
 *
 * **추측하지 않는다.** 인증되지 않았으면 null이고, 그 호출은 애초에
 * 실행되지 않는다. 헤더가 없다고 `manual`로 적지 않는다.
 */
export function resolveWakeSource(
  explicit: string | null | undefined,
  authKind: WakeAuthKind,
): string | null {
  const s = String(explicit ?? '').trim();
  if (s) return s;
  if (authKind === 'CRON_BEARER') return WAKE_SOURCE_CRON_BEARER;
  if (authKind === 'ADMIN_HEADER') return WAKE_SOURCE_UNATTRIBUTED_ADMIN;
  return null;
}

export interface WakeCadence {
  /**
   * 부른 쪽이 **실제로 쓰는** 간격. 라우트는 자기 상수로 채우지 않는다 —
   * Worker 간격은 env로 바뀌고, GitHub·Vercel은 예정이 서로 다르다.
   */
  intervalMs: number | null;
  /**
   * 예정보다 얼마나 늦게 깨어났는가 (양수 = 늦음).
   *
   * ★ 이것은 **두 기계의 epoch 시계 차**다. 같은 프로세스 안에서 잰
   *   `…ElapsedMs` 계열(monotonic)과 **같은 축이 아니다.** 빼거나 더하지
   *   않는다. 시계 틀어짐만큼의 오차가 들어 있다.
   */
  delayMs: number | null;
}

function finiteNum(v: string | null | undefined): number | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * 받은 헤더에서 cadence를 읽는다.
 *
 * **모르면 null이다.** 예정 시각을 모르는데 5분이라고 가정해 빼지 않고,
 * 0으로 적지도 않는다 — 0은 "정시에 깨어났다"는 **다른 사실**이다.
 * cron 문자열만 보고 가장 가까운 예정시각을 지어내지도 않는다.
 */
export function resolveWakeCadence(i: {
  intervalHeader?: string | null;
  expectedAtHeader?: string | null;
  observedAtMs: number;
}): WakeCadence {
  const iv = finiteNum(i?.intervalHeader);
  const intervalMs = iv != null && iv > 0 ? iv : null;

  const exp = finiteNum(i?.expectedAtHeader);
  const observed = Number(i?.observedAtMs);
  // 예정 시각이 epoch으로 말이 되지 않으면 **쓰지 않는다**. 0이나 음수,
  // 초 단위(1e10 미만)로 잘못 보낸 값은 빼면 수십 년짜리 지연이 된다.
  const usable = exp != null && exp > 1e12 && Number.isFinite(observed);
  const delayMs = usable ? observed - (exp as number) : null;

  return { intervalMs, delayMs };
}

/**
 * 부르는 쪽(Worker)이 붙일 cadence 헤더.
 *
 * 규칙:
 *   · interval  = 부르는 쪽이 **실제로 쓰는** 값
 *   · expectedAt = **직전 실행 시각이 있을 때만** (lastRunMs + interval)
 *   · 첫 tick이면 expectedAt 없음
 *   · 모르는 값은 **헤더 자체를 보내지 않는다** — 빈 문자열도 보내지 않는다
 */
export function wakeCadenceHeaders(i: {
  lastRunMs: number | null;
  intervalMs: number | null;
}): Record<string, string> {
  const h: Record<string, string> = {};
  const iv = Number(i?.intervalMs);
  if (Number.isFinite(iv) && iv > 0) h[WAKE_INTERVAL_HEADER] = String(Math.round(iv));

  const last = i?.lastRunMs;
  // 첫 tick(lastRunMs == null)에는 예정 시각이 없다. **지어내지 않는다.**
  if (typeof last === 'number' && Number.isFinite(last) && last > 0
      && Number.isFinite(iv) && iv > 0) {
    h[WAKE_EXPECTED_AT_HEADER] = String(Math.round(last + iv));
  }
  return h;
}
