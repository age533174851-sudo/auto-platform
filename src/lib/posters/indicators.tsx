'use client';
import React from 'react';
import type { PosterType } from './meta';

// 모든 인디케이터는 viewBox="0 0 400 220"으로 통일.
// 부모 SVG 안에 nested SVG로 삽입하기 위해 React.SVGProps 받음.

interface ChartProps {
  x?: number;       // 부모 SVG 안에서의 위치
  y?: number;
  width?: number;
  height?: number;
  primaryColor?: string;
}

// ─── Ichimoku 5선 ────────────────────────────────────────────────
function IchimokuChart({ x = 0, y = 0, width = 400, height = 220, primaryColor = '#60A5FA' }: ChartProps) {
  // 가격선
  const pricePath = 'M10,140 L40,130 L70,115 L100,120 L130,100 L160,90 L190,95 L220,75 L250,80 L280,65 L310,60 L340,70 L370,55 L390,50';
  // 전환선 (파랑)
  const tenkanPath = 'M10,130 L40,125 L70,118 L100,115 L130,105 L160,95 L190,98 L220,85 L250,82 L280,72 L310,68 L340,72 L370,62 L390,58';
  // 기준선 (빨강)
  const kijunPath = 'M10,150 L40,148 L70,140 L100,135 L130,128 L160,118 L190,110 L220,102 L250,95 L280,88 L310,80 L340,75 L370,70 L390,65';
  // Span A (위 선, 구름대 상단)
  const spanAPath = 'M10,160 L40,155 L70,148 L100,140 L130,132 L160,122 L190,115 L220,108 L250,100 L280,92 L310,85 L340,78 L370,72 L390,68';
  // Span B (아래 선, 구름대 하단)
  const spanBPath = 'M10,175 L40,172 L70,168 L100,162 L130,155 L160,148 L190,140 L220,132 L250,125 L280,118 L310,112 L340,105 L370,100 L390,95';
  return (
    <svg x={x} y={y} width={width} height={height} viewBox="0 0 400 220">
      {/* 격자 */}
      {[40,80,120,160,200].map(yy => (
        <line key={yy} x1="0" y1={yy} x2="400" y2={yy} stroke="#243A5E" strokeOpacity="0.3" strokeDasharray="2 4"/>
      ))}
      {/* 구름대 fill — 상승 (Span A > Span B) → 초록 반투명 */}
      <path d={`${spanAPath} L390,95 L370,100 L340,105 L310,112 L280,118 L250,125 L220,132 L190,140 L160,148 L130,155 L100,162 L70,168 L40,172 L10,175 Z`}
        fill="#10B981" fillOpacity="0.18"/>
      {/* Span A — 초록 */}
      <path d={spanAPath} stroke="#10B981" strokeWidth="1.4" fill="none" strokeOpacity="0.9"/>
      {/* Span B — 빨강 */}
      <path d={spanBPath} stroke="#EF4444" strokeWidth="1.4" fill="none" strokeOpacity="0.85"/>
      {/* 가격선 */}
      <path d={pricePath} stroke="#E2E8F0" strokeWidth="2.2" fill="none"/>
      {/* 전환선 — 파랑 */}
      <path d={tenkanPath} stroke="#60A5FA" strokeWidth="1.6" fill="none" strokeOpacity="0.95"/>
      {/* 기준선 — 빨강 */}
      <path d={kijunPath} stroke="#F87171" strokeWidth="1.6" fill="none" strokeOpacity="0.9"/>
      {/* 라벨 */}
      <g fontFamily="sans-serif" fontSize="9" fontWeight="700">
        <rect x="6" y="6" width="56" height="14" rx="3" fill="#60A5FA22" stroke="#60A5FA" strokeWidth="0.5"/>
        <text x="10" y="16" fill="#60A5FA">전환선</text>
        <rect x="68" y="6" width="56" height="14" rx="3" fill="#F8717122" stroke="#F87171" strokeWidth="0.5"/>
        <text x="72" y="16" fill="#F87171">기준선</text>
        <rect x="130" y="6" width="56" height="14" rx="3" fill="#10B98122" stroke="#10B981" strokeWidth="0.5"/>
        <text x="134" y="16" fill="#10B981">구름대</text>
      </g>
      {/* 신호 화살표 */}
      <g>
        <circle cx="190" cy="95" r="5" fill="#10B981" stroke="#fff" strokeWidth="1.5"/>
        <text x="200" y="100" fill="#10B981" fontSize="9" fontFamily="sans-serif" fontWeight="800">매수</text>
      </g>
    </svg>
  );
}

