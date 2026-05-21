'use client';
import React, { useState, useMemo, useCallback } from 'react';
import { DEFAULT_FEES, getDefaultConfig, calcTradePnL, calcMinViableProfit, fmtFeeRate } from '@/lib/fees';
import { getDefaultFundingRate, fmtFundingRate } from '@/lib/funding';
import { classifyAsset } from '@/lib/slippage';
import type { ExchangeId, UserFeeConfig } from '@/lib/fees';
import type { TradePnLParams } from '@/lib/pnl';

// Re-export calc for convenience
export { calcTradePnL, applyBacktestCosts } from '@/lib/pnl';
export { calcMinViableProfit } from '@/lib/pnl';

const T = {
  bg:'#060B14', card:'#0A1628', surf:'#0D1F3C', alt:'#0F2040',
  border:'#1A2D4A', border2:'#243A5E', txt:'#E2E8F0', sub:'#94A3B8',
  muted:'#475569', grn:'#10B981', red:'#EF4444', ylw:'#F59E0B',
  acl:'#60A5FA', acc:'#2563EB', acg:'#1E3A5F', prp:'#7C3AED',
} as const;

const EXCHANGES: ExchangeId[] = ['binance','bybit','okx','gate','upbit','bithumb'];
const EXCHANGE_NAMES: Record<ExchangeId, string> = {
  binance:'바이낸스', bybit:'바이비트', okx:'OKX', gate:'Gate.io', upbit:'업비트', bithumb:'빗썸',
};

function Row({ label, value, color, bold, sub }: { label:string; value:string; color?:string; bold?:boolean; sub?:boolean }) {
  return (
    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'5px 0', borderBottom:`1px solid ${T.border}` }}>
      <span style={{ color: sub ? T.muted : T.sub, fontSize: sub ? 10 : 11 }}>{label}</span>
      <span style={{ color: color || T.txt, fontWeight: bold ? 800 : 500, fontSize: sub ? 10 : 12, fontFamily:'monospace' }}>{value}</span>
    </div>
  );
}

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div style={{ background:T.card, border:`1px solid ${T.border}`, borderRadius:14, padding:'14px 16px', ...style }}>{children}</div>;
}

// ── Fee Config Panel ──────────────────────────────────────────
interface FeeConfigPanelProps {
  config: UserFeeConfig;
  onChange: (c: UserFeeConfig) => void;
}

