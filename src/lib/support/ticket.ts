// ─────────────────────────────────────────────────────────────
// 문의 하나가 무엇인가 — 분류 · 상태 · 공개 여부.
//
// **이 파일이 정본이다.** 화면도 API도 DB 제약도 여기서 나온 값을 쓴다.
// 같은 판단이 두 곳에 있으면 언젠가 갈린다(CLAUDE.md 상습 고장 ②).
//
// 세 가지를 섞지 않는다
// ─────────────────────
//   분류(category)   무엇에 대한 문의인가       — 사용자가 고른다
//   상태(status)     지금 어디까지 왔는가       — 관리자·시스템이 정한다
//   공개(visibility) 누가 볼 수 있는가          — **올리기만 되고 내리기만 된다**
//
// 공개 전환이 왜 한 방향인가
// ──────────────────────────
// 비공개 문의에는 거래 내역·계정 문제가 들어 있다. 그것이 사용자 동의 없이
// 공개 게시판으로 올라가면 되돌릴 수 없다 — 이미 읽힌 뒤다. 그래서 **비공개를
// 공개로 바꾸는 전이는 이 파일에 없다.** 사용자가 새로 공개 글을 쓰는 것은
// 되지만, 쓴 것을 올리는 것은 안 된다.
//
// 반대로 공개 → 비공개는 허용한다. 되돌릴 수 있는 방향이기 때문이다.
// ─────────────────────────────────────────────────────────────

/** 무엇에 대한 문의인가. **새 분류를 더해도 기존 값이 안 깨지도록** 문자열이다 */
export const CATEGORIES = [
  'BUG',              // 버그 신고
  'UX',               // 불편·화면 개선 제안
  'FEATURE',          // 새 기능 요청
  'ORDER',            // 거래·주문 문제
  'AUTOTRADE',        // 자동매매 봇 오류
  'CONNECTION',       // 거래소·증권사 연결 문제
  'ACCOUNT',          // 계정·로그인·인증
  'PAPER',            // 모의투자·테스트넷
  'SECURITY',         // 보안 관련 신고
  'GENERAL',          // 일반 문의
  'OTHER',            // 기타
] as const;
export type Category = typeof CATEGORIES[number];

export const CATEGORY_LABEL: Record<Category, string> = {
  BUG: '버그 신고', UX: '불편·개선 제안', FEATURE: '새 기능 요청',
  ORDER: '거래·주문 문제', AUTOTRADE: '자동매매 오류', CONNECTION: '거래소 연결 문제',
  ACCOUNT: '계정·로그인', PAPER: '모의투자·테스트넷', SECURITY: '보안 신고',
  GENERAL: '일반 문의', OTHER: '기타',
};

/** 지금 어디까지 왔는가 */
export const STATUSES = [
  'RECEIVED',    // 접수 완료
  'REVIEWING',   // 확인 중
  'NEEDS_INFO',  // 추가 정보 요청
  'IN_PROGRESS', // 수정 진행 중
  'RESOLVED',    // 해결 완료
  'CLOSED',      // 종료
] as const;
export type Status = typeof STATUSES[number];

export const STATUS_LABEL: Record<Status, string> = {
  RECEIVED: '접수 완료', REVIEWING: '확인 중', NEEDS_INFO: '추가 정보 요청',
  IN_PROGRESS: '수정 진행 중', RESOLVED: '해결 완료', CLOSED: '종료',
};

/**
 * **아직 없는 상태는 여기 넣지 않는다.**
 *
 * 'AI 분석 중' · '수정안 작성 완료' · '배포 완료' 같은 상태는 그 일을 하는
 * 파이프라인이 실제로 생긴 뒤에 더한다. 지금 넣으면 아무도 돌리지 않는
 * 상태가 화면에 떠서 **가짜 진행 상황**이 된다.
 */
export const STATUS_NOT_YET: readonly string[] = [
  'AI_QUEUED', 'AI_ANALYZING', 'REPRODUCING', 'FIXING', 'TESTING',
  'PR_OPEN', 'DEPLOY_PENDING', 'DEPLOYED', 'BLOCKED_CONFLICT', 'FAILED',
];

/** 얼마나 급한가 */
export const SEVERITIES = ['URGENT', 'HIGH', 'NORMAL', 'LOW'] as const;
export type Severity = typeof SEVERITIES[number];

export const SEVERITY_LABEL: Record<Severity, string> = {
  URGENT: '긴급', HIGH: '높음', NORMAL: '보통', LOW: '낮음',
};

/** 누가 볼 수 있는가 */
export const VISIBILITIES = ['PRIVATE', 'PUBLIC'] as const;
export type Visibility = typeof VISIBILITIES[number];

