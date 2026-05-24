'use client';
import React, { useState, useMemo } from 'react';
// ── Import from the TIERED fee lib (has .spot/.futures arrays) ──
import {
  DEFAULT_FEES,
  getDefaultConfig,
  fmtFeeRate,
  type ExchangeId,
  type UserFeeConfig,
} from '@/lib/fees/index';
import { getDefaultFundingRate } from '@/lib/funding';
import { calcTradePnL, calcMinViableProfit } from '@/lib/pnl';
import type { TradePnLResult } from '@/lib/pnl';

// Re-export for external consumers
export { calcTradePnL, calcMinViableProfit } from '@/lib/pnl';
export { applyBacktestCosts } from '@/lib/pnl';

/* ─── safe helpers ─────────────────────────────────────── */
function safeNum(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function safeParseFloat(s: string, fallback = 0): number {
  return safeNum(parseFloat(s), fallback);
}

/* ─── Design tokens ─────────────────────────────────────── */
const T = {
  bg:'#060B14', card:'#0A1628', surf:'#0D1F3C', alt:'#0F2040',
  border:'#1A2D4A', border2:'#243A5E', txt:'#E2E8F0', sub:'#94A3B8',
  muted:'#475569', grn:'#10B981', red:'#EF4444', ylw:'#F59E0B',
  acl:'#60A5FA', acc:'#2563EB', acg:'#1E3A5F', prp:'#7C3AED',
} as const;

const EXCHANGES: ExchangeId[] = ['binance','bybit','okx','gate','upbit','bithumb'];
const EX_NAME: Record<ExchangeId,string> = {
  binance:'바이낸스', bybit:'바이비트', okx:'OKX', gate:'Gate.io', upbit:'업비트', bithumb:'빗썸',
};

/* ─── Sub-components ─────────────────────────────────────── */
function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ background:T.card, border:`1px solid ${T.border}`, borderRadius:14, padding:'14px 16px', ...style }}>
      {children}
    </div>
  );
}

function Row({ label, value, color, bold, sub }: { label:string; value:string; color?:string; bold?:boolean; sub?:boolean }) {
  return (
    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'5px 0', borderBottom:`1px solid ${T.border}` }}>
      <span style={{ color: sub ? T.muted : T.sub, fontSize: sub ? 10 : 11 }}>{label}</span>
      <span style={{ color: color || T.txt, fontWeight: bold ? 800 : 500, fontSize: sub ? 10 : 12, fontFamily:'monospace' }}>{value}</span>
    </div>
  );
}

