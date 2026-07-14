'use client';
// RebalanceTool — 자동 리밸런싱. 현재 비중 vs 목표 비중 → 드리프트 → 매수/매도 제안.
import React, { useState, useEffect, useMemo } from 'react';
import { T } from '@/lib/constants';
import { cvt } from '@/lib/utils';
import { Scale, RotateCcw, TrendingUp, TrendingDown } from 'lucide-react';

const PORT_KEY = 'tg_portfolio_v2';
const TARGET_KEY = 'tg_rebalance_targets_v1';

const CATS = [
  { id: 'crypto',   label: '코인',     color: '#F59E0B' },
  { id: 'us_stock', label: '미국주식', color: '#3B82F6' },
  { id: 'kr_stock', label: '국내주식', color: '#10B981' },
  { id: 'etf',      label: 'ETF',      color: '#8B5CF6' },
  { id: 'cash',     label: '현금',     color: '#64748B' },
] as const;

const DEFAULT_TARGET: Record<string, number> = { crypto: 40, us_stock: 30, etf: 20, kr_stock: 0, cash: 10 };

function loadPositions(): any[] { if (typeof window === 'undefined') return []; try { return JSON.parse(localStorage.getItem(PORT_KEY) || '[]'); } catch { return []; } }
function loadTargets(): Record<string, number> { if (typeof window === 'undefined') return DEFAULT_TARGET; try { const r = localStorage.getItem(TARGET_KEY); return r ? JSON.parse(r) : DEFAULT_TARGET; } catch { return DEFAULT_TARGET; } }