// ─── RSI ──────────────────────────────────────────────────────────
function RsiChart({ x = 0, y = 0, width = 400, height = 220, primaryColor = '#A78BFA' }: ChartProps) {
  // RSI 라인 — 0~100 스케일 (svg y는 반전: 0=상단)
  // 가격 (상단)
  const pricePath = 'M10,40 L50,50 L90,45 L130,60 L170,80 L210,72 L250,60 L290,75 L330,55 L370,38 L390,42';
  // RSI (하단 영역에 그림. 30~70선)
  const rsiPath = 'M10,150 L50,140 L90,165 L130,178 L170,185 L210,170 L250,150 L290,148 L330,130 L370,115 L390,118';
  // 과매수 70선 = y 130, 과매도 30선 = y 190
  return (
    <svg x={x} y={y} width={width} height={height} viewBox="0 0 400 220">
      {/* 가격 영역 (상단 0~110) */}
      <rect x="0" y="0" width="400" height="110" fill="#060B14"/>
      <path d={pricePath} stroke="#E2E8F0" strokeWidth="2.2" fill="none"/>
      <text x="10" y="14" fill="#94A3B8" fontSize="9" fontFamily="sans-serif" fontWeight="700">PRICE</text>
      {/* 구분선 */}
      <line x1="0" y1="115" x2="400" y2="115" stroke="#1A2D4A" strokeWidth="1"/>
      {/* RSI 영역 (115~210) */}
      {/* 70선 (과매수, 빨강 영역) */}
      <rect x="0" y="120" width="400" height="20" fill="#EF4444" fillOpacity="0.1"/>
      <line x1="0" y1="130" x2="400" y2="130" stroke="#EF4444" strokeWidth="0.7" strokeDasharray="3 3"/>
      <text x="6" y="128" fill="#EF4444" fontSize="9" fontFamily="sans-serif" fontWeight="700">70 과매수</text>
      {/* 30선 (과매도, 초록 영역) */}
      <rect x="0" y="180" width="400" height="30" fill="#10B981" fillOpacity="0.1"/>
      <line x1="0" y1="190" x2="400" y2="190" stroke="#10B981" strokeWidth="0.7" strokeDasharray="3 3"/>
      <text x="6" y="200" fill="#10B981" fontSize="9" fontFamily="sans-serif" fontWeight="700">30 과매도</text>
      {/* RSI 라인 */}
      <path d={rsiPath} stroke="#A78BFA" strokeWidth="2.2" fill="none"/>
      <text x="350" y="128" fill="#A78BFA" fontSize="9" fontFamily="sans-serif" fontWeight="800">RSI</text>
      {/* 다이버전스 표시 */}
      <g>
        <line x1="50" y1="50" x2="170" y2="80" stroke="#F59E0B" strokeWidth="1" strokeDasharray="2 2"/>
        <line x1="50" y1="140" x2="170" y2="185" stroke="#F59E0B" strokeWidth="1" strokeDasharray="2 2"/>
        <text x="100" y="90" fill="#F59E0B" fontSize="9" fontFamily="sans-serif" fontWeight="800">DIVERGENCE</text>
      </g>
    </svg>
  );
}

