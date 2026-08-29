// src/lib/ui/display.ts
//
// **화면에 숫자와 상태를 적는 규칙은 한 곳에만 있다.**
//
// 왜 만드는가
// ───────────
// 사용자가 스크린샷으로 지적한 것 넷이 전부 같은 뿌리에서 나왔다:
//
//   · `0.00000000 USDT`        — 화면마다 toFixed 자릿수를 직접 골랐다
//   · 반복되는 '확인 불가'      — 178곳이 각자 ternary를 적었다
//   · `내 원본 v1 (v1)`        — 이름과 버전을 화면이 직접 이어붙였다
//   · 길고 빨간 경고 박스        — 무엇이 급한지 화면마다 다르게 정했다
//
// 저장소에 `toFixed(`가 323번, `toLocaleString(`이 112번 있고, `const fmt =`
// 로 시작하는 사설 포매터가 15개 넘게 있다. **같은 판단이 여러 곳에 있으면
// 언젠가 갈린다** — 실제로 자동매매 화면은 만원 단위 원화를, 지갑 화면은
// USDT를 같은 자리에 적고 있었다.
//
// 여기서 정하는 것은 "예쁘게"가 아니라 **무엇을 말하고 무엇을 말하지
// 않는가**다.

/** 값의 성격에 따른 색조. `strategyCard`·`autoOverview`가 각자 정의하던 것을 여기로 모았다 */
export type Tone = 'good' | 'warn' | 'bad' | 'muted' | 'live';

/** 표에서 값이 비는 자리 */
export const UNKNOWN_TEXT = '—';

/**
 * 문장 안에서 모른다고 말할 때.
 *
 * **'0'도 '없음'도 아니다.** 확인하지 못한 것은 통과가 아니라는 규칙이
 * 화면에서 지켜지는 자리다.
 */
export const UNKNOWN_LABEL = '확인 불가';

export type ValueKind =
  /** 돈. 통화 단위가 붙는다 */
  | 'money'
  /** 가격. 돈이지만 단위를 붙이지 않는다 */
  | 'price'
  /** 수량(코인 개수) */
  | 'qty'
  /** 퍼센트 */
  | 'pct'
  /** 건수 */
  | 'count'
  /** 점수 */
  | 'score';

export interface Shown {
  /** 화면에 그대로 쓸 문자열 */
  text: string;
  /** 값을 실제로 알았는가. **false면 0이 아니라 모르는 것이다** */
  known: boolean;
  tone: Tone;
}

/** 모르는 값 하나 */
export function unknownShown(text: string = UNKNOWN_TEXT): Shown {
  return { text, known: false, tone: 'muted' };
}

/** 숫자로 읽을 수 있는가. `''`·null·NaN·Infinity는 값이 아니다 */
export function numOrNull(v: unknown): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 이 값에 몇 자리를 적을 것인가.
 *
 * **자릿수를 고정하지 않는다.** 8자리로 고정하면 잔고 0이 `0.00000000`이
 * 되고, 사용자는 그것을 "정밀한 0"이 아니라 **고장난 화면**으로 읽는다.
 * 반대로 2자리로 고정하면 0.0000012 짜리 코인 수량이 전부 `0.00`이 된다.
 *
 * 그래서 **값의 크기가 자릿수를 정한다.**
 */
export function digitsFor(n: number, kind: ValueKind): number {
  const a = Math.abs(n);
  if (kind === 'count' || kind === 'score') return 0;
  if (kind === 'pct') return a >= 100 ? 1 : 2;
  if (kind === 'qty') {
    if (a === 0) return 0;          // 0개는 그냥 0이다
    if (a >= 1) return 4;
    if (a >= 0.001) return 6;
    return 8;                        // 진짜 작은 수량만 8자리를 쓴다
  }
  // money · price
  if (a === 0) return 0;             // **0은 0이다.** 0.00000000이 아니다
  if (a >= 0.1) return 2;            // 0.5 USDT는 '0.50'이지 '0.5000'이 아니다
  if (a >= 0.001) return 4;
  return 8;                          // 소수점 아래로 내려가는 코인 가격만
}

export interface ShowOpts {
  /** 'USDT' 같은 단위. money에만 붙는다 */
  currency?: string;
  /** 양수에 +를 붙이고 색을 준다 (손익) */
  signed?: boolean;
  /** 모를 때 쓸 문자열. 기본은 '—' */
  unknownText?: string;
}

/**
 * 값 하나를 화면 문자열로.
 *
 * **없는 값을 0으로 채우지 않는다.** 잔고 0과 "잔고를 못 읽었다"는 다른
 * 사건이고, 사용자에게는 전혀 다른 행동을 요구한다.
 */
export function shownValue(v: unknown, kind: ValueKind, opts: ShowOpts = {}): Shown {
  const n = numOrNull(v);
  if (n == null) return unknownShown(opts.unknownText ?? UNKNOWN_TEXT);

  const digits = digitsFor(n, kind);
  const body = Math.abs(n).toLocaleString('ko-KR', {
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  });

  let text: string;
  if (opts.signed) {
    // **−는 하이픈이 아니다.** 하이픈은 '없음' 자리와 헷갈린다.
    const sign = n > 0 ? '+' : n < 0 ? '−' : '';
    text = `${sign}${body}`;
  } else {
    text = n < 0 ? `−${body}` : body;
  }

  if (kind === 'pct') text = `${text}%`;
  else if (kind === 'count') text = `${text}건`;
  else if (kind === 'money' && opts.currency) text = `${text} ${opts.currency}`;

  const tone: Tone = opts.signed ? (n > 0 ? 'good' : n < 0 ? 'bad' : 'muted') : 'muted';
  return { text, known: true, tone };
}