/**
 * 비공개여야만 하는 분류.
 *
 * 이 분류의 문의는 **공개로 만들 수 없다.** 거래 내역·계정·키 문제가
 * 들어 있고, 사용자가 실수로 공개를 골라도 막아야 한다.
 */
export const ALWAYS_PRIVATE: readonly Category[] =
  ['BUG', 'ORDER', 'AUTOTRADE', 'CONNECTION', 'ACCOUNT', 'PAPER', 'SECURITY'];

export function mustBePrivate(category: unknown): boolean {
  return typeof category === 'string' && ALWAYS_PRIVATE.includes(category as Category);
}

/**
 * 공개 여부를 정한다. **요청이 무엇이든 분류가 이긴다.**
 */
export function resolveVisibility(category: unknown, requested: unknown): Visibility {
  if (mustBePrivate(category)) return 'PRIVATE';
  return requested === 'PUBLIC' ? 'PUBLIC' : 'PRIVATE';
}

/**
 * 공개 여부를 **바꿀 수 있는가**. 한 방향이다.
 *
 *   PUBLIC  → PRIVATE   가능 (되돌릴 수 있는 방향)
 *   PRIVATE → PUBLIC    **불가** (이미 읽힌 것은 되돌릴 수 없다)
 */
export function canChangeVisibility(from: Visibility, to: Visibility): boolean {
  if (from === to) return true;
  return from === 'PUBLIC' && to === 'PRIVATE';
}

/** 더 이상 움직이지 않는 상태 */
const TERMINAL: readonly Status[] = ['CLOSED'];

/**
 * 상태 전이표.
 *
 * `RESOLVED`에서 다시 열 수 있는 이유: 사용자가 "아직 안 고쳐졌어요"라고
 * 답장하는 것이 이 시스템의 핵심이다. 해결됐다고 적었다고 끝이 아니다.
 */
const NEXT: Record<Status, readonly Status[]> = {
  RECEIVED:    ['REVIEWING', 'NEEDS_INFO', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'],
  REVIEWING:   ['NEEDS_INFO', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'],
  NEEDS_INFO:  ['REVIEWING', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'],
  IN_PROGRESS: ['NEEDS_INFO', 'REVIEWING', 'RESOLVED', 'CLOSED'],
  RESOLVED:    ['REVIEWING', 'IN_PROGRESS', 'CLOSED'],
  CLOSED:      [],
};

export function canTransition(from: unknown, to: unknown): boolean {
  if (typeof from !== 'string' || typeof to !== 'string') return false;
  if (!STATUSES.includes(from as Status) || !STATUSES.includes(to as Status)) return false;
  if (from === to) return true;
  return NEXT[from as Status].includes(to as Status);
}

export function isTerminal(s: unknown): boolean {
  return typeof s === 'string' && TERMINAL.includes(s as Status);
}

/** 사용자가 이 문의에 더 적을 수 있는가 */
export function canUserReply(status: unknown): boolean {
  return typeof status === 'string' && STATUSES.includes(status as Status) && status !== 'CLOSED';
}

// ── 입력 검증 ──

export const TITLE_MAX = 120;
export const BODY_MAX = 8000;

export interface ParsedTicket {
  category: Category;
  title: string;
  body: string;
  visibility: Visibility;
}

/**
 * 접수 요청을 읽는다. **못 읽으면 null** — 추측해서 기본값으로 채우지 않는다.
 *
 * 분류를 모르면 `OTHER`로 바꾸지 않고 거절한다. 사용자가 고른 적 없는
 * 분류로 접수되면 관리자가 엉뚱한 줄에서 찾게 된다.
 */
export function parseTicketInput(raw: any): ParsedTicket | null {
  if (raw == null || typeof raw !== 'object') return null;
  const category = raw.category;
  if (typeof category !== 'string' || !CATEGORIES.includes(category as Category)) return null;
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const body = typeof raw.body === 'string' ? raw.body.trim() : '';
  if (title === '' || title.length > TITLE_MAX) return null;
  if (body === '' || body.length > BODY_MAX) return null;
  return {
    category: category as Category,
    title, body,
    visibility: resolveVisibility(category, raw.visibility),
  };
}

/**
 * 분류에서 기본 심각도를 제안한다. **관리자가 바꿀 수 있는 제안일 뿐이다.**
 *
 * 실제 주문·자산·보안에 닿는 것을 일반 화면 개선보다 위에 둔다.
 */
export function suggestSeverity(category: Category): Severity {
  if (category === 'SECURITY') return 'URGENT';
  if (category === 'ORDER' || category === 'ACCOUNT') return 'HIGH';
  if (category === 'AUTOTRADE' || category === 'CONNECTION' || category === 'BUG') return 'NORMAL';
  return 'LOW';
}
