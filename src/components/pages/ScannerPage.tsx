'use client';
import React, { useState, useMemo } from 'react';
import { T } from '@/lib/constants';
import { cvt, fmtPct } from '@/lib/utils';
import { ASSETS } from '@/data/assets';
import type { Asset } from '@/types';
import { Card, Logo } from './SharedUI';

function ScannerPage({ prices, currency, onOpenAsset }: {
  prices: Asset[];
  currency: string;
  onOpenAsset?: (a: Asset, dest?: string) => void;
}) {
  const src = prices.length > 0 ? prices : ASSETS; // always have data
  const filters = ['급등', '급락', '거래량', '변동성', '신고점', '신저점'];
  const [active, setActive] = useState('급등');

  const filtered = useMemo(() => {
    const p = [...src].filter(a => isFinite(a.c) && isFinite(a.p));
    switch (active) {
      case '급등':   return p.sort((a, b) => b.c - a.c).slice(0, 15);
      case '급락':   return p.sort((a, b) => a.c - b.c).slice(0, 15);
      case '거래량': return p.sort((a, b) => parseFloat(String(b.v)) - parseFloat(String(a.v))).slice(0, 15);
      case '변동성': return p.sort((a, b) => Math.abs(b.c) - Math.abs(a.c)).slice(0, 15);
      case '신고점': return p.sort((a, b) => b.p - a.p).slice(0, 15);
      case '신저점': return p.sort((a, b) => a.p - b.p).slice(0, 15);
      default:       return p.slice(0, 15);
    }
  }, [src, active]);

  return (
    <div>
      <div style={{ fontWeight: 800, fontSize: 15, color: T.txt, marginBottom: 12 }}>마켓 스캐너</div>
      <div style={{ display: 'flex', gap: 6, overflowX: 'auto', marginBottom: 12, paddingBottom: 2 }}>
        {filters.map(f => (
          <button key={f} onClick={() => setActive(f)}
            style={{ flexShrink: 0, padding: '6px 14px', minHeight: 34,
              background: active === f ? T.acg : T.alt,
              border: `1px solid ${active === f ? T.acl : T.border}`,
              color: active === f ? T.acl : T.muted,
              borderRadius: 20, fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
            {f}
          </button>
        ))}
      </div>
      {filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px 0', color: T.muted }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>📊</div>
          <div style={{ fontSize: 13 }}>데이터를 불러오는 중입니다…</div>
        </div>
      ) : (Array.isArray(filtered)?filtered:[]).map((a, i) => (
        <Card key={a.id} style={{ padding: '10px 14px', marginBottom: 6, cursor: 'pointer' }}
          onClick={() => onOpenAsset ? onOpenAsset(a, 'trading') : undefined}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <span style={{ color: T.muted, fontSize: 11, width: 20, flexShrink: 0 }}>#{i + 1}</span>
              <Logo id={a.id} size={30} clr={a.clr} name={a.nameKr} />
              <div style={{ minWidth: 0 }}>
                <div style={{ color: T.txt, fontSize: 12, fontWeight: 700,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.nameKr}</div>
                <div style={{ color: T.muted, fontSize: 9, fontFamily: 'monospace' }}>{a.sym || a.id}</div>
              </div>
            </div>
            <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: 8 }}>
              <div style={{ color: T.txt, fontSize: 12, fontWeight: 700, fontFamily: 'monospace' }}>
                {cvt(a.p, currency)}
              </div>
              <div style={{ color: a.c >= 0 ? T.grn : T.red, fontSize: 11, fontWeight: 700 }}>
                {a.c >= 0 ? '+' : ''}{fmtPct(a.c)}
              </div>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}

export default ScannerPage;
