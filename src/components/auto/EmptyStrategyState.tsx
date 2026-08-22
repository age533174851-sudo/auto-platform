'use client';
// src/components/auto/EmptyStrategyState.tsx
//
// **빈 화면으로 두지 않는다. 그렇다고 투자를 부추기지도 않는다.**
//
// "지금 가장 수익률 좋은 봇" 같은 문구는 금융 앱에서 쓰면 안 된다.
// 과거 성과를 미래 수익처럼 읽게 만들고, 그건 이 앱이 사용자에게
// 지켜야 할 신뢰의 반대편이다.
//
// 대신 **다음 한 걸음**을 준다. 그리고 그 한 걸음은 테스트넷이다 —
// 이 저장소의 규칙상 실전은 테스트넷 검증이 끝나기 전에 열지 않는다.
import React from 'react';
import { T } from '@/lib/constants';
import { A } from '@/lib/theme/colors';

export default function EmptyStrategyState(props: { onStart: () => void }) {
  return (
    <div style={{
      background: T.card, border: `1px dashed ${T.border}`, borderRadius: 12,
      padding: '20px 16px', marginBottom: 10, textAlign: 'center',
    }}>
      <div style={{ color: T.txt, fontWeight: 800, fontSize: 12.5 }}>
        아직 실행 중인 자동매매 전략이 없어요
      </div>
      <div style={{ color: T.muted, fontSize: 11, marginTop: 7, lineHeight: 1.6 }}>
        먼저 테스트넷에서 주문 흐름을 확인해 보세요.<br />
        같은 코드가 같은 안전 관문을 지나 돕니다 — 돈만 가짜입니다.
      </div>
      <button
        onClick={props.onStart}
        style={{
          marginTop: 14, minHeight: 44, padding: '0 18px', cursor: 'pointer',
          background: A(T.grn, '18'), color: T.grn,
          border: `1px solid ${A(T.grn, '40')}`, borderRadius: 10,
          fontSize: 12, fontWeight: 800,
        }}
      >테스트넷 전략 시작하기</button>
    </div>
  );
}
