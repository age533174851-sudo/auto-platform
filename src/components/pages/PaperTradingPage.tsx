'use client';
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { confirmDialog } from '@/lib/confirm/dialog';
import { T } from '@/lib/constants';
import MockAutoTrade from '@/components/MockAutoTrade';
import StrategyProfilesPanel from '@/components/StrategyProfilesPanel';
import { notify } from '@/lib/notify/center';
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
    const clean = msg.replace(/^[✅❌⏳⚠️]\s*/, '');
    const kind = /실패|오류|부족/.test(clean) ? 'error' : 'info';
    notify(kind as any, clean);
    void setToast;
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

  /* 보유 종목 원탭 청산 — 실현손익/보유시간/이유 담은 풍부한 알림 */
  const closeHolding = useCallback((p: any) => {
    if (!account) return;
    const cur = priceLookup(p.symbol) ?? p.avgPrice;
    if (cur <= 0) { notify('error', '청산 실패', '현재가를 알 수 없습니다'); return; }
    const result = placeOrder(account, { symbol: p.symbol, name: p.name, side: 'sell', price: cur, qty: p.qty });
    if (result.ok && result.account) {
      setAccount(result.account);
      const o: any = result.order || {};
      const realized = safeNumber(o.realized, 0);
      const realizedPct = safeNumber(o.realizedPct, 0);
      const win = realized >= 0;
      // 보유시간
      const ms = p.openedAt ? Date.now() - p.openedAt : 0;
      const mins = Math.floor(ms / 60000);
      const hold = mins >= 60 ? `${Math.floor(mins/60)}시간 ${mins%60}분` : `${mins}분`;
      notify(
        win ? 'tp' : 'sl',
        win ? '모의 익절 청산' : '모의 손절 청산',
        `${p.name} · 평단 ${formatKRW(p.avgPrice)} → 청산 ${formatKRW(cur)}\n실현손익 ${win ? '+' : ''}₩${Math.round(realized).toLocaleString('ko-KR')} (${realizedPct >= 0 ? '+' : ''}${realizedPct.toFixed(2)}%) · 보유 ${hold}`,
      );
    } else {
      notify('error', '청산 실패', result.error || '알 수 없는 오류');
    }
  }, [account, priceLookup]);

  /* Order submit */
  const submitOrder = useCallback(() => {
    if (!account || !selected) return;
    const curPrice = priceLookup(selected.id) || safeNumber(selected.p, 0);
    if (curPrice <= 0) { notify('error', '주문 실패', '현재가를 알 수 없습니다'); return; }
    const q = safeNumber(qty, 0);
    if (q <= 0) { notify('error', '주문 실패', '수량을 입력하세요'); return; }

    // 포지션 인식: 매도 시 보유 포지션이 있으면 '청산', 없으면 일반 매도
    const posBefore = (account.positions || []).find(p => p.symbol === selected.id);
    const entryPx = posBefore?.avgPrice;
    const nameKr = selected.nameKr || selected.id;

    const result = placeOrder(account, {
      symbol: selected.id, name: nameKr,
      side, price: curPrice, qty: q,
    });
    if (result.ok && result.account) {
      setAccount(result.account);
      setQty(''); setSelected(null); setSearch('');
      if (side === 'buy') {
        notify('buy', '모의 매수 체결', `${nameKr} · ${q.toLocaleString()} @ ${formatKRW(curPrice)}`);
      } else {
        // 매도 = 보유 청산. 실현손익/수익률/진입가/청산가 표시
        const o: any = result.order || {};
        const realized = safeNumber(o.realized, 0);
        const realizedPct = safeNumber(o.realizedPct, 0);
        const closing = entryPx != null;
        notify(
          'sell',
          closing ? '모의 포지션 청산' : '모의 매도 체결',
          `${nameKr} · 실현손익 ${realized >= 0 ? '+' : ''}₩${Math.round(realized).toLocaleString('ko-KR')} · 수익률 ${realizedPct >= 0 ? '+' : ''}${realizedPct.toFixed(2)}%` +
          (closing ? ` · 진입 ${formatKRW(entryPx!)} → 청산 ${formatKRW(curPrice)}` : ''),
        );
      }
    } else {
      notify('error', '주문 실패', result.error || '알 수 없는 오류');
    }
  }, [account, selected, qty, side, priceLookup]);

  const handleReset = useCallback(async () => {
    if (!(await confirmDialog('가상 계좌를 초기화하시겠습니까? (보유 종목·매매 기록 모두 삭제)', { danger: true }))) return;
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

      {/* MOCK 자동매매 패널 — 앱 내부 완결형 (거래소/Worker 무관) */}
      <MockAutoTrade />

      {/* 전략 프로필 (고위험 단타 / 저위험 스윙 분리 운용) */}
      <StrategyProfilesPanel />

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
          초기화
        </button>
      </div>

      {/* Total equity */}
      <Card style={{ marginBottom: 10, padding:'14px 16px' }}>
        <div style={{ color: T.muted, fontSize: 10, marginBottom: 3 }}>총 자산 (현금 + 평가)</div>
        <div style={{ color: T.txt, fontSize: 26, fontWeight: 900, fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums', marginBottom: 6 }}>
          {formatKRW(metrics.totalEquity)}
        </div>
        <div style={{ display:'flex', gap: 10, alignItems:'center', fontSize: 13 }}>
          <span style={{ color: metrics.pnl >= 0 ? T.grn : T.red, fontWeight: 800 }}>
            {metrics.pnl >= 0 ? '▲' : '▼'} {formatKRW(Math.abs(metrics.pnl))}
          </span>
          <span style={{ color: metrics.pnl >= 0 ? T.grn : T.red, fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums' }}>
            ({safePercent(metrics.pnlPct)})
          </span>
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap: 8, marginTop: 12,
          paddingTop: 12, borderTop:`1px solid ${T.border}` }}>
          <div>
            <div style={{ color: T.muted, fontSize: 9 }}>현금</div>
            <div style={{ color: T.txt, fontSize: 12, fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums', fontWeight: 700 }}>
              {formatKRW(account.cash)}
            </div>
          </div>
          <div>
            <div style={{ color: T.muted, fontSize: 9 }}>평가</div>
            <div style={{ color: T.txt, fontSize: 12, fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums', fontWeight: 700 }}>
              {formatKRW(metrics.positionValue)}
            </div>
          </div>
          <div>
            <div style={{ color: T.muted, fontSize: 9 }}>승률</div>
            <div style={{ color: metrics.winRate >= 50 ? T.grn : T.red,
              fontSize: 12, fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums', fontWeight: 700 }}>
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
                <div style={{ color: T.muted, fontSize: 10, fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums' }}>
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
                color: T.txt, fontSize: 14, fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums', outline:'none',
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
                <div style={{ textAlign:'right', display:'flex', alignItems:'center', gap: 10 }}>
                  <div>
                    <div style={{ color: T.txt, fontSize: 12, fontWeight: 700, fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums' }}>
                      {formatKRW(value)}
                    </div>
                    <div style={{ color: pnl >= 0 ? T.grn : T.red,
                      fontSize: 10, fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums' }}>
                      {pnl >= 0 ? '+' : ''}{formatKRW(pnl)} ({safePercent(pnlPct)})
                    </div>
                  </div>
                  <button type="button" onClick={() => closeHolding(p)}
                    style={{ padding:'7px 12px', minHeight: 36, background: T.red, color:'#fff',
                      border:'none', borderRadius: 8, fontSize: 11, fontWeight: 800, cursor:'pointer', flexShrink: 0 }}>
                    청산
                  </button>
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
                <div style={{ color: T.txt, fontSize: 11, fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums' }}>
                  {o.qty.toLocaleString('en-US', { maximumFractionDigits: 4 })} @ {formatKRW(o.price)}
                </div>
                {o.realized !== undefined && (
                  <div style={{
                    color: o.realized >= 0 ? T.grn : T.red,
                    fontSize: 10, fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums', fontWeight: 700,
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
        가상 자금 1천만 원으로 시작 · 수수료 0.1% · localStorage 저장 · 실제 거래 아님
      </div>
    </div>
  );
}
