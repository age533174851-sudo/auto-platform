'use client';
// src/components/trading/PositionList.tsx
//
// **열린 모의 포지션 — 전부.**
//
// 예전 이름은 `PositionRow`였고 이름대로 굴었다
// ─────────────────────────────────────────────
// 화면은 `ledger.openPositions` 전체를 넘기는데 이 부품은
//
//     const head = positions[0];
//     const rest = positions.length - 1;
//
// 첫 줄만 그리고 나머지는 `외 N건`으로 적었다. 하단 내비의 **포지션 탭**
// 인데 두 번째 포지션을 닫을 방법이 화면에 없었다. "내리면 전부 나옵니다"
// 라고 적혀 있었지만 아래에 아무것도 없었다 — 만들어 놓고 배선을 안 한
// 경우다.
//
// 그래서 역할을 둘로 가른다: `PositionItem`이 한 포지션의 정본 표시이고
// `PositionList`가 전부를 그린다. 이름이 하는 일과 같아졌다.
//
// ★ 여기서 청산 요청을 보내지 않는다
// ──────────────────────────────────
// 예전에는 `[전량청산]`이 클릭 즉시 `fetch('/api/paper/close')`를 불렀다.
// **되돌릴 수 없는 동작이 한 번의 클릭**이었고, 좁은 화면에서 옆 칸을
// 누르려다 닿는 자리에 있었다. 진입은 Phase 2C에서 확인 창을 거치게 했는데
// 청산은 그대로였다 — 더 위험한 쪽이 더 쉬웠다.
//
// 이제 이 버튼은 **확인 창을 열 뿐**이고, 요청은 `usePaperCloseReview`
// 한 곳에서 나간다.
//
// RoE를 적지 않는 이유
// ────────────────────
// 진입가는 장부에 있지만 **열린 포지션의 미실현 손익을 내는 정본이 없다.**
// `/api/paper/positions`는 청산된 포지션의 실현 손익만 계산한다. 여기서
// 현재가로 대충 계산하면 수수료 포함 여부·격리/교차·배율 해석이 제각각인
// **세 번째 손익 권위**가 생긴다.
//
// 그래서 이 화면은 장부가 실제로 들고 있는 값만 적는다. 모르는 것은 `—`다.
import React from 'react';
import { C, FS, NUM } from '@/components/terminal/theme';
import type { PaperLedgerPosition } from '@/lib/trading/usePaperLedger';
import type { PaperCloseReview } from '@/lib/trading/usePaperCloseReview';

export interface PositionListProps {
  /** `usePaperLedger`가 준 그대로. 이 컴포넌트는 다시 읽지 않는다 */
  positions: PaperLedgerPosition[];
  /**
   * 청산 확인 창. **여기서 만들지 않는다** — 화면이 배경을 `inert`로
   * 만들려면 같은 상태를 봐야 하고, 사본을 두면 판단이 두 벌이 된다.
   */
  closeReview: PaperCloseReview;
  /** 로그인 여부만 본다. 값은 확인 창이 들고 있다 */
  auth?: string;
}

export function PositionList({ positions, closeReview, auth }: PositionListProps) {
  if (!positions.length) return null;

  return (
    <div data-testid="workspace-position" data-count={positions.length} style={{
      flexShrink: 0, display: 'flex', flexDirection: 'column',
      borderTop: `1px solid ${C.hair}`, background: C.panel, minWidth: 0,
    }}>
      {/* ★ **전부 그린다.** 첫 줄만 그리고 "외 N건"으로 접으면 나머지
          포지션은 이 화면에서 닫을 방법이 없다. */}
      {positions.map(p => (
        <PositionItem key={p.id} position={p} closeReview={closeReview} auth={auth}/>
      ))}
    </div>
  );
}

export function PositionItem({ position, closeReview, auth }: {
  position: PaperLedgerPosition;
  closeReview: PaperCloseReview;
  auth?: string;
}) {
  const mine = closeReview.ticket?.positionId === position.id;
  // 다른 포지션을 청산하는 중이면 이 줄도 잠근다 — 두 청산이 겹치면
  // 어느 쪽 결과인지 화면이 말해 줄 수 없다.
  const otherBusy = closeReview.phase !== 'NONE' && !mine;
  const off = !auth || otherBusy || closeReview.phase === 'SUBMITTING';

  return (
    <div data-testid="position-item" data-position-id={position.id} style={{
      display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flexWrap: 'wrap',
      padding: '4px 8px', borderBottom: `1px solid ${C.hair2}`,
    }}>
      <span data-testid="position-side" style={{
        flexShrink: 0, fontSize: FS.nano, fontWeight: 800,
        color: position.side === 'SHORT' ? C.down : C.up,
      }}>{position.side}</span>
      <span data-testid="position-symbol" style={{
        flexShrink: 0, fontSize: FS.nano, fontWeight: 800, color: C.text,
      }}>{position.symbol}</span>

      <Cell label="진입" value={num(position.fillPrice)} testid="position-entry"/>
      <Cell label="수량" value={num(position.quantity, 6)} testid="position-qty"/>
      <Cell label="청산가" value={num(position.liquidationPrice)} testid="position-liq"/>

      <div style={{ flex: 1, minWidth: 4 }}/>

      {/* ★ 이 버튼은 **확인 창을 열 뿐이다.** 요청은 여기서 나가지 않는다.
          되돌릴 수 없는 동작을 한 번의 클릭에 두지 않는다. */}
      <button
        type="button"
        data-testid="position-close"
        data-for-position={position.id}
        disabled={off}
        title={!auth ? '로그인해야 청산할 수 있습니다'
          : otherBusy ? '다른 포지션을 확인하는 중입니다' : undefined}
        onClick={(e) => {
          // ★ 누른 버튼이 **포커스를 갖게 한다.**
          //
          //   확인 창이 닫힐 때 포커스를 원래 자리로 돌려놓으려면 열 때
          //   그 자리가 있어야 한다. 마우스 클릭은 브라우저가 알아서
          //   포커스를 주지만 터치·프로그램 호출은 그렇지 않다 — 그때는
          //   창을 닫은 뒤 포커스가 문서 처음으로 떨어지고, 키보드
          //   사용자는 목록을 처음부터 다시 훑어야 한다.
          e.currentTarget.focus();
          closeReview.open(position.id);
        }}
        style={{
          flexShrink: 0, minHeight: 26, padding: '2px 8px', borderRadius: 5,
          border: `1px solid ${C.hair}`,
          background: off ? C.panel : C.raised,
          color: off ? C.faint : C.text,
          fontSize: FS.nano, fontWeight: 700,
          cursor: off ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap',
        }}
      >전량청산</button>
    </div>
  );
}

/** **못 읽은 값은 `—`다.** 0으로 적으면 청산가가 0인 포지션으로 읽힌다. */
function num(v: any, digits = 2): string {
  if (v == null || v === '' || typeof v === 'boolean') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

function Cell({ label, value, testid }: { label: string; value: string; testid: string }) {
  return (
    <span style={{ display: 'inline-flex', gap: 3, alignItems: 'baseline', minWidth: 0 }}>
      <span style={{ fontSize: FS.nano, color: C.faint, flexShrink: 0 }}>{label}</span>
      <span data-testid={testid} style={{
        ...NUM, fontSize: FS.nano, color: C.dim, fontWeight: 700,
        minWidth: 0, overflowWrap: 'anywhere',
      }}>{value}</span>
    </span>
  );
}