// ─── MACD ─────────────────────────────────────────────────────────
function MacdChart({ x = 0, y = 0, width = 400, height = 220, primaryColor = '#60A5FA' }: ChartProps) {
  // MACD line (상단), Signal line, Histogram (바)
  const macdLine   = 'M10,140 L40,135 L70,128 L100,120 L130,115 L160,108 L190,98 L220,90 L250,85 L280,82 L310,90 L340,95 L370,105 L390,110';
  const signalLine = 'M10,150 L40,148 L70,142 L100,135 L130,128 L160,120 L190,112 L220,102 L250,95 L280,90 L310,92 L340,98 L370,103 L390,108';
  // Histogram bars
  const hist = [
    {x:10,h:-5}, {x:35,h:-8}, {x:60,h:-10}, {x:85,h:-12}, {x:110,h:-10},
    {x:135,h:-8}, {x:160,h:-5}, {x:185,h:3}, {x:210,h:8}, {x:235,h:12},
    {x:260,h:14}, {x:285,h:10}, {x:310,h:5}, {x:335,h:-3}, {x:360,h:-7}, {x:385,h:-4},
  ];
  const histBase = 175;
  return (
    <svg x={x} y={y} width={width} height={height} viewBox="0 0 400 220">
      <text x="10" y="14" fill="#94A3B8" fontSize="9" fontFamily="sans-serif" fontWeight="700">MACD</text>
      {/* 0선 */}
      <line x1="0" y1={histBase} x2="400" y2={histBase} stroke="#475569" strokeWidth="0.7" strokeDasharray="2 4"/>
      <text x="6" y={histBase-3} fill="#475569" fontSize="8" fontFamily="sans-serif">0</text>
      {/* Histogram */}
      {hist.map((h, i) => (
        <rect key={i} x={h.x} y={h.h >= 0 ? histBase - h.h : histBase}
          width="14" height={Math.abs(h.h)}
          fill={h.h >= 0 ? '#10B981' : '#EF4444'} fillOpacity="0.7"/>
      ))}
      {/* MACD 라인 (파랑) */}
      <path d={macdLine} stroke="#60A5FA" strokeWidth="2.2" fill="none"/>
      {/* Signal 라인 (주황) */}
      <path d={signalLine} stroke="#F59E0B" strokeWidth="2.2" fill="none"/>
      {/* 크로스 포인트 */}
      <g>
        <circle cx="160" cy="120" r="6" fill="#10B981" stroke="#fff" strokeWidth="1.5"/>
        <text x="172" y="125" fill="#10B981" fontSize="10" fontFamily="sans-serif" fontWeight="800">골든크로스</text>
      </g>
      <g>
        <circle cx="335" cy="100" r="5" fill="#EF4444" stroke="#fff" strokeWidth="1.5"/>
        <text x="270" y="80" fill="#EF4444" fontSize="10" fontFamily="sans-serif" fontWeight="800">데드크로스 임박</text>
      </g>
      {/* 범례 */}
      <g fontFamily="sans-serif" fontSize="9" fontWeight="700">
        <rect x="60" y="6" width="64" height="14" rx="3" fill="#60A5FA22" stroke="#60A5FA" strokeWidth="0.5"/>
        <text x="64" y="16" fill="#60A5FA">MACD 선</text>
        <rect x="128" y="6" width="60" height="14" rx="3" fill="#F59E0B22" stroke="#F59E0B" strokeWidth="0.5"/>
        <text x="132" y="16" fill="#F59E0B">시그널</text>
      </g>
    </svg>
  );
}

