// src/lib/ui/status.ts
//
// **상태를 말하는 방식은 한 곳에만 있다.**
//
// 지갑 한 화면에만 '확인 불가' 계열 문구가 15곳, 빨강·노랑 색 지정이
// 23곳 있었다. 전부 그 자리에서 따로 정한 것이라, 같은 사건(계좌를
// 못 읽음)이 화면 위치에 따라 다른 색과 다른 문장으로 나왔다.
//
// 여기서 정하는 것은 넷이다:
//   ① 상태의 종류 (SUCCESS · WARNING · ERROR · UNKNOWN · DISABLED)
//   ② 환경(LIVE · TESTNET · PAPER)을 어떻게 구분해 보여 주는가
//   ③ 못 읽은 것들을 **한 장으로 압축**하는 방법
//   ④ 개발자용 원문(DB·API 오류)을 본문에서 떼어 내는 방법
import type { Tone } from './display';
import { UNKNOWN_LABEL, splitNotice, type Notice } from './display';
import type { RunEnv } from './autoOverview';

// ── ① 상태 ──

export type StatusKind = 'SUCCESS' | 'WARNING' | 'ERROR' | 'UNKNOWN' | 'DISABLED';

export const STATUS_TONE: Record<StatusKind, Tone> = {
  SUCCESS: 'good',
  WARNING: 'warn',
  // **막힌 것만 빨갛다.** 못 읽은 것은 빨강이 아니다 — 다음 회차에
  // 읽힐 수도 있고, 사용자가 지금 할 수 있는 일이 없을 때도 많다.
  ERROR: 'bad',
  UNKNOWN: 'muted',
  DISABLED: 'muted',
};

export const STATUS_LABEL: Record<StatusKind, string> = {
  SUCCESS: '정상',
  WARNING: '주의',
  ERROR: '실패',
  UNKNOWN: UNKNOWN_LABEL,
  DISABLED: '사용 안 함',
};

// ── ② 환경 ──
//
// **문구는 새로 짓지 않았다.** 지갑(`portfolio/wallet.ts`)에 이미 있던
// 세 문장을 그대로 옮겨 왔고, 회귀 테스트가 그 문장을 고정하고 있다.
// 여기서 새 표현을 만들면 화면마다 같은 환경을 다르게 부르게 된다.
//
// **PAPER는 MOCK과 같은 것이다.** 저장소가 두 이름을 함께 써 왔다
// (지갑 탭은 MOCK, 서버 장부는 paper_*). 이름을 하나로 강제하면 기존
// 저장값이 전부 어긋나므로, **표시할 때만** 한 단어로 모은다.

export interface EnvView {
  env: RunEnv;
  /** 화면에 쓸 이름 */
  label: string;
  /** 무엇이 걸려 있는지 한 줄 */
  meaning: string;
  tone: Tone;
  /** 주문 전에 한 번 더 물어야 하는가 */
  confirmBeforeOrder: boolean;
  /** 실제 돈이 움직이는가 */
  realMoney: boolean;
}

export const ENV_VIEW: Record<RunEnv, EnvView> = {
  LIVE: {
    env: 'LIVE', label: '실전', meaning: '실제 자금입니다',
    tone: 'live', confirmBeforeOrder: true, realMoney: true,
  },
  TESTNET: {
    env: 'TESTNET', label: '테스트넷', meaning: '거래소 테스트넷의 가상 자금입니다 — 실제 가치가 없습니다',
    tone: 'warn', confirmBeforeOrder: true, realMoney: false,
  },
  MOCK: {
    // 사용자에게는 '모의'가 통하는 말이다. PAPER는 코드 쪽 이름이다.
    env: 'MOCK', label: '모의', meaning: '앱 안에서만 존재하는 모의 자금입니다 — 거래소와 무관합니다',
    tone: 'muted', confirmBeforeOrder: false, realMoney: false,
  },
};

export function envView(env: RunEnv | null | undefined): EnvView {
  return ENV_VIEW[(env ?? 'TESTNET') as RunEnv] ?? ENV_VIEW.TESTNET;
}

