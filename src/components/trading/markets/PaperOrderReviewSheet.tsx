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
// 어디에 적을지만 안다.
//
// ★ 모양 · 포커스 · 바닥 줄은 `ReviewSheetShell`이 한다
// ─────────────────────────────────────────────────────
// 청산 확인 창(Phase 2D)과 키보드 규칙이 같다. 두 벌로 짜면 한쪽만
// 고쳐지고, 눈으로는 똑같은데 한 창에서만 포커스가 새는 상태가 된다.
// 본문 스크롤 + 바닥 줄 고정도 거기 있다 — 실기에서 확인 버튼이 밀려
// 안 보인 적이 있다.
//
// **판정과 부수효과는 공유하지 않는다** — 진입과 청산은 다른 업무다.
import React from 'react';
import { C, FS, NUM } from '@/components/terminal/theme';
import { formatMoneyForScope } from '@/lib/trading/gameMoney';
import { REVIEW_SERVER_RECALC_NOTE, type ReviewRow, type ReviewValue }
  from '@/lib/trading/paperOrderReview';
import type { PaperOrderReview } from '@/lib/trading/usePaperOrderReview';
import type { MoneyScope } from '@/lib/trading/gameMoney';
import { ReviewSheetShell } from './ReviewSheetShell';

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
  const open = review.phase !== 'NONE' && review.ticket != null;
  const v = review.verdict;
  const sending = review.phase === 'SUBMITTING';
  const t = review.ticket;

  return (
    <ReviewSheetShell
      open={open}
      testid="paper-order-review-sheet"
      title="주문 확인"
      label={`주문 확인 — ${t?.market ?? ''} ${t?.symbol ?? ''} ${t?.side ?? ''}`}
      dataAttrs={{
        'data-review-market': t?.market ?? '',
        'data-review-symbol': t?.symbol ?? '',
        'data-review-side': t?.side ?? '',
        'data-review-phase': review.phase,
      }}
      // 이미 실기·검사기가 보고 있는 이름을 그대로 쓴다 — 공용 껍데기로
      // 옮겼다는 이유로 증거의 이름이 바뀌면 그 증거가 끊긴다.
      ids={{
        backdrop: 'paper-order-review-backdrop', body: 'review-body',
        note: 'review-recalc-note', footer: 'review-footer',
        blocked: 'review-blocked-reason',
      }}
      note={REVIEW_SERVER_RECALC_NOTE}
      blockedReason={v.reason}
      footer={
        <>
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
        </>
      }>
      {review.rows.map(r => <Row key={r.key} row={r} scope={scope}/>)}

      {review.message ? (
        <div data-testid="review-message" style={{
          paddingBottom: 8, fontSize: FS.nano, lineHeight: 1.4,
          color: review.message.ok ? C.up : C.down,
        }}>{review.message.text}</div>
      ) : null}
    </ReviewSheetShell>
  );
}
