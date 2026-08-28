// src/lib/portfolio/paperView.ts
//
// **모의투자 숫자는 한 곳에서만 나온다.**
//
// 두 장부가 있었다
// ────────────────
//   서버 PAPER        paper_accounts · paper_positions · USDT · 실제 전략 평가
//   브라우저 로컬      localStorage · 원화 · 자체 decide() · 자체 TP/SL
//
// 그래서 자동매매 MOCK 화면과 지갑 MOCK 탭이 **서로 다른 잔고**를 보여
// 줬다. 어느 쪽이 진짜인지 사용자가 알 방법이 없었고, 그 상태에서
// 색깔과 레이아웃을 갈아엎으면 **예쁜 화면 두 곳이 다른 답을 하는** 꼴이 된다.
//
// 이 파일이 하는 일
// ─────────────────
// 서버가 준 것을 **한 모양으로** 만든다. 두 화면이 이것만 읽으면 숫자가
// 갈릴 수 없다 — 갈리려면 서버가 두 답을 해야 하는데 그건 같은
// `readPaperEquity` 하나에서 나온다.
//
// **localStorage는 입력이 아니다.** 이 함수는 브라우저 저장소를 읽지
// 않고, 읽을 방법도 없다. 그것이 "로컬 값이 서버 값을 덮을 수 없다"의
// 구현이다 — 규칙을 문서에 적는 대신 **덮을 통로 자체를 없앤다.**

export type PaperViewCode =
  /** 아직 서버 응답을 못 받았다 */
  | 'LOADING'
  /** 조회가 실패했다. **'계좌 없음'이 아니다** */
  | 'UNREADABLE'
  /** 계좌가 없거나 시작한 적이 없다 */
  | 'NOT_STARTED'
  /** 계좌가 있다. **잔고 0도 READY다** */
  | 'READY';

export interface PaperViewPosition {
  id: string | null;
  symbol: string | null;
  side: string | null;
  quantity: number | null;
  entryPrice: number | null;
  markPrice: number | null;
  margin: number | null;
  unrealizedPnl: number | null;
  roiPct: number | null;
  openedAt: string | null;
}

export interface PaperView {
  code: PaperViewCode;
  /** **장부 통화는 USDT다.** 원화는 표시 계층에서 환율로만 환산한다 */
  currency: 'USDT';
  cash: number | null;
  usedMargin: number | null;
  availableMargin: number | null;
  unrealizedPnl: number | null;
  realizedPnl: number | null;
  totalFees: number | null;
  totalEquity: number | null;
  initialBalance: number | null;
  returnPct: number | null;
  todayPnl: number | null;
  todayPct: number | null;
  tradeCount: number | null;
  winCount: number | null;
  positions: PaperViewPosition[];
  /** 사용자가 읽는 문장 */
  note: string;
  /** 진단 원문. **화면 메인에 띄우지 않는다** */
  detail: string;
}

const n = (v: any): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};
const s = (v: any): string | null => (v == null ? null : String(v));

const EMPTY = {
  cash: null, usedMargin: null, availableMargin: null, unrealizedPnl: null,
  realizedPnl: null, totalFees: null, totalEquity: null, initialBalance: null,
  returnPct: null, todayPnl: null, todayPct: null, tradeCount: null, winCount: null,
};

function positionsOf(raw: any): PaperViewPosition[] {
  return (Array.isArray(raw) ? raw : []).map((p: any) => ({
    id: s(p?.id),
    symbol: s(p?.symbol),
    side: s(p?.side),
    quantity: n(p?.quantity),
    // 서버는 `fillPrice`로 준다. 이름을 여기서 한 번만 맞춘다.
    entryPrice: n(p?.fillPrice ?? p?.entryPrice),
    markPrice: n(p?.markPrice),
    margin: n(p?.margin),
    unrealizedPnl: n(p?.unrealizedPnl),
    roiPct: n(p?.roiPct),
    openedAt: s(p?.openedAt ?? p?.opened_at),
  }));
}

/**
 * 서버 응답 → 두 화면이 함께 읽을 한 모양.
 *
 * `/api/paper/account`의 본문과 `/api/wallets/overview`의 `paper` 칸을
 * **둘 다** 받는다. 둘은 같은 `readPaperEquity`에서 나오므로 같은 값이
 * 되어야 하고, 이 함수가 그 사실을 구조로 보장한다.
 */
