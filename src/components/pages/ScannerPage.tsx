'use client';
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { T, CURRENCIES, LANGS, I18N, WORLD_MARKETS, MOCK_NEWS, ECON_EVENTS } from '@/lib/constants';
import { cvt, fmt, fmtPct, clamp, tr, gS, sS, uid } from '@/lib/utils';
import { ASSETS, TYPE_LABEL, TYPE_COLOR } from '@/data/assets';
import type { Asset } from '@/types';
import { Card, Dot, Spark, Pill, Bdg, Logo, getBgColor } from './SharedUI';

function ScannerPage({ prices, currency }: { prices: Asset[]; currency: string }) {
  const filters = ['급등', '급락', '거래량', '변동성', '신고점'];
  const [active, setActive] = React.useState('급등');

  const filtered = React.useMemo(() => {
    const p = [...prices];
    if (active === '급등') return p.sort((a, b) => b.c - a.c).slice(0, 10);
    if (active === '급락') return p.sort((a, b) => a.c - b.c).slice(0, 10);
    if (active === '거래량') return p.slice(0, 10);
    if (active === '변동성') return p.sort((a, b) => Math.abs(b.c) - Math.abs(a.c)).slice(0, 10);
    return p.slice(0, 10);
  }, [prices, active]);

  return (
    <div>
      <div style={{ fontWeight: 800, fontSize: 15, color: T.txt, marginBottom: 12 }}>🔍 마켓 스캐너</div>
      <div style={{ display: 'flex', gap: 6, overflowX: 'auto', marginBottom: 12 }}>
        {filters.map(f => (
          <button key={f} onClick={() => setActive(f)}
            style={{ flexShrink: 0, padding: '6px 14px', background: active === f ? T.acg : T.alt, border: `1px solid ${active === f ? T.acl : T.border}`, borderRadius: 20, color: active === f ? T.acl : T.muted, fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
            {f}
          </button>
        ))}
      </div>
      {filtered.map((a, i) => (
        <Card key={a.id} style={{ padding: '10px 14px', marginBottom: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ color: T.muted, fontSize: 11, width: 18 }}>#{i + 1}</span>
              <Logo id={a.id} size={28} clr={a.clr} />
              <div>
                <div style={{ color: T.txt, fontSize: 12, fontWeight: 700 }}>{a.nameKr}</div>
                <div style={{ color: T.muted, fontSize: 9 }}>{a.sym}</div>
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ color: T.txt, fontSize: 11, fontWeight: 700 }}>{cvt(a.p, currency)}</div>
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
