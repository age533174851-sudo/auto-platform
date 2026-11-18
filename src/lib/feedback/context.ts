// ─────────────────────────────────────────────────────────────
// 문의에 **같이 보낼 화면·기기 정보**.
//
// 왜 허용 목록인가
// ────────────────
// "민감한 것만 빼고 다 보낸다"로 만들면, 나중에 누군가 화면 상태에
// 연결 정보를 하나 더 넣는 순간 그것이 조용히 문의에 실려 나간다.
// 막을 것을 세는 대신 **보낼 것을 세면** 새 칸은 기본으로 안 나간다.
//
// 그래서 이 파일은 "무엇을 지울까"가 아니라 **"무엇만 보낼까"**를 적는다.
// 목록에 없는 칸은 들어올 수 없다.
//
// 값도 검사한다
// ─────────────
// 칸 이름이 맞아도 값이 길면 거기에 무엇이든 실을 수 있다. 각 칸마다
// 모양과 길이를 정해 두고, 안 맞으면 **그 칸을 뺀다**(통째로 거절하지는
// 않는다 — 기기 정보 하나 때문에 버그 신고를 잃을 이유가 없다).
// ─────────────────────────────────────────────────────────────

import { redact } from './redact';

/** 보낼 수 있는 칸과 그 모양. **여기 없는 칸은 나가지 않는다** */
const ALLOWED = {
  /** 어느 화면에서 눌렀는가 — 탭 id */
  screen:      { max: 48,  re: /^[a-z0-9_-]+$/i },
  /** PC / 모바일 / 태블릿 — 폭에서 앱이 판단해 넣는다 */
  device:      { max: 12,  re: /^(pc|mobile|tablet)$/i },
  /** 화면 폭·높이 "390x844" */
  viewport:    { max: 12,  re: /^\d{2,5}x\d{2,5}$/ },
  /** Easy / Pro */
  uiMode:      { max: 8,   re: /^(easy|pro)$/i },
  /** PAPER / TESTNET / LIVE — 어느 돈인가 */
  runEnv:      { max: 12,  re: /^(PAPER|MOCK|TESTNET|LIVE)$/ },
  /** 어느 거래소 이야기인가 */
  venue:       { max: 24,  re: /^[a-z0-9_-]+$/i },
  /** 앱이 띄운 오류 코드 */
  errorCode:   { max: 64,  re: /^[A-Za-z0-9_.:-]+$/ },
  /** 요청 추적 id — 서버 로그와 맞춰 보기 위한 것 */
  requestId:   { max: 64,  re: /^[A-Za-z0-9_.:-]+$/ },
  /** 문제가 난 시각 (ISO) */
  occurredAt:  { max: 32,  re: /^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/ },
  /** 브라우저 종류 — 전체 User-Agent는 넣지 않는다(식별에 쓰일 수 있다) */
  browser:     { max: 32,  re: /^[A-Za-z0-9 ._-]+$/ },
  /** 앱 빌드 */
  appVersion:  { max: 40,  re: /^[A-Za-z0-9 ._+-]+$/ },
} as const;

export type ContextKey = keyof typeof ALLOWED;
export const CONTEXT_KEYS = Object.keys(ALLOWED) as ContextKey[];

export interface ContextResult {
  /** 실을 값. 통과한 칸만 들어 있다 */
  context: Partial<Record<ContextKey, string>>;
  /** 목록에 없어서 버린 칸 이름. **값은 담지 않는다** */
  dropped: string[];
}

/**
 * 보낼 수 있는 칸만 고른다.
 *
 * **값에 비밀이 섞여 있으면 그 칸도 버린다.** 오류 코드 자리에 요청
 * 전체를 붙여넣는 경우가 실제로 있다.
 */
export function pickContext(raw: unknown): ContextResult {
  const out: Partial<Record<ContextKey, string>> = {};
  const dropped: string[] = [];
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return { context: out, dropped };
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const spec = (ALLOWED as Record<string, { max: number; re: RegExp } | undefined>)[k];
    if (spec == null) { dropped.push(k); continue; }
    if (typeof v !== 'string') { dropped.push(k); continue; }
    const s = v.trim();
    if (s === '' || s.length > spec.max || !spec.re.test(s)) { dropped.push(k); continue; }
    // 모양이 맞아도 비밀이 섞였으면 싣지 않는다.
    if (redact(s).redacted) { dropped.push(k); continue; }
    out[k as ContextKey] = s;
  }
  return { context: out, dropped };
}

/** 화면 폭에서 기기 종류를 정한다. **모드(Easy/Pro)와 무관하다** */
export function deviceFromWidth(w: unknown): 'pc' | 'tablet' | 'mobile' | null {
  const n = Number(w);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < 768) return 'mobile';
  if (n < 1100) return 'tablet';
  return 'pc';
}