// ─── EMA 배열 ────────────────────────────────────────────────────
function EmaChart({ x = 0, y = 0, width = 400, height = 220, primaryColor = '#60A5FA' }: ChartProps) {
  const pricePath = 'M10,140 L50,130 L90,115 L130,100 L170,95 L210,80 L250,70 L290,75 L330,55 L370,45 L390,40';
  const ema20     = 'M10,150 L50,140 L90,128 L130,115 L170,105 L210,92 L250,82 L290,80 L330,68 L370,55 L390,50';
  const ema60     = 'M10,165 L50,160 L90,150 L130,140 L170,128 L210,118 L250,108 L290,98 L330,88 L370,78 L390,72';
  const ema120    = 'M10,180 L50,178 L90,170 L130,162 L170,155 L210,145 L250,135 L290,125 L330,115 L370,108 L390,100';
  return (
    <svg x={x} y={y} width={width} height={height} viewBox="0 0 400 220">
      {[60,120,180].map(yy => (
        <line key={yy} x1="0" y1={yy} x2="400" y2={yy} stroke="#243A5E" strokeOpacity="0.3" strokeDasharray="2 4"/>
      ))}
      <path d={pricePath}  stroke="#E2E8F0" strokeWidth="2.4" fill="none"/>
      <path d={ema20}      stroke="#60A5FA" strokeWidth="1.8" fill="none"/>
      <path d={ema60}      stroke="#F59E0B" strokeWidth="1.8" fill="none"/>
      <path d={ema120}     stroke="#A78BFA" strokeWidth="1.8" fill="none"/>
      {/* 정배열 영역 표시 */}
      <rect x="220" y="60" width="160" height="120" fill="#10B981" fillOpacity="0.05" stroke="#10B981" strokeWidth="0.5" strokeDasharray="3 3" strokeOpacity="0.3"/>
      <text x="300" y="76" fill="#10B981" fontSize="10" fontFamily="sans-serif" fontWeight="800" textAnchor="middle">정배열 강세</text>
      {/* 범례 */}
      <g fontFamily="sans-serif" fontSize="9" fontWeight="700">
        <text x="10" y="14" fill="#60A5FA">— EMA20</text>
        <text x="80" y="14" fill="#F59E0B">— EMA60</text>
        <text x="150" y="14" fill="#A78BFA">— EMA120</text>
      </g>
    </svg>
  );
}

// ─── Bollinger Bands ─────────────────────────────────────────────
function BollingerChart({ x = 0, y = 0, width = 400, height = 220 }: ChartProps) {
  const upper  = 'M10,60  L50,55  L90,62  L130,55  L170,50  L210,48  L250,52  L290,46  L330,40  L370,42  L390,38';
  const middle = 'M10,110 L50,108 L90,112 L130,105 L170,100 L210,98  L250,100 L290,95  L330,88  L370,85  L390,80';
  const lower  = 'M10,160 L50,162 L90,160 L130,155 L170,150 L210,148 L250,148 L290,145 L330,138 L370,132 L390,125';
  const price  = 'M10,130 L50,120 L90,158 L130,108 L170,95  L210,148 L250,90  L290,140 L330,55  L370,128 L390,42';

  return (
    <svg x={x} y={y} width={width} height={height} viewBox="0 0 400 220">
      {/* 밴드 영역 fill */}
      <path d={`M10,60 L50,55 L90,62 L130,55 L170,50 L210,48 L250,52 L290,46 L330,40 L370,42 L390,38 L390,125 L370,132 L330,138 L290,145 L250,148 L210,148 L170,150 L130,155 L90,160 L50,162 L10,160 Z`}
        fill="#60A5FA" fillOpacity="0.06"/>
      {/* 상단 밴드 */}
      <path d={upper}  stroke="#60A5FA" strokeWidth="1.4" fill="none" strokeOpacity="0.85"/>
      {/* 중간 (20MA) */}
      <path d={middle} stroke="#F59E0B" strokeWidth="1.6" fill="none" strokeDasharray="4 3"/>
      {/* 하단 밴드 */}
      <path d={lower}  stroke="#60A5FA" strokeWidth="1.4" fill="none" strokeOpacity="0.85"/>
      {/* 가격 */}
      <path d={price}  stroke="#E2E8F0" strokeWidth="2.2" fill="none"/>
      {/* 터치 포인트 */}
      <circle cx="90" cy="158" r="5" fill="#10B981" stroke="#fff" strokeWidth="1.5"/>
      <text x="100" y="170" fill="#10B981" fontSize="9" fontFamily="sans-serif" fontWeight="800">하단 터치 → 매수</text>
      <circle cx="170" cy="50" r="5" fill="#EF4444" stroke="#fff" strokeWidth="1.5"/>
      <text x="180" y="50" fill="#EF4444" fontSize="9" fontFamily="sans-serif" fontWeight="800">상단 터치 → 매도</text>
      {/* 라벨 */}
      <text x="10" y="14" fill="#60A5FA" fontSize="9" fontFamily="sans-serif" fontWeight="800">상단 +2σ</text>
      <text x="10" y="200" fill="#60A5FA" fontSize="9" fontFamily="sans-serif" fontWeight="800">하단 -2σ</text>
    </svg>
  );
}