// ── ③ 계좌 상태: 셋을 절대 섞지 않는다 ──

export type AccountCode =
  /** 이 환경에 연결된 계좌가 없다. 사용자가 만들 수 있다 */
  | 'NO_ACCOUNT'
  /** 계좌가 있는지조차 못 읽었다. **없다는 뜻이 아니다** */
  | 'UNREADABLE'
  /** 읽었다. 잔고가 0일 수도 있다 — 그것은 정상이다 */
  | 'READY'
  /** 조회 중 */
  | 'LOADING';

export interface AccountStatus {
  code: AccountCode;
  kind: StatusKind;
  /** 짧은 한 줄 */
  headline: string;
  /** 접어 두는 설명. 사용자가 할 수 있는 일 */
  detail?: string;
  tone: Tone;
}

/**
 * 계좌 상태 한 줄.
 *
 * **이 셋은 절대 같은 문장을 쓰지 않는다.**
 *
 *   NO_ACCOUNT           계좌가 없다        → 만들면 된다
 *   UNREADABLE           못 읽었다          → 0이 아니다. 잔고를 모른다
 *   READY(balance = 0)   읽었고 0이다       → 정상이다. 충전하면 된다
 *
 * 스크린샷에서 `0.00000000 USDT`와 "계좌가 없습니다"가 **동시에** 떠
 * 있었다. 둘이 같이 나올 수 있다는 것 자체가 판정이 없다는 증거였다.
 */
export function accountStatusOf(i: {
  code: AccountCode | null | undefined;
  balance?: number | null;
  envLabel?: string;
} | null | undefined): AccountStatus {
  const env = i?.envLabel ? `${i.envLabel} ` : '';
  const code = (i?.code ?? 'UNREADABLE') as AccountCode;

  if (code === 'LOADING') {
    return { code, kind: 'UNKNOWN', tone: 'muted', headline: '조회 중…' };
  }
  if (code === 'NO_ACCOUNT') {
    return {
      code, kind: 'DISABLED', tone: STATUS_TONE.DISABLED,
      headline: `${env}계좌가 아직 없습니다`,
      detail: '시작하면 계좌가 만들어집니다. 잔고가 0인 것과는 다른 상태입니다.',
    };
  }
  if (code === 'UNREADABLE') {
    return {
      code, kind: 'UNKNOWN', tone: STATUS_TONE.UNKNOWN,
      headline: `${env}잔고를 확인하지 못했습니다`,
      // **0이 아니라는 말을 반드시 남긴다.**
      detail: '계좌가 없다는 뜻도, 잔고가 0이라는 뜻도 아닙니다. 값을 읽지 못했습니다.',
    };
  }
  const bal = i?.balance;
  if (bal != null && Number(bal) === 0) {
    return {
      code: 'READY', kind: 'SUCCESS', tone: STATUS_TONE.SUCCESS,
      headline: `${env}잔고 0`,
      detail: '정상적으로 읽었고 잔고가 0입니다. 충전하면 거래할 수 있습니다.',
    };
  }
  return { code: 'READY', kind: 'SUCCESS', tone: STATUS_TONE.SUCCESS, headline: `${env}정상` };
}

// ── ④ 못 읽은 것을 한 장으로 압축한다 ──

export interface UnknownRow {
  /** 무엇을 못 읽었나 */
  label: string;
  /** 값을 알았는가 */
  known: boolean;
}

export interface UnknownSummary {
  /** 못 읽은 것이 있는가 */
  any: boolean;
  count: number;
  total: number;
  /** 전부 못 읽었는가 — 그러면 화면 전체가 의미 없다 */
  all: boolean;
  /** 한 줄 요약. 없으면 null */
  headline: string | null;
  /** 어느 항목인지 */
  detail: string | null;
  kind: StatusKind;
}

