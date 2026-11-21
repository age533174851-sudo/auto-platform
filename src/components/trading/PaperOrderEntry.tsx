'use client';

import React, { useState } from 'react';
import { C, FS } from '@/components/terminal/theme';
import type { TradeContext } from '@/lib/trading/tradeContext';

export function PaperOrderEntry({ onOrder }: {
  onOrder: (ctx: TradeContext) => void;
}) {
  const [symbol, setSymbol] = useState('BTCUSDT');
  const [market, setMarket] = useState<'SPOT' | 'USDM'>('SPOT');
  const select: React.CSSProperties = {
    minHeight: 40, minWidth: 0, flex: 1, background: C.raised, color: C.text,
    border: `1px solid ${C.hair}`, borderRadius: 8, padding: 8,
  };
  return (
    <section data-testid="paper-order-entry" style={{
      padding: 16, borderRadius: 10, border: `1px solid ${C.hair}`,
      background: C.panel, display: 'grid', gap: 10,
    }}>
      <div style={{ fontWeight: 800, color: C.text }}>모의 매수·매도</div>
      <div style={{ display: 'flex', gap: 8 }}>
        <select aria-label="모의 시장" value={market}
          onChange={e => setMarket(e.target.value as 'SPOT' | 'USDM')} style={select}>
          <option value="SPOT">현물</option><option value="USDM">USDⓈ-M 선물</option>
        </select>
        <select aria-label="모의 종목" value={symbol}
          onChange={e => setSymbol(e.target.value)} style={select}>
          <option value="BTCUSDT">BTC / USDT</option><option value="ETHUSDT">ETH / USDT</option>
        </select>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        {(['BUY', 'SELL'] as const).map(direction => (
          <button key={direction} type="button"
            onClick={() => onOrder({ symbol, market, direction })}
            style={{ flex: 1, minHeight: 44, background: direction === 'BUY' ? C.up : C.down,
              color: '#fff', border: 0, borderRadius: 8, fontWeight: 800, cursor: 'pointer' }}>
            {direction === 'BUY' ? (market === 'SPOT' ? '모의 매수' : '모의 롱')
              : (market === 'SPOT' ? '보유분 매도' : '모의 숏')}
          </button>
        ))}
      </div>
      <div style={{ color: C.faint, fontSize: FS.small, lineHeight: 1.6 }}>
        선택한 모의 장부로 주문합니다. 현물 매도는 보유 수량만 판매합니다.
      </div>
    </section>
  );
}