// ─── Candle Patterns ─────────────────────────────────────────────
function CandleChart({ x = 0, y = 0, width = 400, height = 220 }: ChartProps) {
  // 다양한 캔들 패턴 표시 — 망치형, 도지, 장악형 등
  // 캔들: { x, open, close, high, low, label }
  const candles = [
    { x: 30,  open: 110, close: 60,  high: 50,  low: 130, label: '강세' },   // 큰 양봉
    { x: 60,  open: 70,  close: 80,  high: 60,  low: 130, label: '망치' },   // 망치형
    { x: 90,  open: 75,  close: 85,  high: 70,  low: 95,  label: '' },
    { x: 120, open: 80,  close: 78,  high: 60,  low: 105, label: '도지' },   // 도지
    { x: 150, open: 80,  close: 110, high: 70,  low: 115, label: '음봉' },
    { x: 180, open: 105, close: 60,  high: 55,  low: 115, label: '장악형' }, // 강한 양봉
    { x: 210, open: 65,  close: 75,  high: 55,  low: 90,  label: '' },
    { x: 240, open: 75,  close: 65,  high: 60,  low: 85,  label: '' },
    { x: 270, open: 65,  close: 55,  high: 45,  low: 75,  label: '' },
    { x: 300, open: 55,  close: 45,  high: 40,  low: 70,  label: '' },
    { x: 330, open: 50,  close: 80,  high: 45,  low: 95,  label: '역망치' },
    { x: 360, open: 80,  close: 50,  high: 40,  low: 85,  label: '' },
  ];
  const cw = 14;

  return (
    <svg x={x} y={y} width={width} height={height} viewBox="0 0 400 220">
      {[40,80,120,160,200].map(yy => (
        <line key={yy} x1="0" y1={yy} x2="400" y2={yy} stroke="#243A5E" strokeOpacity="0.25" strokeDasharray="2 4"/>
      ))}
      {candles.map((c, i) => {
        const up = c.close < c.open;
        const color = up ? '#EF4444' : '#10B981';   // 양봉=초록, 음봉=빨강 (close > open이 양봉인데 svg y는 반전이라 close < open이 시각적으로 위로)
        const bodyTop    = Math.min(c.open, c.close);
        const bodyBottom = Math.max(c.open, c.close);
        return (
          <g key={i}>
            {/* 위/아래 꼬리 */}
            <line x1={c.x + cw/2} y1={c.high} x2={c.x + cw/2} y2={c.low}
              stroke={color} strokeWidth="1.2"/>
            {/* 몸통 */}
            <rect x={c.x} y={bodyTop} width={cw} height={Math.max(2, bodyBottom - bodyTop)}
              fill={color} fillOpacity={up ? 1 : 1} stroke={color}/>
            {/* 라벨 */}
            {c.label && (
              <text x={c.x + cw/2} y={c.low + 12}
                fill={color} fontSize="8" fontWeight="700"
                fontFamily="sans-serif" textAnchor="middle">{c.label}</text>
            )}
          </g>
        );
      })}
      <text x="10" y="14" fill="#94A3B8" fontSize="9" fontFamily="sans-serif" fontWeight="700">캔들 패턴</text>
    </svg>
  );
}

