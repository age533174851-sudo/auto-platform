'use client';
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { T } from '@/lib/constants';
import { ASSETS } from '@/data/assets';
import type { Asset } from '@/types';
import { Card, Logo, DonutChart } from './SharedUI';
import { cvt, fmtPct } from '@/lib/utils';
import { safeNumber, formatKRW } from '@/lib/format';

const STORE_KEY = 'tg_portfolio_v2';

interface Position {
  id:         string;
  assetId:    string;       // BTC, AAPL, ...
  assetName:  string;       // 비트코인, 애플, ...
  category:   'crypto' | 'us_stock' | 'kr_stock' | 'etf' | 'cash' | 'commodity';
  buyPrice:   number;       // average entry
  quantity:   number;
  fxRate?:    number;       // for USD assets (rate at purchase)
  addedAt:    number;
  note?:      string;
}

const CATEGORY_INFO: Record<string, { label:string; icon:string; color:string }> = {
  crypto:    { label:'코인',     icon:'', color:'#F59E0B' },
  us_stock:  { label:'미국주식', icon:'🇺🇸', color:'#3B82F6' },
  kr_stock:  { label:'국내주식', icon:'🇰🇷', color:'#EF4444' },
  etf:       { label:'ETF',     icon:'', color:'#8B5CF6' },
  cash:      { label:'현금',     icon:'💵', color:'#10B981' },
  commodity: { label:'원자재',   icon:'🥇', color:'#F0B90B' },
};

