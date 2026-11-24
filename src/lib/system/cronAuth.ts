// src/lib/system/cronAuth.ts
//
// **깨우는 쪽이 들어올 수 있는지 판정하는 한 곳.**
//
// 무엇이 문제였나
// ───────────────
// 같은 판정이 라우트마다 따로 적혀 있었다. `safeEqual`은 글자까지 똑같이
// 두 번 복제돼 있었고, 더 나쁜 것은 **받는 경로가 달랐다**:
//
//   /api/autotrade/exit-monitor   Bearer CRON_SECRET  +  x-admin-secret
//   /api/paper/exit-monitor       x-admin-secret 만
//
// Vercel Cron은 `Authorization: Bearer <CRON_SECRET>`으로 부른다. 자동매매
// 라우트는 그것을 받고 모의 라우트는 받지 않았다 — 같은 일을 하는 두
// 라우트가 서로 다른 문을 열어 둔 것이다. 깨우는 길이 Fly 워커 하나뿐이던
// 모의 쪽은, 워커가 꺼져 있으면 한 건도 돌지 않고 안전망이 0이었다.
//
// (모의 쪽의 두 번째 길은 결국 `vercel.json`이 아니라 GitHub Actions
// 15분이다 — Hobby 크론은 하루 한 번만 허용하고 더 잦으면 배포가
// 실패한다. 그래도 판정을 한 곳으로 모으는 이유는 그대로다: 같은 판단이
// 두 곳에 있으면 언젠가 갈린다.)
//
// 이 저장소는 이미 같은 사고를 겪었다. `/api/autotrade/exit-monitor`의
// 주석이 기록한다: 비밀 이름이 둘이어서 **2026-08-03부터 30번 연속 401**,
// 그동안 트레일링·본전 이동이 한 번도 돌지 않았다. 고친 뒤에도 **모의
// 라우트만 같은 함정에 남아 있었다** — 경로가 둘인데 한쪽만 고친 것이다.
//
// 무엇을 하지 않는가
// ──────────────────
// ★ **인증은 secret 비교뿐이다.** Vercel 고유 user-agent나 헤더를 근거로
//   쓰지 않는다 — 그건 누구나 흉내 낼 수 있다. provenance(어디서 왔나)는
//   `engine/exitMonitorWake.ts`가 따로 적고, 그 값은 인증에 쓰지 않는다.
//
// ★ **빈 비밀은 아무도 통과시키지 않는다.** 환경변수가 비어 있으면
//   `''`와 `''`가 같아서 헤더를 비워 보낸 쪽이 관리자가 된다. 그 구멍을
//   `safeSecretEqual`이 먼저 막는다.
import { timingSafeEqual } from 'node:crypto';
import type { WakeAuthKind } from '../engine/exitMonitorWake';

/**
 * 비밀 비교. **길이를 먼저 보고 timing-safe로 비교한다.**
 *
 * 기대값이나 받은 값이 비어 있으면 **무조건 false**다. 이 줄이 없으면
 * 비밀이 설정되지 않은 환경에서 아무나 통과한다.
 */
export function safeSecretEqual(provided: string | null | undefined, expected: string): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  try { return timingSafeEqual(a, b); } catch { return false; }
}

export interface WakeAuthVerdict {
  ok: boolean;
  kind: WakeAuthKind;
}

export const CRON_BEARER_PREFIX = 'Bearer ';

/**
 * 이 요청이 깨우기로 들어올 수 있는가.
 *
 * 순서가 곧 규칙이다:
 *   1. Vercel Cron — `Authorization: Bearer <CRON_SECRET>`
 *   2. 워커·수동 점검 — `x-admin-secret`
 *   3. 어느 쪽도 아니면 **들어오지 못한다**
 *
 * 둘을 함께 받는 이유는 **깨우는 길을 하나로 두지 않기 위해서**다. 길이
 * 하나면 그것이 멈출 때 안전망이 없다.
 */
export function wakeAuth(i: {
  authorization: string | null | undefined;
  adminHeader: string | null | undefined;
  cronSecret: string | null | undefined;
  adminSecret: string | null | undefined;
}): WakeAuthVerdict {
  const cronSecret = i.cronSecret || '';
  const adminSecret = i.adminSecret || '';
  const auth = i.authorization || '';

  // `startsWith`를 먼저 본다 — 접두어가 없으면 그 뒤를 자르면 안 된다.
  if (cronSecret && auth.startsWith(CRON_BEARER_PREFIX)
    && safeSecretEqual(auth.slice(CRON_BEARER_PREFIX.length), cronSecret)) {
    return { ok: true, kind: 'CRON_BEARER' };
  }
  if (safeSecretEqual(i.adminHeader, adminSecret)) {
    return { ok: true, kind: 'ADMIN_HEADER' };
  }
  return { ok: false, kind: 'NONE' };
}

/** 환경에서 비밀을 읽어 판정한다. 값은 **어디에도 적지 않는다** */
export function wakeAuthFromEnv(
  headers: { authorization: string | null; adminHeader: string | null },
  env: (k: string) => string | undefined = (k) => process.env[k],
): WakeAuthVerdict {
  return wakeAuth({
    authorization: headers.authorization,
    adminHeader: headers.adminHeader,
    cronSecret: env('CRON_SECRET'),
    adminSecret: env('ADMIN_SECRET'),
  });
}