export default function RebalanceTool({ prices = {}, currency = 'KRW' }: { prices?: Record<string, number>; currency?: string }) {
  const [positions, setPositions] = useState<any[]>([]);
  const [target, setTarget] = useState<Record<string, number>>(DEFAULT_TARGET);
  const [threshold, setThreshold] = useState(5);
  const [saved, setSaved] = useState(false);

  useEffect(() => { setPositions(loadPositions()); setTarget(loadTargets()); }, []);

  const { total, current, byCat } = useMemo(() => {
    const byCat: Record<string, number> = {};
    for (const p of positions) {
      const sym = (p.symbol || p.ticker || p.id || '').toUpperCase();
      const price = prices[sym] || p.curPrice || p.avgPrice || 0;
      const mv = price * (p.quantity || p.qty || 0);
      const cat = p.category || 'crypto';
      byCat[cat] = (byCat[cat] || 0) + mv;
    }
    const total = Object.values(byCat).reduce((a, b) => a + b, 0);
    const current: Record<string, number> = {};
    for (const c of CATS) current[c.id] = total > 0 ? ((byCat[c.id] || 0) / total) * 100 : 0;
    return { total, current, byCat };
  }, [positions, prices]);

  const targetSum = CATS.reduce((s, c) => s + (target[c.id] || 0), 0);

  const setCat = (id: string, v: number) => { setTarget(t => ({ ...t, [id]: Math.max(0, Math.min(100, v)) })); setSaved(false); };
  const save = () => { try { localStorage.setItem(TARGET_KEY, JSON.stringify(target)); setSaved(true); setTimeout(() => setSaved(false), 1800); } catch {} };
  const reset = () => { setTarget(DEFAULT_TARGET); setSaved(false); };

  // 리밸런싱 제안: (목표% - 현재%) × 총자산 → 매수/매도 금액
  const actions = CATS.map(c => {
    const cur = current[c.id] || 0;
    const tgt = target[c.id] || 0;
    const driftPct = tgt - cur;                 // +면 매수, -면 매도
    const amount = (driftPct / 100) * total;
    return { ...c, cur, tgt, driftPct, amount, act: Math.abs(driftPct) < threshold ? 'hold' : driftPct > 0 ? 'buy' : 'sell' };
  }).filter(a => a.tgt > 0 || a.cur > 0);

  const needsRebalance = actions.some(a => a.act !== 'hold');

  if (total === 0) {
    return (
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 16, padding: '22px 18px', marginBottom: 14, textAlign: 'center' }}>
        <Scale size={28} color={T.muted} style={{ marginBottom: 8 }} />
        <div style={{ color: T.txt, fontWeight: 800, fontSize: 14, marginBottom: 4 }}>리밸런싱할 자산이 없어요</div>
        <div style={{ color: T.muted, fontSize: 12, lineHeight: 1.5 }}>포트폴리오에 보유 종목을 추가하면<br />목표 비중 대비 리밸런싱을 제안해드려요.</div>
      </div>
    );
  }

  return (
    <div style={{ marginBottom: 16 }}>
      {/* 헤더 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <div style={{ width: 34, height: 34, borderRadius: 9, background: '#8B5CF61F', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Scale size={18} color="#8B5CF6" />
        </div>
        <div>
          <div style={{ color: T.txt, fontWeight: 800, fontSize: 15 }}>자동 리밸런싱</div>
          <div style={{ color: T.muted, fontSize: 11 }}>총 자산 {cvt(total, currency)}</div>
        </div>
      </div>

      {/* 목표 비중 설정 */}
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: '14px 16px', marginBottom: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <span style={{ color: T.txt, fontWeight: 700, fontSize: 13 }}>목표 비중</span>
          <span style={{ color: targetSum === 100 ? T.grn : T.ylw, fontSize: 11, fontWeight: 800 }}>합계 {targetSum}%{targetSum !== 100 ? ' (100% 필요)' : ''}</span>
        </div>
        {CATS.map(c => (
          <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <span style={{ width: 7, height: 7, borderRadius: 2, background: c.color, flexShrink: 0 }} />
            <span style={{ color: T.txt, fontSize: 12, fontWeight: 600, width: 62, flexShrink: 0 }}>{c.label}</span>
            <input type="range" min={0} max={100} step={5} value={target[c.id] || 0}
              onChange={e => setCat(c.id, Number(e.target.value))}
              style={{ flex: 1, accentColor: c.color }} />
            <span style={{ color: c.color, fontWeight: 800, fontSize: 13, width: 44, textAlign: 'right' }}>{target[c.id] || 0}%</span>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button onClick={save} disabled={targetSum !== 100}
            style={{ flex: 1, background: targetSum === 100 ? '#8B5CF6' : T.alt, color: targetSum === 100 ? '#fff' : T.muted, border: 'none', borderRadius: 10, padding: '11px', fontWeight: 800, fontSize: 13, cursor: targetSum === 100 ? 'pointer' : 'default' }}>
            {saved ? '저장됨 ✓' : '목표 저장'}
          </button>
          <button onClick={reset} style={{ display: 'flex', alignItems: 'center', gap: 5, background: T.alt, color: T.muted, border: `1px solid ${T.border}`, borderRadius: 10, padding: '11px 14px', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>
            <RotateCcw size={13} /> 초기화
          </button>
        </div>
      </div>

      {/* 리밸런싱 임계값 */}
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: '12px 16px', marginBottom: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <span style={{ color: T.muted, fontSize: 12 }}>리밸런싱 임계값</span>
          <span style={{ color: T.acl, fontWeight: 800, fontSize: 13 }}>±{threshold}%</span>
        </div>
        <input type="range" min={1} max={15} step={1} value={threshold} onChange={e => setThreshold(Number(e.target.value))} style={{ width: '100%', accentColor: T.acl }} />
        <div style={{ color: T.muted, fontSize: 10, marginTop: 4 }}>드리프트가 이 값을 넘는 자산만 매매를 제안해요.</div>
      </div>

      {/* 현재 vs 목표 + 제안 */}
      <div style={{ background: T.card, border: `1px solid ${needsRebalance ? T.ylw + '40' : T.grn + '40'}`, borderRadius: 14, padding: '14px 16px' }}>
        <div style={{ color: T.txt, fontWeight: 700, fontSize: 13, marginBottom: 12 }}>
          {needsRebalance ? '리밸런싱 제안' : '균형 잡힘 ✓'}
        </div>
        {actions.map(a => {
          const barCur = Math.min(100, a.cur);
          const barTgt = Math.min(100, a.tgt);
          return (
            <div key={a.id} style={{ marginBottom: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 5 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <span style={{ width: 7, height: 7, borderRadius: 2, background: a.color }} />
                  <span style={{ color: T.txt, fontSize: 12, fontWeight: 700 }}>{a.label}</span>
                </div>
                <span style={{ color: T.muted, fontSize: 11 }}>{a.cur.toFixed(1)}% → {a.tgt}%</span>
              </div>
              {/* 현재(진한) vs 목표(연한 테두리) 바 */}
              <div style={{ position: 'relative', height: 8, background: T.alt, borderRadius: 4, marginBottom: 6 }}>
                <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${barTgt}%`, border: `1.5px dashed ${a.color}`, borderRadius: 4, boxSizing: 'border-box' }} />
                <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${barCur}%`, background: a.color, borderRadius: 4, opacity: 0.85 }} />
              </div>
              {/* 액션 */}
              {a.act === 'hold' ? (
                <div style={{ color: T.muted, fontSize: 11 }}>유지 (드리프트 {Math.abs(a.driftPct).toFixed(1)}%)</div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: a.act === 'buy' ? T.grn : T.red, fontSize: 12, fontWeight: 700 }}>
                  {a.act === 'buy' ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
                  {a.act === 'buy' ? '매수' : '매도'} {cvt(Math.abs(a.amount), currency)}
                  <span style={{ color: T.muted, fontWeight: 500 }}>({a.driftPct > 0 ? '+' : ''}{a.driftPct.toFixed(1)}%)</span>
                </div>
              )}
            </div>
          );
        })}
        <div style={{ color: T.muted, fontSize: 10, marginTop: 4, lineHeight: 1.5, paddingTop: 10, borderTop: `1px solid ${T.border}` }}>
          진한 막대 = 현재 비중, 점선 = 목표 비중. 제안 금액은 참고용이며 실제 매매는 직접 실행하세요.
        </div>
      </div>
    </div>
  );
}
