// src/lib/portfolio/paperPanel.ts
//
// **지갑 MOCK 탭이 그릴 것을 정하는 판정.**
//
// 화면 안에서 정하지 않는 이유는 이 저장소가 여러 번 겪은 것이다:
// 컴포넌트 안에 규칙이 있으면 "왜 이 숫자가 나왔지"를 테스트할 수 없고,
// 같은 판단이 다른 화면에 한 벌 더 생긴다.
//
// 이 파일이 지키는 것 셋
// ──────────────────────
//   1. **못 읽은 것을 '시작 안 함'으로 적지 않는다.** 그러면 화면이
//      "모의투자 시작하기"를 그리고, 누르면 있던 장부가 초기화된다.
//      **읽지 못했을 때 시작 버튼을 내주지 않는다.**
//   2. **못 구한 값을 0으로 그리지 않는다.** 0은 '없다'이고 실패는 '모른다'다
//   3. **환율이 없으면 원화를 적지 않는다.** 달러 숫자에 ₩만 붙이지 않는다
import { moneyView, type FxRate } from './walletMoney';
import type { Readiness } from './wallet';

export type PaperPanelCode =
  /** 아직 응답을 못 받았다 */
  | 'LOADING'
  /** 조회가 실패했다. **'시작 안 함'이 아니다** */
  | 'UNREADABLE'
  /** 시작한 적이 없다 — 시작하기를 그린다 */
  | 'NOT_STARTED'
  /** 돌고 있다 */
  | 'ACTIVE';

export interface PaperRow {
  key: string;
  label: string;
  /** USDT 기준 값. **못 구했으면 null** */
  usd: number | null;
  readiness: Readiness;
  hint: string;
}

export interface PaperPanel {
  code: PaperPanelCode;
  headline: string;
  rows: PaperRow[];
  /** 시작 버튼을 내줘도 되는가. **못 읽었으면 false다** */
  canStart: boolean;
  /** **사용자가 읽는 문장.** DB 오류 원문이 여기 들어가면 안 된다 */
  note: string;
  /**
   * 진단용 원문. 화면의 '자세히'에서만 보인다.
   *
   * `column paper_accounts.started_at does not exist`가 지갑 메인에
   * 그대로 뜬 적이 있다. 사용자는 그 문장으로 할 수 있는 일이 없고,
   * 자기 돈에 무슨 일이 났다고 읽는다.
   */
  detail: string;
}

const ROWS: Array<{ key: string; label: string; hint: string }> = [
  { key: 'total', label: '총자산', hint: '현금 + 미실현손익' },
  { key: 'cash', label: '현금', hint: '실현된 잔고' },
  { key: 'positionMargin', label: '포지션 증거금', hint: '열린 모의 포지션이 물고 있는 금액' },
  { key: 'unrealized', label: '미실현손익', hint: '열린 포지션의 평가손익' },
  { key: 'realized', label: '실현손익', hint: '청산으로 확정된 누적 손익' },
  { key: 'fees', label: '누적 수수료', hint: '모의 체결에 매긴 수수료' },
  { key: 'today', label: '오늘 손익', hint: '오늘 첫 기록 대비' },
];

const val = (v: any): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const blank = (readiness: Readiness, hintFor?: (k: string) => string): PaperRow[] =>
  ROWS.map(r => ({
    key: r.key, label: r.label, usd: null, readiness,
    hint: hintFor ? hintFor(r.key) : r.hint,
  }));

/**
 * 서버가 준 `paper` 블록 → 화면이 그릴 줄들.
 *
 * `loaded`는 **응답을 받았는가**이다. 안 받았는데 `paper`가 없다고
 * '시작 안 함'으로 적으면, 로딩 중에 시작하기 버튼이 번쩍인다.
 */
