// src/lib/trading/ledgerLiquidation.ts
//
// **장부의 청산가 칸을 화면 값으로 옮긴다 — 모르는 것은 null이다.**
//
// 왜 필요한가
// ───────────
// `buildPaperPlan`은 현물(그리고 교차 잔고를 모를 때)의 청산가를 `null`로
// 낸다. 그런데 `PositionPlan.liquidationPrice`가 `number`라 장부에 넣는
// 순간 `liq ?? 0`으로 **0이 되어 저장된다.** 조회 라우트가 그 칸을
// `Number(...)`로 그대로 내보내서, 포지션 줄에 현물 매수가
// "청산가 0.00"으로 그려졌다 — "곧 청산된다"와 "청산이 없다"가 같은
// 모양이 된다. 옛 줄의 NULL도 `Number(null) = 0`으로 같은 길을 탔다.
//
// 실제 청산가는 언제나 0보다 크다(`linearLiquidationPrice`는 0 이하를
// null로 돌린다). 그러므로 저장된 0 이하·비숫자는 **값이 아니라 표식**이고,
// 화면에는 `null`(= `—`)로 나간다. 현물은 값이 무엇이든 청산이 없다.
export function ledgerLiquidationPrice(row: { market?: unknown; liquidation_price?: unknown }): number | null {
  if (String(row?.market ?? '').toUpperCase() === 'SPOT') return null;
  const raw = row?.liquidation_price;
  if (raw == null || raw === '' || typeof raw === 'boolean') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}