// ─── Volume ──────────────────────────────────────────────────────
function VolumeChart({ x = 0, y = 0, width = 400, height = 220 }: ChartProps) {
  const price = 'M10,90 L40,85 L70,75 L100,80 L130,60 L160,55 L190,70 L220,55 L250,40 L280,50 L310,30 L340,42 L370,25 L390,32';
  const vols = [25,30,18,22,45,35,28,55,75,42,65,38,80,72];
  const cw = 26;
  return (
    <svg x={x} y={y} width={width} height={height} viewBox="0 0 400 220">
      <path d={price} stroke="#E2E8F0" strokeWidth="2.2" fill="none"/>
      <text x="10" y="14" fill="#94A3B8" fontSize="9" fontFamily="sans-serif" fontWeight="700">PRICE</text>
      {/* 구분선 */}
      <line x1="0" y1="120" x2="400" y2="120" stroke="#1A2D4A"/>
      {/* 거래량 막대 */}
      {vols.map((v, i) => (
        <rect key={i} x={10 + i*28} y={210 - v} width={cw} height={v}
          fill={v > 50 ? '#60A5FA' : '#1E3A5F'} fillOpacity="0.85"/>
      ))}
      <text x="10" y="134" fill="#94A3B8" fontSize="9" fontFamily="sans-serif" fontWeight="700">VOLUME</text>
      {/* 거래량 폭발 강조 */}
      <text x="260" y="155" fill="#60A5FA" fontSize="9" fontFamily="sans-serif" fontWeight="800">거래량 폭발</text>
      <line x1="252" y1="158" x2="276" y2="170" stroke="#60A5FA" strokeWidth="1"/>
    </svg>
  );
}

// ─── Fibonacci ───────────────────────────────────────────────────
function FibonacciChart({ x = 0, y = 0, width = 400, height = 220 }: ChartProps) {
  const price = 'M10,180 L60,170 L110,140 L160,110 L210,90 L260,60 L300,55 L335,75 L370,95 L390,110';
  // 0%(60) ~ 100%(180) 사이 피보 레벨
  const levels = [
    { pct: 0,     y: 60,  label: '0%' },
    { pct: 23.6,  y: 88,  label: '23.6%' },
    { pct: 38.2,  y: 106, label: '38.2%' },
    { pct: 50,    y: 120, label: '50%' },
    { pct: 61.8,  y: 134, label: '61.8%' },
    { pct: 78.6,  y: 154, label: '78.6%' },
    { pct: 100,   y: 180, label: '100%' },
  ];
  return (
    <svg x={x} y={y} width={width} height={height} viewBox="0 0 400 220">
      {levels.map((l, i) => {
        const isKey = l.pct === 61.8 || l.pct === 50;
        const color = isKey ? '#F59E0B' : '#475569';
        return (
          <g key={i}>
            <line x1="0" y1={l.y} x2="400" y2={l.y}
              stroke={color} strokeWidth={isKey ? 1 : 0.5}
              strokeDasharray={isKey ? '0' : '2 4'}/>
            <rect x="350" y={l.y - 7} width="44" height="14" rx="2" fill={color} fillOpacity="0.18"/>
            <text x="372" y={l.y + 3} fill={color}
              fontSize="9" fontFamily="sans-serif" fontWeight="700" textAnchor="middle">
              {l.label}
            </text>
          </g>
        );
      })}
      <path d={price} stroke="#E2E8F0" strokeWidth="2.2" fill="none"/>
      <text x="10" y="14" fill="#94A3B8" fontSize="9" fontFamily="sans-serif" fontWeight="700">FIBONACCI</text>
    </svg>
  );
}

// ─── 일반 (제목 기반 추상 차트) ─────────────────────────────────
function GenericChart({ x = 0, y = 0, width = 400, height = 220, primaryColor = '#60A5FA' }: ChartProps) {
  return (
    <svg x={x} y={y} width={width} height={height} viewBox="0 0 400 220">
      {[40,80,120,160,200].map(yy => (
        <line key={yy} x1="0" y1={yy} x2="400" y2={yy} stroke="#243A5E" strokeOpacity="0.3"/>
      ))}
      {/* 트레이드 바 */}
      {[0,1,2,3,4,5,6,7,8,9,10,11].map(i=>{
        const h = [60,80,45,95,70,55,85,40,75,65,90,72][i];
        return (
          <rect key={i} x={10 + i*32} y={200 - h * 0.9} width={22} height={h * 0.9}
            rx="3" fill={i % 3 === 0 ? primaryColor : '#1E3A5F'} fillOpacity={i % 3 === 0 ? 0.85 : 0.6}/>
        );
      })}
      {/* 라인 */}
      <polyline points="20,140 60,120 100,130 140,100 180,80 220,90 260,65 300,75 340,50 380,40"
        fill="none" stroke={primaryColor} strokeWidth="2.2"/>
      <circle cx="380" cy="40" r="5" fill={primaryColor} stroke="#fff" strokeWidth="1.5"/>
    </svg>
  );
}