/* ─── FeeConfigPanel ─────────────────────────────────────── */
export function FeeConfigPanel({ config, onChange }: { config: UserFeeConfig; onChange: (c: UserFeeConfig) => void }) {
  // Safe access: DEFAULT_FEES[exchange] might be undefined
  const exFees = DEFAULT_FEES[config.exchange];
  const tiers  = Array.isArray(exFees?.[config.marketType === 'spot' ? 'spot' : 'futures'])
    ? exFees![config.marketType === 'spot' ? 'spot' : 'futures']
    : [];
  const tierIdx    = Math.min(Math.max(0, config.vipTier), Math.max(0, tiers.length - 1));
  const currentTier = tiers[tierIdx];

  return (
    <Card>
      <div style={{ color:T.txt, fontWeight:700, fontSize:13, marginBottom:10 }}>⚙️ 수수료 설정</div>

      {/* Exchange */}
      <div style={{ marginBottom:10 }}>
        <div style={{ color:T.muted, fontSize:10, marginBottom:5 }}>거래소</div>
        <div style={{ display:'flex', gap:4, flexWrap:'wrap' }}>
          {EXCHANGES.map(ex => (
            <button key={ex} type="button"
              onClick={() => onChange({ ...getDefaultConfig(ex, config.marketType as any), referralDiscount: config.referralDiscount, bnbDiscount: config.bnbDiscount })}
              style={{ padding:'4px 10px', background: config.exchange===ex ? T.acg : T.alt,
                border:`1px solid ${config.exchange===ex ? T.acl : T.border}`,
                borderRadius:8, color: config.exchange===ex ? T.acl : T.muted, fontSize:10, cursor:'pointer' }}>
              {EX_NAME[ex]}
            </button>
          ))}
        </div>
      </div>

      {/* Market type */}
      <div style={{ marginBottom:10 }}>
        <div style={{ color:T.muted, fontSize:10, marginBottom:5 }}>시장 유형</div>
        <div style={{ display:'flex', gap:4 }}>
          {(['spot','futures'] as const).map(mt => (
            <button key={mt} type="button"
              onClick={() => onChange({ ...config, marketType: mt, vipTier: 0 })}
              style={{ padding:'4px 12px', background: config.marketType===mt ? T.acg : T.alt,
                border:`1px solid ${config.marketType===mt ? T.acl : T.border}`,
                borderRadius:8, color: config.marketType===mt ? T.acl : T.muted, fontSize:10, cursor:'pointer' }}>
              {mt === 'spot' ? '현물' : '선물'}
            </button>
          ))}
        </div>
      </div>

      {/* VIP tier */}
      {tiers.length > 0 && (
        <div style={{ marginBottom:10 }}>
          <div style={{ color:T.muted, fontSize:10, marginBottom:5 }}>
            VIP 등급
            {currentTier && ` — ${currentTier.label} · Maker ${fmtFeeRate(currentTier.maker)} / Taker ${fmtFeeRate(currentTier.taker)}`}
          </div>
          <div style={{ display:'flex', gap:4, overflowX:'auto', paddingBottom:2 }}>
            {tiers.map((tier, i) => (
              <button key={i} type="button"
                onClick={() => onChange({ ...config, vipTier: i, customMaker: undefined, customTaker: undefined })}
                style={{ flexShrink:0, padding:'4px 10px',
                  background: config.vipTier===i ? T.acg : T.alt,
                  border:`1px solid ${config.vipTier===i ? T.acl : T.border}`,
                  borderRadius:8, color: config.vipTier===i ? T.acl : T.muted, fontSize:9, cursor:'pointer' }}>
                {tier.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Custom override */}
      <div className="mobile-1col" style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginBottom:10 }}>
        {([['Maker %', 'customMaker'], ['Taker %', 'customTaker']] as const).map(([label, key]) => (
          <div key={key}>
            <div style={{ color:T.muted, fontSize:9, marginBottom:3 }}>{label} 직접 입력 (%)</div>
            <input type="number" step="0.001" min="0" max="1"
              value={config[key] !== undefined ? +((config[key]! * 100)).toFixed(4) : ''}
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

      {/* Referral + BNB discount */}
      <div className="mobile-1col" style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
        <div>
          <div style={{ color:T.muted, fontSize:9, marginBottom:3 }}>레퍼럴 할인 (%)</div>
          <input type="number" step="1" min="0" max="50"
            value={Math.round((config.referralDiscount || 0) * 100)}
            onChange={e => onChange({ ...config, referralDiscount: safeParseFloat(e.target.value) / 100 })}
            style={{ width:'100%', background:T.bg, border:`1px solid ${T.border}`, borderRadius:8,
              padding:'6px 10px', color:T.txt, fontSize:11, outline:'none', boxSizing:'border-box' }}
          />
        </div>
        {config.exchange === 'binance' && (
          <div style={{ display:'flex', alignItems:'center', gap:8, paddingTop:14 }}>
            <div onClick={() => onChange({ ...config, bnbDiscount: !config.bnbDiscount })}
              style={{ width:36, height:20, borderRadius:10, cursor:'pointer', position:'relative',
                background: config.bnbDiscount ? '#F0B90B' : T.alt,
                border:`1px solid ${config.bnbDiscount ? '#F0B90B' : T.border}` }}>
              <div style={{ position:'absolute', top:2, left: config.bnbDiscount ? 18 : 2,
                width:14, height:14, borderRadius:'50%', background:'#fff', transition:'left .2s' }}/>
            </div>
            <span style={{ color: config.bnbDiscount ? '#F0B90B' : T.muted, fontSize:10 }}>BNB -25%</span>
          </div>
        )}
      </div>
    </Card>
  );
}

/* ─── PnLCard ─────────────────────────────────────── */
export function PnLCard({
  entryPrice, exitPrice, quantity, leverage = 1,
  isLong = true, feeConfig, dailyVolume = 1e9,
  holdingHours = 24, fundingRate = 0.0001,
  isFutures = false, currency = 'KRW',
}: {
  entryPrice: number; exitPrice: number; quantity: number;
  leverage?: number; isLong?: boolean; feeConfig: UserFeeConfig;
  dailyVolume?: number; holdingHours?: number; fundingRate?: number;
  isFutures?: boolean; currency?: string;
}) {
  const result = useMemo<TradePnLResult | null>(() => {
    if (!entryPrice || !exitPrice || !quantity) return null;
    try {
      return calcTradePnL({
        entryPrice:   safeNum(entryPrice),
        exitPrice:    safeNum(exitPrice),
        quantity:     safeNum(quantity),
        leverage:     safeNum(leverage, 1),
        isLong,
        feeConfig,
        dailyVolume:  safeNum(dailyVolume, 1e9),
        holdingHours: safeNum(holdingHours, 24),
        fundingRate:  safeNum(fundingRate, 0.0001),
        isFutures,
      });
    } catch (e) {
      console.error('calcTradePnL error:', e);
      return null;
    }
  }, [entryPrice, exitPrice, quantity, leverage, isLong, feeConfig, dailyVolume, holdingHours, fundingRate, isFutures]);

  const sym = currency === 'USD' ? '$' : '₩';
  const fmt = (v: number) => {
    if (!Number.isFinite(v)) return sym + '0';
    const abs = Math.abs(v);
    const s = abs >= 1e8 ? sym+(abs/1e8).toFixed(1)+'억'
            : abs >= 1e4 ? sym+Math.round(abs).toLocaleString()
            : sym+abs.toFixed(2);
    return v < 0 ? '-'+s : v > 0 ? '+'+s : s;
  };
  const fmtP = (v: number) => {
    if (!Number.isFinite(v)) return '0.000%';
    return (v >= 0 ? '+' : '') + (v * 100).toFixed(3) + '%';
  };

  if (!result) return (
    <Card>
      <div style={{ color:T.muted, fontSize:12, textAlign:'center', padding:'12px 0' }}>
        진입가, 목표가, 수량을 입력하면 계산 결과가 표시됩니다
      </div>
    </Card>
  );

  const warnings = Array.isArray(result.warnings) ? result.warnings : [];

  return (
    <Card>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
        <div style={{ color:T.txt, fontWeight:700, fontSize:13 }}>💰 예상 순수익 계산</div>
        <div style={{ background: result.isViable ? T.grn+'20' : T.red+'20',
          border:`1px solid ${result.isViable ? T.grn : T.red}40`,
          borderRadius:8, padding:'3px 10px',
          color: result.isViable ? T.grn : T.red, fontSize:10, fontWeight:700 }}>
          {result.isViable ? '✅ 수익 가능' : '❌ 손실 예상'}
        </div>
      </div>

      <div style={{ marginBottom:12 }}>
        <Row label="📈 총수익 (가격 변동)" value={fmt(result.grossPnL)} color={result.grossPnL>=0?T.grn:T.red}/>
        <Row label="  ∟ 진입 수수료" value={`-${fmt(result.entryFee)}`} color={T.red} sub/>
        <Row label="  ∟ 청산 수수료" value={`-${fmt(result.exitFee)}`} color={T.red} sub/>
        <Row label="  ∟ 진입 슬리피지" value={`-${fmt(result.entrySlippage)}`} color={T.ylw} sub/>
        <Row label="  ∟ 청산 슬리피지" value={`-${fmt(result.exitSlippage)}`} color={T.ylw} sub/>
        {(result.fundingPayments ?? 0) > 0 && (
          <Row label={`  ∟ 펀딩비 (${result.fundingPayments}회)`}
            value={`${(result.fundingCost??0)>=0?'-':'+'} ${fmt(Math.abs(result.fundingCost??0))}`}
            color={(result.fundingCost??0)>0?T.red:T.grn} sub/>
        )}
        <div style={{ borderTop:`2px solid ${T.border2}`, marginTop:4, paddingTop:6 }}>
          <Row label="= 최종 순수익" value={fmt(result.netPnL)} color={result.netPnL>=0?T.grn:T.red} bold/>
          <Row label="  손익률 (원금 대비)" value={fmtP(result.netPnLPct)} color={result.netPnLPct>=0?T.grn:T.red}/>
          {(result.marginUsed??0) > 0 && (result.leverage??1) > 1 && (
            <Row label={`  레버리지 수익률 (${result.leverage}x)`}
              value={fmtP(result.netPnLLevered??0)} color={(result.netPnLLevered??0)>=0?T.grn:T.red}/>
          )}
        </div>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:6, marginBottom:10 }}>
        {[
          { label:'총 수수료',  value: fmt(result.totalFees??0),    color:T.red  },
          { label:'총 슬리피지',value: fmt(result.totalSlippage??0), color:T.ylw  },
          { label:'펀딩비',     value: fmt(result.fundingCost??0),   color:(result.fundingCost??0)<=0?T.grn:T.red },
        ].map(m => (
          <div key={m.label} style={{ background:T.alt, border:`1px solid ${T.border}`, borderRadius:8, padding:'7px 8px', textAlign:'center' }}>
            <div style={{ color:T.muted, fontSize:8, marginBottom:2 }}>{m.label}</div>
            <div style={{ color:m.color, fontSize:11, fontWeight:700, fontFamily:'monospace' }}>{m.value}</div>
          </div>
        ))}
      </div>

      <div style={{ background:T.alt, border:`1px solid ${T.border}`, borderRadius:8, padding:'8px 10px', marginBottom:8 }}>
        <div style={{ color:T.muted, fontSize:9, marginBottom:3 }}>손익분기점 이동폭</div>
        <div style={{ color:T.ylw, fontSize:12, fontWeight:700 }}>
          {Number.isFinite(result.breakEvenMove) ? ((result.breakEvenMove??0)*100).toFixed(3) : '0.000'}% 이상 이동해야 수익
        </div>
      </div>

      {warnings.map((w, i) => (
        <div key={i} style={{ background:'#F59E0B0A', border:`1px solid ${T.ylw}30`,
          borderRadius:8, padding:'6px 10px', marginBottom:4, color:T.ylw, fontSize:10 }}>
          {w}
        </div>
      ))}
    </Card>
  );
}

/* ─── Main PnLCalculatorPage ─────────────────────────────── */
export interface PnLPrefill {
  assetName?: string;
  assetType?: 'crypto'|'kr_stock'|'us_stock'|'etf'|'commodity';
  symbol?: string;
  currentPrice?: number;
  side?: 'long'|'short';
  isFutures?: boolean;
  fxRate?: number;
}

export default function PnLCalculatorPage({
  currency = 'KRW',
  prefill,
}: {
  currency?: string;
  prefill?: PnLPrefill | null;
}) {
  // Use prefilled values when provided
  const initEntry  = prefill?.currentPrice ? String(prefill.currentPrice) : '';
  const initSide   = prefill?.side === 'short' ? 'short' : 'long';
  const initFut    = prefill?.isFutures ?? false;
  const [feeConfig, setFeeConfig] = useState<UserFeeConfig>(() => getDefaultConfig('binance', 'futures'));
  const [entryPrice,   setEntryPrice]   = useState(initEntry);
  const [exitPrice,    setExitPrice]    = useState('');
  const [quantity,     setQuantity]     = useState('');
  const [leverage,     setLeverage]     = useState('1');
  const [side,         setSide]         = useState<'long'|'short'>(initSide as 'long'|'short');
  const [isFutures,    setIsFutures]    = useState(initFut);
  const [holdingHrs,   setHoldingHrs]   = useState('24');
  const [fundingRate,  setFundingRate]  = useState('0.01');
  const [volume24h,    setVolume24h]    = useState('1000000000');

  const minViable = useMemo(() => {
    if (!entryPrice) return null;
    try {
      return calcMinViableProfit(
        safeParseFloat(entryPrice) * (safeParseFloat(quantity) || 1),
        feeConfig,
        safeParseFloat(fundingRate, 0.01) / 100,
        safeParseFloat(holdingHrs, 24),
        safeParseFloat(volume24h, 1e9),
        0.005,
      );
    } catch { return null; }
  }, [entryPrice, quantity, feeConfig, fundingRate, holdingHrs, volume24h]);

  // Safe access to DEFAULT_FEES for comparison table
  const safeFees = DEFAULT_FEES || {};

  const defaultFunding = (() => {
    try { return getDefaultFundingRate('BTC'); } catch { return { rate: 0.0001 }; }
  })();

  return (
    <div style={{ color:T.txt }}>
      {/* Header */}
      <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:14 }}>
        <div style={{ width:32, height:32, borderRadius:10,
          background:'linear-gradient(135deg,#2563EB,#10B981)',
          display:'flex', alignItems:'center', justifyContent:'center', fontSize:16 }}>💹</div>
        <div>
          <div style={{ fontWeight:900, fontSize:15 }}>실제 수익 계산기</div>
          <div style={{ color:T.muted, fontSize:10 }}>수수료 · 슬리피지 · 펀딩비 통합 계산</div>
        </div>
      </div>
      {/* Prefill banner */}
      {prefill && (prefill.assetName || prefill.symbol) && (
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between',
          background: T.acg, border:`1px solid ${T.acl}40`, borderRadius:12,
          padding:'10px 14px', marginBottom:10 }}>
          <div>
            <div style={{ color:T.acl, fontSize:11, fontWeight:700, marginBottom:2 }}>
              📊 {prefill.assetName || prefill.symbol}에서 가져옴
            </div>
            <div style={{ color:T.muted, fontSize:10 }}>
              {prefill.assetType === 'crypto'   ? '코인' :
               prefill.assetType === 'us_stock' ? '미국주식' :
               prefill.assetType === 'kr_stock' ? '국내주식' :
               prefill.assetType === 'etf'      ? 'ETF' : '자산'}
              {prefill.currentPrice ? ` · 현재가 ${Math.round(prefill.currentPrice).toLocaleString('ko-KR')}` : ''}
            </div>
          </div>
          <div style={{ background: T.grn+'20', color:T.grn, fontSize:9, fontWeight:700,
            padding:'3px 8px', borderRadius:6 }}>자동 입력됨</div>
        </div>
      )}
      <div style={{ color:T.ylw, fontSize:10, marginBottom:12, padding:'6px 10px',
        background:'#F59E0B0A', border:`1px solid ${T.ylw}20`, borderRadius:8 }}>
        ⚠️ 참고용 계산입니다. 실제 거래 전 세무/재무 전문가 확인을 권장합니다.
      </div>

      {/* Trade inputs */}
      <Card style={{ marginBottom:10 }}>
        <div style={{ color:T.txt, fontWeight:700, fontSize:13, marginBottom:10 }}>📊 거래 정보</div>

        {/* Long / Short */}
        <div style={{ display:'flex', gap:6, marginBottom:10 }}>
          {(['long','short'] as const).map(s => (
            <button key={s} type="button" onClick={() => setSide(s)}
              style={{ flex:1, padding:'8px',
                background: side===s ? (s==='long'?T.grn+'20':T.red+'20') : T.alt,
                border:`1px solid ${side===s ? (s==='long'?T.grn:T.red)+'60' : T.border}`,
                borderRadius:10, color: side===s ? (s==='long'?T.grn:T.red) : T.muted,
                fontWeight:700, fontSize:12, cursor:'pointer' }}>
              {s === 'long' ? '📈 롱 (매수)' : '📉 숏 (매도)'}
            </button>
          ))}
        </div>

        {/* Spot / Futures */}
        <div style={{ display:'flex', gap:6, marginBottom:10 }}>
          {[false, true].map(f => (
            <button key={String(f)} type="button" onClick={() => setIsFutures(f)}
              style={{ flex:1, padding:'6px',
                background: isFutures===f ? T.acg : T.alt,
                border:`1px solid ${isFutures===f ? T.acl : T.border}`,
                borderRadius:8, color: isFutures===f ? T.acl : T.muted, fontSize:11, cursor:'pointer' }}>
              {f ? '⚡ 선물' : '💱 현물'}
            </button>
          ))}
        </div>

        <div className="mobile-1col" style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
          {[
            ['진입가',     entryPrice, setEntryPrice, '0.00'  ] as const,
            ['목표/청산가', exitPrice,  setExitPrice,  '0.00'  ] as const,
            ['수량',       quantity,   setQuantity,   '예: 0.01'] as const,
            (isFutures ? ['레버리지 (x)', leverage, setLeverage, '1'] : ['보유시간 (h)', holdingHrs, setHoldingHrs, '24']) as const,
          ].map(([label, val, setter, ph]) => (
            <div key={label}>
              <div style={{ color:T.muted, fontSize:10, marginBottom:3 }}>{label}</div>
              <input type="number" value={val}
                onChange={e => setter(e.target.value)}
                placeholder={ph}
                style={{ width:'100%', background:T.bg, border:`1px solid ${T.border}`, borderRadius:8,
                  padding:'8px 12px', color:T.txt, fontSize:12, outline:'none', boxSizing:'border-box' }}
              />
            </div>
          ))}
        </div>

        {isFutures && (
          <div className="mobile-1col" style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginTop:8 }}>
            <div>
              <div style={{ color:T.muted, fontSize:10, marginBottom:3 }}>보유시간 (시간)</div>
              <input type="number" value={holdingHrs} onChange={e => setHoldingHrs(e.target.value)}
                placeholder="24"
                style={{ width:'100%', background:T.bg, border:`1px solid ${T.border}`, borderRadius:8,
                  padding:'8px 12px', color:T.txt, fontSize:12, outline:'none', boxSizing:'border-box' }}/>
            </div>
            <div>
              <div style={{ color:T.muted, fontSize:10, marginBottom:3 }}>
                펀딩비 /8h (%)&nbsp;
                <span style={{ color:T.acl }}>
                  기본: {Number.isFinite(defaultFunding.rate) ? (defaultFunding.rate * 100).toFixed(4) : '0.0100'}%
                </span>
              </div>
              <input type="number" step="0.001" value={fundingRate}
                onChange={e => setFundingRate(e.target.value)}
                placeholder="0.01"
                style={{ width:'100%', background:T.bg, border:`1px solid ${T.border}`, borderRadius:8,
                  padding:'8px 12px', color:T.txt, fontSize:12, outline:'none', boxSizing:'border-box' }}/>
            </div>
          </div>
        )}

        <div style={{ marginTop:8 }}>
          <div style={{ color:T.muted, fontSize:10, marginBottom:3 }}>24h 거래량 (슬리피지 계산용)</div>
          <select value={volume24h} onChange={e => setVolume24h(e.target.value)}
            style={{ width:'100%', background:T.bg, border:`1px solid ${T.border}`,
              borderRadius:8, padding:'8px 12px', color:T.txt, fontSize:11, outline:'none' }}>
            <option value="5000000000000">BTC급 (5조+)</option>
            <option value="1000000000">대형 (10억+)</option>
            <option value="100000000">중형 (1억+)</option>
            <option value="10000000">소형 (천만+)</option>
            <option value="1000000">마이크로 (백만+)</option>
          </select>
        </div>
      </Card>

      {/* Fee config */}
      <FeeConfigPanel
        config={feeConfig}
        onChange={c => setFeeConfig({ ...c, marketType: isFutures ? 'futures' : 'spot' })}
      />

      {/* Result */}
      {entryPrice && exitPrice && quantity && (
        <div style={{ marginTop:10 }}>
          <PnLCard
            entryPrice={safeParseFloat(entryPrice)}
            exitPrice={safeParseFloat(exitPrice)}
            quantity={safeParseFloat(quantity)}
            leverage={safeParseFloat(leverage, 1)}
            isLong={side === 'long'}
            feeConfig={feeConfig}
            dailyVolume={safeParseFloat(volume24h, 1e9)}
            holdingHours={safeParseFloat(holdingHrs, 24)}
            fundingRate={safeParseFloat(fundingRate, 0.01) / 100}
            isFutures={isFutures}
            currency={currency}
          />
        </div>
      )}

      {/* Min viable */}
      {minViable && (
        <Card style={{ marginTop:10 }}>
          <div style={{ color:T.txt, fontWeight:700, fontSize:12, marginBottom:10 }}>🎯 최소 수익 달성 조건</div>
          <Row label="최소 이동폭 (수수료+슬리피지+0.5% 목표)"
            value={`${Number.isFinite(minViable.minMove) ? (minViable.minMove*100).toFixed(3) : '0.000'}%`}
            color={T.ylw} bold/>
          <Row label="∟ 수수료 (왕복)"
            value={`${Number.isFinite(minViable.feesPct) ? (minViable.feesPct*100).toFixed(3) : '0.000'}%`}
            color={T.red} sub/>
          <Row label="∟ 슬리피지 (예상)"
            value={`${Number.isFinite(minViable.slippagePct) ? (minViable.slippagePct*100).toFixed(3) : '0.000'}%`}
            color={T.ylw} sub/>
          {isFutures && (
            <Row label="∟ 펀딩비 (예상)"
              value={`${Number.isFinite(minViable.fundingPct) ? (Math.abs(minViable.fundingPct)*100).toFixed(3) : '0.000'}%`}
              color={T.prp} sub/>
          )}
        </Card>
      )}

      {/* Fee comparison table */}
      <Card style={{ marginTop:10 }}>
        <div style={{ color:T.txt, fontWeight:700, fontSize:12, marginBottom:8 }}>📊 거래소별 수수료 비교</div>
        <div style={{ overflowX:'auto' }}>
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:10, color:T.sub }}>
            <thead>
              <tr style={{ borderBottom:`1px solid ${T.border2}` }}>
                {['거래소','현물 Maker','현물 Taker','선물 Maker','선물 Taker'].map(h => (
                  <th key={h} style={{ textAlign: h==='거래소' ? 'left' : 'right',
                    padding:'4px 6px', color:T.muted }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {EXCHANGES.map(ex => {
                const exData = safeFees[ex];
                const spotTiers   = Array.isArray(exData?.spot)    ? exData!.spot    : [];
                const futTiers    = Array.isArray(exData?.futures)  ? exData!.futures : [];
                const sp = spotTiers[0];
                const ft = futTiers[0];
                return (
                  <tr key={ex} style={{ borderBottom:`1px solid ${T.border}` }}>
                    <td style={{ padding:'5px 6px', color:T.txt,
                      fontWeight: feeConfig.exchange===ex ? 700 : 400 }}>{EX_NAME[ex]}</td>
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
