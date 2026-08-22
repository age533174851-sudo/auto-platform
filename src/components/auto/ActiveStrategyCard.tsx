'use client';
// src/components/auto/ActiveStrategyCard.tsx
//
// **예약 한 줄을 사람이 읽는 카드로.**
//
// 예전에는 이 자리에 서버 내부 상태가 전부 나열돼 있었다 — 마지막 실행
// 시각, 다음 확인 가능 시각, UTC 원문, 실행기 주기 설명. 그건 무엇이
// 고장 났을 때 필요한 것이지 평소에 보는 것이 아니다.
//
// 카드 첫 화면은 넷만 말한다: 어느 전략인가 · 지금 도는가 ·
// 무엇을 들고 있는가 · 마지막에 뭐라고 판단했는가.
//
// **이름을 지어내지 않는다.** 서버가 내려준 전략만, 서버가 준 이름으로
// 그린다. 실제 등록되지 않은 상품명을 보여주면 사용자는 존재하지 않는
// 것을 켰다고 믿는다.
import React from 'react';
import { T } from '@/lib/constants';
import { A } from '@/lib/theme/colors';
import type { StrategyCardView } from '@/lib/ui/autoHome';
import { agoText } from '@/lib/engine/autotradeHealth';

export default function ActiveStrategyCard(props: {
  card: StrategyCardView;
  /** 지금. **컴포넌트가 Date.now()를 부르지 않는다** — 서버와 화면이
   *  다른 시각을 쓰면 '방금'과 '3분 전'이 같은 순간에 뜬다 */
  nowMs: number;
  onOpen: () => void;
}) {
  const c = props.card;
  const tone = c.running ? T.grn : T.muted;
  return (
    <button
      onClick={props.onOpen}
      style={{
        width: '100%', textAlign: 'left', cursor: 'pointer',
        background: T.card, border: `1px solid ${c.running ? A(T.grn, '30') : T.border}`,
        borderRadius: 12, padding: '12px 13px', marginBottom: 8, minHeight: 44, minWidth: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span style={{ color: T.txt, fontWeight: 900, fontSize: 12.5, minWidth: 0 }}>
          {c.symbol} {c.strategyName}
        </span>
        <span style={{ color: tone, fontSize: 10.5, fontWeight: 800, marginLeft: 'auto' }}>
          {c.running ? '● 실행 중' : '○ 꺼짐'}
        </span>
      </div>

      {/* **실전이면 계속 말한다.** 한 번 알려주고 마는 것으로는 부족하다 */}
      {c.live && (
        <div style={{ color: T.red, fontSize: 10, fontWeight: 800, marginTop: 5 }}>
          실제 자금으로 거래 중
        </div>
      )}

      {/* ── 마지막 판단 ──
          **'돌았다'와 '진입했다'는 다르다.** 대부분의 날은 조건이 안 맞아
          진입하지 않고, 그게 정상이라는 것이 보여야 사용자가 기다린다. */}
      <div style={{ marginTop: 7, color: T.muted, fontSize: 10.5, lineHeight: 1.55 }}>
        <div style={{ fontWeight: 700 }}>마지막 판단</div>
        <div style={{ color: T.txt, marginTop: 2 }}>
          {c.lastResult ?? '아직 판단 기록이 없습니다'}
          {c.lastRunAtMs != null && (
            <span style={{ color: T.muted }}> · {agoText(c.lastRunAtMs, props.nowMs)}</span>
          )}
        </div>
      </div>

      <div style={{ color: T.muted, fontSize: 9.5, marginTop: 7 }}>자세히 보기 ›</div>
    </button>
  );
}
