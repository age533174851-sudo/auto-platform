'use client';
// src/components/ui/DataBadge.tsx
//
// 값 하나에 "어디서 왔고 얼마나 오래됐는지"를 붙이는 배지.
//
// 판정은 lib/engine/dataQuality.ts(순수 함수)가 하고 여기서는 그리기만 한다.
// 규칙이 화면 코드 안에 들어가면 화면마다 다르게 판정하게 된다 —
// 호가창은 '실시간'이라 하고 차트는 아무 말도 안 하는 식이 된다.
//
// 모양 규칙 (dataQuality.badgeStyle이 정한다):
//   ● 채운 점   실시간 (WebSocket)
//   ○ 빈 고리   주기 수신·계산값·AI 추정 — 실시간이 아니다
//   ◌ 점선      모의 — 거래소에 존재하지 않는 값
//   ⚠ 경고      멈춤·수신 없음
//
// 색만으로 구분하지 않는 이유: 색약이거나 화면을 빠르게 훑을 때 구분되지
// 않는다. 실제로 가짜 호가가 실시간처럼 보이던 사고가 있었다.
import React, { useEffect, useState } from 'react';
import { T } from '@/lib/constants';
import { assess, badgeStyle, worst, type DataSource, type BadgeTone } from '@/lib/engine/dataQuality';

const TONE: Record<BadgeTone, string> = {
  good: T.grn,
  caution: T.ylw,
  bad: T.red,
  neutral: T.sub,
};

/**
 * 나이 표시를 1초마다 다시 그린다.
 *
 * 데이터가 안 와도 나이는 계속 늘어난다. 다시 그리지 않으면 '81ms 전'이
 * 화면에 얼어붙어, 값이 멈춘 것을 오히려 감춘다.
 */
function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function Mark({ shape, color }: { shape: string; color: string }) {
  const base: React.CSSProperties = {
    display: 'inline-block', width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
  };
  if (shape === 'dot') {
    return <span style={{ ...base, background: color, animation: 'pulse 1.5s ease-in-out infinite' }} />;
  }
  if (shape === 'ring') {
    return <span style={{ ...base, border: `1.5px solid ${color}` }} />;
  }
  if (shape === 'dashed') {
    return <span style={{ ...base, border: `1.5px dashed ${color}` }} />;
  }
  // warning — 점 계열과 확실히 다른 형태여야 한다
  return <span style={{ color, fontSize: 10, lineHeight: 1, flexShrink: 0 }}>⚠</span>;
}

export interface DataBadgeProps {
  source: DataSource;
  /** 작게 — 값 옆에 붙일 때 */
  compact?: boolean;
  style?: React.CSSProperties;
}

export function DataBadge({ source, compact, style }: DataBadgeProps) {
  const now = useNow();
  const a = assess(source, now);
  const { shape, tone } = badgeStyle(a);
  const color = TONE[tone];

  return (
    <span
      title={a.text}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        fontSize: compact ? 8 : 9, color,
        fontFamily: 'Inter,monospace', fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap', ...style,
      }}
    >
      <Mark shape={shape} color={color} />
      {compact ? <span>{a.text.split(' · ').slice(-2).join(' · ')}</span> : <span>{a.text}</span>}
    </span>
  );
}

/**
 * 값 자체를 감싸는 형태. 모의·추정·멈춘 값이면 값에도 표시가 남는다.
 *
 * 배지를 옆에 두는 것만으로는 부족하다. 사용자는 큰 숫자를 먼저 보고
 * 작은 글씨는 나중에 본다. 실전 근거가 아닌 값은 숫자 자체가 달라 보여야 한다.
 */
export function DataValue(
  { source, children, style }: { source: DataSource; children: React.ReactNode; style?: React.CSSProperties },
) {
  const now = useNow();
  const a = assess(source, now);
  if (a.tradeable) return <span style={style}>{children}</span>;
  return <MarkedValue assessment={a} style={style}>{children}</MarkedValue>;
}

function MarkedValue(
  { assessment: a, children, style }:
  { assessment: ReturnType<typeof assess>; children: React.ReactNode; style?: React.CSSProperties },
) {

  const dimmed = a.freshness === 'STALE' || a.freshness === 'NONE';
  return (
    <span
      title={a.text}
      style={{
        ...style,
        opacity: dimmed ? 0.45 : 1,
        // 실전 근거가 아닌 값에는 밑줄을 그어 둔다. 숫자만 봐도 다르다.
        textDecoration: 'underline',
        textDecorationStyle: a.kind === 'SIMULATED' ? 'dashed' : 'dotted',
        textDecorationColor: dimmed ? T.red : T.sub,
        textUnderlineOffset: 3,
      }}
    >
      {children}
    </span>
  );
}

/**
 * 여러 값 중 **가장 나쁜 상태 하나**를 띄운다.
 *
 * 왜 필요한가
 * ───────────
 * 호가창 한 화면에 현재가(WebSocket 100ms) · 24h 변동률(REST 5초) ·
 * 호가 잔량 계산값이 같이 있다. 배지를 각각 붙이면 셋을 다 읽어야
 * "지금 이 화면을 믿어도 되는가"를 알 수 있는데, 급할 때 그걸 읽는
 * 사람은 없다.
 *
 * **하나라도 문제면 문제다.** 그래서 최악만 앞에 세운다 — 전부 정상이면
 * 눈에 안 띄고, 하나라도 멈추면 그것이 대표로 뜬다.
 *
 * 판정은 dataQuality.worst가 한다. 여기서 다시 고르면 화면마다 '나쁨'의
 * 순서가 달라진다.
 */
export function DataHealth(
  { sources, compact, style }:
  { sources: DataSource[]; compact?: boolean; style?: React.CSSProperties },
) {
  const now = useNow();
  const list = (Array.isArray(sources) ? sources : []).filter(Boolean);
  // **빈 목록을 '정상'으로 그리지 않는다.** 볼 것이 없는 것과 다 괜찮은
  // 것은 다르다.
  if (list.length === 0) return null;
  const a = worst(list.map(s => assess(s, now)));
  if (!a) return null;
  const { shape, tone } = badgeStyle(a);
  const color = TONE[tone];
  const others = list.length - 1;

  return (
    <span
      title={list.map(s => assess(s, now).text).join('\n')}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        fontSize: compact ? 8 : 9, color,
        fontFamily: 'Inter,monospace', fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap', ...style,
      }}
    >
      <Mark shape={shape} color={color}/>
      <span>{compact ? a.text.split(' · ').slice(-2).join(' · ') : a.text}</span>
      {others > 0 && <span style={{ opacity: 0.6 }}>외 {others}</span>}
    </span>
  );
}
