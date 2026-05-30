'use client';
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { T } from '@/lib/constants';
import { Card, Logo } from './SharedUI';
import { safeNumber, formatKRW, safePercent } from '@/lib/format';
import { ASSETS } from '@/data/assets';
import type { Asset } from '@/types';
import {
  loadAccount, placeOrder, resetAccount, calcMetrics,
  type PaperAccount, type PaperOrder,
} from '@/lib/paper/engine';

export default function PaperTradingPage({
  prices,
  onOpenAsset,
}: {
  prices?: Asset[];
  onOpenAsset?: (a: any, dest?: string) => void;
}) {
  const [account, setAccount] = useState<PaperAccount | null>(null);
  const [search,  setSearch]  = useState('');
  const [selected,setSelected]= useState<Asset | null>(null);
  const [side,    setSide]    = useState<'buy'|'sell'>('buy');
  const [qty,     setQty]     = useState('');
  const [toast,   setToast]   = useState('');

  useEffect(() => { setAccount(loadAccount()); }, []);

  const showToast = useCallback((msg: string) => {
    setToast(msg); setTimeout(() => setToast(''), 2500);
  }, []);

  /* Price lookup */
  const sourceAssets = useMemo(() => {
    const src = Array.isArray(prices) && prices.length > 0 ? prices : ASSETS;
    return Array.isArray(src) ? src : [];
  }, [prices]);

  const priceMap = useMemo(() => {
    const m = new Map<string, number>();
    sourceAssets.forEach(a => m.set(a.id, safeNumber(a.p, 0)));
    return m;
  }, [sourceAssets]);

  const priceLookup = useCallback((symbol: string) => {
    const p = priceMap.get(symbol);
    return p && p > 0 ? p : null;
  }, [priceMap]);

  /* Metrics */
  const metrics = useMemo(() => {
    if (!account) return null;
    return calcMetrics(account, priceLookup);
  }, [account, priceLookup]);

  /* Search */
  const searchMatches = useMemo(() => {
    if (!search.trim()) return [];
    const q = search.toLowerCase();
    return sourceAssets.filter(a =>
      (a.nameKr || '').toLowerCase().includes(q) ||
      (a.id     || '').toLowerCase().includes(q) ||
      (a.sym    || '').toLowerCase().includes(q)
    ).slice(0, 6);
  }, [search, sourceAssets]);

  /* Order submit */
  const submitOrder = useCallback(() => {
    if (!account || !selected) return;
    const curPrice = priceLookup(selected.id) || safeNumber(selected.p, 0);
    if (curPrice <= 0) { showToast('현재가를 알 수 없습니다'); return; }
    const q = safeNumber(qty, 0);
    if (q <= 0) { showToast('수량을 입력하세요'); return; }

    const result = placeOrder(account, {
      symbol: selected.id, name: selected.nameKr || selected.id,
      side, price: curPrice, qty: q,
    });
    if (result.ok && result.account) {
      setAccount(result.account);
      setQty(''); setSelected(null); setSearch('');
      showToast(`✅ ${side === 'buy' ? '매수' : '매도'} 체결 (${q.toLocaleString()} @ ${formatKRW(curPrice)})`);
    } else {
      showToast(`❌ ${result.error || '주문 실패'}`);
    }
  }, [account, selected, qty, side, priceLookup, showToast]);

  const handleReset = useCallback(() => {
    if (!confirm('가상 계좌를 초기화하시겠습니까? (보유 종목·매매 기록 모두 삭제)')) return;
    setAccount(resetAccount());
    showToast('계좌 초기화 완료');
  }, [showToast]);

  if (!account || !metrics) {
    return <div style={{ padding:'40px 20px', textAlign:'center', color: T.muted }}>⏳ 로딩 중…</div>;
  }

  /* Position holdings (only those with qty > 0) */
  const holdings = (Array.isArray(account.positions) ? account.positions : []);

  return (
    <div style={{ paddingBottom: 100 }}>
      {/* Toast */}
      {toast && (
        <div style={{ position:'fixed', top: 16, left:'50%', transform:'translateX(-50%)',
          background: T.acl, color:'#fff', padding:'10px 18px', borderRadius: 12,
          fontSize: 13, fontWeight: 700, zIndex: 999 }}>
          {toast}
        </div>
      )}

      {/* Header */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom: 14 }}>
        <div>
          <div style={{ color: T.txt, fontWeight: 900, fontSize: 17 }}>📓 모의매매</div>
          <div style={{ color: T.muted, fontSize: 10 }}>가상 자금으로 매매 연습</div>
        </div>
        <button type="button" onClick={handleReset}
          style={{ padding:'8px 12px', minHeight: 36, background: T.alt, color: T.red,
            border:`1px solid ${T.red}30`, borderRadius: 8,
            fontSize: 10, fontWeight: 700, cursor:'pointer' }}>
          🔄 초기화
        </button>
      </div>

      {/* Total equity */}
      <Card style={{ marginBottom: 10, padding:'14px 16px' }}>
        <div style={{ color: T.muted, fontSize: 10, marginBottom: 3 }}>총 자산 (현금 + 평가)</div>
        <div style={{ color: T.txt, fontSize: 26, fontWeight: 900, fontFamily:'monospace', marginBottom: 6 }}>
          {formatKRW(metrics.totalEquity)}
        </div>
        <div style={{ display:'flex', gap: 10, alignItems:'center', fontSize: 13 }}>
          <span style={{ color: metrics.pnl >= 0 ? T.grn : T.red, fontWeight: 800 }}>
            {metrics.pnl >= 0 ? '▲' : '▼'} {formatKRW(Math.abs(metrics.pnl))}
          </span>
          <span style={{ color: metrics.pnl >= 0 ? T.grn : T.red, fontFamily:'monospace' }}>
            ({safePercent(metrics.pnlPct)})
          </span>
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap: 8, marginTop: 12,
          paddingTop: 12, borderTop:`1px solid ${T.border}` }}>
          <div>
            <div style={{ color: T.muted, fontSize: 9 }}>현금</div>
            <div style={{ color: T.txt, fontSize: 12, fontFamily:'monospace', fontWeight: 700 }}>
              {formatKRW(account.cash)}
            </div>
          </div>
          <div>
            <div style={{ color: T.muted, fontSize: 9 }}>평가</div>
            <div style={{ color: T.txt, fontSize: 12, fontFamily:'monospace', fontWeight: 700 }}>
              {formatKRW(metrics.positionValue)}
            </div>
          </div>
          <div>
            <div style={{ color: T.muted, fontSize: 9 }}>승률</div>
            <div style={{ color: metrics.winRate >= 50 ? T.grn : T.red,
              fontSize: 12, fontFamily:'monospace', fontWeight: 700 }}>
              {metrics.winRate.toFixed(1)}%
            </div>
          </div>
        </div>
      </Card>

      {/* New order */}
      <Card style={{ marginBottom: 10 }}>
        <div style={{ color: T.txt, fontWeight: 700, fontSize: 13, marginBottom: 10 }}>📤 신규 주문</div>

        {/* Asset search */}
        {!selected ? (
          <>
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="종목 검색 (BTC, AAPL, 삼성전자...)"
              style={{ width:'100%', boxSizing:'border-box', background: T.bg,
                border:`1px solid ${T.border}`, borderRadius: 10, padding:'10px 14px',
                color: T.txt, fontSize: 13, outline:'none', marginBottom: 8 }}/>
            {searchMatches.map(a => (
              <div key={a.id} onClick={() => setSelected(a)}
                style={{ display:'flex', alignItems:'center', gap: 10,
                  padding:'9px 10px', cursor:'pointer',
                  background: T.alt, borderRadius: 8, marginBottom: 4 }}>
                <Logo id={a.id} size={28} clr={a.clr} name={a.nameKr}/>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: T.txt, fontSize: 12, fontWeight: 700 }}>{a.nameKr}</div>
                  <div style={{ color: T.muted, fontSize: 9 }}>
                    {a.sym || a.id} · {formatKRW(safeNumber(a.p, 0))}
                  </div>
                </div>
              </div>
            ))}
          </>
        ) : (
          <>
            <div style={{ display:'flex', alignItems:'center', gap: 10,
              background: T.alt, borderRadius: 10, padding:'10px 12px', marginBottom: 10 }}>
              <Logo id={selected.id} size={32} clr={selected.clr} name={selected.nameKr}/>
              <div style={{ flex: 1 }}>
                <div style={{ color: T.txt, fontWeight: 700, fontSize: 13 }}>{selected.nameKr}</div>
                <div style={{ color: T.muted, fontSize: 10, fontFamily:'monospace' }}>
                  현재가 {formatKRW(priceLookup(selected.id) ?? safeNumber(selected.p, 0))}
                </div>
              </div>
              <button type="button" onClick={() => { setSelected(null); setQty(''); }}
                style={{ background:'none', border:'none', color: T.muted, fontSize: 12,
                  cursor:'pointer', padding:'5px 10px' }}>
                변경
              </button>
            </div>

            {/* Side toggle */}
            <div style={{ display:'flex', gap: 4, marginBottom: 10 }}>
              {(['buy','sell'] as const).map(s => (
                <button key={s} type="button" onClick={() => setSide(s)}
                  style={{ flex: 1, padding:'10px', minHeight: 42,
                    background: side === s ? (s === 'buy' ? T.grn : T.red) : T.alt,
                    color: side === s ? '#fff' : T.muted,
                    border:'none', borderRadius: 10,
                    fontSize: 13, fontWeight: 800, cursor:'pointer' }}>
                  {s === 'buy' ? '매수' : '매도'}
                </button>
              ))}
            </div>

            <input type="text" inputMode="decimal" value={qty}
              onChange={e => setQty(e.target.value.replace(/[^\d.]/g, ''))}
              placeholder="수량"
              style={{ width:'100%', boxSizing:'border-box', background: T.bg,
                border:`1px solid ${T.border}`, borderRadius: 10, padding:'12px 14px',
                color: T.txt, fontSize: 14, fontFamily:'monospace', outline:'none',
                marginBottom: 10 }}/>

            {/* Preview */}
            {safeNumber(qty, 0) > 0 && (
              <div style={{ background: T.alt, borderRadius: 8, padding:'8px 12px', marginBottom: 10,
                fontSize: 11, color: T.sub }}>
                예상 체결: <strong style={{ color: T.txt }}>
                  {formatKRW(safeNumber(qty, 0) * (priceLookup(selected.id) ?? safeNumber(selected.p, 0)))}
                </strong> + 수수료 0.1%
              </div>
            )}

            <button type="button" onClick={submitOrder}
              style={{ width:'100%', padding:'13px', minHeight: 48,
                background: side === 'buy' ? T.grn : T.red,
                color:'#fff', border:'none', borderRadius: 12,
                fontSize: 14, fontWeight: 800, cursor:'pointer' }}>
              {side === 'buy' ? '매수 체결' : '매도 체결'}
            </button>
          </>
        )}
      </Card>

      {/* Holdings */}
      {holdings.length > 0 && (
        <Card style={{ marginBottom: 10, overflow:'hidden', padding: 0 }}>
          <div style={{ padding:'10px 14px', borderBottom:`1px solid ${T.border}`,
            color: T.muted, fontSize: 10, fontWeight: 700 }}>
            보유 종목 ({holdings.length})
          </div>
          {holdings.map((p, i) => {
            const cur = priceLookup(p.symbol) ?? p.avgPrice;
            const value = cur * p.qty;
            const pnl = (cur - p.avgPrice) * p.qty;
            const pnlPct = p.avgPrice > 0 ? ((cur - p.avgPrice) / p.avgPrice) * 100 : 0;
            return (
              <div key={p.symbol} style={{ padding:'10px 14px',
                borderBottom: i < holdings.length - 1 ? `1px solid ${T.border}` : 'none',
                display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: T.txt, fontSize: 12, fontWeight: 700 }}>{p.name}</div>
                  <div style={{ color: T.muted, fontSize: 9 }}>
                    {p.qty.toLocaleString('en-US', { maximumFractionDigits: 6 })} @ {formatKRW(p.avgPrice)}
                  </div>
                </div>
                <div style={{ textAlign:'right' }}>
                  <div style={{ color: T.txt, fontSize: 12, fontWeight: 700, fontFamily:'monospace' }}>
                    {formatKRW(value)}
                  </div>
                  <div style={{ color: pnl >= 0 ? T.grn : T.red,
                    fontSize: 10, fontFamily:'monospace' }}>
                    {pnl >= 0 ? '+' : ''}{formatKRW(pnl)} ({safePercent(pnlPct)})
                  </div>
                </div>
              </div>
            );
          })}
        </Card>
      )}

      {/* Recent orders */}
      {Array.isArray(account.orders) && account.orders.length > 0 && (
        <Card style={{ overflow:'hidden', padding: 0 }}>
          <div style={{ padding:'10px 14px', borderBottom:`1px solid ${T.border}`,
            color: T.muted, fontSize: 10, fontWeight: 700 }}>
            최근 주문 (최대 20건)
          </div>
          {account.orders.slice(0, 20).map((o, i) => (
            <div key={o.id} style={{ padding:'8px 14px',
              borderBottom: i < Math.min(19, account.orders.length - 1) ? `1px solid ${T.border}` : 'none',
              display:'flex', justifyContent:'space-between', alignItems:'center', fontSize: 11 }}>
              <div>
                <div style={{ display:'flex', alignItems:'center', gap: 5 }}>
                  <span style={{
                    background: o.side === 'buy' ? T.grn+'20' : T.red+'20',
                    color: o.side === 'buy' ? T.grn : T.red,
                    fontSize: 9, fontWeight: 700, padding:'1px 6px', borderRadius: 4,
                  }}>{o.side === 'buy' ? '매수' : '매도'}</span>
                  <span style={{ color: T.txt, fontWeight: 700 }}>{o.name}</span>
                </div>
                <div style={{ color: T.muted, fontSize: 9, marginTop: 2 }}>
                  {new Date(o.ts).toLocaleString('ko-KR', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' })}
                </div>
              </div>
              <div style={{ textAlign:'right' }}>
                <div style={{ color: T.txt, fontSize: 11, fontFamily:'monospace' }}>
                  {o.qty.toLocaleString('en-US', { maximumFractionDigits: 4 })} @ {formatKRW(o.price)}
                </div>
                {o.realized !== undefined && (
                  <div style={{
                    color: o.realized >= 0 ? T.grn : T.red,
                    fontSize: 10, fontFamily:'monospace', fontWeight: 700,
                  }}>
                    {o.realized >= 0 ? '+' : ''}{formatKRW(o.realized)} ({safePercent(o.realizedPct ?? 0)})
                  </div>
                )}
              </div>
            </div>
          ))}
        </Card>
      )}

      <div style={{ color: T.muted, fontSize: 10, lineHeight: 1.6,
        padding:'10px 12px', background: T.alt, borderRadius: 10, marginTop: 6 }}>
        💡 가상 자금 1천만 원으로 시작 · 수수료 0.1% · localStorage 저장 · 실제 거래 아님
      </div>
    </div>
  );
}
