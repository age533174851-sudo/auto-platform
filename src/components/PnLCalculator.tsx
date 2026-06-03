'use client';
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { safeNumber, formatKRW, safePercent } from '@/lib/format';

// Re-exports for backward compatibility
export { calcTradePnL, calcMinViableProfit, applyBacktestCosts } from '@/lib/pnl';

/* ─── Types ───────────────────────────────────────────────── */
export type AssetCategory = 'crypto' | 'us_stock' | 'kr_stock' | 'futures' | 'etf';
export type Side = 'long' | 'short';
export type TaxMode = 'kr_stock' | 'us_stock' | 'crypto' | 'futures' | 'custom';

export interface PnLPrefill {
  assetName?:    string;
  assetType?:    AssetCategory | 'commodity';
  symbol?:       string;
  currentPrice?: number;
  side?:         Side;
  isFutures?:    boolean;
  fxRate?:       number;
}

interface CalcRecord {
  id:        string;
  ts:        number;
  symbol:    string;
  assetType: AssetCategory;
  side:      Side;
  buyPrice:  number;
  sellPrice: number;
  quantity:  number;
  netProfit: number;
  roi:       number;
}

/* ─── Constants ───────────────────────────────────────────── */
const STORE_KEY = 'tg_pnl_history_v1';

const T = {
  bg:'#060B14', card:'#0A1628', alt:'#0F2040',
  border:'#1A2D4A', txt:'#E2E8F0', sub:'#94A3B8', muted:'#475569',
  grn:'#10B981', red:'#EF4444', ylw:'#F59E0B',
  acl:'#60A5FA', acg:'rgba(37,99,235,.15)', prp:'#7C3AED',
};

const ASSET_OPTIONS: { id: AssetCategory; label: string; icon: string; fee: number; tax: number }[] = [
  { id:'crypto',   label:'코인',     icon:'🪙', fee: 0.1,   tax: 0    },
  { id:'us_stock', label:'미국주식', icon:'🇺🇸', fee: 0.07,  tax: 22   },
  { id:'kr_stock', label:'국내주식', icon:'🇰🇷', fee: 0.015, tax: 0.23 },
  { id:'etf',      label:'ETF',      icon:'📊', fee: 0.07,  tax: 15.4 },
  { id:'futures',  label:'선물',     icon:'⚡', fee: 0.05,  tax: 20   },
];

const TAX_MODE_INFO: Record<TaxMode, { label: string; rate: number; note: string }> = {
  crypto:   { label: '코인 (2025년 기준)',  rate: 0,    note: '국내 가상자산 과세는 250만원 공제 후 20% — 시행 시점 변경 가능' },
  us_stock: { label: '미국주식 양도세',      rate: 22,   note: '250만원 공제 후 양도소득세 22% (지방세 포함)' },
  kr_stock: { label: '국내주식 거래세',      rate: 0.23, note: '코스피 0.23%, 코스닥 0.23% (매도 시)' },
  futures:  { label: '선물·옵션 양도세',     rate: 20,   note: '연 250만원 공제 후 양도소득세 20%' },
  custom:   { label: '직접 입력',           rate: 0,    note: '사용자 정의' },
};

const EXAMPLES: Record<AssetCategory, {
  symbol: string; buy: number; sell: number; qty: number; fee: number; tax: number; lev: number; side: Side;
}> = {
  crypto:   { symbol:'BTC',    buy:94_000_000, sell:98_000_000, qty:0.05,  fee:0.1,   tax:0,    lev:1, side:'long' },
  us_stock: { symbol:'NVDA',   buy:875,        sell:920,        qty:10,    fee:0.07,  tax:22,   lev:1, side:'long' },
  kr_stock: { symbol:'005930', buy:75_000,     sell:82_000,     qty:100,   fee:0.015, tax:0.23, lev:1, side:'long' },
  etf:      { symbol:'SOXL',   buy:42,         sell:48,         qty:50,    fee:0.07,  tax:15.4, lev:1, side:'long' },
  futures:  { symbol:'BTCUSDT',buy:94_000,     sell:98_000,     qty:0.1,   fee:0.05,  tax:20,   lev:10, side:'long' },
};

