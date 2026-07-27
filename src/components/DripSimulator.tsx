'use client';
// DripSimulator — 배당 재투자 복리 시뮬레이션. 재투자 vs 현금 수령 비교.
import React, { useState, useMemo } from 'react';
import { T } from '@/lib/constants';
import { cvt } from '@/lib/utils';
import { Repeat, TrendingUp } from 'lucide-react';
import { compareDrip } from '@/lib/accounts/drip';

const PRESETS = [
  { label: 'SCHD', yield: 3.5, divG: 8, priceG: 7 },
  { label: 'JEPI', yield: 7.2, divG: 2, priceG: 4 },
  { label: 'VOO',  yield: 1.4, divG: 6, priceG: 9 },
  { label: '직접', yield: 4.0, divG: 5, priceG: 6 },
];

export default function DripSimulator({ currency = 'KRW' }: { currency?: string }) {
  const [principal, setPrincipal] = useState(10000000);
  const [years, setYears] = useState(20);
  const [yieldPct, setYieldPct] = useState(3.5);
  const [divGrowth, setDivGrowth] = useState(8);
  const [priceGrowth, setPriceGrowth] = useState(7);
  const [preset, setPreset] = useState('SCHD');
  const [taxRate, setTaxRate] = useState(0);   // 0=세전, 15.4=한국, 15=미국

  const { reinvest, cash, extra, extraPct } = useMemo(
    () => compareDrip({ principal, annualYield: yieldPct, divGrowth, priceGrowth, years, taxRate }),
    [principal, yieldPct, divGrowth, priceGrowth, years, taxRate]
  );

  const rFinal = reinvest[reinvest.length - 1]?.totalReturn || 0;
  const cFinal = cash[cash.length - 1]?.totalReturn || 0;
  const maxV = Math.max(rFinal, cFinal, 1);

  const applyPreset = (p: typeof PRESETS[0]) => {
    setPreset(p.label); setYieldPct(p.yield); setDivGrowth(p.divG); setPriceGrowth(p.priceG);
  };

  // 차트 좌표 (재투자/현금 두 라인)
  const W = 300, H = 120;
  const line = (series: typeof reinvest) => series.map((d, i) => {
    const x = (i / (series.length - 1 || 1)) * W;
    const yv = H - (d.totalReturn / maxV) * (H - 10) - 5;
    return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${yv.toFixed(1)}`;
  }).join(' ');

  const Slider = ({ label, val, set, min, max, step, suffix }: any) => (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
        <span style={{ color: T.muted, fontSize: 11 }}>{label}</span>
        <span style={{ color: T.txt, fontWeight: 700, fontSize: 12 }}>{suffix === '원' ? cvt(val, currency) : `${val}${suffix}`}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={val} onChange={e => set(Number(e.target.value))} style={{ width: '100%', accentColor: '#10B981' }} />
    </div>
  );

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 16, padding: '16px', marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 14 }}>
        <div style={{ width: 34, height: 34, borderRadius: 9, background: '#10B98120', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Repeat size={18} color="#10B981" />
        </div>
        <div>
          <div style={{ color: T.txt, fontWeight: 800, fontSize: 15 }}>배당 재투자 시뮬레이터</div>
          <div style={{ color: T.muted, fontSize: 11 }}>배당을 재투자하면 복리로 불어나요</div>
        </div>
      </div>

      {/* 프리셋 */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        {PRESETS.map(p => (
          <button key={p.label} onClick={() => applyPreset(p)}
            style={{ flex: 1, background: preset === p.label ? '#10B981' : T.alt, color: preset === p.label ? '#fff' : T.muted, border: 'none', borderRadius: 8, padding: '8px 4px', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>
            {p.label}
          </button>
        ))}
      </div>

      {/* 최종 비교 카드 */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
        <div style={{ flex: 1, background: '#10B98115', border: `1px solid #10B98140`, borderRadius: 12, padding: '12px' }}>
          <div style={{ color: T.muted, fontSize: 10, marginBottom: 3 }}>재투자 시 ({years}년 후)</div>
          <div style={{ color: '#10B981', fontSize: 17, fontWeight: 900, fontFamily: 'Inter,monospace' }}>{cvt(rFinal, currency)}</div>
        </div>
        <div style={{ flex: 1, background: T.alt, borderRadius: 12, padding: '12px' }}>
          <div style={{ color: T.muted, fontSize: 10, marginBottom: 3 }}>현금 수령 시</div>
          <div style={{ color: T.sub, fontSize: 17, fontWeight: 900, fontFamily: 'Inter,monospace' }}>{cvt(cFinal, currency)}</div>
        </div>
      </div>

      {/* 복리 효과 강조 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#10B98112', borderRadius: 10, padding: '10px 14px', marginBottom: 14 }}>
        <TrendingUp size={16} color="#10B981" />
        <span style={{ color: T.txt, fontSize: 12 }}>재투자로 <b style={{ color: '#10B981' }}>{cvt(extra, currency)}</b> 더 (+{extraPct.toFixed(1)}%)</span>
      </div>

      {/* 차트 */}
      <div style={{ background: T.alt, borderRadius: 12, padding: '12px', marginBottom: 14 }}>
        <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
          <path d={line(cash)} fill="none" stroke={T.muted} strokeWidth="2" strokeDasharray="4 3" />
          <path d={line(reinvest)} fill="none" stroke="#10B981" strokeWidth="2.5" />
        </svg>
        <div style={{ display: 'flex', gap: 14, justifyContent: 'center', marginTop: 6 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5, color: T.muted, fontSize: 10 }}><span style={{ width: 12, height: 2, background: '#10B981', display: 'inline-block' }} />재투자</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5, color: T.muted, fontSize: 10 }}><span style={{ width: 12, height: 2, background: T.muted, display: 'inline-block' }} />현금 수령</span>
        </div>
      </div>

      {/* 입력 */}
      <Slider label="초기 투자금" val={principal} set={setPrincipal} min={1000000} max={100000000} step={1000000} suffix="원" />
      <Slider label="투자 기간" val={years} set={setYears} min={5} max={40} step={1} suffix="년" />
      <Slider label="배당 수익률" val={yieldPct} set={setYieldPct} min={0.5} max={12} step={0.1} suffix="%" />
      <Slider label="배당 성장률 (연)" val={divGrowth} set={setDivGrowth} min={0} max={15} step={0.5} suffix="%" />
      <Slider label="주가 상승률 (연)" val={priceGrowth} set={setPriceGrowth} min={0} max={15} step={0.5} suffix="%" />

      {/* 배당소득세 옵션 */}
      <div style={{ background: T.alt, borderRadius: 10, padding: '10px 12px', marginBottom: 12 }}>
        <div style={{ color: T.muted, fontSize: 11, fontWeight: 700, marginBottom: 8 }}>배당소득세</div>
        <div style={{ display: 'flex', gap: 6 }}>
          {[{ l: '세전', v: 0 }, { l: '한국 15.4%', v: 15.4 }, { l: '미국 15%', v: 15 }].map(o => (
            <button key={o.v} onClick={() => setTaxRate(o.v)}
              style={{ flex: 1, background: taxRate === o.v ? '#10B981' : T.card, color: taxRate === o.v ? '#fff' : T.muted, border: `1px solid ${taxRate === o.v ? '#10B981' : T.border}`, borderRadius: 8, padding: '8px 4px', fontWeight: 700, fontSize: 11, cursor: 'pointer' }}>
              {o.l}
            </button>
          ))}
        </div>
      </div>

      <div style={{ color: T.muted, fontSize: 10, lineHeight: 1.5, marginTop: 4 }}>
        연 단위 복리 근사입니다. 실제 수익률·배당은 변동하며{taxRate > 0 ? ` 배당소득세 ${taxRate}%를 반영했습니다.` : ' 세금은 미반영(세전)입니다.'} 참고용 시뮬레이션이에요.
      </div>
    </div>
  );
}
