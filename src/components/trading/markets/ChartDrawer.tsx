'use client';
// src/components/trading/markets/ChartDrawer.tsx
//
// **차트는 접혀 있다. 이것이 이 파일의 전부다.**
//
// 무엇이 잘못돼 있었나
// ────────────────────
// 거래 화면이 이렇게 쌓여 있었다:
//
//     종목 헤더 → 260px 차트 → 호가 → 주문 → 포지션
//
// 360~430px 폭에서 이 배치는 **주문 버튼을 첫 화면 밖으로 밀어낸다.**
// 증거금·청산가·호가도 같이 밀린다. 화면은 멀쩡해 보인다 — 오류도 빈
// 칸도 없고, 그냥 내려야 보일 뿐이다. 그래서 아무도 고장이라고 부르지
// 않는다.
//
// 차트를 100~250px로 눌러 담는 것은 답이 아니다. 그러면 차트도 못 쓰고
// 주문도 좁다. 둘 다 반쯤 나쁜 화면이 된다.
//
// 그래서 **두 상태로 나눈다.**
//
//     COLLAPSED  한 줄짜리 막대만. 주문이 화면 전부를 쓴다   ← 기본
//     EXPANDED   차트가 화면을 덮는다. 주문을 억지로 같이 안 보여준다
//
// ★ 기본은 COLLAPSED다
// ────────────────────
// `useState(false)`. 이 한 줄이 계약이고 검사기가 이것을 본다. 기본을
// 펴짐으로 바꾸면 위의 배치가 이름만 바꿔 돌아온다.
//
// ★ 주문 상태를 건드리지 않는다
// ─────────────────────────────
// 이 부품은 주문폼의 **형제**다. 부모도 자식도 아니다. 그래서 열고 닫아도
// 주문 훅이 다시 만들어지지 않는다 — 수량을 다 넣고 차트를 봤다가 돌아오면
// 입력이 비어 있는 화면을 만들지 않는다.
//
// ★ 이 파일은 시장을 모른다
// ─────────────────────────
// 레버리지도 계약 수도 주문가능금액도 여기 없다. 네 시장이 같은 서랍을
// 쓰되, 서랍이 시장을 알면 그 순간 의미가 섞인다
// (`marketScreenContract.SHARED_NEUTRAL_COMPONENTS`).
import React, { useState } from 'react';
import { C, FS } from '@/components/terminal/theme';
import { PriceChart, type ChartInterval } from '@/components/trading/PriceChart';
import type { IndicatorId } from '@/lib/trading/indicators';
import { fieldTestId } from '@/lib/trading/marketScreenContract';

/** 차트를 그릴 수 있는 출처. **없으면 null이고, 그러면 이유를 적는다** */
export interface ChartSource {
  symbol: string;
  /** 우리 봉 출처가 아는 시장. 여기에 없는 시장은 차트를 못 그린다 */
  market: 'SPOT' | 'USDM';
}

export interface ChartDrawerProps {
  /** 막대에 적을 한 줄. 예: `BTCUSDT 차트` */
  label: string;
  /**
   * 봉 출처. **null이면 차트를 그리지 않고 이유를 적는다** —
   * 다른 시장의 봉을 대신 그리면 사용자는 그것을 이 종목의 차트로 읽는다.
   */
  source: ChartSource | null;
  /** `source`가 null일 때 화면에 그대로 보여 줄 한 줄 */
  unavailableReason?: string;
}

export function ChartDrawer({ label, source, unavailableReason }: ChartDrawerProps) {
  // ★ 기본 COLLAPSED. 이 초기값이 계약이다.
  const [open, setOpen] = useState(false);
  const [interval, setInterval] = useState<ChartInterval>('15m');
  const [indicators, setIndicators] = useState<IndicatorId[]>([]);

  return (
    <>
      {/* ── 접힌 막대 ── 언제나 여기 있다. 높이는 한 줄이다 */}
      <button
        type="button"
        data-testid={fieldTestId('CHART_BAR')}
        data-chart-open={open ? '1' : '0'}
        aria-expanded={open}
        onClick={() => setOpen(v => !v)}
        style={{
          flexShrink: 0, display: 'flex', alignItems: 'center',
          justifyContent: 'space-between', gap: 8, width: '100%',
          padding: '9px 12px', minHeight: 40,
          background: C.panel, border: 'none',
          borderTop: `1px solid ${C.hair}`, borderBottom: `1px solid ${C.hair}`,
          color: C.text, fontSize: FS.small, fontWeight: 700, cursor: 'pointer',
        }}
      >
        <span style={{ minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap' }}>{label}</span>
        <span style={{ color: C.dim, fontSize: FS.micro }}>{open ? '닫기 ▼' : '▲'}</span>
      </button>

      {/* ── 펼친 차트 ──
          주문 화면 **위에** 덮는다. 주문폼을 억지로 같이 보여주지 않는다 —
          차트를 볼 때 하는 일은 보는 것이지 주문하는 것이 아니다.

          주문폼은 아래에 그대로 살아 있다(언마운트하지 않는다). 닫으면
          넣어 둔 수량과 손절이 그대로다. */}
      {open ? (
        <div
          data-testid="chart-drawer-overlay"
          style={{
            position: 'absolute', inset: 0, zIndex: 20,
            background: C.bg, display: 'flex', flexDirection: 'column',
          }}
        >
          <div style={{
            flexShrink: 0, display: 'flex', alignItems: 'center',
            justifyContent: 'space-between', padding: '9px 12px',
            borderBottom: `1px solid ${C.hair}`,
          }}>
            <span style={{ fontSize: FS.body, fontWeight: 800, color: C.text }}>{label}</span>
            <button type="button" data-testid="chart-drawer-close" onClick={() => setOpen(false)}
              style={{
                minHeight: 32, padding: '4px 12px', borderRadius: 7,
                background: C.raised, border: `1px solid ${C.hair}`,
                color: C.text, fontSize: FS.small, fontWeight: 700, cursor: 'pointer',
              }}>닫기</button>
          </div>

          <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
            {source ? (
              <PriceChart
                symbol={source.symbol}
                market={source.market}
                interval={interval}
                onIntervalChange={setInterval}
                indicators={indicators}
                onToggleIndicator={(id) => setIndicators(prev =>
                  prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])}
                // 화면의 60~75%를 쓴다. 덮개라 나머지는 차트 도구 줄이다.
                height={Math.max(260, Math.round((typeof window !== 'undefined'
                  ? window.innerHeight : 800) * 0.68))}
              />
            ) : (
              // 봉 출처가 없으면 **빈 차트를 그리지 않는다.** 빈 차트는
              // "거래가 없는 종목"처럼 보이고, 그건 거짓이다.
              <div data-testid="chart-drawer-unavailable" style={{
                padding: 20, fontSize: FS.small, color: C.faint, lineHeight: 1.7,
              }}>{unavailableReason || '이 종목의 봉 출처가 아직 없습니다'}</div>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}