/* ─── Helpers ─────────────────────────────────────────────── */
function toNum(v: unknown): number {
  const cleaned = String(v ?? '').replace(/,/g, '').trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function formatPrice(v: unknown, currency = 'KRW'): string {
  const n = safeNumber(v, 0);
  if (currency === 'KRW') return formatKRW(n);
  if (n === 0) return '$0';
  if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (Math.abs(n) >= 1)   return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return '$' + n.toFixed(6);
}

function formatPL(v: unknown, currency = 'KRW'): string {
  const n = safeNumber(v, 0);
  const sign = n > 0 ? '+' : n < 0 ? '-' : '';
  return sign + formatPrice(Math.abs(n), currency).replace(/^-/, '');
}

/* ─── Sub UI components ──────────────────────────────────── */
function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ background:T.card, border:`1px solid ${T.border}`,
      borderRadius:14, padding:'14px 16px', marginBottom:10, ...style }}>
      {children}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ color: T.muted, fontSize: 11, marginBottom: 4, display:'flex', justifyContent:'space-between' }}>
        <span>{label}</span>
        {hint && <span style={{ color: T.acl, fontSize: 10 }}>{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function NumInput({
  value, onChange, placeholder, suffix, disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  suffix?: string;
  disabled?: boolean;
}) {
  return (
    <div style={{ position:'relative' }}>
      <input
        type="text"
        inputMode="decimal"
        value={value}
        disabled={disabled}
        onChange={(e) => {
          // Allow digits, dot, comma, minus
          const v = e.target.value.replace(/[^\d.,-]/g, '');
          onChange(v);
        }}
        placeholder={placeholder}
        style={{
          width:'100%', boxSizing:'border-box',
          background: disabled ? T.alt : T.bg,
          border: `1px solid ${T.border}`,
          borderRadius: 10, padding: '11px 14px',
          paddingRight: suffix ? 40 : 14,
          color: T.txt, fontSize: 14, outline:'none',
          fontFamily: 'monospace',
        }}
      />
      {suffix && (
        <span style={{ position:'absolute', right: 12, top: '50%',
          transform:'translateY(-50%)', color: T.muted, fontSize: 11 }}>
          {suffix}
        </span>
      )}
    </div>
  );
}

/* ─── Main component ─────────────────────────────────────── */
export default function PnLCalculatorPage({
  currency = 'KRW',
  prefill,
  onSaveToJournal,
}: {
  currency?: string;
  prefill?: PnLPrefill | null;
  onSaveToJournal?: (record: CalcRecord) => void;
}) {
  /* ── State ────────────────────────────────────────────── */
  const [assetType, setAssetType] = useState<AssetCategory>(() => {
    const t = prefill?.assetType;
    if (t === 'us_stock' || t === 'kr_stock' || t === 'crypto' || t === 'etf' || t === 'futures') return t;
    return 'crypto';
  });
  const [symbol,    setSymbol]    = useState(prefill?.symbol || prefill?.assetName || '');
  const [side,      setSide]      = useState<Side>(prefill?.side === 'short' ? 'short' : 'long');
  const [buyPrice,  setBuyPrice]  = useState(prefill?.currentPrice ? String(prefill.currentPrice) : '');
  const [sellPrice, setSellPrice] = useState('');
  const [investment,setInvestment]= useState('');
  const [quantity,  setQuantity]  = useState('');
  const [leverage,  setLeverage]  = useState('1');
  const [feeRate,   setFeeRate]   = useState(String(
    ASSET_OPTIONS.find(o => o.id === (prefill?.assetType ?? 'crypto'))?.fee ?? 0.1
  ));
  const [taxMode,   setTaxMode]   = useState<TaxMode>('crypto');
  const [taxRate,   setTaxRate]   = useState(String(
    ASSET_OPTIONS.find(o => o.id === (prefill?.assetType ?? 'crypto'))?.tax ?? 0
  ));
  const [fxRate,    setFxRate]    = useState(String(prefill?.fxRate || 1375));
  const [extraCost, setExtraCost] = useState('');

  // Advanced
  const [targetROI, setTargetROI] = useState('10');
  const [stopLoss,  setStopLoss]  = useState('-3');
  const [splitBuy2, setSplitBuy2] = useState('');
  const [splitQty2, setSplitQty2] = useState('');
  const [splitBuy3, setSplitBuy3] = useState('');
  const [splitQty3, setSplitQty3] = useState('');

  // DCA
  const [dcaMonthly, setDcaMonthly] = useState('');
  const [dcaMonths,  setDcaMonths]  = useState('12');
  const [dcaYield,   setDcaYield]   = useState('10');

  // UI state
  const [computed, setComputed] = useState(false);
  const [history,  setHistory]  = useState<CalcRecord[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [toast, setToast] = useState('');

  /* ── Load history ─────────────────────────────────────── */
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      setHistory(Array.isArray(arr) ? arr : []);
    } catch { setHistory([]); }
  }, []);

  /* ── Auto-update fee/tax when asset type changes ───── */
  useEffect(() => {
    const opt = ASSET_OPTIONS.find(o => o.id === assetType);
    if (opt) {
      setFeeRate(String(opt.fee));
      setTaxRate(String(opt.tax));
      // Map asset type → tax mode
      if (assetType === 'crypto')   setTaxMode('crypto');
      if (assetType === 'us_stock') setTaxMode('us_stock');
      if (assetType === 'kr_stock') setTaxMode('kr_stock');
      if (assetType === 'futures')  setTaxMode('futures');
      if (assetType === 'etf')      setTaxMode('us_stock');
    }
  }, [assetType]);

  /* ── Toast helper ────────────────────────────────────── */
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 2500);
  }, []);

  /* ── Quick presets ──────────────────────────────────── */
  const loadExample = useCallback((cat?: AssetCategory) => {
    const ex = EXAMPLES[cat ?? assetType];
    setAssetType(cat ?? assetType);
    setSymbol(ex.symbol);
    setSide(ex.side);
    setBuyPrice(String(ex.buy));
    setSellPrice(String(ex.sell));
    setQuantity(String(ex.qty));
    setInvestment(String(ex.buy * ex.qty));
    setFeeRate(String(ex.fee));
    setTaxRate(String(ex.tax));
    setLeverage(String(ex.lev));
    showToast(`${ex.symbol} 예시 불러옴`);
  }, [assetType, showToast]);

  /* ── Reset ──────────────────────────────────────────── */
  const reset = useCallback(() => {
    setSymbol(''); setBuyPrice(''); setSellPrice('');
    setInvestment(''); setQuantity(''); setLeverage('1');
    setExtraCost(''); setComputed(false);
    setSplitBuy2(''); setSplitQty2('');
    setSplitBuy3(''); setSplitQty3('');
    setDcaMonthly('');
    showToast('초기화됨');
  }, [showToast]);

  /* ── Auto qty from investment ───────────────────────── */
  const autoFillQty = useCallback(() => {
    const inv = toNum(investment);
    const bp  = toNum(buyPrice);
    if (inv > 0 && bp > 0) {
      const q = inv / bp;
      setQuantity(q < 1 ? q.toFixed(8) : q.toFixed(4));
      showToast(`✏️ 수량 자동입력: ${q.toFixed(4)}`);
    } else {
      showToast('⚠️ 투자금과 매수가를 먼저 입력하세요');
    }
  }, [investment, buyPrice, showToast]);

  /* ── Validation ─────────────────────────────────────── */
  const validation = useMemo(() => {
    const errors: string[] = [];
    if (toNum(buyPrice)  <= 0) errors.push('매수 가격을 입력해주세요');
    if (toNum(sellPrice) <= 0) errors.push('매도 가격을 입력해주세요');
    if (toNum(quantity)  <= 0) errors.push('수량을 입력해주세요');
    if (toNum(leverage)  <= 0) errors.push('레버리지는 1 이상이어야 합니다');
    return errors;
  }, [buyPrice, sellPrice, quantity, leverage]);

  /* ── Main calculation ───────────────────────────────── */
  const result = useMemo(() => {
    const bp    = toNum(buyPrice);
    const sp    = toNum(sellPrice);
    const qty   = toNum(quantity);
    const lev   = Math.max(1, toNum(leverage));
    const fee   = toNum(feeRate) / 100;
    const tax   = toNum(taxRate) / 100;
    const extra = toNum(extraCost);

    if (!bp || !sp || !qty) return null;

    const buyAmount  = bp * qty;
    const sellAmount = sp * qty;
    const direction  = side === 'long' ? 1 : -1;
    const grossProfit = (sp - bp) * qty * lev * direction;

    const totalFee = (buyAmount + sellAmount) * fee;
    const taxableProfit = Math.max(0, grossProfit);
    let estimatedTax = taxableProfit * tax;

    // Special tax rules
    if (taxMode === 'us_stock') {
      // 250만원 공제 후 22%
      const deducted = Math.max(0, grossProfit - 2_500_000);
      estimatedTax = deducted * 0.22;
    } else if (taxMode === 'futures') {
      const deducted = Math.max(0, grossProfit - 2_500_000);
      estimatedTax = deducted * 0.20;
    } else if (taxMode === 'kr_stock') {
      // 거래세는 매도금액의 0.23%
      estimatedTax = sellAmount * 0.0023;
    } else if (taxMode === 'crypto') {
      // 시행 시 250만원 공제 후 20%
      const deducted = Math.max(0, grossProfit - 2_500_000);
      estimatedTax = deducted * 0.20;
    }

    const netProfit = grossProfit - totalFee - estimatedTax - extra;
    const margin    = buyAmount / lev;
    const roi       = margin > 0 ? (netProfit / margin) * 100 : 0;
    const leveragedProfit = grossProfit; // already includes leverage
    const grossROI  = buyAmount > 0 ? (grossProfit / buyAmount) * 100 : 0;

    // Break-even sell price (where netProfit = 0)
    // For long: (be - bp)*qty*lev - (bp*qty + be*qty)*fee - tax - extra = 0
    // Approx ignoring tax (which kicks in only on profit):
    //   be ≈ bp * (1 + fee*lev) / (lev - fee*lev) approx
    // We solve iteratively for precision
    let breakEven = bp;
    const solveBreakEven = (): number => {
      const target = 0;
      let lo = bp * 0.5, hi = bp * 2;
      for (let i = 0; i < 50; i++) {
        const mid = (lo + hi) / 2;
        const gp  = (mid - bp) * qty * lev * direction;
        const ff  = (bp * qty + mid * qty) * fee;
        const tt  = Math.max(0, gp) * tax;
        const np  = gp - ff - tt - extra;
        if (Math.abs(np) < 1) return mid;
        if ((side === 'long' && np < target) || (side === 'short' && np > target)) {
          if (side === 'long')  lo = mid; else hi = mid;
        } else {
          if (side === 'long')  hi = mid; else lo = mid;
        }
      }
      return (lo + hi) / 2;
    };
    breakEven = solveBreakEven();

    // Target ROI → required sell price
    const tROI = toNum(targetROI) / 100;
    let targetPrice = bp;
    if (tROI > 0) {
      // netProfit / buyAmount = tROI → grossProfit ≈ buyAmount * tROI + fees + tax
      // For simplicity (long, no tax on small): targetPrice = bp * (1 + tROI/lev) + fee adjustment
      targetPrice = side === 'long'
        ? bp * (1 + (tROI + 2*fee*lev) / lev)
        : bp * (1 - (tROI + 2*fee*lev) / lev);
    }

    // Stop-loss
    const slRate = toNum(stopLoss) / 100;
    const stopPrice = side === 'long'
      ? bp * (1 + slRate / lev)  // slRate is negative → price below entry
      : bp * (1 - slRate / lev);

    // Liquidation estimate (only for leverage > 1)
    const liqPrice = lev > 1
      ? (side === 'long' ? bp * (1 - 0.95 / lev) : bp * (1 + 0.95 / lev))
      : null;

    // Risk/reward (if targetPrice and stopPrice both valid)
    const reward = Math.abs(targetPrice - bp);
    const risk   = Math.abs(stopPrice - bp);
    const rrRatio = risk > 0 ? reward / risk : 0;

    const status: 'profit'|'loss'|'flat' =
      netProfit > 1 ? 'profit' : netProfit < -1 ? 'loss' : 'flat';

    return {
      buyAmount, sellAmount, totalFee,
      grossProfit, estimatedTax, netProfit, roi, grossROI,
      leveragedProfit, breakEven, targetPrice, stopPrice, liqPrice,
      rrRatio, margin, status,
    };
  }, [buyPrice, sellPrice, quantity, leverage, feeRate, taxRate, side, taxMode, extraCost, targetROI, stopLoss]);

  /* ── Split buy average ───────────────────────────────── */
  const splitAvg = useMemo(() => {
    const b1 = toNum(buyPrice), q1 = toNum(quantity);
    const b2 = toNum(splitBuy2), q2 = toNum(splitQty2);
    const b3 = toNum(splitBuy3), q3 = toNum(splitQty3);
    const totalQty  = q1 + q2 + q3;
    const totalCost = b1 * q1 + b2 * q2 + b3 * q3;
    if (totalQty === 0) return null;
    return { avgPrice: totalCost / totalQty, totalQty, totalCost };
  }, [buyPrice, quantity, splitBuy2, splitQty2, splitBuy3, splitQty3]);

  /* ── DCA projection ──────────────────────────────────── */
  const dcaResult = useMemo(() => {
    const m   = toNum(dcaMonthly);
    const n   = toNum(dcaMonths);
    const yp  = toNum(dcaYield) / 100;
    if (m <= 0 || n <= 0) return null;
    const monthlyRate = yp / 12;
    // Future value of annuity: FV = PMT × ((1 + r)^n − 1) / r
    let fv = 0;
    if (monthlyRate > 0) {
      fv = m * (Math.pow(1 + monthlyRate, n) - 1) / monthlyRate;
    } else {
      fv = m * n;
    }
    const totalInvest = m * n;
    return { fv, totalInvest, profit: fv - totalInvest, profitPct: ((fv - totalInvest) / totalInvest) * 100 };
  }, [dcaMonthly, dcaMonths, dcaYield]);

  /* ── Compute action ─────────────────────────────────── */
  const compute = useCallback(() => {
    if (validation.length > 0) {
      showToast(validation[0]);
      return;
    }
    setComputed(true);
    showToast('✅ 계산 완료');
  }, [validation, showToast]);

  /* ── Save to history ─────────────────────────────────── */
  const saveResult = useCallback(() => {
    if (!result || !computed) {
      showToast('먼저 계산하기를 눌러주세요');
      return;
    }
    const rec: CalcRecord = {
      id: 'pnl-' + Date.now().toString(36),
      ts: Date.now(),
      symbol: symbol || '미지정',
      assetType, side,
      buyPrice:  toNum(buyPrice),
      sellPrice: toNum(sellPrice),
      quantity:  toNum(quantity),
      netProfit: result.netProfit,
      roi:       result.roi,
    };
    const next = [rec, ...history].slice(0, 5);
    setHistory(next);
    try { localStorage.setItem(STORE_KEY, JSON.stringify(next)); } catch {}
    onSaveToJournal?.(rec);
    showToast('💾 매매일지에 저장됨');
  }, [result, computed, symbol, assetType, side, buyPrice, sellPrice, quantity, history, onSaveToJournal, showToast]);

  /* ── Load from history ───────────────────────────────── */
  const loadRecord = useCallback((r: CalcRecord) => {
    setAssetType(r.assetType);
    setSymbol(r.symbol);
    setSide(r.side);
    setBuyPrice(String(r.buyPrice));
    setSellPrice(String(r.sellPrice));
    setQuantity(String(r.quantity));
    setShowHistory(false);
    showToast('📂 불러옴');
  }, [showToast]);

  /* ── Copy result ─────────────────────────────────────── */
  const copyResult = useCallback(() => {
    if (!result) return;
    const text = [
      `${symbol || '계산결과'} (${side === 'long' ? '롱' : '숏'})`,
      `매수가: ${formatPrice(toNum(buyPrice))} × ${quantity}`,
      `매도가: ${formatPrice(toNum(sellPrice))}`,
      `총수수료: ${formatPrice(result.totalFee)}`,
      `예상세금: ${formatPrice(result.estimatedTax)}`,
      `━━━━━━━━━━━━━━`,
      `순수익: ${formatPL(result.netProfit)}`,
      `수익률: ${safePercent(result.roi)}`,
      `손익분기: ${formatPrice(result.breakEven)}`,
    ].join('\n');
    navigator.clipboard?.writeText(text)
      .then(() => showToast('결과 복사됨'))
      .catch(() => showToast('❌ 복사 실패'));
  }, [result, symbol, side, buyPrice, sellPrice, quantity, showToast]);

  const statusColor = result?.status === 'profit' ? T.grn
                    : result?.status === 'loss'   ? T.red
                    : T.muted;

  return (
    <div style={{ paddingBottom: 100, color: T.txt }}>
      {/* Toast */}
      {toast && (
        <div style={{ position:'fixed', top: 16, left:'50%', transform:'translateX(-50%)',
          background: T.acl, color:'#fff', padding:'10px 18px', borderRadius: 12,
          fontSize: 13, fontWeight: 700, zIndex: 999, boxShadow:'0 4px 20px rgba(0,0,0,.4)' }}>
          {toast}
        </div>
      )}

      {/* Header */}
      <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:14 }}>
        <div style={{ width: 36, height: 36, borderRadius: 10,
          background:'linear-gradient(135deg,#2563EB,#10B981)',
          display:'flex', alignItems:'center', justifyContent:'center', fontSize:18 }}>💹</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 900, fontSize: 17 }}>실제 수익 계산기</div>
          <div style={{ color: T.muted, fontSize: 10 }}>수수료 · 세금 · 레버리지 통합 계산</div>
        </div>
        <button type="button" onClick={() => setShowHistory(s => !s)}
          style={{ background: T.alt, border:`1px solid ${T.border}`, borderRadius: 10,
            color: T.muted, padding:'8px 12px', fontSize: 11, fontWeight: 700, cursor:'pointer', minHeight: 36 }}>
          📂 기록({history.length})
        </button>
      </div>

      {/* Prefill banner */}
      {prefill && (prefill.assetName || prefill.symbol) && (
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between',
          background: T.acg, border:`1px solid ${T.acl}40`, borderRadius: 12,
          padding:'10px 14px', marginBottom: 10 }}>
          <div>
            <div style={{ color: T.acl, fontSize: 11, fontWeight: 700 }}>
              📊 {prefill.assetName || prefill.symbol}에서 가져옴
            </div>
            <div style={{ color: T.muted, fontSize: 10 }}>
              현재가 {formatPrice(prefill.currentPrice)} · 자동 입력됨
            </div>
          </div>
        </div>
      )}

      {/* History panel */}
      {showHistory && (
        <Card>
          <div style={{ color: T.txt, fontWeight: 700, fontSize: 12, marginBottom: 8 }}>최근 계산 기록</div>
          {history.length === 0 ? (
            <div style={{ color: T.muted, fontSize: 11, padding:'12px 0', textAlign:'center' }}>
              저장된 기록이 없습니다
            </div>
          ) : (
            history.map(r => (
              <div key={r.id} onClick={() => loadRecord(r)}
                style={{ display:'flex', justifyContent:'space-between', padding:'10px 0',
                  borderBottom:`1px solid ${T.border}`, cursor:'pointer' }}>
                <div>
                  <div style={{ color: T.txt, fontSize: 12, fontWeight: 600 }}>
                    {r.symbol} <span style={{ color: T.muted, fontSize: 10 }}>· {r.side === 'long' ? '롱' : '숏'}</span>
                  </div>
                  <div style={{ color: T.muted, fontSize: 9 }}>{new Date(r.ts).toLocaleString('ko-KR')}</div>
                </div>
                <div style={{ textAlign:'right' }}>
                  <div style={{ color: r.netProfit >= 0 ? T.grn : T.red, fontSize: 12, fontWeight: 700 }}>
                    {formatPL(r.netProfit)}
                  </div>
                  <div style={{ color: r.roi >= 0 ? T.grn : T.red, fontSize: 10 }}>
                    {safePercent(r.roi)}
                  </div>
                </div>
              </div>
            ))
          )}
        </Card>
      )}

      {/* ── Section 1: 거래 설정 ── */}
      <Card>
        <div style={{ color: T.txt, fontWeight: 700, fontSize: 13, marginBottom: 10 }}>거래 설정</div>

        <Field label="자산 종류">
          <div style={{ display:'flex', gap: 5, flexWrap:'wrap' }}>
            {ASSET_OPTIONS.map(o => (
              <button key={o.id} type="button" onClick={() => setAssetType(o.id)}
                style={{ flex:'1 0 30%', minWidth: 100, padding:'8px 6px',
                  background: assetType === o.id ? T.acg : T.alt,
                  border:`1px solid ${assetType === o.id ? T.acl : T.border}`,
                  borderRadius: 10, color: assetType === o.id ? T.acl : T.muted,
                  fontSize: 11, fontWeight: 700, cursor:'pointer', minHeight: 38 }}>
                {o.icon} {o.label}
              </button>
            ))}
          </div>
        </Field>

        <Field label="거래 방향">
          <div style={{ display:'flex', gap: 6 }}>
            <button type="button" onClick={() => setSide('long')}
              style={{ flex: 1, padding:'11px', minHeight: 42,
                background: side === 'long' ? T.grn + '20' : T.alt,
                border:`1px solid ${side === 'long' ? T.grn : T.border}`,
                borderRadius: 10, color: side === 'long' ? T.grn : T.muted,
                fontWeight: 700, fontSize: 13, cursor:'pointer' }}>
              📈 롱 (매수)
            </button>
            <button type="button" onClick={() => setSide('short')}
              style={{ flex: 1, padding:'11px', minHeight: 42,
                background: side === 'short' ? T.red + '20' : T.alt,
                border:`1px solid ${side === 'short' ? T.red : T.border}`,
                borderRadius: 10, color: side === 'short' ? T.red : T.muted,
                fontWeight: 700, fontSize: 13, cursor:'pointer' }}>
              📉 숏 (공매도)
            </button>
          </div>
        </Field>

        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap: 8 }}>
          <Field label="레버리지 (배율)">
            <NumInput value={leverage} onChange={setLeverage} placeholder="1" suffix="x" />
          </Field>
          <Field label="환율 (USD/KRW)" hint={assetType === 'us_stock' ? '미국주식' : undefined}>
            <NumInput value={fxRate} onChange={setFxRate} placeholder="1375" />
          </Field>
        </div>

        <Field label="자산명 / 심볼 (선택)">
          <input type="text" value={symbol} onChange={(e) => setSymbol(e.target.value)}
            placeholder="예: BTC, NVDA, 삼성전자"
            style={{ width:'100%', boxSizing:'border-box', background: T.bg,
              border:`1px solid ${T.border}`, borderRadius: 10, padding:'11px 14px',
              color: T.txt, fontSize: 14, outline:'none' }}/>
        </Field>
      </Card>

      {/* ── Section 2: 가격/수량 ── */}
      <Card>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom: 10 }}>
          <div style={{ color: T.txt, fontWeight: 700, fontSize: 13 }}>가격 · 수량</div>
          <button type="button" onClick={() => loadExample()}
            style={{ background: T.acg, border:`1px solid ${T.acl}40`, borderRadius: 8,
              color: T.acl, padding:'5px 10px', fontSize: 10, fontWeight: 700, cursor:'pointer' }}>
            📌 예시 불러오기
          </button>
        </div>

        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap: 8 }}>
          <Field label="매수 가격">
            <NumInput value={buyPrice} onChange={setBuyPrice} placeholder="진입가" />
          </Field>
          <Field label="매도 가격">
            <NumInput value={sellPrice} onChange={setSellPrice} placeholder="청산가" />
          </Field>
        </div>

        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap: 8 }}>
          <Field label="투자금 (선택)" hint="수량 자동계산">
            <NumInput value={investment} onChange={setInvestment} placeholder="총 투자금" />
          </Field>
          <Field label="수량">
            <div style={{ display:'flex', gap: 6 }}>
              <NumInput value={quantity} onChange={setQuantity} placeholder="0.01" />
              <button type="button" onClick={autoFillQty}
                style={{ flexShrink: 0, padding:'0 12px', background: T.alt,
                  border:`1px solid ${T.border}`, borderRadius: 10,
                  color: T.acl, fontSize: 10, fontWeight: 700, cursor:'pointer' }}>
                계산
              </button>
            </div>
          </Field>
        </div>
      </Card>

      {/* ── Section 3: 비용 ── */}
      <Card>
        <div style={{ color: T.txt, fontWeight: 700, fontSize: 13, marginBottom: 10 }}>수수료 · 세금</div>

        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap: 8 }}>
          <Field label="수수료율">
            <NumInput value={feeRate} onChange={setFeeRate} placeholder="0.1" suffix="%" />
          </Field>
          <Field label="세금률">
            <NumInput value={taxRate} onChange={setTaxRate} placeholder="0" suffix="%" />
          </Field>
        </div>

        <Field label="세금 모드">
          <select value={taxMode} onChange={(e) => setTaxMode(e.target.value as TaxMode)}
            style={{ width:'100%', boxSizing:'border-box', background: T.bg,
              border:`1px solid ${T.border}`, borderRadius: 10, padding:'10px 12px',
              color: T.txt, fontSize: 12, outline:'none' }}>
            {Object.entries(TAX_MODE_INFO).map(([k, v]) => (
              <option key={k} value={k}>{v.label}</option>
            ))}
          </select>
          <div style={{ color: T.muted, fontSize: 9, marginTop: 4 }}>
            {TAX_MODE_INFO[taxMode].note}
          </div>
        </Field>

        <Field label="기타 비용 (선택)">
          <NumInput value={extraCost} onChange={setExtraCost} placeholder="펀딩비, 슬리피지 등" />
        </Field>
      </Card>

      {/* ── Action buttons ── */}
      <div style={{ display:'flex', gap: 8, marginBottom: 14 }}>
        <button type="button" onClick={compute}
          style={{ flex: 2, padding:'14px', minHeight: 50,
            background: validation.length === 0
              ? 'linear-gradient(135deg,#2563EB,#10B981)' : T.alt,
            color:'#fff', border:'none', borderRadius: 12,
            fontWeight: 900, fontSize: 15, cursor:'pointer',
            opacity: validation.length === 0 ? 1 : 0.7,
            boxShadow:'0 4px 12px rgba(37,99,235,.3)' }}>
          🚀 계산하기
        </button>
        <button type="button" onClick={reset}
          style={{ flex: 1, padding:'14px', minHeight: 50,
            background: T.alt, color: T.muted,
            border:`1px solid ${T.border}`, borderRadius: 12,
            fontWeight: 700, fontSize: 13, cursor:'pointer' }}>
          🔄 초기화
        </button>
      </div>

      {/* ── Validation messages ── */}
      {validation.length > 0 && computed && (
        <Card style={{ background: T.ylw + '10', border:`1px solid ${T.ylw}40` }}>
          <div style={{ color: T.ylw, fontSize: 12, fontWeight: 700, marginBottom: 4 }}>
            ⚠️ 입력값을 확인하세요
          </div>
          {validation.map((v, i) => (
            <div key={i} style={{ color: T.ylw, fontSize: 11, marginTop: 4 }}>· {v}</div>
          ))}
        </Card>
      )}

      {/* ── Results ── */}
      {result && computed && validation.length === 0 && (
        <>
          <Card style={{ border:`2px solid ${statusColor}40` }}>
            {/* Status banner */}
            <div style={{ background: statusColor + '15', borderRadius: 10,
              padding:'10px 12px', marginBottom: 14, textAlign:'center' }}>
              <div style={{ color: statusColor, fontSize: 11, fontWeight: 700, marginBottom: 2 }}>
                {result.status === 'profit' ? '✅ 수익 예상'
                  : result.status === 'loss' ? '❌ 손실 예상' : '➖ 본전'}
              </div>
              <div style={{ color: statusColor, fontSize: 24, fontWeight: 900, fontFamily:'monospace' }}>
                {formatPL(result.netProfit)}
              </div>
              <div style={{ color: statusColor, fontSize: 14, fontWeight: 700 }}>
                {safePercent(result.roi)}
              </div>
            </div>

            {/* Detail rows */}
            {[
              ['총 매수금액',  formatPrice(result.buyAmount),    T.txt],
              ['총 매도금액',  formatPrice(result.sellAmount),   T.txt],
              ['총 수수료',    '-' + formatPrice(result.totalFee), T.red],
              ['예상 세금',    '-' + formatPrice(result.estimatedTax), T.red],
              ['세전 손익',    formatPL(result.grossProfit), result.grossProfit >= 0 ? T.grn : T.red],
              ['레버리지 적용 수익', formatPL(result.leveragedProfit), result.leveragedProfit >= 0 ? T.grn : T.red],
              ['손익분기 매도가 (추정)', formatPrice(result.breakEven), T.ylw],
              ['리스크/리워드 비율', result.rrRatio > 0 ? `1 : ${result.rrRatio.toFixed(2)}` : '-', T.acl],
              ...(result.liqPrice
                ? [['청산가 (추정)', formatPrice(result.liqPrice), T.red] as [string, string, string]]
                : []),
            ].map(([label, value, color]) => (
              <div key={label} style={{ display:'flex', justifyContent:'space-between',
                padding:'7px 0', borderBottom:`1px solid ${T.border}` }}>
                <span style={{ color: T.muted, fontSize: 11 }}>{label}</span>
                <span style={{ color, fontSize: 12, fontWeight: 700, fontFamily:'monospace' }}>{value}</span>
              </div>
            ))}

            {/* Interpretation */}
            <div style={{ marginTop: 14, padding:'10px 12px', background: T.alt,
              borderRadius: 10, color: T.sub, fontSize: 11, lineHeight: 1.6 }}>
              💡 현재 조건에서 수수료 {formatPrice(result.totalFee)}와 세금 {formatPrice(result.estimatedTax)}를
              제외하고 <strong style={{ color: statusColor }}>{formatPL(result.netProfit)}</strong>의
              {result.status === 'profit' ? ' 순수익' : result.status === 'loss' ? ' 순손실' : ' 본전'}입니다.
              {result.status === 'profit' && result.roi >= 10 && ' 수익률이 우수합니다.'}
              {result.status === 'loss' && ' 손절 전략 검토를 권장합니다.'}
            </div>

            {/* Action row */}
            <div style={{ display:'flex', gap: 6, marginTop: 12 }}>
              <button type="button" onClick={saveResult}
                style={{ flex: 1, padding:'10px', background: T.grn + '20',
                  border:`1px solid ${T.grn}60`, borderRadius: 10, color: T.grn,
                  fontWeight: 700, fontSize: 11, cursor:'pointer', minHeight: 38 }}>
                💾 매매일지에 저장
              </button>
              <button type="button" onClick={copyResult}
                style={{ flex: 1, padding:'10px', background: T.acg,
                  border:`1px solid ${T.acl}40`, borderRadius: 10, color: T.acl,
                  fontWeight: 700, fontSize: 11, cursor:'pointer', minHeight: 38 }}>
                📋 결과 복사
              </button>
            </div>
          </Card>

          {/* Target ROI / Stop loss */}
          <Card>
            <div style={{ color: T.txt, fontWeight: 700, fontSize: 12, marginBottom: 10 }}>목표가 · 손절가 역산</div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap: 8 }}>
              <Field label="목표 수익률">
                <NumInput value={targetROI} onChange={setTargetROI} placeholder="10" suffix="%" />
              </Field>
              <Field label="허용 손실률">
                <NumInput value={stopLoss} onChange={setStopLoss} placeholder="-3" suffix="%" />
              </Field>
            </div>
            <div style={{ display:'flex', justifyContent:'space-between', padding:'8px 0', borderTop:`1px solid ${T.border}` }}>
              <span style={{ color: T.muted, fontSize: 11 }}>필요 매도가</span>
              <span style={{ color: T.grn, fontSize: 12, fontWeight: 700, fontFamily:'monospace' }}>
                {formatPrice(result.targetPrice)}
              </span>
            </div>
            <div style={{ display:'flex', justifyContent:'space-between', padding:'8px 0', borderTop:`1px solid ${T.border}` }}>
              <span style={{ color: T.muted, fontSize: 11 }}>추천 손절가</span>
              <span style={{ color: T.red, fontSize: 12, fontWeight: 700, fontFamily:'monospace' }}>
                {formatPrice(result.stopPrice)}
              </span>
            </div>
          </Card>
        </>
      )}

      {/* ── Section 5: 분할매수 ── */}
      <Card>
        <div style={{ color: T.txt, fontWeight: 700, fontSize: 12, marginBottom: 10 }}>🔀 분할매수 평균단가</div>
        <div style={{ color: T.muted, fontSize: 10, marginBottom: 8 }}>1차 매수: 위 매수가/수량 사용</div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap: 8 }}>
          <NumInput value={splitBuy2} onChange={setSplitBuy2} placeholder="2차 매수가" />
          <NumInput value={splitQty2} onChange={setSplitQty2} placeholder="2차 수량" />
          <NumInput value={splitBuy3} onChange={setSplitBuy3} placeholder="3차 매수가" />
          <NumInput value={splitQty3} onChange={setSplitQty3} placeholder="3차 수량" />
        </div>
        {splitAvg && (
          <div style={{ marginTop: 10, padding:'10px 12px', background: T.alt, borderRadius: 10 }}>
            <div style={{ display:'flex', justifyContent:'space-between', marginBottom: 4 }}>
              <span style={{ color: T.muted, fontSize: 11 }}>평균 단가</span>
              <span style={{ color: T.acl, fontSize: 13, fontWeight: 700, fontFamily:'monospace' }}>
                {formatPrice(splitAvg.avgPrice)}
              </span>
            </div>
            <div style={{ display:'flex', justifyContent:'space-between' }}>
              <span style={{ color: T.muted, fontSize: 10 }}>총 {splitAvg.totalQty} 개</span>
              <span style={{ color: T.muted, fontSize: 10, fontFamily:'monospace' }}>
                = {formatPrice(splitAvg.totalCost)}
              </span>
            </div>
          </div>
        )}
      </Card>

      {/* ── Section 6: DCA ── */}
      <Card>
        <div style={{ color: T.txt, fontWeight: 700, fontSize: 12, marginBottom: 10 }}>DCA 적립식 예측</div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap: 8 }}>
          <Field label="월 투자금">
            <NumInput value={dcaMonthly} onChange={setDcaMonthly} placeholder="100000" />
          </Field>
          <Field label="기간 (개월)">
            <NumInput value={dcaMonths} onChange={setDcaMonths} placeholder="12" />
          </Field>
          <Field label="연 수익률">
            <NumInput value={dcaYield} onChange={setDcaYield} placeholder="10" suffix="%" />
          </Field>
        </div>
        {dcaResult && (
          <div style={{ padding:'10px 12px', background: T.alt, borderRadius: 10, marginTop: 4 }}>
            <div style={{ display:'flex', justifyContent:'space-between', padding:'4px 0' }}>
              <span style={{ color: T.muted, fontSize: 11 }}>총 투자금</span>
              <span style={{ color: T.txt, fontSize: 12, fontWeight: 700, fontFamily:'monospace' }}>
                {formatPrice(dcaResult.totalInvest)}
              </span>
            </div>
            <div style={{ display:'flex', justifyContent:'space-between', padding:'4px 0' }}>
              <span style={{ color: T.muted, fontSize: 11 }}>예상 최종금액</span>
              <span style={{ color: T.grn, fontSize: 13, fontWeight: 700, fontFamily:'monospace' }}>
                {formatPrice(dcaResult.fv)}
              </span>
            </div>
            <div style={{ display:'flex', justifyContent:'space-between', padding:'4px 0' }}>
              <span style={{ color: T.muted, fontSize: 11 }}>예상 수익</span>
              <span style={{ color: dcaResult.profit >= 0 ? T.grn : T.red,
                fontSize: 12, fontWeight: 700, fontFamily:'monospace' }}>
                {formatPL(dcaResult.profit)} ({safePercent(dcaResult.profitPct)})
              </span>
            </div>
          </div>
        )}
      </Card>

      {/* ── Disclaimer ── */}
      <div style={{ color: T.muted, fontSize: 10, lineHeight: 1.7,
        padding:'10px 12px', background: T.alt, borderRadius: 10,
        marginBottom: 20 }}>
        ⚠️ 본 계산기는 참고용입니다. 실제 세금은 보유기간·국가·증권사 정책에 따라 달라질 수 있으며,
        실거래 손익은 슬리피지·펀딩비 등으로 차이가 발생할 수 있습니다. 투자 결정 전 세무사 확인을 권장합니다.
      </div>
    </div>
  );
}
