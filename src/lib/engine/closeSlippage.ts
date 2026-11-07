// src/lib/engine/closeSlippage.ts
//
// **종료 체결이 마크가보다 얼마나 불리했는가.** 순수 계산 하나다.
//
// 부호 규칙 — **불리하면 양수**
// ─────────────────────────────
// 방향마다 "불리"가 반대쪽이라 그냥 `(fill − mark)`로 두면 LONG과
// SHORT의 분포가 서로 뒤집힌 채 한 통에 섞인다. 그러면 백분위가 아무
// 뜻이 없다. 그래서 **항상 불리한 쪽을 양수**로 맞춘다:
//
//   LONG 포지션을 닫는 주문은 SELL  → 싸게 팔릴수록 불리 → mark − fill
//   SHORT 포지션을 닫는 주문은 BUY  → 비싸게 살수록 불리 → fill − mark
//
// 양수 = 그만큼 손해 봤다. 음수 = 오히려 유리하게 체결됐다(있을 수 있다).
//
// 모르면 재지 않는다
// ──────────────────
// 마크가나 체결가 중 하나라도 없거나 0 이하면 **null**이다. 0으로 적으면
// "슬리피지 없었음"이 되어 분포가 0 쪽으로 쏠린다 — 못 잰 것과 없는 것은
// 다른 사실이다.
//
// 신선도는 ④ 정본에 맡긴다
// ────────────────────────
// 전송 시점 마크가가 너무 낡았으면 그 차이는 슬리피지가 아니라 **시간
// 경과**다. 그 판정에 새 ms 문턱을 만들지 않는다 — 부르는 쪽이 ④의
// `assessMarketFreshness` 결과를 보고 `markPrice`를 null로 넘기면 된다.
// 이 파일은 문턱을 하나도 갖지 않는다.

export type CloseSlippageCode =
  | 'MEASURED'
  /** 마크가를 쓸 수 없다 */
  | 'MARK_UNUSABLE'
  /** 거래소가 평균가를 주지 않았다 */
  | 'FILL_UNUSABLE'
  /** 방향을 모른다 */
  | 'SIDE_UNKNOWN';

export interface CloseSlippage {
  code: CloseSlippageCode;
  /** 불리하면 양수(%). 못 재면 null */
  adverseCloseSlippagePct: number | null;
  reason: string;
}

const px = (v: unknown): number | null => {
  if (v == null || typeof v === 'boolean') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * **잰다. 판단하지 않는다.** 문턱도 좋다/나쁘다도 없다.
 *
 * @param side      **포지션의** 방향이다. 주문 방향이 아니다 —
 *                  둘을 섞으면 부호가 통째로 뒤집힌다.
 * @param markPrice 전송 시점의 마크가. 낡았으면 부르는 쪽이 null을 준다.
 * @param fillPrice 거래소가 적어 준 평균가(`reportedAvgPrice`).
 */
export function closeSlippage(i: {
  side: 'LONG' | 'SHORT' | null | undefined;
  markPrice: number | null | undefined;
  fillPrice: number | null | undefined;
} | null | undefined): CloseSlippage {
  const no = (code: CloseSlippageCode, reason: string): CloseSlippage =>
    ({ code, adverseCloseSlippagePct: null, reason });

  const side = i?.side;
  if (side !== 'LONG' && side !== 'SHORT') {
    return no('SIDE_UNKNOWN', `포지션 방향을 모릅니다 (${String(side)})`);
  }
  const mark = px(i?.markPrice);
  if (mark == null) {
    return no('MARK_UNUSABLE',
      `전송 시점 마크가를 쓸 수 없습니다 (${String(i?.markPrice)})`
      + ' — 0으로 적으면 슬리피지가 없었던 것이 됩니다');
  }
  const fill = px(i?.fillPrice);
  if (fill == null) {
    return no('FILL_UNUSABLE',
      `거래소가 평균 체결가를 주지 않았습니다 (${String(i?.fillPrice)})`);
  }
  // LONG 종료 = SELL(싸게 팔릴수록 불리) · SHORT 종료 = BUY(비싸게 살수록 불리)
  const adverse = side === 'LONG' ? mark - fill : fill - mark;
  return {
    code: 'MEASURED',
    adverseCloseSlippagePct: (adverse / mark) * 100,
    reason: '',
  };
}
