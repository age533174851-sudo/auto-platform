// src/lib/ops/deploymentCheck.ts
//
// **판정을 읽는 쪽이 틀리면, 그 검사는 없느니만 못하다.**
//
// 실제로 이렇게 틀렸다
// ────────────────────
// `deployment-check` 워크플로는 이렇게 비교했다:
//
//     verdict=$(python3 -c "... print(d.get('verdict') or '(없음)')")
//     if [ "$verdict" != "MATCHED" ]; then exit 1; fi
//
// 그런데 `/api/system/deployment`의 `verdict`는 **객체**다:
//
//     "verdict": { "code": "MATCHED", "matched": true, "reason": "..." }
//
// 그래서 출력은 `{'code': 'MATCHED', 'matched': True, ...}`가 됐고
// 문자열 `MATCHED`와 절대 같아지지 않는다. **8번 실행해서 8번 다
// 실패했다.** 방금도 main · Vercel · Fly가 전부 같은 SHA인데
// "main과 실제 배포가 다릅니다"라고 적었다.
//
// 이게 왜 무거운가
// ────────────────
// 이 워크플로는 "#136에서 하루를 잃은" 실패 — 배포 기록은 초록인데
// 운영에는 옛 코드가 떠 있던 것 — 을 다시 안 겪으려고 만든 것이다.
// 그런데 **언제나 빨강이면 진짜 어긋난 날의 빨강과 구별되지 않는다.**
// 검사가 늘 틀리면 사람들은 검사를 끈다.
//
// 그래서 판정을 YAML 밖으로 뺀다 — `wait-worker-alive`와 같은 이유다.

/**
 * **배포를 확인하려고 시크릿을 요구하지 않는다.**
 *
 * 왜 이 함수가 생겼나 — 실제로 못 확인했다
 * ────────────────────────────────────────
 * `scripts/verify-deployment.mjs`는 주소를 `BASE`(워크플로가
 * `EXIT_MONITOR_URL`에서 넣는다) 하나에서만 읽고, 비어 있으면 이렇게
 * 끝냈다:
 *
 *     ::error::확인할 주소가 없습니다 (EXIT_MONITOR_URL)
 *            — 배포 상태를 확인하지 못했습니다
 *
 * 그런데 무인 회차는 그 시크릿을 **일부러 받지 않는다**(`CLAUDE.md`의
 * 울타리). 그래서 회차 보고마다 "배포를 확인하지 못했습니다"가 남고,
 * 사람이 대신 눌러 봐야 했다 — `CLAUDE.md`가 없애라고 적은 바로 그
 * 문장이다("SHA를 비교해 주세요").
 *
 * 그럴 필요가 없었다. `/api/system/deployment`는 **인증이 없는 경로**다.
 * 주소만 알면 누구나 읽는다. 실측(2026-11-24):
 *
 *     GET https://<공개주소>/api/system/deployment?main=cc3dc28a…
 *     → 200 · verdict MATCHED · main·vercel·fly 모두 cc3dc28
 *
 * 그래서 주소를 **네 곳에서 차례로** 찾고, 어느 쪽에서 찾았는지까지
 * 돌려준다. 어디서 왔는지를 적지 않으면 "기본값으로 엉뚱한 배포를
 * 봤다"를 나중에 구별할 수 없다.
 *
 * ★ 주소 자체는 호출부가 **로그에 적지 않는다**(이 파일을 쓰는 스크립트의
 *   머리말 규칙). `source`만 적는다.
 */
export const PUBLIC_APP_BASE = 'https://auto-platform-zeta.vercel.app';

export type DeployBaseSource =
  /** 호출부가 직접 준 주소 (`BASE`) */
  | 'BASE'
  /** 워크플로 시크릿 */
  | 'EXIT_MONITOR_URL'
  /** 앱이 이미 쓰는 공개 주소 변수 */
  | 'NEXT_PUBLIC_APP_URL'
  | 'APP_URL'
  /** 위가 전부 없을 때의 공개 기본값 */
  | 'PUBLIC_DEFAULT';

export interface DeployBase {
  base: string;
  source: DeployBaseSource;
}

/**
 * 배포 상태를 읽을 주소를 정한다. **빈 값·공백은 없는 것으로 본다.**
 *
 * 순서에 뜻이 있다 — 호출부가 준 것이 가장 세고, 공개 기본값이 가장
 * 약하다. 기본값까지 내려가도 **확인을 포기하지는 않는다.**
 */
export function deploymentBaseFrom(env: Record<string, string | undefined>): DeployBase {
  const pick = (k: DeployBaseSource): string => String(env?.[k] ?? '').trim().replace(/\/+$/, '');
  for (const k of ['BASE', 'EXIT_MONITOR_URL', 'NEXT_PUBLIC_APP_URL', 'APP_URL'] as const) {
    const v = pick(k);
    if (v) return { base: v, source: k };
  }
  return { base: PUBLIC_APP_BASE, source: 'PUBLIC_DEFAULT' };
}

