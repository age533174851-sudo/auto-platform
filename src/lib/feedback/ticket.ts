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
  'RECEIVED',          // 접수 완료
  'REVIEWING',         // 확인 중
  'NEEDS_INFO',        // 추가 정보 요청
  'IN_PROGRESS',       // 수정 진행 중
  'VERIFYING',         // 검증 중 — 고쳤다고 적기 **전에** 확인하는 자리
  'RESOLVED',          // 해결 완료
  'ON_HOLD',           // 보류
  'DUPLICATE',         // 중복
  'CANNOT_REPRODUCE',  // 재현 불가
  'CLOSED',            // 종료
] as const;
export type Status = typeof STATUSES[number];

export const STATUS_LABEL: Record<Status, string> = {
  RECEIVED: '접수 완료', REVIEWING: '확인 중', NEEDS_INFO: '추가 정보 요청',
  IN_PROGRESS: '수정 진행 중', VERIFYING: '검증 중', RESOLVED: '해결 완료',
  ON_HOLD: '보류', DUPLICATE: '중복', CANNOT_REPRODUCE: '재현 불가',
  CLOSED: '종료',
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
/**
 * 더 이상 움직이지 않는 상태.
 *
 * `DUPLICATE`·`CANNOT_REPRODUCE`는 **종결이 아니다** — 중복으로 닫은 글이
 * 사실 다른 문제였거나, 재현 못 하던 것이 재현되는 일이 실제로 있다.
 * 되돌릴 수 있어야 사용자가 "아직 그래요"라고 말할 자리가 남는다.
 */
const TERMINAL: readonly Status[] = ['CLOSED'];

/**
 * 상태 전이표.
 *
 * `RESOLVED`에서 다시 열 수 있는 이유: 사용자가 "아직 안 고쳐졌어요"라고
 * 답장하는 것이 이 시스템의 핵심이다. 해결됐다고 적었다고 끝이 아니다.
 */
const PARKED: readonly Status[] = ['ON_HOLD', 'DUPLICATE', 'CANNOT_REPRODUCE'];
const OPEN_AGAIN: readonly Status[] = ['REVIEWING', 'IN_PROGRESS'];

const NEXT: Record<Status, readonly Status[]> = {
  RECEIVED:    ['REVIEWING', 'NEEDS_INFO', 'IN_PROGRESS', 'VERIFYING', 'RESOLVED', ...PARKED, 'CLOSED'],
  REVIEWING:   ['NEEDS_INFO', 'IN_PROGRESS', 'VERIFYING', 'RESOLVED', ...PARKED, 'CLOSED'],
  NEEDS_INFO:  ['REVIEWING', 'IN_PROGRESS', 'VERIFYING', 'RESOLVED', ...PARKED, 'CLOSED'],
  IN_PROGRESS: ['NEEDS_INFO', 'REVIEWING', 'VERIFYING', 'RESOLVED', ...PARKED, 'CLOSED'],
  // **검증 중에서 바로 해결로 간다.** 그것이 이 상태를 만든 이유다 —
  // 고쳤다고 적기 전에 확인하는 자리. 검증이 실패하면 수정 중으로 돌아간다.
  VERIFYING:   ['IN_PROGRESS', 'NEEDS_INFO', 'RESOLVED', ...PARKED, 'CLOSED'],
  RESOLVED:    [...OPEN_AGAIN, 'VERIFYING', 'CLOSED'],
  // 묶어 둔 것은 다시 열 수 있다 — 중복이 아니었거나 재현이 됐을 때.
  ON_HOLD:          [...OPEN_AGAIN, 'NEEDS_INFO', 'CLOSED'],
  DUPLICATE:        [...OPEN_AGAIN, 'CLOSED'],
  CANNOT_REPRODUCE: [...OPEN_AGAIN, 'NEEDS_INFO', 'CLOSED'],
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
export const STEPS_MAX = 4000;
export const EXPECTED_MAX = 2000;
export const ACTUAL_MAX = 2000;

export interface ParsedTicket {
  category: Category;
  title: string;
  body: string;
  visibility: Visibility;
  /** #618의 재현 절차. **비어 있을 수 있다** — 버그가 아닌 문의엔 해당이 없다 */
  steps: string | null;
  /** 기대한 결과 */
  expected: string | null;
  /** 실제로 일어난 결과 */
  actual: string | null;
}

/** 선택 칸 하나를 읽는다. 비면 null — **빈 문자열을 저장하지 않는다** */
function optional(v: unknown, max: number): { ok: true; value: string | null } | { ok: false } {
  if (v == null) return { ok: true, value: null };
  if (typeof v !== 'string') return { ok: false };
  const t = v.trim();
  if (t === '') return { ok: true, value: null };
  if (t.length > max) return { ok: false };
  return { ok: true, value: t };
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
  const steps = optional(raw.steps, STEPS_MAX);
  const expected = optional(raw.expected, EXPECTED_MAX);
  const actual = optional(raw.actual, ACTUAL_MAX);
  // 길이를 넘기면 **자르지 않고 거절한다** — 잘린 재현 절차는 다른 절차다.
  if (!steps.ok || !expected.ok || !actual.ok) return null;
  return {
    category: category as Category,
    title, body,
    visibility: resolveVisibility(category, raw.visibility),
    steps: steps.value, expected: expected.value, actual: actual.value,
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

/**
 * 가림(`redact`)을 거친 **뒤의** 길이를 판정한다.
 *
 * **검증과 저장 사이에서 글이 늘어난다.** `parseTicketInput`은 사용자가
 * 적은 원문을 보고 8000자를 통과시키는데, `redact`는 `a@b.co`(6자)를
 * 그보다 **긴 표식**으로 바꾼다. 짧은 이메일을 잔뜩 적은 신고는
 * 7994자로 들어와 11420자가 되고, DB의
 * `CHECK (length(body) BETWEEN 1 AND 8000)`에 막힌다.
 *
 * 그때 사용자가 받던 말은 "다시 시도해 주세요"였다. **같은 글은 다시
 * 보내도 똑같이 늘어나므로 영원히 실패한다** — 할 수 없는 일을 시키는
 * 안내였다. 그래서 얼마나 넘쳤는지 숫자로 말한다.
 *
 * **자르지 않는다.** 잘린 신고는 다른 신고다.
 *
 * 한계는 `TITLE_MAX`·`BODY_MAX` 하나뿐이고 마이그레이션 106의 CHECK와
 * 같은 값이다. 판정을 여기 한 곳에 두는 이유도 그것이다 — 라우트가
 * 제 숫자를 따로 적으면 언젠가 DB와 갈린다.
 */
/**
 * 가림 뒤에 넘친 칸. **넘치지 않았으면 `null`이다.**
 *
 * `{ ok: true } | { ok: false, ... }` 모양을 쓰지 않는다 — 이 저장소의
 * `tsconfig`는 `strict: false`라서 그런 판별 유니온이 **좁혀지지 않는다**
 * (`if (!v.ok)` 뒤에도 `v.field`가 없다고 한다). `parseTicketInput`이
 * `T | null`을 쓰는 이유와 같다.
 */
/**
 * #618의 선택 칸 세 개. **이 목록이 정본이다.**
 *
 * 마이그레이션 106에 칸이 있고 `parseTicketInput`이 검증하는데도 접수
 * 라우트의 insert에 셋이 한 번도 나오지 않아 **사용자가 적은 재현 절차가
 * 조용히 사라졌다.** 칸 이름을 세 파일에 손으로 적으면 또 하나가 빠지므로
 * 저장 줄·길이 판정·안내문이 전부 이 목록을 돈다.
 */
export const TICKET_OPTIONAL_FIELDS = ['steps', 'expected', 'actual'] as const;
export type TicketOptionalField = typeof TICKET_OPTIONAL_FIELDS[number];
/** 가린 뒤의 선택 칸 값들. 비어 있으면 null — **빈 문자열을 저장하지 않는다** */
export type TicketOptionals = Record<TicketOptionalField, string | null>;

export type TicketTextField = 'title' | 'body' | TicketOptionalField;

/** 칸마다의 상한. DB(106)의 CHECK와 같은 수여야 한다 */
const FIELD_MAX: Record<TicketTextField, number> = {
  title: TITLE_MAX, body: BODY_MAX,
  steps: STEPS_MAX, expected: EXPECTED_MAX, actual: ACTUAL_MAX,
};

/**
 * 안내문에 쓸 이름. **조사까지 함께 둔다** — '제목이'·'재현 절차가'처럼
 * 받침에 따라 달라지므로, 이름만 두면 문장을 만드는 쪽에서 틀린다.
 */
const FIELD_SUBJECT: Record<TicketTextField, string> = {
  title: '제목이', body: '내용이',
  steps: '재현 절차가', expected: '기대한 결과가', actual: '실제 결과가',
};

/** 판정 순서. 먼저 걸린 칸 하나를 돌려준다 */
const OVERFLOW_ORDER: readonly TicketTextField[] = ['title', 'body', ...TICKET_OPTIONAL_FIELDS];

export type RedactedOverflow = {
  field: TicketTextField;
  length: number;
  max: number;
  /** 몇 자를 줄여야 들어가는지 */
  over: number;
};

export function redactedOverflow(
  t: { title?: string | null; body: string } & Partial<TicketOptionals>,
): RedactedOverflow | null {
  // 답글에는 제목이 없다. **그래서 판정을 둘로 나누지 않는다** —
  // 글 쓰기와 답글 쓰기가 서로 다른 한계를 갖게 되는 순간 한쪽만 고쳐진다.
  //
  // 선택 칸도 같은 자리에서 본다. 가림은 글을 늘리므로, 늘어난 재현 절차는
  // 106의 CHECK에 막히고 사용자에게는 "다시 시도해 주세요"만 간다 —
  // 같은 글은 다시 보내도 똑같이 늘어나므로 영원히 실패하는 안내다.
  for (const f of OVERFLOW_ORDER) {
    const v = (t as Record<string, unknown>)[f];
    if (typeof v !== 'string') continue;
    const max = FIELD_MAX[f];
    if (v.length > max) return { field: f, length: v.length, max, over: v.length - max };
  }
  return null;
}

/** 사용자에게 보여 줄 한 줄. **글 내용은 담지 않는다 — 길이만 말한다.** */
export function redactedOverflowMessage(v: RedactedOverflow): string {
  const where = FIELD_SUBJECT[v.field] ?? '내용이';
  return `비밀로 보이는 값을 가리면서 ${where} ${v.max}자를 ${v.over}자 넘었습니다 — ${v.over}자 이상 줄여 주세요`;
}

/**
 * 접수 글 한 줄을 만든다. **라우트가 칸을 빠뜨릴 수 없는 자리다.**
 *
 * 예전에는 라우트가 insert 객체를 직접 적었고, 그래서 선택 칸 세 개가
 * 그 객체에 없다는 것을 아무도 몰랐다. 줄을 만드는 곳이 한 곳이면
 * 시험 하나가 세 칸 전부를 지킨다.
 *
 * `user_id`는 **인자로 받은 값만** 쓴다 — 요청이 보낸 값은 여기까지
 * 오지 않는다.
 */
export function ticketReportRow(i: {
  userId: string;
  parsed: ParsedTicket;
  /** 가린 뒤의 제목 */
  title: string;
  /** 가린 뒤의 선택 칸들 */
  optionals: TicketOptionals;
  context: unknown;
  redactions: unknown;
}): Record<string, unknown> {
  const row: Record<string, unknown> = {
    user_id: i.userId,
    category: i.parsed.category,
    title: i.title,
    status: 'RECEIVED',
    severity: suggestSeverity(i.parsed.category),   // 관리자가 바꿀 수 있는 제안
    visibility: i.parsed.visibility,
    context: i.context,
    redactions: i.redactions,
  };
  // **목록을 돌며 넣는다.** 비어 있어도 칸은 넣는다 — 없는 칸과 null은
  // 다르고, 다음에 칸이 하나 늘 때 여기만 보면 된다.
  for (const f of TICKET_OPTIONAL_FIELDS) row[f] = i.optionals[f] ?? null;
  return row;
}

/** 저장·조회에서 함께 읽을 칸 목록. **쓰고 아무도 안 읽으면 같은 병이다.** */
export const TICKET_REPORT_COLUMNS =
  `id,ref,category,title,status,severity,visibility,${TICKET_OPTIONAL_FIELDS.join(',')},created_at`;
