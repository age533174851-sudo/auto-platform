'use client';
// src/components/trading/markets/PaperOrderReviewSheet.tsx
//
// **보내기 전에 읽는 창. 두 번째 주문폼이 아니다.**
//
// 왜 읽기 전용인가
// ────────────────
// 여기에 배율이나 수량 칸을 하나라도 두면 폼 상태가 **두 벌**이 된다.
// 시트에서 고친 값과 뒤 화면의 값 중 무엇이 나가는지가 코드를 읽어야만
// 알 수 있게 되고, 그 둘은 언젠가 갈린다. 고치려면 닫고 주문폼에서 고친다.
//
// ★ 여기에 계산이 없다
// ────────────────────
// 줄도 값도 `paperOrderReview.reviewRows()`가 만든다. 이 파일은 `—`를
// 어디에 적을지와 `sticky` footer만 안다.
//
// 360×660
// ───────
// 본문이 길어져도 확인 버튼이 화면 밖으로 나가면 안 된다. 본문만 스크롤하고
// 바닥 줄은 붙여 둔다 — 실기에서 버튼이 밀려 안 보인 적이 있다.
import React from 'react';
import { C, FS, NUM } from '@/components/terminal/theme';
import { formatMoneyForScope } from '@/lib/trading/gameMoney';
import { REVIEW_SERVER_RECALC_NOTE, type ReviewRow, type ReviewValue }
  from '@/lib/trading/paperOrderReview';
import type { PaperOrderReview } from '@/lib/trading/usePaperOrderReview';
import type { MoneyScope } from '@/lib/trading/gameMoney';

export interface PaperOrderReviewSheetProps {
  review: PaperOrderReview;
  scope: MoneyScope;
}

/** 값 하나를 글자로. **`UNKNOWN`은 `—`이고 0이 아니다** */
function valueText(v: ReviewValue, scope: MoneyScope): string {
  switch (v.kind) {
    case 'TEXT': return v.text;
    case 'MONEY': return formatMoneyForScope(v.amount, scope);
    case 'PRICE': return v.amount.toFixed(2);
    case 'QTY': return v.amount.toFixed(v.amount < 1 ? 6 : 4);
    case 'PERCENT': return `${v.amount.toFixed(2)}%`;
    default: return '—';
  }
}

function Row({ row, scope }: { row: ReviewRow; scope: MoneyScope }) {
  const unknown = row.value.kind === 'UNKNOWN';
  return (
    <div data-testid={`review-row-${row.key}`} data-unknown={unknown ? '1' : '0'}
      style={{
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
        gap: 10, padding: '6px 0', borderBottom: `1px solid ${C.hair}`, minWidth: 0,
      }}>
      <span style={{ fontSize: FS.nano, color: C.dim, flexShrink: 0 }}>{row.label}</span>
      <span style={{ minWidth: 0, textAlign: 'right' }}>
        <span data-testid={`review-value-${row.key}`} style={{
          ...NUM, fontSize: FS.small, fontWeight: 700,
          color: unknown ? C.faint : C.text,
        }}>{valueText(row.value, scope)}</span>
        {/* 왜 모르는지 적는다. 빈 칸은 0으로 읽힌다. */}
        {row.value.kind === 'UNKNOWN' ? (
          <span data-testid={`review-unknown-${row.key}`} style={{
            display: 'block', fontSize: FS.micro, color: C.warn, lineHeight: 1.35,
          }}>{row.value.reason}</span>
        ) : null}
      </span>
    </div>
  );
}