export type DeployCheckCode =
  /** main · Vercel · Fly가 같은 코드다 */
  | 'MATCHED'
  /** 다르다. **배포가 안 끝났거나 옛 코드가 떠 있다** */
  | 'MISMATCH'
  /** 응답에 판정이 없다. **같다는 뜻이 아니다** */
  | 'NO_VERDICT'
  /** 응답을 읽지 못했다. **같다는 뜻이 아니다** */
  | 'UNREADABLE';

export interface DeployCheckVerdict {
  code: DeployCheckCode;
  /** 초록으로 끝내도 되는가 */
  ok: boolean;
  /** 서버가 준 판정 코드 그대로 (없으면 null) */
  serverCode: string | null;
  reason: string;
  /** 로그 한 줄에 남길 값들 */
  detail: { main: string | null; vercel: string | null; fly: string | null; pendingCount: number | null };
}

const short = (v: any): string | null => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, 7) : null;
};

/**
 * 서버가 준 verdict에서 **코드만** 꺼낸다.
 *
 * 객체(`{code}`)로 와도, 예전처럼 문자열로 와도 같은 답을 준다.
 * 둘 다 아니면 `null` — **모르는 것을 MATCHED로 만들지 않는다.**
 */
export function verdictCodeOf(body: any): string | null {
  const v = body?.verdict;
  if (typeof v === 'string') return v.trim().toUpperCase() || null;
  if (v && typeof v === 'object') {
    const c = v.code;
    if (typeof c === 'string' && c.trim()) return c.trim().toUpperCase();
  }
  return null;
}

/**
 * 배포가 main과 같은가.
 *
 * `expectMain`을 주지 않으면 **판정을 읽어서 보여 주기만 한다** —
 * 예전 워크플로의 동작 그대로다(비교 대상이 없으면 실패시키지 않는다).
 */
export function deploymentCheckVerdict(i: {
  /** `/api/system/deployment` 응답. **못 읽었으면 null** */
  body: any;
  /** 비교할 main SHA. 비어 있으면 보여 주기만 한다 */
  expectMain?: string | null;
}): DeployCheckVerdict {
  const body = i?.body ?? null;
  const expect = String(i?.expectMain || '').trim().toLowerCase() || null;
  const detail = {
    main: short(body?.main?.sha),
    vercel: short(body?.vercel?.sha),
    fly: short(body?.fly?.sha),
    pendingCount: typeof body?.migrations?.pendingCount === 'number'
      ? body.migrations.pendingCount : null,
  };

  if (!body || typeof body !== 'object') {
    return { code: 'UNREADABLE', ok: false, serverCode: null, detail,
      reason: '배포 상태를 읽지 못했습니다 — 같은 코드가 떠 있다는 뜻이 아닙니다' };
  }

  const serverCode = verdictCodeOf(body);
  if (!serverCode) {
    // **검사가 대상을 잃으면 조용히 통과한다.** 그러지 않게 막는다.
    return { code: 'NO_VERDICT', ok: false, serverCode: null, detail,
      reason: '응답에 판정(verdict)이 없습니다 — 응답 모양이 바뀌었거나 서버가 판정을 못 했습니다' };
  }

  if (!expect) {
    return { code: serverCode === 'MATCHED' ? 'MATCHED' : 'MISMATCH',
      ok: true, serverCode, detail,
      reason: `서버 판정: ${serverCode} (비교할 main을 주지 않아 실패로 만들지 않습니다)` };
  }

  // 서버가 우리가 준 main을 실제로 썼는지도 본다. 안 썼으면 이 판정은
  // 우리가 물어본 질문의 답이 아니다.
  const echoed = String(body?.main?.sha || '').trim().toLowerCase();
  if (echoed && echoed !== expect) {
    return { code: 'UNREADABLE', ok: false, serverCode, detail,
      reason: `서버가 다른 main으로 판정했습니다 (요청 ${expect.slice(0, 7)} · 응답 ${echoed.slice(0, 7)})` };
  }

  if (serverCode === 'MATCHED') {
    return { code: 'MATCHED', ok: true, serverCode, detail,
      reason: 'main · Vercel · Fly가 같은 코드를 돌리고 있습니다' };
  }
  return { code: 'MISMATCH', ok: false, serverCode, detail,
    reason: `main(${expect.slice(0, 7)})과 실제 배포가 다릅니다 (${serverCode})`
      + ` — vercel ${detail.vercel ?? '?'} · fly ${detail.fly ?? '?'}` };
}