export function FeeConfigPanel({ config, onChange }: FeeConfigPanelProps) {
  const tiers = DEFAULT_FEES[config.exchange]?.[config.marketType] || DEFAULT_FEES[config.exchange]?.spot || [];
  const currentTier = tiers[Math.min(config.vipTier, tiers.length-1)];

  return (
    <Card>
      <div style={{ color:T.txt, fontWeight:700, fontSize:13, marginBottom:10 }}>⚙️ 수수료 설정</div>

      {/* Exchange selector */}
      <div style={{ marginBottom:10 }}>
        <div style={{ color:T.muted, fontSize:10, marginBottom:5 }}>거래소</div>
        <div style={{ display:'flex', gap:4, flexWrap:'wrap' }}>
          {EXCHANGES.map(ex => (
            <button key={ex}
              onClick={() => onChange({ ...getDefaultConfig(ex, config.marketType), referralDiscount: config.referralDiscount, bnbDiscount: config.bnbDiscount })}
              style={{ padding:'4px 10px', background: config.exchange === ex ? T.acg : T.alt,
                border: `1px solid ${config.exchange === ex ? T.acl : T.border}`,
                borderRadius:8, color: config.exchange === ex ? T.acl : T.muted, fontSize:10, cursor:'pointer' }}>
              {EXCHANGE_NAMES[ex]}
            </button>
          ))}
        </div>
      </div>

      {/* Market type */}
      <div style={{ marginBottom:10 }}>
        <div style={{ color:T.muted, fontSize:10, marginBottom:5 }}>시장 유형</div>
        <div style={{ display:'flex', gap:4 }}>
          {(['spot','futures'] as const).map(mt => (
            <button key={mt}
              onClick={() => onChange({ ...config, marketType: mt, vipTier: 0 })}
              style={{ padding:'4px 12px', background: config.marketType === mt ? T.acg : T.alt,
                border: `1px solid ${config.marketType === mt ? T.acl : T.border}`,
                borderRadius:8, color: config.marketType === mt ? T.acl : T.muted, fontSize:10, cursor:'pointer' }}>
              {mt === 'spot' ? '현물' : '선물/퍼페추얼'}
            </button>
          ))}
        </div>
      </div>

      {/* VIP tier */}
      <div style={{ marginBottom:10 }}>
        <div style={{ color:T.muted, fontSize:10, marginBottom:5 }}>
          VIP 등급 — {currentTier?.label} · Maker {fmtFeeRate(currentTier?.maker||0)} / Taker {fmtFeeRate(currentTier?.taker||0)}
        </div>
        <div style={{ display:'flex', gap:4, overflowX:'auto', paddingBottom:2 }}>
          {tiers.map((tier, i) => (
            <button key={i}
              onClick={() => onChange({ ...config, vipTier: i, customMaker: undefined, customTaker: undefined })}
              style={{ flexShrink:0, padding:'4px 10px', background: config.vipTier === i ? T.acg : T.alt,
                border: `1px solid ${config.vipTier === i ? T.acl : T.border}`,
                borderRadius:8, color: config.vipTier === i ? T.acl : T.muted, fontSize:9, cursor:'pointer' }}>
              {tier.label}
            </button>
          ))}
        </div>
      </div>

      {/* Custom override */}
      <div className="mobile-1col" style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginBottom:10 }}>
        {[['Maker %', 'customMaker'] as const, ['Taker %', 'customTaker'] as const].map(([label, key]) => (
          <div key={key}>
            <div style={{ color:T.muted, fontSize:9, marginBottom:3 }}>{label} 직접 입력 (%)</div>
            <input
              type="number" step="0.001" min="0" max="1"
              value={config[key] !== undefined ? +(config[key]! * 100).toFixed(4) : ''}
              onChange={e => {
                const v = e.target.value === '' ? undefined : parseFloat(e.target.value) / 100;
                onChange({ ...config, [key]: v });
              }}
              placeholder="기본값"
              style={{ width:'100%', background:T.bg, border:`1px solid ${T.border}`, borderRadius:8,
                padding:'6px 10px', color:T.txt, fontSize:11, outline:'none', boxSizing:'border-box' }}
            />
          </div>
        ))}
      </div>

      {/* Referral discount */}
      <div className="mobile-1col" style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
        <div>
          <div style={{ color:T.muted, fontSize:9, marginBottom:3 }}>레퍼럴 할인 (%)</div>
          <input type="number" step="1" min="0" max="50"
            value={Math.round(config.referralDiscount * 100)}
            onChange={e => onChange({ ...config, referralDiscount: parseFloat(e.target.value||'0') / 100 })}
            style={{ width:'100%', background:T.bg, border:`1px solid ${T.border}`, borderRadius:8, padding:'6px 10px', color:T.txt, fontSize:11, outline:'none', boxSizing:'border-box' }}
          />
        </div>
        {config.exchange === 'binance' && (
          <div style={{ display:'flex', alignItems:'center', gap:8, paddingTop:14 }}>
            <div onClick={() => onChange({ ...config, bnbDiscount: !config.bnbDiscount })}
              style={{ width:36, height:20, borderRadius:10, cursor:'pointer', position:'relative',
                background: config.bnbDiscount ? '#F0B90B' : T.alt,
                border: `1px solid ${config.bnbDiscount ? '#F0B90B' : T.border}`, transition:'background .2s' }}>
              <div style={{ position:'absolute', top:2, left: config.bnbDiscount ? 18 : 2,
                width:14, height:14, borderRadius:'50%', background:'#fff', transition:'left .2s' }}/>
            </div>
            <span style={{ color: config.bnbDiscount ? '#F0B90B' : T.muted, fontSize:10 }}>BNB 할인 25%</span>
          </div>
        )}
      </div>
    </Card>
  );
}

// ── P&L Display Card ──────────────────────────────────────────
interface PnLCardProps {
  entryPrice:  number;
  exitPrice:   number;
  quantity:    number;
  leverage:    number;
  isLong:      boolean;
  feeConfig:   UserFeeConfig;
  dailyVolume: number;
  holdingHours:number;
  fundingRate: number;
  isFutures:   boolean;
  currency:    string;
}

