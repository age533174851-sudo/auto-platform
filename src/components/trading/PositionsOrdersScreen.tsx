'use client';
// src/components/trading/PositionsOrdersScreen.tsx
//
// **하단 '거래' 탭 — 새 주문을 여는 곳이 아니라 들고 있는 것을 다루는 곳이다.**
//
// 왜 이 탭이 Markets가 아닌가
// ───────────────────────────
// 시장 탐색은 이미 '시장' 탭이 한다. 거래 탭까지 Markets로 보내면 같은
// 목적지가 둘이 되고, 사용자는 어느 쪽이 무엇인지 배워야 한다.
//
// 새 주문은 **종목에서 시작한다**:
//
//     시장 / 왓치리스트 / 검색 → 종목 상세 → 주문 화면
//
// 그래서 이 탭이 맡는 것은 그 다음이다 — 열린 포지션, 미체결 주문,
// 주문·체결 내역.
//
// ★ 칸을 만들려고 값을 지어내지 않는다
// ────────────────────────────────────
// 화면을 채우고 싶어서 "미체결 0건"이라고 적으면 그건 **거짓이다.**
// 우리 모의 장부에는 대기 주문이라는 개념 자체가 없다(`/api/paper/order`가
// 즉시 체결만 받는다). 0건과 "그런 것이 없다"는 다른 말이고, 0건이라고
// 적으면 사용자는 대기 주문 기능이 있는데 지금 비어 있는 것으로 읽는다.
//
// 주문 내역도 같다. `/api/paper/`에 내역을 주는 경로가 없다 —
// account · holdings · positions · order · sell · close · modify뿐이다.
//
// 그래서 **출처가 있는 것만 그리고, 없는 것은 잠그고 이유를 적는다.**
import React from 'react';
import { C, FS } from '@/components/terminal/theme';
import { PositionRow } from './PositionRow';
import { usePaperTarget } from '@/lib/trading/usePaperTarget';
import { usePaperLedger } from '@/lib/trading/usePaperLedger';

export interface PositionsOrdersScreenProps {
  auth?: string;
}

/** 출처가 없는 칸. **비어 있다고 적지 않는다 — 없다고 적는다** */
function Locked({ title, reason }: { title: string; reason: string }) {
  return (
    <section data-testid={`locked-${title}`} style={{
      border: `1px solid ${C.hair}`, borderRadius: 10, background: C.panel,
      padding: 14, display: 'grid', gap: 6,
    }}>
      <div style={{ fontSize: FS.body, fontWeight: 800, color: C.dim }}>{title}</div>
      <div style={{ fontSize: FS.small, color: C.faint, lineHeight: 1.6 }}>{reason}</div>
    </section>
  );
}

export function PositionsOrdersScreen({ auth }: PositionsOrdersScreenProps) {
  const [target] = usePaperTarget();
  // 주문 화면이 쓰는 **바로 그 장부**다. 여기서 따로 읽으면 같은 포지션이
  // 두 화면에서 다르게 보인다.
  const ledger = usePaperLedger(target, !!auth);
  const positions = auth ? ledger.openPositions : [];

  return (
    <div data-testid="positions-orders-screen" style={{
      display: 'flex', flexDirection: 'column', gap: 12, padding: '12px 12px 24px',
      minHeight: 0,
    }}>
      <header style={{ display: 'grid', gap: 3 }}>
        <h1 style={{ margin: 0, fontSize: FS.lead, fontWeight: 900, color: C.text }}>
          포지션 · 주문
        </h1>
        <p style={{ margin: 0, fontSize: FS.small, color: C.faint, lineHeight: 1.6 }}>
          새로 사고팔려면 <b>시장</b>이나 <b>왓치리스트</b>에서 종목을 고르세요.
        </p>
      </header>

      {/* ── 열린 포지션 — 출처가 있다 ── */}
      <section data-testid="open-positions" style={{ display: 'grid', gap: 8 }}>
        <div style={{ fontSize: FS.body, fontWeight: 800, color: C.dim }}>열린 포지션</div>
        {!auth ? (
          <Locked title="로그인 필요" reason="로그인하면 모의 장부의 열린 포지션을 볼 수 있습니다."/>
        ) : ledger.error ? (
          // **못 읽은 것을 '없음'으로 적지 않는다.**
          <Locked title="읽지 못했습니다" reason={ledger.error}/>
        ) : positions.length ? (
          <PositionRow positions={positions} auth={auth} onClosed={ledger.reload}/>
        ) : (
          <div style={{
            border: `1px dashed ${C.hair}`, borderRadius: 10, padding: 16,
            fontSize: FS.small, color: C.faint, textAlign: 'center',
          }}>열린 포지션이 없습니다</div>
        )}
      </section>

      {/* ── 미체결 · 내역 — 출처가 없다 ── */}
      <Locked
        title="미체결 주문"
        reason={'모의 장부는 대기 주문을 받지 않습니다 — 낼 수 있는 것은 즉시 '
          + '체결뿐입니다. 없는 기능을 비어 있는 것처럼 적지 않습니다.'}
      />
      <Locked
        title="주문 · 체결 내역"
        reason={'내역을 돌려주는 경로가 아직 없습니다. 만들어지면 여기에 붙습니다 — '
          + '그때까지 화면에서 지어내지 않습니다.'}
      />
    </div>
  );
}