export function PaperOrderReviewSheet({ review, scope }: PaperOrderReviewSheetProps) {
  if (review.phase === 'NONE' || review.ticket == null) return null;
  const v = review.verdict;
  const sending = review.phase === 'SUBMITTING';

  return (
    <div data-testid="paper-order-review-backdrop"
      // 뒤를 눌러서 닫지 않는다 — 보내는 중에 잘못 닫히면 결과를 잃는다.
      style={{
        position: 'absolute', inset: 0, zIndex: 40,
        background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'flex-end',
      }}>
      <div data-testid="paper-order-review-sheet"
        data-review-market={review.ticket.market}
        data-review-symbol={review.ticket.symbol}
        data-review-side={review.ticket.side}
        data-review-phase={review.phase}
        style={{
          width: '100%', maxHeight: '86%', minHeight: 0,
          display: 'flex', flexDirection: 'column',
          background: C.panel, borderTop: `1px solid ${C.hair}`,
          borderRadius: '12px 12px 0 0',
        }}>
        <div style={{
          padding: '10px 14px 6px', fontSize: FS.lead, fontWeight: 800, color: C.text,
        }}>주문 확인</div>

        {/* 본문만 스크롤한다 */}
        <div data-testid="review-body" style={{
          flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain',
          padding: '0 14px',
        }}>
          {review.rows.map(r => <Row key={r.key} row={r} scope={scope}/>)}

          {review.message ? (
            <div data-testid="review-message" style={{
              paddingBottom: 8, fontSize: FS.nano, lineHeight: 1.4,
              color: review.message.ok ? C.up : C.down,
            }}>{review.message.text}</div>
          ) : null}
        </div>

        {/* ★ 서버 재계산 문구는 **스크롤 밖**이다.
            본문 안에 두면 360×660에서 접혀 보이지 않았다 — 그러면 화면
            숫자가 확정 체결가로 읽힌다. 확인 버튼 바로 위, 늘 보이는
            자리에 둔다. */}
        <div data-testid="review-recalc-note" style={{
          flexShrink: 0, padding: '6px 14px 0', background: C.panel,
          fontSize: FS.micro, color: C.faint, lineHeight: 1.45,
        }}>{REVIEW_SERVER_RECALC_NOTE}</div>

        {/* 바닥 줄은 붙어 있다 — 내용이 길어도 확인 버튼이 사라지지 않는다 */}
        <div data-testid="review-footer" style={{
          position: 'sticky', bottom: 0, flexShrink: 0,
          display: 'flex', gap: 8, padding: '8px 14px 14px',
          background: C.panel, borderTop: `1px solid ${C.hair}`,
        }}>
          <button type="button" data-testid="review-cancel"
            disabled={sending}
            title={sending ? '주문을 보내는 중입니다' : undefined}
            onClick={() => review.cancel()}
            style={{
              flex: 1, padding: '12px 0', borderRadius: 9,
              border: `1px solid ${C.hair}`,
              background: sending ? C.panel : C.raised,
              color: sending ? C.faint : C.text,
              fontSize: FS.small, fontWeight: 800,
              cursor: sending ? 'not-allowed' : 'pointer',
            }}>돌아가서 수정</button>

          <button type="button" data-testid="review-confirm"
            disabled={v.off}
            data-confirm-action={v.action}
            title={v.reason || undefined}
            onClick={() => {
              // 판정을 다시 쓰지 않는다. 훅이 정한 것을 그대로 따른다.
              review.confirm();
            }}
            style={{
              flex: 1.4, padding: '12px 0', borderRadius: 9, border: 'none',
              background: v.off ? C.raised : C.up,
              color: v.off ? C.faint : '#fff',
              fontSize: FS.small, fontWeight: 800,
              cursor: v.off ? 'not-allowed' : 'pointer',
            }}>{sending ? '보내는 중…' : '확인 및 주문'}</button>
        </div>

        {/* 왜 못 누르는지 적는다 — 회색 버튼만 두지 않는다 */}
        {v.reason ? (
          <div data-testid="review-blocked-reason" style={{
            padding: '0 14px 12px', fontSize: FS.micro, color: C.warn, lineHeight: 1.4,
          }}>{v.reason}</div>
        ) : null}
      </div>
    </div>
  );
}