// ─── Risk / Psychology / Plan (텍스트 + 아이콘) ──────────────
function ConceptChart({ x = 0, y = 0, width = 400, height = 220, type }: ChartProps & { type: PosterType }) {
  // 진입/리스크/심리/계획/복기 = 도식 / 체크리스트 형태
  const config: Record<string, { items: string[]; color: string; bg: string }> = {
    risk:       { items:['1% 룰','손익비 1:2','분할 진입','감정 차단'], color:'#EF4444', bg:'#EF4444' },
    psychology: { items:['공포 제어','탐욕 차단','복기 습관','일관성'], color:'#FB923C', bg:'#FB923C' },
    plan:       { items:['체크리스트','진입 계획','목표가','복기'],     color:'#10B981', bg:'#10B981' },
    review:     { items:['일지 작성','패턴 발견','전략 개선','반복'],   color:'#7C3AED', bg:'#7C3AED' },
    entry:      { items:['추세 확인','지지/저항','거래량','캔들 패턴'], color:'#F59E0B', bg:'#F59E0B' },
  };
  const cfg = config[type] || config.plan;

  return (
    <svg x={x} y={y} width={width} height={height} viewBox="0 0 400 220">
      {cfg.items.map((item, i) => {
        const yy = 30 + i * 45;
        return (
          <g key={i}>
            <circle cx="40" cy={yy + 13} r="14" fill={cfg.color} fillOpacity="0.18"
              stroke={cfg.color} strokeWidth="1.5"/>
            <text x="40" y={yy + 18} fill={cfg.color} fontSize="14"
              fontFamily="sans-serif" fontWeight="900" textAnchor="middle">{i + 1}</text>
            <rect x="64" y={yy} width="320" height="30" rx="6"
              fill={cfg.bg} fillOpacity="0.1" stroke={cfg.color} strokeWidth="0.5" strokeOpacity="0.4"/>
            <text x="80" y={yy + 20} fill="#E2E8F0"
              fontSize="14" fontFamily="sans-serif" fontWeight="700">
              {item}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ─── 메인 dispatcher ─────────────────────────────────────────────
export function PosterIndicator({ type, x = 0, y = 0, width = 400, height = 220, primaryColor }: ChartProps & { type: PosterType }) {
  switch (type) {
    case 'ichimoku':  return <IchimokuChart  x={x} y={y} width={width} height={height} primaryColor={primaryColor}/>;
    case 'rsi':       return <RsiChart       x={x} y={y} width={width} height={height} primaryColor={primaryColor}/>;
    case 'macd':      return <MacdChart      x={x} y={y} width={width} height={height} primaryColor={primaryColor}/>;
    case 'ema':       return <EmaChart       x={x} y={y} width={width} height={height} primaryColor={primaryColor}/>;
    case 'bollinger': return <BollingerChart x={x} y={y} width={width} height={height} primaryColor={primaryColor}/>;
    case 'candle':    return <CandleChart    x={x} y={y} width={width} height={height} primaryColor={primaryColor}/>;
    case 'volume':    return <VolumeChart    x={x} y={y} width={width} height={height} primaryColor={primaryColor}/>;
    case 'fibonacci': return <FibonacciChart x={x} y={y} width={width} height={height} primaryColor={primaryColor}/>;
    case 'risk':
    case 'psychology':
    case 'plan':
    case 'review':
    case 'entry':
      return <ConceptChart type={type} x={x} y={y} width={width} height={height}/>;
    default:
      return <GenericChart x={x} y={y} width={width} height={height} primaryColor={primaryColor}/>;
  }
}
