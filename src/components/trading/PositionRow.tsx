'use client';
// src/components/trading/PositionRow.tsx
//
// **한 화면 안의 열린 모의 포지션 한 줄.**
//
// 왜 이 줄이 필요했나
// ───────────────────
// 주문을 넣은 다음 그 포지션을 확인하고 닫는 것까지가 한 화면의 일이다.
// 그런데 정본 화면에는 포지션을 그리는 곳이 아예 없었고, 아래 `BottomDock`이
// 대신 그리고 있었다. 그 둘이 **다른 계좌를 보고 있었다.**
//
//   주문      TradingWorkspace → usePaperTarget(challengeId) → /api/paper/order
//   포지션 표시 BottomDock      → usePaperAccount            → /api/paper/account
//                                → readPaperEquity → is_default = true
//
// 챌린지 장부로 주문하면 주문은 챌린지 계좌로 가는데 화면은 **기본 계좌**를
// 읽는다. 방금 연 포지션이 안 보이고, 대신 남의 장부 포지션이 보인다.
// 화면에는 오류가 없다 — 그냥 "포지션이 없네"로 읽힌다.
//
// 그래서 이 줄은 **새로 읽지 않는다.** 같은 화면이 주문에 쓰는 바로 그
// `usePaperLedger` 결과를 그대로 받는다. 읽는 곳과 쓰는 곳이 같은 객체이면
// 계좌가 어긋날 자리가 아예 없다.
//
// RoE를 적지 않는 이유
// ────────────────────
// 진입가는 장부에 있지만 **열린 포지션의 미실현 손익을 내는 정본이 없다.**
// `/api/paper/positions`는 청산된 포지션의 실현 손익만 계산한다. 여기서
// 현재가로 대충 계산하면 수수료 포함 여부·격리/교차·배율 해석이 제각각인
// **세 번째 손익 권위**가 생긴다.
//
// 그래서 이 줄은 장부가 실제로 들고 있는 값만 적는다 — 방향·종목·진입가·
// 수량·청산가. 모르는 것은 `—`다.
import React, { useState } from 'react';
import { C, FS, NUM } from '@/components/terminal/theme';
import type { PaperLedgerPosition } from '@/lib/trading/usePaperLedger';

export interface PositionRowProps {
  /** `usePaperLedger`가 준 그대로. 이 컴포넌트는 다시 읽지 않는다 */
  positions: PaperLedgerPosition[];
  auth?: string;
  /** 청산 뒤 장부를 다시 읽는다 — `ledger.reload` */
  onClosed: () => void;
}

export function PositionRow({ positions, auth, onClosed }: PositionRowProps) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  if (!positions.length) return null;

  // 첫 화면은 **한 줄**이다. 포지션이 여럿이어도 차트와 주문 칸을 밀어내지
  // 않는다 — 나머지는 아래 포지션 독에 그대로 있다.
  const head = positions[0];
  const rest = positions.length - 1;

  return (
    <div data-testid="workspace-position" data-count={positions.length} style={{
      flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 2,
      padding: '4px 8px', borderTop: `1px solid ${C.hair}`,
      background: C.panel, minWidth: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flexWrap: 'wrap' }}>
        <span data-testid="position-side" style={{
          flexShrink: 0, fontSize: FS.nano, fontWeight: 800,
          color: head.side === 'SHORT' ? C.down : C.up,
        }}>{head.side}</span>
        <span data-testid="position-symbol" style={{
          flexShrink: 0, fontSize: FS.nano, fontWeight: 800, color: C.text,
        }}>{head.symbol}</span>

        <Cell label="진입" value={num(head.fillPrice)} testid="position-entry"/>
        <Cell label="수량" value={num(head.quantity, 6)} testid="position-qty"/>
        <Cell label="청산가" value={num(head.liquidationPrice)} testid="position-liq"/>

        <div style={{ flex: 1, minWidth: 4 }}/>

        {/* 청산은 **기존 정본 경로**다(`/api/paper/close`). 이 화면은
            계좌도 체결가도 보내지 않는다 — 서버가 포지션에서 계좌를 찾고
            마크가를 스스로 읽는다. 새 정산 권위를 만들지 않는다. */}
        <button
          type="button"
          data-testid="position-close"
          disabled={!auth || busyId === head.id}
          onClick={async () => {
            if (!auth) return;
            setBusyId(head.id); setMessage(null);
            try {
              const r = await fetch('/api/paper/close', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: auth },
                body: JSON.stringify({ positionId: head.id }),
              });
              const d = await r.json().catch(() => null);
              if (r.ok && d?.ok) { onClosed(); setMessage(null); }
              else setMessage(String(d?.message || d?.error || `청산 실패 (${r.status})`));
            } catch (e: any) {
              setMessage(`청산 실패 (${e?.message || e})`);
            } finally { setBusyId(null); }
          }}
          style={{
            flexShrink: 0, minHeight: 26, padding: '2px 8px', borderRadius: 5,
            border: `1px solid ${C.hair}`, background: C.raised,
            color: auth ? C.text : C.faint, fontSize: FS.nano, fontWeight: 700,
            cursor: auth ? 'pointer' : 'not-allowed', whiteSpace: 'nowrap',
          }}
        >{busyId === head.id ? '청산 중…' : '전량청산'}</button>
      </div>

      {rest > 0 ? (
        <div data-testid="position-more" style={{ fontSize: FS.nano, color: C.faint }}>
          외 {rest}건 — 내리면 전부 나옵니다
        </div>
      ) : null}

      {message ? (
        <div data-testid="position-message" style={{ fontSize: FS.nano, color: C.down, lineHeight: 1.35 }}>
          {message}
        </div>
      ) : null}
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