/** 돈 한 줄. 통화를 안 주면 붙이지 않는다 — **단위 없는 금액을 만들지 않기 위해** 기본은 USDT다 */
export function moneyText(v: unknown, currency = 'USDT'): Shown {
  return shownValue(v, 'money', { currency });
}

/** 손익. 부호와 색이 값에서 나온다 */
export function pnlText(v: unknown, currency = 'USDT'): Shown {
  return shownValue(v, 'money', { currency, signed: true });
}

/** 수량 */
export function qtyText(v: unknown): Shown {
  return shownValue(v, 'qty');
}

/** 퍼센트 */
export function pctText(v: unknown, signed = false): Shown {
  return shownValue(v, 'pct', { signed });
}

/**
 * 전략 이름.
 *
 * 화면에 `내 원본 v1 (v1)`이 떴다. 이름에 이미 버전이 들어 있는데 화면이
 * `(v${version})`을 한 번 더 붙였기 때문이다. **이름을 짓는 곳이 둘이면
 * 언젠가 이렇게 겹친다.**
 *
 * 규칙은 하나다: 이름이 이미 그 버전을 말하고 있으면 다시 붙이지 않는다.
 */
export function strategyLabel(
  i: { name?: any; version?: any } | null | undefined,
): string {
  const name = String(i?.name ?? '').trim();
  const rawVer = i?.version;
  if (!name) return UNKNOWN_LABEL;

  const ver = rawVer == null || String(rawVer).trim() === '' ? null : String(rawVer).trim();
  if (!ver) return name;

  // 'v1' · '1' 둘 다 같은 버전을 가리킨다
  const verNum = ver.replace(/^v/i, '');
  const already = new RegExp(`(^|[\\s(\\[·-])v?${escapeRe(verNum)}(\\b|$|\\))`, 'i').test(name);
  if (already) return name;
  return `${name} (v${verNum})`;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 알림 한 건의 급함 */
export type NoticeLevel = 'blocking' | 'warn' | 'info';

export interface Notice {
  level: NoticeLevel;
  /** 한 줄. **이것만 봐도 무엇을 해야 하는지 알아야 한다** */
  headline: string;
  /** 접어 두는 자세한 설명. 없으면 접을 것이 없다 */
  detail?: string;
  tone: Tone;
}

export const NOTICE_TONE: Record<NoticeLevel, Tone> = {
  blocking: 'bad',
  warn: 'warn',
  info: 'muted',
};

/**
 * 경고 한 건을 만든다.
 *
 * 화면에 길고 빨간 박스가 여러 개 쌓여 있었다. 전부 빨간색이면 **어느
 * 것도 빨갛지 않은 것과 같다** — 사용자는 전부 배경으로 읽고 넘긴다.
 *
 * 그래서 두 가지를 강제한다:
 *   · 첫 줄은 짧다. 긴 설명은 `detail`로 접는다
 *   · 지금 막힌 것(blocking)만 빨갛다. 나머지는 노랑·회색이다
 */
export function noticeOf(
  level: NoticeLevel, headline: any, detail?: any,
): Notice {
  const head = String(headline ?? '').trim() || UNKNOWN_LABEL;
  const det = detail == null ? undefined : String(detail).trim() || undefined;
  return { level, headline: head, detail: det, tone: NOTICE_TONE[level] };
}

/** 첫 줄에 쓸 길이. 넘으면 뒤는 detail로 밀어 넣는다 */
export const HEADLINE_MAX = 40;

/**
 * 긴 문장 하나를 **짧은 첫 줄 + 접는 상세**로 나눈다.
 *
 * 기존 화면들은 DB 오류 문장을 통째로 빨간 박스에 넣었다. 사용자는
 * `column paper_accounts.started_at does not exist`를 읽을 이유가 없다.
 */
export function splitNotice(level: NoticeLevel, text: any): Notice {
  const s = String(text ?? '').trim();
  if (!s) return noticeOf(level, UNKNOWN_LABEL);
  if (s.length <= HEADLINE_MAX) return noticeOf(level, s);

  // 문장 경계에서 자른다. 없으면 글자 수로 자른다.
  const cut = s.slice(0, HEADLINE_MAX);
  const at = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf(' — '), cut.lastIndexOf(' · '));
  const head = at > 10 ? s.slice(0, at).trim() : cut.trim();
  return noticeOf(level, head, s.slice(head.length).trim() || s);
}

/**
 * 여러 알림 중 **화면 맨 위에 놓을 하나**.
 *
 * 다 보여 주는 것은 아무것도 안 보여 주는 것과 같다. 막힌 것이 하나라도
 * 있으면 그것이고, 없으면 경고, 그것도 없으면 아무것도 띄우지 않는다.
 */
export function topNotice(list: Notice[] | null | undefined): Notice | null {
  if (!Array.isArray(list) || list.length === 0) return null;
  return list.find(n => n?.level === 'blocking')
      ?? list.find(n => n?.level === 'warn')
      ?? list.find(n => n?.level === 'info')
      ?? null;
}