export function PnLCard(p: PnLCardProps) {
  const result = useMemo(() => {
    if (!p.entryPrice || !p.exitPrice || !p.quantity) return null;
    return calcTradePnL({
      entryPrice:   p.entryPrice,
      exitPrice:    p.exitPrice,
      quantity:     p.quantity,
      leverage:     p.leverage || 1,
      isLong:       p.isLong,
      feeConfig:    p.feeConfig,
      dailyVolume:  p.dailyVolume,
      holdingHours: p.holdingHours,
      fundingRate:  p.fundingRate,
      isFutures:    p.isFutures,
    });
  }, [p.entryPrice, p.exitPrice, p.quantity, p.leverage, p.isLong, p.feeConfig, p.dailyVolume, p.holdingHours, p.fundingRate, p.isFutures]);

  const sym = p.currency === 'USD' ? '$' : '₩';
  const fmt = (v: number) => {
    const abs = Math.abs(v);
    const s = abs >= 1e8 ? sym+(abs/1e8).toFixed(1)+'억'
            : abs >= 1e4 ? sym+Math.round(abs).toLocaleString()
            : sym+abs.toFixed(2);
    return v < 0 ? '-'+s : (v > 0 ? '+'+s : s);
  };
  const fmtP = (v: number) => (v >= 0 ? '+' : '')+(v*100).toFixed(3)+'%';

  if (!result) return (
    <Card>
      <div style={{ color:T.muted, fontSize:12, textAlign:'center', padding:'12px 0' }}>진입/목표가와 수량을 입력하세요</div>
    </Card>
  );

  return (
    <Card>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
        <div style={{ color:T.txt, fontWeight:700, fontSize:13 }}>💰 예상 순수익 계산</div>
        <div style={{ background: result.isViable ? T.grn+'20' : T.red+'20',
          border: `1px solid ${result.isViable ? T.grn : T.red}40`,
          borderRadius:8, padding:'3px 10px', color: result.isViable ? T.grn : T.red, fontSize:10, fontWeight:700 }}>
          {result.isViable ? '✅ 수익 가능' : '❌ 손실 예상'}
        </div>
      </div>

      {/* Main P&L breakdown */}
      <div style={{ marginBottom:12 }}>
        <Row label="📈 총수익 (가격 변동)" value={fmt(result.grossPnL)} color={result.grossPnL>=0?T.grn:T.red}/>
        <Row label="  ∟ 진입 수수료" value={`-${fmt(result.entryFee)}`} color={T.red} sub/>
        <Row label="  ∟ 청산 수수료" value={`-${fmt(result.exitFee)}`} color={T.red} sub/>
        <Row label="  ∟ 진입 슬리피지" value={`-${fmt(result.entrySlippage)}`} color={T.ylw} sub/>
        <Row label="  ∟ 청산 슬리피지" value={`-${fmt(result.exitSlippage)}`} color={T.ylw} sub/>
        {result.fundingPayments > 0 && (
          <Row label={`  ∟ 펀딩비 (${result.fundingPayments}회)`} value={`${result.fundingCost>=0?'-':'+'} ${fmt(Math.abs(result.fundingCost))}`} color={result.fundingCost>0?T.red:T.grn} sub/>
        )}
        <div style={{ borderTop:`2px solid ${T.border2}`, marginTop:4, paddingTop:6 }}>
          <Row label="= 최종 순수익" value={fmt(result.netPnL)} color={result.netPnL>=0?T.grn:T.red} bold/>
          <Row label="  손익률 (원금 대비)" value={fmtP(result.netPnLPct)} color={result.netPnLPct>=0?T.grn:T.red}/>
          {result.marginUsed > 0 && result.leverage > 1 && (
            <Row label={`  레버리지 수익률 (${result.leverage}x)`} value={fmtP(result.netPnLLevered)} color={result.netPnLLevered>=0?T.grn:T.red}/>
          )}
        </div>
      </div>

      {/* Summary metrics */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:6, marginBottom:10 }}>
        {[
          { label:'총 수수료', value: fmt(result.totalFees), color:T.red },
          { label:'총 슬리피지', value: fmt(result.totalSlippage), color:T.ylw },
          { label:'펀딩비', value: fmt(result.fundingCost), color: result.fundingCost<=0?T.grn:T.red },
        ].map(m => (
          <div key={m.label} style={{ background:T.alt, border:`1px solid ${T.border}`, borderRadius:8, padding:'7px 8px', textAlign:'center' }}>
            <div style={{ color:T.muted, fontSize:8, marginBottom:2 }}>{m.label}</div>
            <div style={{ color:m.color, fontSize:11, fontWeight:700, fontFamily:'monospace' }}>{m.value}</div>
          </div>
        ))}
      </div>

      {/* Break-even */}
      <div style={{ background:T.alt, border:`1px solid ${T.border}`, borderRadius:8, padding:'8px 10px', marginBottom:8 }}>
        <div style={{ color:T.muted, fontSize:9, marginBottom:3 }}>손익분기점 이동폭</div>
        <div style={{ color:T.ylw, fontSize:12, fontWeight:700 }}>
          {(result.breakEvenMove * 100).toFixed(3)}% 이상 이동해야 수익
        </div>
      </div>

      {/* Warnings */}
      {result.warnings.map((w, i) => (
        <div key={i} style={{ background:'#F59E0B0A', border:`1px solid ${T.ylw}30`, borderRadius:8, padding:'6px 10px', marginBottom:4, color:T.ylw, fontSize:10 }}>
          {w}
        </div>
      ))}
    </Card>
  );
}