export function paperPanelOf(i: {
  paper: any | null | undefined;
  loaded: boolean;
}): PaperPanel {
  if (!i?.loaded) {
    return {
      code: 'LOADING', headline: '모의 계좌를 읽는 중입니다',
      rows: blank('LOADING'), canStart: false, note: '', detail: '',
    };
  }

  const p = i?.paper;
  if (p == null) {
    // **응답은 왔는데 모의 블록이 없다.** 서버가 옛 버전이거나 오류다 —
    // 어느 쪽이든 "시작하지 않았다"는 증명되지 않았다.
    return {
      code: 'UNREADABLE', headline: '모의 계좌를 확인하지 못했습니다',
      rows: blank('FAILED'), canStart: false,
      note: '잠시 뒤 다시 열어 보세요. 계좌가 없다는 뜻이 아닙니다.',
      detail: '서버 응답에 모의 계좌 항목이 없습니다',
    };
  }

  // **판정의 원본은 `code`다.** 옛 응답만 `state`를 준다.
  const code = String(p?.code ?? p?.state ?? '');
  const eq = p?.equity ?? {};
  // 원문은 여기에만 모은다 — note로 새어 나가면 안 된다.
  const detail = [
    p?.error, p?.schema?.startedAt === false
      ? 'started_at 칸이 아직 없습니다 (071 미적용)' : '',
  ].filter(Boolean).map(String).join(' · ');

  if (code === 'UNREADABLE') {
    return {
      code: 'UNREADABLE', headline: '모의 계좌를 확인하지 못했습니다',
      rows: blank('FAILED'), canStart: false,
      // **사람이 읽는 문장만.** 원문은 detail에 있다.
      note: '조회에 실패했습니다 — 계좌가 없다는 뜻이 아닙니다. 잠시 뒤 다시 열어 보세요.',
      detail: detail || String(eq.note || '원인을 알 수 없습니다'),
    };
  }

  if (code === 'NO_ACCOUNT' || code === 'GHOST' || code === 'NOT_STARTED') {
    return {
      code: 'NOT_STARTED', headline: '모의투자 계좌가 없습니다',
      rows: blank('NOT_APPLICABLE', () => '시작하면 값이 생깁니다'),
      canStart: true,
      note: '아직 모의투자를 시작하지 않았습니다.',
      // 빈 껍데기였는지 진짜 줄이 없었는지는 진단에만 남긴다.
      detail: [code === 'GHOST' ? '자동으로 생긴 빈 계좌 줄이 있습니다' : '', detail]
        .filter(Boolean).join(' · '),
    };
  }

  const today = p?.today ?? {};
  const pick: Record<string, number | null> = {
    total: val(eq.totalEquity),
    cash: val(eq.cash),
    positionMargin: val(eq.usedMargin),
    unrealized: val(eq.unrealizedPnl),
    realized: val(eq.realizedPnl),
    fees: val(eq.totalFees),
    today: val(today.pnl),
  };
  const why: Record<string, string> = {
    total: String(eq.note || ''),
    unrealized: String(eq.note || ''),
    today: String(today.note || ''),
  };

  return {
    code: 'ACTIVE', headline: '모의투자',
    canStart: false,
    rows: ROWS.map(r => {
      const v = pick[r.key];
      return {
        key: r.key, label: r.label, usd: v,
        // **못 구한 값은 FAILED다.** 0으로 그리면 사용자가 그 숫자를 믿는다.
        // 반대로 **진짜 0은 0이다** — 잔고가 0인 계좌는 "0 USDT"라고 적는다.
        readiness: (v == null ? 'FAILED' : 'OK') as Readiness,
        hint: v == null && why[r.key] ? why[r.key] : r.hint,
      };
    }),
    note: String(eq.note || ''),
    detail,
  };
}

export interface SeedOption {
  usd: number;
  usdText: string;
  /** 원화 병기. **환율이 없으면 null이고 이유가 남는다** */
  krwText: string | null;
  krwReason: string;
}

/**
 * 시작 금액 선택지 + 원화 병기.
 *
 * **환율이 없으면 원화를 만들지 않는다.** 이 저장소에는 이미 그 사고
 * 기록이 있다 — 공용 `cvt()`가 입력을 KRW로 가정해서 달러 값이 몇 배
 * 틀린 원화로 보였다. 못 바꾸는 것은 불편이고, 잘못 바꾼 숫자는 사고다.
 */
export function seedOptionsOf(
  choices: ReadonlyArray<number> | null | undefined,
  fx?: FxRate | null,
): SeedOption[] {
  return (Array.isArray(choices) ? choices : []).map((usd) => {
    const n = Number(usd);
    const krw = moneyView(Number.isFinite(n) ? n : null, 'KRW', fx);
    return {
      usd: n,
      usdText: `${n.toLocaleString('ko-KR')} USDT`,
      krwText: krw.available && krw.converted ? krw.text : null,
      krwReason: krw.available && krw.converted ? krw.reason : krw.reason,
    };
  });
}
