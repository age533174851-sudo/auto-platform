'use client';
// src/components/trading/markets/InstrumentPicker.tsx
//
// **이 시장의 상장 목록에서 종목을 고른다. 없으면 없다고 적는다.**
//
// 이 부품이 지키는 것
// ───────────────────
//  · 검색은 **이미 받아 둔 목록 안에서** 한다. 타이핑마다 조회를 보내면
//    느리고, 중간 실패에 목록이 깜빡여 "종목이 사라진" 것처럼 보인다.
//  · 목록을 못 읽으면 **0건으로 그리지 않는다.** 0건은 "이 시장에 종목이
//    없다"로 읽힌다 — 사유를 적고 다시 시도할 수단을 준다.
//  · 고른 줄을 그대로 넘긴다. 심볼을 다듬거나 만들지 않는다.
import React from 'react';
import { C, FS } from '@/components/terminal/theme';
import { searchCatalog, type CatalogInstrument } from '@/lib/trading/instrumentCatalog';
import type { InstrumentCatalog } from '@/lib/trading/useInstrumentCatalog';
import { marketTabLabel, type TradingMarketId } from '@/lib/trading/marketTabs';

export interface InstrumentPickerProps {
  open: boolean;
  market: TradingMarketId;
  catalog: InstrumentCatalog;
  /** 지금 고른 종목 (있으면 표시) */
  currentSymbol: string | null;
  onPick: (row: CatalogInstrument) => void;
  onClose: () => void;
}

export function InstrumentPicker(p: InstrumentPickerProps) {
  const [q, setQ] = React.useState('');
  const label = marketTabLabel(p.market);

  // 열 때마다 검색어를 비운다 — 지난 검색이 남아 있으면 목록이 비어 보인다
  React.useEffect(() => { if (p.open) setQ(''); }, [p.open]);

  if (!p.open) return null;

  const hits = p.catalog.state === 'READY' ? searchCatalog(p.catalog.rows, q) : [];

  return (
    <div data-testid="instrument-picker" style={{
      position: 'absolute', inset: 0, zIndex: 30,
      background: C.bg, display: 'flex', flexDirection: 'column',
    }}>
      <div style={{
        flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8,
        padding: '9px 12px', borderBottom: `1px solid ${C.hair}`,
      }}>
        <span style={{ fontSize: FS.body, fontWeight: 800 }}>{label} 종목</span>
        <button type="button" data-testid="instrument-picker-close" onClick={p.onClose}
          style={{
            marginLeft: 'auto', minHeight: 32, padding: '4px 12px', borderRadius: 7,
            background: C.raised, border: `1px solid ${C.hair}`,
            color: C.text, fontSize: FS.small, fontWeight: 700, cursor: 'pointer',
          }}>닫기</button>
      </div>

      <div style={{ flexShrink: 0, padding: '8px 12px' }}>
        <input
          data-testid="instrument-search"
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder={`${label} 종목 검색`}
          disabled={p.catalog.state !== 'READY'}
          style={{
            width: '100%', minHeight: 36, borderRadius: 7,
            border: `1px solid ${C.hair}`, background: C.raised,
            color: C.text, fontSize: FS.body, padding: '0 10px', minWidth: 0,
          }}/>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 8px 12px' }}>
        {p.catalog.state === 'LOADING' ? (
          <div data-testid="catalog-loading" style={{ padding: 14, fontSize: FS.small, color: C.faint }}>
            {label} 종목 목록을 읽는 중입니다…
          </div>
        ) : p.catalog.state === 'ERROR' || p.catalog.state === 'CLOSED' ? (
          // ★ 0건으로 그리지 않는다. 못 읽은 것과 없는 것은 다르다.
          <div data-testid="catalog-unavailable" style={{ padding: 14, display: 'grid', gap: 10 }}>
            <div style={{ fontSize: FS.small, color: C.warn, lineHeight: 1.6 }}>
              {p.catalog.reason || `${label} 종목 목록을 읽지 못했습니다`}
            </div>
            {p.catalog.state === 'ERROR' ? (
              <button type="button" data-testid="catalog-retry" onClick={p.catalog.reload}
                style={{
                  justifySelf: 'start', minHeight: 36, padding: '0 14px', borderRadius: 7,
                  background: C.raised, border: `1px solid ${C.hair}`,
                  color: C.text, fontSize: FS.small, fontWeight: 700, cursor: 'pointer',
                }}>다시 시도</button>
            ) : null}
          </div>
        ) : hits.length === 0 ? (
          // 목록은 읽었는데 **검색어와 맞는 것이 없다.** 이건 진짜 0건이고,
          // 위의 "못 읽음"과 다른 문장을 쓴다.
          <div data-testid="catalog-no-match" style={{ padding: 14, fontSize: FS.small, color: C.faint }}>
            `{q}`와 맞는 종목이 없습니다 ({label} {p.catalog.rows.length}개 중)
          </div>
        ) : (
          <div role="list">
            {hits.map(row => {
              const on = row.symbol === p.currentSymbol;
              return (
                <button key={row.symbol} type="button" role="listitem"
                  data-testid={`instrument-row-${row.symbol}`}
                  onClick={() => p.onPick(row)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                    minHeight: 44, padding: '6px 10px', borderRadius: 7,
                    background: on ? C.accentBg : 'transparent',
                    border: `1px solid ${on ? C.accent : 'transparent'}`,
                    color: C.text, cursor: 'pointer', textAlign: 'left',
                  }}>
                  <span style={{ fontSize: FS.body, fontWeight: 800, minWidth: 0 }}>
                    {row.symbol}
                  </span>
                  <span style={{ fontSize: FS.nano, color: C.faint, marginLeft: 'auto' }}>
                    {row.baseAsset} / {row.quoteAsset}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