/**
 * 여러 줄에 흩어진 '확인 불가'를 **한 장으로 모은다.**
 *
 * 값마다 '확인 불가'를 적으면 화면이 그 단어로 뒤덮이고, 사용자는
 * 어느 것이 진짜 문제인지 고를 수 없다. 표에는 `—`만 남기고, 무엇을
 * 못 읽었는지는 카드 하나가 말한다.
 */
export function unknownSummaryOf(rows: UnknownRow[] | null | undefined): UnknownSummary {
  const list = Array.isArray(rows) ? rows.filter(r => r && typeof r.label === 'string') : [];
  const missing = list.filter(r => !r.known);
  const total = list.length;
  const count = missing.length;

  if (total === 0 || count === 0) {
    return { any: false, count: 0, total, all: false, headline: null, detail: null, kind: 'SUCCESS' };
  }
  const all = count === total;
  return {
    any: true, count, total, all,
    headline: all
      ? '값을 하나도 읽지 못했습니다'
      : `${count}개 항목을 확인하지 못했습니다`,
    detail: `확인하지 못한 항목: ${missing.map(r => r.label).join(' · ')}`
      + '\n0이라는 뜻이 아닙니다 — 값을 읽지 못했습니다.',
    kind: 'UNKNOWN',
  };
}

// ── ⑤ 개발자용 원문은 본문에서 뗀다 ──

/**
 * 사용자에게 보여도 되는 문장인가.
 *
 * `column paper_accounts.started_at does not exist`가 메인 화면 빨간
 * 박스에 그대로 떴었다. 사용자가 읽을 이유가 없고, 읽어도 할 수 있는
 * 일이 없다.
 */
const RAW_ERROR_MARKS = [
  /column .* does not exist/i,
  /relation .* does not exist/i,
  /\bPGRST\d+\b/,
  /\bECONN|ETIMEDOUT|ENOTFOUND\b/,
  /\bhttps?:\/\//i,
  /\bat \w+ \(.*:\d+:\d+\)/,      // 스택 트레이스
  /\b(?:HTTP )?[45]\d\d\b.*\{/,   // 상태코드 + JSON 조각
  /[{}[\]]{2,}/,                  // JSON 덩어리
];

export function looksLikeRawError(text: any): boolean {
  const s = String(text ?? '');
  if (!s.trim()) return false;
  return RAW_ERROR_MARKS.some(re => re.test(s));
}

export interface SplitDetail {
  /** 사용자에게 보일 본문 */
  body: string;
  /** 진단 화면으로 밀어 넣을 원문. 없으면 undefined */
  diagnostics?: string;
}

/**
 * 한 문장을 **사용자 본문**과 **진단용 원문**으로 가른다.
 *
 * 원문을 버리지 않는다 — 버리면 진짜 고장 났을 때 아무도 원인을 못 찾는다.
 * 자리를 옮길 뿐이다.
 */
export function splitDiagnostics(text: any, fallback = UNKNOWN_LABEL): SplitDetail {
  const s = String(text ?? '').trim();
  if (!s) return { body: fallback };
  if (!looksLikeRawError(s)) return { body: s };

  // 원문이 섞여 있으면, 사람이 쓴 앞부분만 남긴다.
  const cut = s.search(/[({[]|column |relation |PGRST|https?:\/\//i);
  const head = cut > 8 ? s.slice(0, cut).replace(/[\s—·-]+$/, '').trim() : '';
  return { body: head || fallback, diagnostics: s };
}

/**
 * 화면 맨 위에 놓을 알림 하나로 만든다.
 *
 * 긴 설명은 `splitNotice`가 첫 줄과 상세로 나눈다 — 문장을 자르는
 * 규칙을 여기서 다시 쓰지 않는다.
 */
export function statusNotice(kind: StatusKind, text: any): Notice & { diagnostics?: string } {
  const { body, diagnostics } = splitDiagnostics(text);
  const level = kind === 'ERROR' ? 'blocking' : kind === 'WARNING' ? 'warn' : 'info';
  const n = splitNotice(level, body);
  return diagnostics ? { ...n, diagnostics } : n;
}
