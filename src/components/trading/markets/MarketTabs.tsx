'use client';
// src/components/trading/markets/MarketTabs.tsx
//
// **거래 화면 맨 위 시장 전환 — [현물] [USDT-M] [COIN-M] [주식]**
//
// 목록을 여기 적지 않는다
// ───────────────────────
// `marketTabs.MARKET_TABS`가 정본이고 이 파일은 그것을 그린다. 화면에
// 손으로 적으면 탭과 화면이 갈리는 날이 오고, 그날 탭은 넷인데 갈 수 있는
// 화면은 셋이 된다 — 그게 이 저장소의 1번 고장이다.
//
// 좁아도 숨기지 않는다
// ────────────────────
// 360px에서 네 칩이 안 들어가면 **가로로 스크롤한다.** 두 줄로 접거나
// 드롭다운에 넣지 않는다. 숨기는 순간 사용자는 "이 앱에 그 시장이 없다"로
// 읽고, 실제로 있는 기능을 영영 못 찾는다.
//
// 이 파일은 시장의 **이름만** 안다
// ────────────────────────────────
// 레버리지·계약 수·주문가능금액 같은 시장 전용 칸은 여기 없다. 탭 줄이
// 시장의 내용을 알기 시작하면 네 화면의 의미가 한 파일에서 섞인다.
import React from 'react';
import { C, FS } from '@/components/terminal/theme';
import { MARKET_TABS, type TradingMarketId } from '@/lib/trading/marketTabs';

export interface MarketTabsProps {
  market: TradingMarketId;
  onMarket: (m: TradingMarketId) => void;
}

export function MarketTabs({ market, onMarket }: MarketTabsProps) {
  return (
    <div
      data-testid="market-tabs"
      role="tablist"
      aria-label="시장"
      style={{
        display: 'flex', gap: 4, padding: '6px 8px', minWidth: 0,
        // ★ 좁으면 가로 스크롤. 줄바꿈하지 않는다.
        overflowX: 'auto', flexWrap: 'nowrap',
        overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch' as any,
        borderBottom: `1px solid ${C.hair}`, background: C.panel,
      }}
    >
      {MARKET_TABS.map(t => {
        const on = t.id === market;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={on}
            data-testid={`market-tab-${t.id}`}
            data-active={on ? '1' : '0'}
            onClick={() => onMarket(t.id)}
            style={{
              flexShrink: 0, minHeight: 32, padding: '0 12px', borderRadius: 7,
              border: `1px solid ${on ? C.accent : 'transparent'}`,
              background: on ? C.accentBg : 'transparent',
              color: on ? C.accent : C.faint,
              fontSize: FS.small, fontWeight: 800, cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
