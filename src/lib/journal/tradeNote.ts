// src/lib/journal/tradeNote.ts
//
// **매매일지에 붙는 한 줄은 입력한 값에서 따라 나온 것만 적는다.**
//
// 무엇이 있었나
// ─────────────
// `HistoryPage.tsx`가 거래를 저장할 때마다 이렇게 했다:
//
//     const aiReview = AI_REVIEWS[Math.floor(Math.random() * AI_REVIEWS.length)];
//
// 고정 문장 아홉 개 중 하나를 **난수로** 골라 "AI 리뷰"라는 상자에
// 넣었다. 사용자가 입력한 종목·방향·진입가·청산가·수량·손익 중
// **어느 것도 보지 않았다.**
//
// 손절을 놓쳐 크게 잃은 거래에 "손절 규칙을 잘 지켰습니다"가 뜰 수
// 있었고, 규칙대로 잘라낸 거래에 "FOMO 진입 가능성이 있습니다"가 뜰 수
// 있었다. 조언처럼 생겼고, 개인화된 것처럼 보이고, 내용은 무작위다.
// **그리고 사람이 그걸 근거로 다음 거래를 바꾼다.**
//
// 이 파일이 지키는 것
// ───────────────────
// 1. **계산되는 것만 적는다.** 명목가·손익·손익률은 입력에서 바로 나온다.
// 2. **모르는 것은 모른다고 적는다.** 일지에는 손절가 칸이 없다. 그래서
//    "손절을 잘 지켰는가"는 이 일지로 **알 수 없다** — 0으로도, 칭찬으로도
//    적지 않는다.
// 3. **조언하지 않는다.** "다음에는 신호를 기다리세요" 같은 문장은
//    관측에서 따라 나오지 않는다.

export interface TradeNoteInput {
  /** '매수' 또는 '매도'. 그 밖의 값은 방향을 모르는 것으로 둔다 */
  side?: string | null;
  entryPrice?: number | null;
  exitPrice?: number | null;
  size?: number | null;
  pnl?: number | null;
  pnlPct?: number | null;
}

export interface TradeNote {
  /** 입력에서 따라 나온 사실. 지어낸 문장은 없다 */
  facts: string[];
  /** 이 일지로는 **알 수 없는** 것. 비워 두지 않는다 */
  unknown: string[];
  /** 화면에 그대로 넣을 수 있는 한 덩어리. 사실이 하나도 없으면 빈 문자열 */
  text: string;
}

const num = (v: any): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** 1,234 처럼. 소수는 있는 만큼만 남긴다 */
function fmt(n: number): string {
  const r = Math.round(n * 100) / 100;
  return r.toLocaleString('ko-KR', { maximumFractionDigits: 2 });
}

/**
 * 일지 한 건에서 **따라 나오는 것만** 뽑는다.
 *
 * 입력이 모자라면 사실을 지어내지 않고 `unknown`에 적는다.
 */
export function tradeNote(i: TradeNoteInput | null | undefined): TradeNote {
  const facts: string[] = [];
  const unknown: string[] = [];

  const entry = num(i?.entryPrice);
  const exit = num(i?.exitPrice);
  const size = num(i?.size);
  const pnl = num(i?.pnl);
  const pnlPct = num(i?.pnlPct);
  const side = String(i?.side ?? '').trim();

  // ── 명목가 ──
  if (entry && size) {
    facts.push(`명목 ${fmt(entry * size)}`);
  } else {
    unknown.push('명목가 — 진입가와 수량이 모두 있어야 계산됩니다');
  }

  // ── 손익 ──
  //
  // **0을 "본전"으로 단정하지 않는다.** 진입가·청산가·수량 중 하나라도
  // 비면 `computePnl`이 0을 돌려주는데, 그 0은 "본전"이 아니라
  // "계산하지 못함"이다.
  if (entry && exit && size) {
    const sign = (pnl ?? 0) > 0 ? '+' : '';
    const pctPart = pnlPct == null ? '' : ` (${pnlPct > 0 ? '+' : ''}${fmt(pnlPct)}%)`;
    facts.push(`손익 ${sign}${fmt(pnl ?? 0)}${pctPart}`);
  } else {
    unknown.push('손익 — 진입가·청산가·수량이 모두 있어야 계산됩니다');
  }

  // ── 방향 ──
  if (side === '매수' || side === '매도') {
    if (entry && exit) {
      const moved = exit > entry ? '올랐습니다' : exit < entry ? '내렸습니다' : '그대로였습니다';
      facts.push(`${side} · 가격은 ${moved}`);
    } else {
      facts.push(side);
    }
  } else {
    unknown.push('방향 — 매수/매도가 기록되지 않았습니다');
  }

  // ── 알 수 없는 것 — **언제나 적는다** ──
  //
  // 이 일지에는 손절가·목표가 칸이 없다. 그러니 "손절 규칙을 잘
  // 지켰는가"는 여기서 판단할 수 없다. 예전 문구가 바로 그걸
  // 지어내고 있었다.
  unknown.push('손절·목표가 준수 — 일지에 그 값을 적는 칸이 없어 이 기록으로는 알 수 없습니다');

  const text = facts.length === 0
    ? ''
    : facts.join(' · ');

  return { facts, unknown, text };
}