export function paperViewOf(i: {
  /** 응답을 받았는가. 안 받았으면 LOADING이다 */
  loaded: boolean;
  /** `/api/paper/account` 본문 또는 overview의 `paper` 칸 */
  payload: any;
}): PaperView {
  const base = { currency: 'USDT' as const, positions: [] as PaperViewPosition[] };

  if (!i?.loaded) {
    return { ...base, ...EMPTY, code: 'LOADING', note: '모의 계좌를 읽는 중입니다', detail: '' };
  }

  const p = i?.payload;
  if (p == null) {
    // **응답은 왔는데 내용이 없다.** '시작 안 함'으로 적지 않는다 —
    // 그러면 화면이 시작 버튼을 내주고, 누르면 있던 장부가 초기화된다.
    return { ...base, ...EMPTY, code: 'UNREADABLE',
      note: '모의 계좌를 확인하지 못했습니다 — 계좌가 없다는 뜻이 아닙니다',
      detail: '응답에 모의 계좌 항목이 없습니다' };
  }

  // `/api/paper/account`는 최상위 ok가 false일 수 있다.
  if (p?.ok === false) {
    return { ...base, ...EMPTY, code: 'UNREADABLE',
      note: '모의 계좌를 확인하지 못했습니다 — 잠시 뒤 다시 열어 보세요',
      detail: String(p?.message || p?.error || '') };
  }

  const eq = p?.equity ?? {};
  const today = p?.today ?? {};
  // 두 응답이 서로 다른 칸에 상태를 싣는다. 여기서 한 번만 맞춘다.
  const code = String(p?.code ?? eq?.state ?? p?.state ?? '');

  const detail = [
    p?.error, p?.schema?.startedAt === false ? 'started_at 칸이 아직 없습니다 (071 미적용)' : '',
  ].filter(Boolean).map(String).join(' · ');

  if (code === 'UNREADABLE') {
    return { ...base, ...EMPTY, code: 'UNREADABLE',
      note: '조회에 실패했습니다 — 계좌가 없다는 뜻이 아닙니다. 잠시 뒤 다시 열어 보세요.',
      detail: detail || String(eq?.note || '원인을 알 수 없습니다') };
  }
  if (code === 'NO_ACCOUNT' || code === 'GHOST' || code === 'NOT_STARTED') {
    return { ...base, ...EMPTY, code: 'NOT_STARTED',
      note: '아직 모의투자를 시작하지 않았습니다.',
      detail: [code === 'GHOST' ? '자동으로 생긴 빈 계좌 줄이 있습니다' : '', detail]
        .filter(Boolean).join(' · ') };
  }

  // **모르는 모양을 READY로 떨어뜨리지 않는다.**
  //
  // 서버 응답이 아니면(예: 옛 localStorage 장부 모양) 상태 칸이 비어
  // 있다. 그걸 그냥 통과시키면 `equity`가 없으니 전부 null인데 화면은
  // "계좌가 있다"로 그린다 — 그게 두 장부가 섞이는 통로다.
  if (code !== 'READY' && code !== 'ACTIVE') {
    return { ...base, ...EMPTY, code: 'UNREADABLE',
      note: '모의 계좌를 확인하지 못했습니다 — 계좌가 없다는 뜻이 아닙니다',
      detail: `알 수 없는 응답 모양입니다 (code=${code || '없음'})` };
  }

  const cash = n(eq.cash);
  const usedMargin = n(eq.usedMargin);
  return {
    currency: 'USDT',
    code: 'READY',
    cash,
    usedMargin,
    // **못 구한 값으로 뺄셈하지 않는다.** null − 0은 0이 아니다.
    availableMargin: cash == null || usedMargin == null ? null : Math.max(0, cash - usedMargin),
    unrealizedPnl: n(eq.unrealizedPnl),
    realizedPnl: n(eq.realizedPnl),
    totalFees: n(eq.totalFees),
    totalEquity: n(eq.totalEquity),
    initialBalance: n(eq.initialBalance),
    returnPct: n(eq.returnPct),
    todayPnl: n(today.pnl),
    todayPct: n(today.pct),
    tradeCount: n(eq.tradeCount ?? p?.account?.tradeCount),
    winCount: n(eq.winCount ?? p?.account?.winCount),
    positions: positionsOf(p?.positions),
    note: String(eq.note || ''),
    detail,
  };
}

/**
 * 두 화면이 같은 값을 보고 있는가.
 *
 * **시험용이 아니라 규칙이다.** 회귀 테스트가 이 함수로 두 응답을
 * 대조한다 — 나중에 누가 한쪽에만 칸을 더하면 여기서 갈린다.
 */
export function paperViewsAgree(a: PaperView, b: PaperView): { same: boolean; diff: string[] } {
  const diff: string[] = [];
  const keys: Array<keyof PaperView> = [
    'code', 'currency', 'cash', 'usedMargin', 'availableMargin', 'unrealizedPnl',
    'realizedPnl', 'totalFees', 'totalEquity', 'initialBalance', 'returnPct',
    'todayPnl', 'todayPct',
  ];
  for (const k of keys) {
    if (a[k] !== b[k]) diff.push(`${k}: ${String(a[k])} ≠ ${String(b[k])}`);
  }
  if (a.positions.length !== b.positions.length) {
    diff.push(`positions: ${a.positions.length} ≠ ${b.positions.length}`);
  } else {
    for (let i = 0; i < a.positions.length; i += 1) {
      const x = a.positions[i], y = b.positions[i];
      for (const k of Object.keys(x) as Array<keyof PaperViewPosition>) {
        if (x[k] !== y[k]) diff.push(`positions[${i}].${k}: ${String(x[k])} ≠ ${String(y[k])}`);
      }
    }
  }
  return { same: diff.length === 0, diff };
}
