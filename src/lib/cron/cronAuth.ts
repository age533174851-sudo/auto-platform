// src/lib/cron/cronAuth.ts
//
// **크론 경로의 인증 판정 정본.**
//
// 무엇이 문제였나
// ───────────────
// 다섯 크론이 똑같이 이렇게 적고 있었다:
//
//     const secret = process.env.CRON_SECRET || '';
//     if (secret) {                                  // ← 없으면 통째로 건너뛴다
//       const given = …;
//       if (given !== secret) return 401;
//     }
//
// `CRON_SECRET`이 없거나 빈 값이면 **인증이 사라지고 아무나 호출한다.**
// 그 호출이 하는 일은 DB 삭제(cleanup) · 외부 API 한도 소모(news-sync ·
// calendar-sync) · 유료 AI 호출(ai-enrichment · ai-scoring)이다.
//
// 같은 저장소의 `/api/cron/reconcile`은 이미 반대로 적어 뒀다:
//
//   > 다른 크론들은 `CRON_SECRET`이 없으면 열려 있는데, 여기서 그러면
//   > 익명 호출로 남의 계좌에 거래소 요청을 일으킬 수 있다.
//   > **미설정이면 잠근다.**
//
// 그 계약을 다섯 경로에 똑같이 적용한다. **판정은 여기 한 곳에만 둔다** —
// 다섯 벌로 두었기 때문에 다섯 벌이 같이 틀려 있었다.
//
// 공백만 있는 값도 미설정이다
// ───────────────────────────
// `CRON_SECRET="   "`는 truthy라 예전 코드에서는 **그 공백이 진짜 비밀**이
// 됐다. 운영자가 값을 지우려다 공백을 남긴 상황이 가장 흔하고, 그때
// 잠긴 줄 알지만 실제로는 공백만 보내면 통과한다. 미설정으로 본다.
import { timingSafeEqual } from 'crypto';

export type CronAuthCode =
  /** 통과 */
  | 'OK'
  /** 비밀이 설정돼 있지 않다(미설정·빈 값·공백). **열지 않고 잠근다** */
  | 'SECRET_MISSING'
  /** 비밀은 있는데 제시한 값이 다르다 */
  | 'UNAUTHORIZED';

export interface CronAuthVerdict {
  ok: boolean;
  code: CronAuthCode;
  /** 그대로 응답에 쓴다 */
  status: 200 | 401 | 503;
  error: string;
  message: string;
}

/** 길이가 달라도 타이밍으로 값을 흘리지 않는다 */
function safeEqual(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  try { return timingSafeEqual(a, b); } catch { return false; }
}

/**
 * 이 호출을 받아도 되는가.
 *
 * **순서가 곧 의미다:** 비밀이 없으면 비교할 것도 없다 — 그때는
 * "아무나 통과"가 아니라 "이 경로는 잠겨 있다"이다.
 */
export function cronAuthVerdict(i: {
  /** `process.env.CRON_SECRET`. null·undefined·''·공백이면 미설정 */
  secret: string | null | undefined;
  /** `Authorization` 헤더 원문. `Bearer ` 접두사는 여기서 떼어낸다 */
  authorization?: string | null;
  /** `?secret=` 질의 */
  querySecret?: string | null;
}): CronAuthVerdict {
  const secret = String(i.secret ?? '').trim();
  if (!secret) {
    return {
      ok: false, code: 'SECRET_MISSING', status: 503, error: 'not_configured',
      message: 'CRON_SECRET이 설정되지 않아 이 경로는 잠겨 있습니다 — '
        + '설정되지 않았다는 것은 아무나 불러도 된다는 뜻이 아닙니다',
    };
  }

  const given = String(i.authorization ?? '').replace(/^Bearer\s+/i, '')
    || String(i.querySecret ?? '');

  if (!safeEqual(given, secret)) {
    return {
      ok: false, code: 'UNAUTHORIZED', status: 401, error: 'unauthorized',
      message: '크론 인증에 실패했습니다',
    };
  }

  return { ok: true, code: 'OK', status: 200, error: '', message: '' };
}

/**
 * 요청에서 읽어 판정까지.
 *
 * **Next 타입을 가져오지 않는다.** 구조만 맞으면 되므로 시험에서
 * 가짜 요청을 그대로 넣을 수 있다 — 핸들러를 못 불러 보는 검증은
 * 검증이 아니다.
 */
export interface CronRequestLike {
  headers: { get(name: string): string | null };
  nextUrl?: { searchParams: { get(name: string): string | null } } | null;
}

export function cronAuthFromRequest(
  req: CronRequestLike, env: Record<string, string | undefined> = process.env as any,
): CronAuthVerdict {
  return cronAuthVerdict({
    secret: env.CRON_SECRET,
    authorization: req.headers.get('authorization'),
    querySecret: req.nextUrl?.searchParams.get('secret') ?? null,
  });
}
