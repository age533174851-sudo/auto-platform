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
import { C, FS, tabStyle } from './theme';
import { InlineTVChart } from '@/components/pages/SharedUI';

const INTERVALS: { id: string; label: string }[] = [
  { id: '1', label: '1m' }, { id: '5', label: '5m' }, { id: '15', label: '15m' },
  { id: '60', label: '1H' }, { id: '240', label: '4H' }, { id: 'D', label: '1D' },
];

const IV_KEY = 'tg_terminal_interval';

/** 심볼만 바뀌면 다시 그린다. 그 외에는 절대 건드리지 않는다. */
function ChartInner({ symbol, compact }: { symbol: string; compact?: boolean }) {
  const [interval, setInterval] = useState('60');
  // 모바일 기본값은 'minimal'이다. TradingView 자체 도구줄까지 나오면
  // 차트 위에 도구줄이 세 겹으로 쌓여 정작 봉이 안 보인다.
  const [layout, setLayout] = useState<'default' | 'minimal' | 'pro'>(compact ? 'minimal' : 'default');

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
        display: 'flex', alignItems: 'center', gap: 3,
        padding: compact ? '6px 8px' : '6px 8px 6px 46px',
        borderBottom: `1px solid ${C.hair}`, flexShrink: 0,
        overflowX: 'auto', scrollbarWidth: 'none',
      }}>
        {INTERVALS.map(iv => (
          <button key={iv.id} onClick={() => pick(iv.id)} style={tabStyle(interval === iv.id)}>
            {iv.label}
          </button>
        ))}
        <div style={{ flex: 1, minWidth: 8 }}/>
        {/* 레이아웃 전환은 PC에서만. 모바일에서는 이 세 버튼이 간격 버튼을
            밀어내서 정작 자주 쓰는 것이 화면 밖으로 나간다. */}
        {!compact && (['default', 'minimal', 'pro'] as const).map(l => (
          <button key={l} onClick={() => pickLayout(l)} style={{
            ...tabStyle(layout === l), fontSize: FS.micro, padding: '4px 9px',
          }}>{l === 'default' ? '기본' : l === 'minimal' ? '간결' : '고급'}</button>
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 0, padding: compact ? 0 : 6, background: C.bg }}>
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

export const ChartPane = memo(ChartInner, (a, b) => a.symbol === b.symbol && a.compact === b.compact);
