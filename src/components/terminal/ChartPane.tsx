'use client';
// src/components/terminal/ChartPane.tsx
//
// 중앙 차트.
//
// 상태 격리가 이 파일의 전부다.
// ─────────────────────────────
// 차트는 iframe이다. 부모가 다시 그려지면 iframe이 새로 붙고, 그러면
// 사용자가 그려둔 추세선과 확대해둔 구간이 전부 날아간다. 좌측 뉴스가
// 30초마다 갱신되는데 그때마다 차트가 리셋되면 쓸 수 없는 화면이 된다.
//
// 그래서 이 컴포넌트는
//   1. props를 심볼과 간격 두 개만 받고
//   2. memo로 감싸 그 둘이 그대로면 아예 다시 그리지 않고
//   3. 내부 상태(간격 선택)는 자기 안에만 둔다.
import React, { memo, useState, useEffect } from 'react';
import { T } from '@/lib/constants';
import { InlineTVChart } from '@/components/pages/SharedUI';

const INTERVALS: { id: string; label: string }[] = [
  { id: '1', label: '1m' }, { id: '5', label: '5m' }, { id: '15', label: '15m' },
  { id: '60', label: '1H' }, { id: '240', label: '4H' }, { id: 'D', label: '1D' },
];

const IV_KEY = 'tg_terminal_interval';

/** 심볼만 바뀌면 다시 그린다. 그 외에는 절대 건드리지 않는다. */
function ChartInner({ symbol }: { symbol: string }) {
  const [interval, setInterval] = useState('60');
  const [layout, setLayout] = useState<'default' | 'minimal' | 'pro'>('default');

  useEffect(() => {
    try {
      const v = localStorage.getItem(IV_KEY);
      if (v) setInterval(v);
      const l = localStorage.getItem(IV_KEY + '_layout');
      if (l === 'minimal' || l === 'pro' || l === 'default') setLayout(l);
    } catch {}
  }, []);

  const pick = (v: string) => {
    setInterval(v);
    try { localStorage.setItem(IV_KEY, v); } catch {}
  };
  const pickLayout = (v: 'default' | 'minimal' | 'pro') => {
    setLayout(v);
    try { localStorage.setItem(IV_KEY + '_layout', v); } catch {}
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 3, padding: '4px 8px',
        borderBottom: `1px solid ${T.border}`, flexShrink: 0,
      }}>
        {INTERVALS.map(iv => (
          <button key={iv.id} onClick={() => pick(iv.id)} style={{
            background: interval === iv.id ? T.acc : 'transparent',
            color: interval === iv.id ? '#fff' : T.sub,
            border: `1px solid ${interval === iv.id ? T.acc : T.border}`,
            borderRadius: 5, padding: '2px 8px', fontSize: 10, fontWeight: 700, cursor: 'pointer',
          }}>{iv.label}</button>
        ))}
        <div style={{ flex: 1 }}/>
        {(['default', 'minimal', 'pro'] as const).map(l => (
          <button key={l} onClick={() => pickLayout(l)} style={{
            background: layout === l ? T.alt : 'transparent',
            color: layout === l ? T.acl : T.muted,
            border: `1px solid ${layout === l ? T.border2 : 'transparent'}`,
            borderRadius: 5, padding: '2px 7px', fontSize: 9, fontWeight: 700, cursor: 'pointer',
          }}>{l === 'default' ? '기본' : l === 'minimal' ? '간결' : '고급'}</button>
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 0, padding: 4 }}>
        {/* key에 심볼과 간격만 넣는다. 다른 무엇이 바뀌어도 iframe은 살아남는다. */}
        <InlineTVChart
          key={`${symbol}-${interval}-${layout}`}
          symbol={symbol}
          interval={interval}
          mode={layout}
          studies={layout === 'pro' ? ['RSI@tv-basicstudies', 'MACD@tv-basicstudies'] : undefined}
        />
      </div>
    </div>
  );
}

export const ChartPane = memo(ChartInner, (a, b) => a.symbol === b.symbol);