function toNum(v: unknown): number {
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function detectCategory(t: string): Position['category'] {
  if (t === 'coin')      return 'crypto';
  if (t === 'krstock')   return 'kr_stock';
  if (t === 'stock')     return 'us_stock';
  if (t === 'etf')       return 'etf';
  if (t === 'commodity') return 'commodity';
  return 'crypto';
}

export default function PortfolioPage({
  prices,
  currency,
  onOpenAsset,
}: {
  prices?: Asset[];
  currency: string;
  onOpenAsset?: (a: any, dest?: string) => void;
}) {
  const [positions, setPositions] = useState<Position[]>([]);
  const [acctTab, setAcctTab] = useState('all');
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [toast, setToast] = useState('');

  // Form state
  const [assetSearch, setAssetSearch] = useState('');
  const [selectedAsset, setSelectedAsset] = useState<Asset | null>(null);
  const [buyPrice,  setBuyPrice]  = useState('');
  const [quantity,  setQuantity]  = useState('');
  const [note,      setNote]      = useState('');

  /* ── Load positions from localStorage ── */
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      setPositions(Array.isArray(arr) ? arr : []);
    } catch { setPositions([]); }
  }, []);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 2500);
  }, []);

  const savePositions = useCallback((next: Position[]) => {
    setPositions(next);
    try { localStorage.setItem(STORE_KEY, JSON.stringify(next)); } catch {}
  }, []);

  /* ── Source assets for search ── */
  const sourceAssets = useMemo(() => {
    const src = Array.isArray(prices) && prices.length > 0 ? prices : ASSETS;
    return Array.isArray(src) ? src : [];
  }, [prices]);

  /* ── Search matches ── */
  const searchMatches = useMemo(() => {
    if (!assetSearch.trim()) return [];
    const q = assetSearch.toLowerCase();
    return sourceAssets.filter(a =>
      (a.nameKr || '').toLowerCase().includes(q) ||
      (a.id || '').toLowerCase().includes(q) ||
      (a.sym || '').toLowerCase().includes(q)
    ).slice(0, 8);
  }, [assetSearch, sourceAssets]);

  /* ── Current prices lookup ── */
  const priceLookup = useMemo(() => {
    const m = new Map<string, { p: number; c: number }>();
    sourceAssets.forEach(a => m.set(a.id, { p: safeNumber(a.p, 0), c: safeNumber(a.c, 0) }));
    return m;
  }, [sourceAssets]);

  /* ── Calculate portfolio metrics ── */
  const portfolioStats = useMemo(() => {
    const enriched = positions.map(pos => {
      const cur = priceLookup.get(pos.assetId);
      const curPrice = cur?.p ?? pos.buyPrice;
      const buyValue   = pos.buyPrice * pos.quantity;
      const marketValue = curPrice * pos.quantity;
      const unrealizedPnL = marketValue - buyValue;
      const unrealizedROI = buyValue > 0 ? (unrealizedPnL / buyValue) * 100 : 0;
      return { ...pos, curPrice, buyValue, marketValue, unrealizedPnL, unrealizedROI };
    });

    const totalBuy    = enriched.reduce((s, p) => s + p.buyValue,    0);
    const totalMarket = enriched.reduce((s, p) => s + p.marketValue, 0);
    const totalPnL    = totalMarket - totalBuy;
    const totalROI    = totalBuy > 0 ? (totalPnL / totalBuy) * 100 : 0;

    // Allocation by category
    const allocation: Record<string, number> = {};
    enriched.forEach(p => {
      allocation[p.category] = (allocation[p.category] ?? 0) + p.marketValue;
    });

    const allocationList = Object.entries(allocation)
      .filter(([, v]) => v > 0)
      .map(([cat, val]) => ({
        cat,
        label: CATEGORY_INFO[cat]?.label ?? cat,
        color: CATEGORY_INFO[cat]?.color ?? T.muted,
        value: val,
        pct:   totalMarket > 0 ? (val / totalMarket) * 100 : 0,
      }))
      .sort((a, b) => b.value - a.value);

    return { enriched, totalBuy, totalMarket, totalPnL, totalROI, allocationList };
  }, [positions, priceLookup]);

  /* ── Add/Edit position ── */
  const resetForm = useCallback(() => {
    setAssetSearch(''); setSelectedAsset(null);
    setBuyPrice(''); setQuantity(''); setNote('');
    setEditingId(null);
  }, []);

  const openAdd = useCallback(() => {
    resetForm();
    setShowAddModal(true);
  }, [resetForm]);

  const openEdit = useCallback((p: Position) => {
    resetForm();
    setEditingId(p.id);
    setSelectedAsset({
      id: p.assetId, nameKr: p.assetName, name: p.assetName, sym: p.assetId,
      p: 0, c: 0, v: '-', t: 'coin', clr: T.acl,
    } as Asset);
    setBuyPrice(String(p.buyPrice));
    setQuantity(String(p.quantity));
    setNote(p.note || '');
    setShowAddModal(true);
  }, [resetForm]);

  const submit = useCallback(() => {
    if (!selectedAsset) { showToast('종목을 선택해주세요'); return; }
    const bp = toNum(buyPrice);
    const qty = toNum(quantity);
    if (bp <= 0) { showToast('매수가를 입력해주세요'); return; }
    if (qty <= 0) { showToast('수량을 입력해주세요'); return; }

    const entry: Position = {
      id:        editingId ?? 'pos-' + Date.now().toString(36),
      assetId:   selectedAsset.id,
      assetName: selectedAsset.nameKr || selectedAsset.id,
      category:  detectCategory(selectedAsset.t),
      buyPrice:  bp,
      quantity:  qty,
      addedAt:   Date.now(),
      note:      note.trim() || undefined,
    };
    const next = editingId
      ? positions.map(p => p.id === editingId ? entry : p)
      : [entry, ...positions];
    savePositions(next);
    setShowAddModal(false);
    resetForm();
    showToast(editingId ? '✅ 수정됨' : '✅ 추가됨');
  }, [selectedAsset, buyPrice, quantity, note, editingId, positions, savePositions, resetForm, showToast]);

  const removePosition = useCallback((id: string) => {
    if (!confirm('이 종목을 삭제하시겠습니까?')) return;
    savePositions(positions.filter(p => p.id !== id));
    showToast('🗑 삭제됨');
  }, [positions, savePositions, showToast]);

  /* ── Render ── */
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
          <div style={{ color: T.txt, fontWeight: 900, fontSize: 17 }}>내 포트폴리오</div>
          <div style={{ color: T.muted, fontSize: 10 }}>
            {positions.length}개 종목 · 실시간 평가
          </div>
        </div>
        <button type="button" onClick={openAdd}
          style={{ padding:'10px 16px', minHeight: 40,
            background:'linear-gradient(135deg,#2563EB,#10B981)',
            color:'#fff', border:'none', borderRadius: 10,
            fontWeight: 800, fontSize: 12, cursor:'pointer' }}>
          + 종목 추가
        </button>
      </div>

      {/* 계좌 분리 탭 */}
      <div style={{ display:'flex', gap:6, marginBottom:12, overflowX:'auto' }}>
        {([['all','전체'],['auto','자동매매'],['swing','단타'],['hold','장투']] as [string,string][]).map(([v,l])=>(
          <button key={v} onClick={()=>setAcctTab(v)} style={{ flex:'1 0 auto', minWidth:70, padding:'9px 8px', background: acctTab===v?T.acc:T.alt, color: acctTab===v?'#fff':T.muted, border:`1px solid ${acctTab===v?T.acc:T.border}`, borderRadius:10, fontSize:12, fontWeight:700, cursor:'pointer', whiteSpace:'nowrap' }}>{l}</button>
        ))}
      </div>
      {acctTab!=='all' && (
        <div style={{ background:T.alt, borderRadius:10, padding:'10px 13px', marginBottom:10, fontSize:11, color:T.sub, lineHeight:1.5 }}>
          {acctTab==='auto' && '자동매매 계좌 — 봇이 자동으로 운용하는 자금이에요.'}
          {acctTab==='swing' && '단타 계좌 — 짧게 사고파는 단기 매매 자금이에요.'}
          {acctTab==='hold' && '장투 계좌 — 길게 보유하는 장기 투자 자금이에요.'}
        </div>
      )}

      {/* Total value card */}
      <Card style={{ marginBottom: 10, padding:'16px 18px' }}>
        <div style={{ color: T.muted, fontSize: 10, fontWeight: 700, marginBottom: 4 }}>{acctTab==='all'?'총 평가금액':acctTab==='auto'?'자동매매 평가금액':acctTab==='swing'?'단타 평가금액':'장투 평가금액'}</div>
        <div style={{ color: T.txt, fontSize: 26, fontWeight: 900, fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums', marginBottom: 6 }}>
          {formatKRW(portfolioStats.totalMarket)}
        </div>
        <div style={{ display:'flex', gap: 8, alignItems:'center' }}>
          <span style={{
            color: portfolioStats.totalPnL >= 0 ? T.grn : T.red,
            fontSize: 14, fontWeight: 800,
          }}>
            {portfolioStats.totalPnL >= 0 ? '▲' : '▼'} {formatKRW(Math.abs(portfolioStats.totalPnL))}
          </span>
          <span style={{
            color: portfolioStats.totalROI >= 0 ? T.grn : T.red,
            fontSize: 12, fontWeight: 700, fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums',
          }}>
            ({fmtPct(portfolioStats.totalROI)})
          </span>
        </div>
        <div style={{ display:'flex', justifyContent:'space-between', marginTop: 12,
          paddingTop: 12, borderTop:`1px solid ${T.border}`, fontSize: 11 }}>
          <span style={{ color: T.muted }}>매수원금</span>
          <span style={{ color: T.txt, fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums', fontWeight: 600 }}>
            {formatKRW(portfolioStats.totalBuy)}
          </span>
        </div>
      </Card>

      {/* Allocation chart */}
      {portfolioStats.allocationList.length > 0 && (
        <Card style={{ marginBottom: 10 }}>
          <div style={{ color: T.txt, fontWeight: 700, fontSize: 13, marginBottom: 12 }}>자산 비중</div>
          <div style={{ display:'flex', gap: 16, alignItems:'center' }}>
            <DonutChart
              data={portfolioStats.allocationList.map(a => ({
                label: a.label, value: a.value, color: a.color,
              }))}
              size={120}
              thickness={20}
            />
            <div style={{ flex: 1 }}>
              {portfolioStats.allocationList.map(a => (
                <div key={a.cat} style={{ display:'flex', alignItems:'center',
                  justifyContent:'space-between', padding:'4px 0' }}>
                  <div style={{ display:'flex', alignItems:'center', gap: 6 }}>
                    <span style={{ width: 10, height: 10, borderRadius: 2, background: a.color }}/>
                    <span style={{ color: T.txt, fontSize: 11 }}>{a.label}</span>
                  </div>
                  <span style={{ color: T.muted, fontSize: 11, fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums' }}>
                    {a.pct.toFixed(1)}%
                  </span>
                </div>
              ))}
            </div>
          </div>
        </Card>
      )}

      {/* Positions list */}
      <Card style={{ overflow:'hidden', padding: 0, marginBottom: 10 }}>
        <div style={{ padding:'10px 14px', borderBottom:`1px solid ${T.border}`,
          color: T.muted, fontSize: 10, fontWeight: 700 }}>
          보유 종목
        </div>
        {portfolioStats.enriched.length === 0 ? (
          <div style={{ padding:'48px 20px', textAlign:'center', color: T.muted }}>
            <div style={{ fontSize: 40, marginBottom: 10 }}>📭</div>
            <div style={{ fontSize: 13, marginBottom: 14 }}>아직 보유 종목이 없습니다</div>
            <button type="button" onClick={openAdd}
              style={{ background: T.acg, color: T.acl,
                border:`1px solid ${T.acl}40`, borderRadius: 10,
                padding:'10px 20px', fontSize: 12, fontWeight: 700,
                cursor:'pointer', minHeight: 40 }}>
              첫 종목 추가하기
            </button>
          </div>
        ) : portfolioStats.enriched.map((p, i) => (
          <div key={p.id}
            style={{ padding:'12px 14px',
              borderBottom: i < portfolioStats.enriched.length - 1 ? `1px solid ${T.border}` : 'none' }}>
            <div style={{ display:'flex', alignItems:'center', gap: 10 }}>
              <Logo id={p.assetId} size={40} clr={CATEGORY_INFO[p.category]?.color} name={p.assetName}/>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display:'flex', alignItems:'center', gap: 5, marginBottom: 2 }}>
                  <span style={{ color: T.txt, fontWeight: 700, fontSize: 13,
                    whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
                    {p.assetName}
                  </span>
                  <span style={{
                    background: (CATEGORY_INFO[p.category]?.color ?? T.muted) + '20',
                    color: CATEGORY_INFO[p.category]?.color ?? T.muted,
                    fontSize: 8, fontWeight: 700, padding:'1px 6px', borderRadius: 4,
                  }}>
                    {CATEGORY_INFO[p.category]?.icon} {CATEGORY_INFO[p.category]?.label}
                  </span>
                </div>
                <div style={{ color: T.muted, fontSize: 9 }}>
                  {p.quantity.toLocaleString('en-US', { maximumFractionDigits: 8 })} 개 · 평균 {formatKRW(p.buyPrice)}
                </div>
              </div>
              <div style={{ textAlign:'right' }}>
                <div style={{ color: T.txt, fontSize: 12, fontWeight: 700, fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums' }}>
                  {formatKRW(p.marketValue)}
                </div>
                <div style={{
                  color: p.unrealizedPnL >= 0 ? T.grn : T.red,
                  fontSize: 11, fontWeight: 700, fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums',
                }}>
                  {p.unrealizedPnL >= 0 ? '+' : ''}{formatKRW(p.unrealizedPnL).replace('₩', '₩')}
                </div>
                <div style={{
                  color: p.unrealizedROI >= 0 ? T.grn : T.red,
                  fontSize: 10, fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums',
                }}>
                  ({fmtPct(p.unrealizedROI)})
                </div>
              </div>
            </div>
            <div style={{ display:'flex', gap: 6, marginTop: 10 }}>
              <button type="button"
                onClick={() => {
                  if (onOpenAsset) {
                    const asset = sourceAssets.find(a => a.id === p.assetId) ?? {
                      id: p.assetId, nameKr: p.assetName, name: p.assetName,
                      sym: p.assetId, p: p.curPrice, c: 0, v: '-', t: 'coin',
                      clr: CATEGORY_INFO[p.category]?.color ?? T.acl,
                    } as Asset;
                    onOpenAsset(asset, 'trading');
                  }
                }}
                style={{ flex: 1, padding:'7px', background: T.acg, color: T.acl,
                  border:`1px solid ${T.acl}40`, borderRadius: 8,
                  fontSize: 10, fontWeight: 700, cursor:'pointer', minHeight: 34 }}>
                상세
              </button>
              <button type="button" onClick={() => openEdit(p)}
                style={{ flex: 1, padding:'7px', background: T.alt, color: T.muted,
                  border:`1px solid ${T.border}`, borderRadius: 8,
                  fontSize: 10, fontWeight: 700, cursor:'pointer', minHeight: 34 }}>
                ✏️ 수정
              </button>
              <button type="button" onClick={() => removePosition(p.id)}
                style={{ padding:'7px 12px', background: T.alt, color: T.red,
                  border:`1px solid ${T.red}30`, borderRadius: 8,
                  fontSize: 10, fontWeight: 700, cursor:'pointer', minHeight: 34 }}>
                🗑
              </button>
            </div>
          </div>
        ))}
      </Card>

      {/* Add/Edit modal */}
      {showAddModal && (
        <>
          <div onClick={() => setShowAddModal(false)}
            style={{ position:'fixed', inset: 0, background:'rgba(0,0,0,.7)', zIndex: 200 }}/>
          <div onClick={(e) => e.stopPropagation()}
            style={{ position:'fixed', zIndex: 201, inset:'auto 0 0 0',
              background: T.bg, borderRadius:'20px 20px 0 0',
              maxHeight:'92dvh', overflowY:'auto',
              padding:`18px 16px calc(env(safe-area-inset-bottom, 20px) + 24px)`,
              maxWidth: 520, margin:'0 auto' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom: 16 }}>
              <div style={{ color: T.txt, fontWeight: 800, fontSize: 15 }}>
                {editingId ? '종목 수정' : '+ 종목 추가'}
              </div>
              <button type="button" onClick={() => setShowAddModal(false)}
                style={{ background:'transparent', border:`1px solid ${T.border}`,
                  borderRadius: 8, color: T.muted, padding:'5px 12px',
                  fontSize: 12, cursor:'pointer', minHeight: 36 }}>
                닫기
              </button>
            </div>

            {/* Asset picker */}
            {!selectedAsset && (
              <>
                <div style={{ color: T.muted, fontSize: 11, marginBottom: 5 }}>종목 검색</div>
                <input
                  autoFocus
                  value={assetSearch}
                  onChange={e => setAssetSearch(e.target.value)}
                  placeholder="BTC, 삼성전자, AAPL..."
                  style={{ width:'100%', boxSizing:'border-box', background: T.bg,
                    border:`1px solid ${T.border}`, borderRadius: 10, padding:'12px 14px',
                    color: T.txt, fontSize: 14, outline:'none', marginBottom: 10 }}
                />
                {searchMatches.length > 0 && (
                  <div style={{ background: T.alt, borderRadius: 10, overflow:'hidden', marginBottom: 14 }}>
                    {searchMatches.map(a => (
                      <div key={a.id} onClick={() => {
                        setSelectedAsset(a);
                        setBuyPrice(String(safeNumber(a.p, 0)));
                      }}
                        style={{ display:'flex', alignItems:'center', gap: 10,
                          padding:'10px 12px', cursor:'pointer',
                          borderBottom:`1px solid ${T.border}` }}>
                        <Logo id={a.id} size={30} clr={a.clr} name={a.nameKr}/>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ color: T.txt, fontSize: 12, fontWeight: 700 }}>{a.nameKr}</div>
                          <div style={{ color: T.muted, fontSize: 9, fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums' }}>
                            {a.sym || a.id} · {formatKRW(safeNumber(a.p, 0))}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            {selectedAsset && (
              <>
                <div style={{ display:'flex', alignItems:'center', gap: 10,
                  background: T.alt, borderRadius: 12, padding:'10px 14px', marginBottom: 14 }}>
                  <Logo id={selectedAsset.id} size={36} clr={selectedAsset.clr} name={selectedAsset.nameKr}/>
                  <div style={{ flex: 1 }}>
                    <div style={{ color: T.txt, fontWeight: 700, fontSize: 13 }}>{selectedAsset.nameKr}</div>
                    <div style={{ color: T.muted, fontSize: 10 }}>{selectedAsset.sym || selectedAsset.id}</div>
                  </div>
                  {!editingId && (
                    <button type="button" onClick={() => setSelectedAsset(null)}
                      style={{ background:'none', border:'none', color: T.muted,
                        cursor:'pointer', fontSize: 12 }}>
                      변경
                    </button>
                  )}
                </div>

                <div style={{ marginBottom: 12 }}>
                  <div style={{ color: T.muted, fontSize: 11, marginBottom: 5 }}>매수 평균가</div>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={buyPrice}
                    onChange={e => setBuyPrice(e.target.value.replace(/[^\d.,]/g, ''))}
                    placeholder="0"
                    style={{ width:'100%', boxSizing:'border-box', background: T.bg,
                      border:`1px solid ${T.border}`, borderRadius: 10, padding:'12px 14px',
                      color: T.txt, fontSize: 14, fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums', outline:'none' }}
                  />
                </div>

                <div style={{ marginBottom: 12 }}>
                  <div style={{ color: T.muted, fontSize: 11, marginBottom: 5 }}>보유 수량</div>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={quantity}
                    onChange={e => setQuantity(e.target.value.replace(/[^\d.,]/g, ''))}
                    placeholder="예: 0.05, 100"
                    style={{ width:'100%', boxSizing:'border-box', background: T.bg,
                      border:`1px solid ${T.border}`, borderRadius: 10, padding:'12px 14px',
                      color: T.txt, fontSize: 14, fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums', outline:'none' }}
                  />
                </div>

                <div style={{ marginBottom: 14 }}>
                  <div style={{ color: T.muted, fontSize: 11, marginBottom: 5 }}>메모 (선택)</div>
                  <input
                    type="text"
                    value={note}
                    onChange={e => setNote(e.target.value)}
                    placeholder="장기 보유, DCA 등"
                    style={{ width:'100%', boxSizing:'border-box', background: T.bg,
                      border:`1px solid ${T.border}`, borderRadius: 10, padding:'12px 14px',
                      color: T.txt, fontSize: 13, outline:'none' }}
                  />
                </div>

                {/* Live preview */}
                {toNum(buyPrice) > 0 && toNum(quantity) > 0 && (
                  <div style={{ background: T.acg, border:`1px solid ${T.acl}40`,
                    borderRadius: 10, padding:'10px 14px', marginBottom: 14 }}>
                    <div style={{ color: T.acl, fontSize: 10, fontWeight: 700, marginBottom: 4 }}>
                      미리보기
                    </div>
                    <div style={{ color: T.txt, fontSize: 11, lineHeight: 1.6 }}>
                      매수 총액: <strong>{formatKRW(toNum(buyPrice) * toNum(quantity))}</strong>
                    </div>
                  </div>
                )}

                <button type="button" onClick={submit}
                  style={{ width:'100%', padding:'13px', minHeight: 48,
                    background:'linear-gradient(135deg,#2563EB,#10B981)',
                    color:'#fff', border:'none', borderRadius: 12,
                    fontWeight: 800, fontSize: 14, cursor:'pointer' }}>
                  {editingId ? '✏️ 수정 저장' : '➕ 추가하기'}
                </button>
              </>
            )}
          </div>
        </>
      )}

      {/* Disclaimer */}
      <div style={{ color: T.muted, fontSize: 10, lineHeight: 1.6,
        padding:'10px 12px', background: T.alt, borderRadius: 10, marginTop: 6 }}>
        보유 종목은 이 기기에만 저장되며 (localStorage), 평가금액은 실시간 시세 기준 추정입니다.
      </div>
    </div>
  );
}
