// src/lib/journal/tradeNote.ts
//
// **없는 분석을 지어내지 않는다.**
//
// 매매일지 화면은 사용자가 거래를 기록하면 이런 상자를 붙였다:
//
//   ┌──────────────────────────────────────┐
//   │ AI 리뷰                              │
//   │ 손절 규칙을 잘 지켰습니다.           │
//   └──────────────────────────────────────┘
//
// 그 문장은 고정 목록 여덟 개 중 **하나를 난수로 고른 것**이었다:
//
//   const aiReview = AI_REVIEWS[Math.floor(Math.random() * AI_REVIEWS.length)];
//
// 사용자가 입력한 종목·방향·가격·손익 중 **어느 것도 보지 않는다.**
// 손절을 놓쳐 크게 잃은 거래에 "손절 규칙을 잘 지켰습니다"가 뜰 수 있고,
// 규칙대로 잘라낸 거래에 "FOMO 진입 가능성이 있습니다"가 뜰 수 있다.
//
// 조언처럼 생겼고, 개인화된 것처럼 보이고, 내용은 무작위다. 이 저장소가
// 계속 막아 온 것 중 가장 나쁜 모양이다 — **조용히 틀리는 데다, 사람이
// 그걸 근거로 다음 거래를 바꾼다.**
//
// 무엇으로 대신하나
// ─────────────────
// 사용자가 입력한 숫자에서 **실제로 따라 나오는 것만** 적는다. 값이
// 빠졌으면 계산하지 않고 그렇게 말한다. 그리고 이건 AI가 아니므로
// AI라고 부르지 않는다.

export interface JournalEntry {
  side?: string | null;
  entryPrice?: any;
  exitPrice?: any;
  size?: any;
  pnl?: any;
  pnlPct?: any;
}

export type NoteCode =
  /** 입력한 값으로 계산했다 */
  | 'DERIVED'
  /** 값이 빠져 계산할 수 없다. **0으로 채우지 않는다** */
  | 'INCOMPLETE';

export interface JournalNote {
  code: NoteCode;
  /** 화면에 그대로 적을 문장. **AI라고 부르지 않는다** */
  text: string;
  /** 무엇이 빠졌는가 */
  missing: string[];
}

const num = (v: any): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * 기록 요약.
 *
 * **판단하지 않는다.** "잘했다"·"아쉽다"는 이 함수가 알 수 없는
 * 것이다 — 같은 손실이라도 계획대로면 잘한 것이고 아니면 아니다.
 * 계획은 사용자만 안다. 그래서 일어난 일만 적는다.
 */
export function journalNoteOf(e: JournalEntry | null | undefined): JournalNote {
  const entry = num(e?.entryPrice);
  const exit = num(e?.exitPrice);
  const size = num(e?.size);

  const missing: string[] = [];
  if (entry == null || entry <= 0) missing.push('진입가');
  if (exit == null || exit <= 0) missing.push('청산가');
  if (size == null || size <= 0) missing.push('수량');

  if (missing.length > 0) {
    return {
      code: 'INCOMPLETE', missing,
      text: `${missing.join(' · ')}이(가) 없어 손익을 계산하지 않았습니다 — 0이라는 뜻이 아닙니다`,
    };
  }

  const isBuy = String(e?.side ?? '').includes('매수');
  const movePct = ((exit! - entry!) / entry!) * 100;
  const dirPct = isBuy ? movePct : -movePct;
  const pnl = num(e?.pnl);

  const moved = `${isBuy ? '매수' : '매도'} 후 가격이 ${movePct >= 0 ? '+' : ''}${movePct.toFixed(2)}% 움직였습니다`;
  const result = dirPct >= 0
    ? `방향이 맞아 ${dirPct.toFixed(2)}% 유리하게 끝났습니다`
    : `방향이 반대로 가 ${Math.abs(dirPct).toFixed(2)}% 불리하게 끝났습니다`;
  const money = pnl == null ? '' : ` (손익 ${pnl >= 0 ? '+' : ''}${pnl.toLocaleString('ko-KR')})`;

  return { code: 'DERIVED', missing: [], text: `${moved}. ${result}${money}.` };
}
