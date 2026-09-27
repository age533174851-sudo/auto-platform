'use client';
// src/components/trading/markets/PaperCloseReviewSheet.tsx
//
// **포지션을 닫기 전에 읽는 창. 되돌릴 수 없는 동작 앞의 한 걸음.**
//
// 왜 읽기 전용인가
// ────────────────
// 여기에 수량이나 손절 칸을 두면 "일부만 닫기"·"손절 옮기기"가 이 창의
// 일이 되고, 그건 서버에 없는 기능이다(`/api/paper/close`는 전량만 닫는다).
// 없는 기능을 화면이 먼저 그리면 눌리는데 아무 일도 안 하는 칸이 된다.
//
// ★ 손익을 적지 않는다
// ────────────────────
// 열린 포지션의 미실현 손익 정본이 이 저장소에 없다. 예상 실현손익·ROE·
// 예상 체결가를 여기서 만들면 **세 번째 손익 권위**가 생긴다. 장부가 준
// 값만 적고, 나머지는 서버가 확인 시점에 정한다.
import React from 'react';
import { C, FS, NUM } from '@/components/terminal/theme';
import { formatMoneyForScope, type MoneyScope } from '@/lib/trading/gameMoney';
import { CLOSE_SERVER_REPRICE_NOTE, type CloseRow, type CloseValue }
  from '@/lib/trading/paperCloseReview';
import type { PaperCloseReview } from '@/lib/trading/usePaperCloseReview';
import { ReviewSheetShell } from './ReviewSheetShell';

export interface PaperCloseReviewSheetProps {
  review: PaperCloseReview;
  scope: MoneyScope;
}

/** 값 하나를 글자로. **`UNKNOWN`은 `—`이고 0이 아니다** */
function valueText(v: CloseValue, scope: MoneyScope): string {
  switch (v.kind) {
    case 'TEXT': return v.text;
    case 'MONEY': return formatMoneyForScope(v.amount, scope);
    case 'PRICE': return v.amount.toFixed(2);
    case 'QTY': return v.amount.toFixed(v.amount < 1 ? 6 : 4);
    case 'TIME': {
      const d = new Date(v.iso);
      return Number.isNaN(d.getTime()) ? v.iso : d.toLocaleString('ko-KR');
    }
    default: return '—';
  }
}

function Row({ row, scope }: { row: CloseRow; scope: MoneyScope }) {
  const unknown = row.value.kind === 'UNKNOWN';
  return (
    <div data-testid={`close-row-${row.key}`} data-unknown={unknown ? '1' : '0'}
      style={{
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
        gap: 10, padding: '6px 0', borderBottom: `1px solid ${C.hair}`, minWidth: 0,
      }}>
      <span style={{ fontSize: FS.nano, color: C.dim, flexShrink: 0 }}>{row.label}</span>
      <span style={{ minWidth: 0, textAlign: 'right' }}>
        <span data-testid={`close-value-${row.key}`} style={{
          ...NUM, fontSize: FS.small, fontWeight: 700,
          color: unknown ? C.faint : C.text,
        }}>{valueText(row.value, scope)}</span>
        {row.value.kind === 'UNKNOWN' ? (
          <span data-testid={`close-unknown-${row.key}`} style={{
            display: 'block', fontSize: FS.micro, color: C.warn, lineHeight: 1.35,
          }}>{row.value.reason}</span>
        ) : null}
      </span>
    </div>
  );
}

export function PaperCloseReviewSheet({ review, scope }: PaperCloseReviewSheetProps) {
  const open = review.phase !== 'NONE' && review.ticket != null;
  const v = review.verdict;
  const sending = review.phase === 'SUBMITTING';
  const id = review.ticket?.positionId ?? '';
  const sym = review.position?.symbol ?? '';

  return (
    <ReviewSheetShell
      open={open}
      testid="paper-close-review-sheet"
      title="전량청산 확인"
      label={`전량청산 확인 — ${sym || '포지션'}`}
      dataAttrs={{
        'data-close-position-id': id,
        'data-close-symbol': sym,
        'data-close-phase': review.phase,
      }}
      note={CLOSE_SERVER_REPRICE_NOTE}
      blockedReason={v.reason}
      footer={
        <>
          <button type="button" data-testid="close-review-cancel"
            disabled={sending}
            title={sending ? '청산 요청을 보내는 중입니다' : undefined}
            onClick={() => review.cancel()}
            style={{
              flex: 1, padding: '12px 0', borderRadius: 9,
              border: `1px solid ${C.hair}`,
              background: sending ? C.panel : C.raised,
              color: sending ? C.faint : C.text,
              fontSize: FS.small, fontWeight: 800,
              cursor: sending ? 'not-allowed' : 'pointer',
            }}>돌아가기</button>

          <button type="button" data-testid="close-review-confirm"
            disabled={v.off}
            data-close-action={v.action}
            title={v.reason || undefined}
            onClick={() => {
              // 판정을 다시 쓰지 않는다. 훅이 정한 것을 그대로 따른다.
              review.confirm();
            }}
            style={{
              flex: 1.4, padding: '12px 0', borderRadius: 9, border: 'none',
              background: v.off ? C.raised : C.down,
              color: v.off ? C.faint : '#fff',
              fontSize: FS.small, fontWeight: 800,
              cursor: v.off ? 'not-allowed' : 'pointer',
            }}>{sending ? '청산 중…' : '전량청산 확인'}</button>
        </>
      }>
      {review.rows.map(r => <Row key={r.key} row={r} scope={scope}/>)}

      {/* ★ 예상 실현손익·ROE 칸이 여기 없는 것은 **빠뜨린 것이 아니다.**
          그 값을 낼 정본이 아직 없어서 적지 않는다는 사실을 적는다. */}
      <div data-testid="close-no-pnl-note" style={{
        padding: '8px 0', fontSize: FS.micro, color: C.faint, lineHeight: 1.45,
      }}>
        열린 포지션의 손익은 아직 정본이 없어 적지 않습니다 — 실현 손익은
        청산된 뒤 장부에 기록됩니다.
      </div>

      {review.message ? (
        <div data-testid="close-review-message" style={{
          paddingBottom: 8, fontSize: FS.nano, lineHeight: 1.4,
          color: review.message.ok ? C.up : C.down,
        }}>{review.message.text}</div>
      ) : null}
    </ReviewSheetShell>
  );
}
