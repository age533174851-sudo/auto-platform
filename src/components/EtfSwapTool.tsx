'use client';
// EtfSwapTool — 보유 ETF를 스캔해 더 저렴한 동급 ETF로 교체 제안.
import React, { useState, useEffect, useMemo } from 'react';
import { T } from '@/lib/constants';
import { cvt } from '@/lib/utils';
import { ArrowRightLeft, TrendingDown, Check, Search } from 'lucide-react';
import { ETF_GROUPS, suggestSwap, findEtf, type SwapSuggestion } from '@/lib/accounts/etfSwap';

const PORT_KEY = 'tg_portfolio_v2';

function loadPositions(): any[] { if (typeof window === 'undefined') return []; try { return JSON.parse(localStorage.getItem(PORT_KEY) || '[]'); } catch { return []; } }

export default function EtfSwapTool({ prices = {}, currency = 'KRW' }: { prices?: Record<string, number>; currency?: string }) {
  const [positions, setPositions] = useState<any[]>([]);
  const [demoSym, setDemoSym] = useState('SPY');
  const [demoValue, setDemoValue] = useState(10000000);

  useEffect(() => { setPositions(loadPositions()); }, []);

  // 보유 ETF 중 교체 제안 있는 것
  const heldSuggestions = useMemo(() => {
    const out: { value: number; s: SwapSuggestion }[] = [];
    for (const p of positions) {
      const sym = (p.symbol || p.ticker || p.id || '').toUpperCase();
      if (!findEtf(sym)) continue;
      const price = prices[sym] || p.curPrice || p.avgPrice || 0;
      const value = price * (p.quantity || p.qty || 0);
      const s = suggestSwap(sym, value);
      if (s) out.push({ value, s });
    }
    return out;
  }, [positions, prices]);

  const demoSuggestion = useMemo(() => suggestSwap(demoSym, demoValue), [demoSym, demoValue]);

  const Card = ({ s, value, tenYear }: { s: SwapSuggestion; value: number; tenYear: number }) => (
    <div style={{ background: T.card, border: `1px solid #10B98140`, borderRadius: 14, padding: '14px', marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <div style={{ textAlign: 'center', flex: 1 }}>
          <div style={{ color: T.muted, fontSize: 9 }}>현재</div>
          <div style={{ color: T.txt, fontWeight: 800, fontSize: 15 }}>{s.from.symbol}</div>
          <div style={{ color: T.red, fontSize: 10, fontWeight: 700 }}>{s.from.expense}%</div>
        </div>
        <ArrowRightLeft size={18} color="#10B981" style={{ flexShrink: 0 }} />
        <div style={{ textAlign: 'center', flex: 1 }}>
          <div style={{ color: T.muted, fontSize: 9 }}>추천</div>
          <div style={{ color: '#10B981', fontWeight: 800, fontSize: 15 }}>{s.to.symbol}</div>
          <div style={{ color: '#10B981', fontSize: 10, fontWeight: 700 }}>{s.to.expense}%</div>
        </div>
      </div>
      <div style={{ color: T.muted, fontSize: 11, marginBottom: 8 }}>{s.reason}</div>
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1, background: T.alt, borderRadius: 8, padding: '8px 10px' }}>
          <div style={{ color: T.muted, fontSize: 9 }}>연 절감</div>
          <div style={{ color: '#10B981', fontWeight: 800, fontSize: 13 }}>{cvt(s.annualSaved, currency)}</div>
        </div>
        <div style={{ flex: 1, background: T.alt, borderRadius: 8, padding: '8px 10px' }}>
          <div style={{ color: T.muted, fontSize: 9 }}>10년 누적 절감</div>
          <div style={{ color: '#10B981', fontWeight: 800, fontSize: 13 }}>{cvt(tenYear, currency)}</div>
        </div>
      </div>
    </div>
  );

  return (
    <div style={{ background: 'linear-gradient(145deg,#0D1A35,#091228)', border: `1px solid ${T.border2}`, borderRadius: 18, padding: '16px', marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 14 }}>
        <div style={{ width: 34, height: 34, borderRadius: 9, background: '#10B98120', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <ArrowRightLeft size={18} color="#10B981" />
        </div>
        <div>
          <div style={{ color: T.txt, fontWeight: 800, fontSize: 15 }}>ETF 자동 교체</div>
          <div style={{ color: T.muted, fontSize: 11 }}>같은 지수, 더 낮은 총보수로 갈아타기</div>
        </div>
      </div>

      {/* 보유 ETF 제안 */}
      {heldSuggestions.length > 0 ? (
        <div style={{ marginBottom: 14 }}>
          <div style={{ color: T.muted, fontSize: 11, fontWeight: 700, marginBottom: 8 }}>내 보유 ETF 교체 제안</div>
          {heldSuggestions.map(({ value, s }) => <Card key={s.from.symbol} s={s} value={value} tenYear={s.annualSaved * 10} />)}
        </div>
      ) : positions.length > 0 ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, background: '#10B98112', borderRadius: 10, padding: '10px 14px', marginBottom: 14 }}>
          <Check size={15} color="#10B981" />
          <span style={{ color: T.txt, fontSize: 12 }}>보유 ETF는 이미 저보수 최적 상태예요.</span>
        </div>
      ) : null}

      {/* 데모/조회 */}
      <div style={{ background: T.card, borderRadius: 12, padding: '12px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
          <Search size={13} color={T.muted} />
          <span style={{ color: T.muted, fontSize: 11, fontWeight: 700 }}>ETF 조회 (교체 시뮬)</span>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
          {['SPY', 'QQQ', 'DVY', 'QYLD', 'VOO'].map(sym => (
            <button key={sym} onClick={() => setDemoSym(sym)}
              style={{ background: demoSym === sym ? '#10B981' : T.alt, color: demoSym === sym ? '#fff' : T.muted, border: 'none', borderRadius: 7, padding: '6px 12px', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>
              {sym}
            </button>
          ))}
        </div>
        <div style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ color: T.muted, fontSize: 10 }}>보유 금액</span>
            <span style={{ color: T.txt, fontSize: 12, fontWeight: 700 }}>{cvt(demoValue, currency)}</span>
          </div>
          <input type="range" min={1000000} max={100000000} step={1000000} value={demoValue} onChange={e => setDemoValue(Number(e.target.value))} style={{ width: '100%', accentColor: '#10B981' }} />
        </div>
        {demoSuggestion ? (
          <Card s={demoSuggestion} value={demoValue} tenYear={demoSuggestion.annualSaved * 10} />
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: T.muted, fontSize: 12, padding: '8px 0' }}>
            <Check size={15} color="#10B981" /> {demoSym}는 동급 중 이미 최저 총보수예요.
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginTop: 12 }}>
        <TrendingDown size={13} color={T.muted} style={{ flexShrink: 0, marginTop: 1 }} />
        <span style={{ color: T.muted, fontSize: 10, lineHeight: 1.5 }}>
          총보수(운용수수료)는 매년 자동 차감돼 장기 수익률에 큰 영향을 줍니다. 같은 지수를 추종하면 더 저렴한 ETF가 유리해요. 교체 시 세금·매매비용은 별도이니 참고용으로 활용하세요.
        </span>
      </div>
    </div>
  );
}