// ── Full P&L Calculator UI ────────────────────────────────────
export default function PnLCalculatorPage({ currency = 'KRW' }: { currency?: string }) {
  const [exchange, setExchange] = useState<ExchangeId>('binance');
  const [feeConfig, setFeeConfig] = useState<UserFeeConfig>(getDefaultConfig('binance', 'futures'));

  const [entryPrice,  setEntryPrice]  = useState('');
  const [exitPrice,   setExitPrice]   = useState('');
  const [quantity,    setQuantity]    = useState('');
  const [leverage,    setLeverage]    = useState('1');
  const [side,        setSide]        = useState<'long'|'short'>('long');
  const [isFutures,   setIsFutures]   = useState(false);
  const [holdingHrs,  setHoldingHrs]  = useState('24');
  const [fundingRate, setFundingRate] = useState('0.01');  // %
  const [volume24h,   setVolume24h]   = useState('1000000000');  // 1B default

  // Minimum viable profit analysis
  const minViable = useMemo(() => {
    if (!entryPrice) return null;
    return calcMinViableProfit(
      parseFloat(entryPrice) * (parseFloat(quantity)||1),
      feeConfig,
      parseFloat(fundingRate||'0.01') / 100,
      parseFloat(holdingHrs||'24'),
      parseFloat(volume24h||'1e9'),
      0.005
    );
  }, [entryPrice, quantity, feeConfig, fundingRate, holdingHrs, volume24h]);

  const defaultFunding = getDefaultFundingRate('BTC');

  return (
    <div style={{ color:T.txt }}>
      {/* Header */}
      <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:14 }}>
        <div style={{ width:32, height:32, borderRadius:10, background:'linear-gradient(135deg,#2563EB,#10B981)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:16 }}>💹</div>
        <div>
          <div style={{ fontWeight:900, fontSize:15 }}>실제 수익 계산기</div>
          <div style={{ color:T.muted, fontSize:10 }}>수수료 · 슬리피지 · 펀딩비 통합 계산</div>
        </div>
      </div>

      {/* Trade inputs */}
      <Card style={{ marginBottom:10 }}>
        <div style={{ color:T.txt, fontWeight:700, fontSize:13, marginBottom:10 }}>📊 거래 정보</div>

        {/* Long/Short */}
        <div style={{ display:'flex', gap:6, marginBottom:10 }}>
          {(['long','short'] as const).map(s => (
            <button key={s} onClick={() => setSide(s)}
              style={{ flex:1, padding:'8px', background: side===s ? (s==='long'?T.grn+'20':T.red+'20') : T.alt,
                border: `1px solid ${side===s ? (s==='long'?T.grn:T.red)+'60' : T.border}`,
                borderRadius:10, color: side===s ? (s==='long'?T.grn:T.red) : T.muted,
                fontWeight:700, fontSize:12, cursor:'pointer' }}>
              {s === 'long' ? '📈 롱 (매수)' : '📉 숏 (매도)'}
            </button>
          ))}
        </div>

        {/* Spot / Futures */}
        <div style={{ display:'flex', gap:6, marginBottom:10 }}>
          {[false, true].map(f => (
            <button key={String(f)} onClick={() => setIsFutures(f)}
              style={{ flex:1, padding:'6px', background: isFutures===f ? T.acg : T.alt,
                border: `1px solid ${isFutures===f ? T.acl : T.border}`,
                borderRadius:8, color: isFutures===f ? T.acl : T.muted, fontSize:11, cursor:'pointer' }}>
              {f ? '⚡ 선물/퍼페추얼' : '💱 현물'}
            </button>
          ))}
        </div>

        <div className="mobile-1col" style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
          {[
            ['진입가', entryPrice, setEntryPrice, '0.00'],
            ['목표/청산가', exitPrice, setExitPrice, '0.00'],
            ['수량', quantity, setQuantity, '예: 0.01'],
            isFutures ? ['레버리지 (x)', leverage, setLeverage, '1'] : ['보유시간 (h)', holdingHrs, setHoldingHrs, '24'],
          ].map(([label, val, setter, ph]) => (
            <div key={label as string}>
              <div style={{ color:T.muted, fontSize:10, marginBottom:3 }}>{label as string}</div>
              <input type="number" value={val as string}
                onChange={e => (setter as any)(e.target.value)}
                placeholder={ph as string}
                style={{ width:'100%', background:T.bg, border:`1px solid ${T.border}`, borderRadius:8,
                  padding:'8px 12px', color:T.txt, fontSize:12, outline:'none', boxSizing:'border-box' }}
              />
            </div>
          ))}
        </div>

        {/* Futures-specific */}
        {isFutures && (
          <div className="mobile-1col" style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginTop:8 }}>
            <div>
              <div style={{ color:T.muted, fontSize:10, marginBottom:3 }}>보유시간 (시간)</div>
              <input type="number" value={holdingHrs} onChange={e => setHoldingHrs(e.target.value)}
                placeholder="24" style={{ width:'100%', background:T.bg, border:`1px solid ${T.border}`, borderRadius:8, padding:'8px 12px', color:T.txt, fontSize:12, outline:'none', boxSizing:'border-box' }}/>
            </div>
            <div>
              <div style={{ color:T.muted, fontSize:10, marginBottom:3 }}>
                펀딩비 /8h (%) <span style={{ color:T.acl }}>기본: {(defaultFunding.rate*100).toFixed(4)}%</span>
              </div>
              <input type="number" step="0.001" value={fundingRate} onChange={e => setFundingRate(e.target.value)}
                placeholder="0.01" style={{ width:'100%', background:T.bg, border:`1px solid ${T.border}`, borderRadius:8, padding:'8px 12px', color:T.txt, fontSize:12, outline:'none', boxSizing:'border-box' }}/>
            </div>
          </div>
        )}

        {/* 24h volume */}
        <div style={{ marginTop:8 }}>
          <div style={{ color:T.muted, fontSize:10, marginBottom:3 }}>24h 거래량 (KRW/USD — 슬리피지 계산용)</div>
          <select value={volume24h} onChange={e => setVolume24h(e.target.value)}
            style={{ width:'100%', background:T.bg, border:`1px solid ${T.border}`, borderRadius:8, padding:'8px 12px', color:T.txt, fontSize:11, outline:'none' }}>
            <option value="5000000000000">BTC급 (5조+)</option>
            <option value="1000000000">대형 (10억+)</option>
            <option value="100000000">중형 (1억+)</option>
            <option value="10000000">소형 (천만+)</option>
            <option value="1000000">마이크로 (백만+)</option>
          </select>
        </div>
      </Card>

      {/* Fee config */}
      <FeeConfigPanel config={feeConfig} onChange={c => setFeeConfig({...c, marketType: isFutures?'futures':'spot'})}/>

      {/* P&L result */}
      {entryPrice && exitPrice && quantity && (
        <div style={{ marginTop:10 }}>
          <PnLCard
            entryPrice={parseFloat(entryPrice)||0}
            exitPrice={parseFloat(exitPrice)||0}
            quantity={parseFloat(quantity)||0}
            leverage={parseFloat(leverage)||1}
            isLong={side==='long'}
            feeConfig={feeConfig}
            dailyVolume={parseFloat(volume24h)||1e9}
            holdingHours={parseFloat(holdingHrs)||24}
            fundingRate={parseFloat(fundingRate||'0.01')/100}
            isFutures={isFutures}
            currency={currency}
          />
        </div>
      )}

      {/* Minimum viable analysis */}
      {minViable && (
        <Card style={{ marginTop:10 }}>
          <div style={{ color:T.txt, fontWeight:700, fontSize:12, marginBottom:10 }}>🎯 최소 수익 달성 조건</div>
          <Row label="최소 필요 이동폭 (수수료+슬리피지+0.5% 수익)" value={`${(minViable.minMove*100).toFixed(3)}%`} color={T.ylw} bold/>
          <Row label="∟ 수수료 (왕복)" value={`${(minViable.feesPct*100).toFixed(3)}%`} color={T.red} sub/>
          <Row label="∟ 슬리피지 (예상)" value={`${(minViable.slippagePct*100).toFixed(3)}%`} color={T.ylw} sub/>
          {isFutures && <Row label="∟ 펀딩비 (예상)" value={`${(Math.abs(minViable.fundingPct)*100).toFixed(3)}%`} color={T.prp} sub/>}
          <Row label="∟ 목표 순수익" value="0.500%" color={T.grn} sub/>
          <div style={{ marginTop:8, background:T.acl+'0A', border:`1px solid ${T.acl}20`, borderRadius:8, padding:'7px 10px', color:T.acl, fontSize:10 }}>
            💡 자동매매: 예상 순수익이 이 조건 미달 시 진입 자동 차단
          </div>
        </Card>
      )}

      {/* Fee comparison table */}
      <Card style={{ marginTop:10 }}>
        <div style={{ color:T.txt, fontWeight:700, fontSize:12, marginBottom:8 }}>📊 거래소별 수수료 비교</div>
        <div style={{ overflowX:'auto' }}>
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:10, color:T.sub }}>
            <thead>
              <tr style={{ borderBottom:`1px solid ${T.border2}` }}>
                <th style={{ textAlign:'left', padding:'4px 6px', color:T.muted }}>거래소</th>
                <th style={{ textAlign:'right', padding:'4px 6px', color:T.muted }}>현물 Maker</th>
                <th style={{ textAlign:'right', padding:'4px 6px', color:T.muted }}>현물 Taker</th>
                <th style={{ textAlign:'right', padding:'4px 6px', color:T.muted }}>선물 Maker</th>
                <th style={{ textAlign:'right', padding:'4px 6px', color:T.muted }}>선물 Taker</th>
              </tr>
            </thead>
            <tbody>
              {EXCHANGES.map(ex => {
                const sp = DEFAULT_FEES[ex]?.spot?.[0];
                const ft = DEFAULT_FEES[ex]?.futures?.[0];
                return (
                  <tr key={ex} style={{ borderBottom:`1px solid ${T.border}` }}>
                    <td style={{ padding:'5px 6px', color:T.txt, fontWeight: exchange===ex ? 700 : 400 }}>{EXCHANGE_NAMES[ex]}</td>
                    <td style={{ textAlign:'right', padding:'5px 6px', color:T.grn }}>{sp ? fmtFeeRate(sp.maker) : '-'}</td>
                    <td style={{ textAlign:'right', padding:'5px 6px', color:T.ylw }}>{sp ? fmtFeeRate(sp.taker) : '-'}</td>
                    <td style={{ textAlign:'right', padding:'5px 6px', color:T.grn }}>{ft ? fmtFeeRate(ft.maker) : '-'}</td>
                    <td style={{ textAlign:'right', padding:'5px 6px', color:T.ylw }}>{ft ? fmtFeeRate(ft.taker) : '-'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
