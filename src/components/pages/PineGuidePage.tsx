'use client';
import React, { useState, useEffect } from 'react';
import { T } from '@/lib/constants';
import { Card } from './SharedUI';
import { Copy, ExternalLink, Check, FlaskConical, Bot, ChevronDown, ChevronRight } from 'lucide-react';

const STORAGE_KEY = 'tg_pine_backtests_v1';

const SAMPLE_PINE = `//@version=5
strategy("공포 DCA 전략", overlay=true, initial_capital=10000, default_qty_type=strategy.cash)

// 리스크 설정
riskPct = input.float(2.0, "1회 리스크(%)", step=0.1) / 100
atrMult = input.float(1.5, "ATR 손절 배수", step=0.1)

// 진입 조건 (EMA 추세)
ema20 = ta.ema(close, 20)
ema60 = ta.ema(close, 60)
longCond = ta.crossover(ema20, ema60)

// ATR 기반 손절
atr = ta.atr(14)
stopLoss = close - (atr * atrMult)

// 포지션 사이징
riskAmt = strategy.equity * riskPct
riskDist = close - stopLoss
qty = riskDist > 0 ? riskAmt / riskDist : 0

if (longCond and strategy.opentrades == 0)
    strategy.entry("Long", strategy.long, qty=qty)
    strategy.exit("Exit", "Long", stop=stopLoss, limit=close + (atr * 3))

plot(ema20, color=color.blue)
plot(ema60, color=color.orange)`;

interface BtRecord {
  id: string; symbol: string; period: string; timeframe: string;
  netProfit: string; winRate: string; mdd: string; profitFactor: string;
  trades: string; memo: string; at: number; analysis?: string;
}

export default function PineGuidePage() {
  const [copied, setCopied] = useState(false);
  const [codeOpen, setCodeOpen] = useState(true);
  const [records, setRecords] = useState<BtRecord[]>([]);
  const [form, setForm] = useState({ symbol: 'BTCUSDT', period: '', timeframe: '1D', netProfit: '', winRate: '', mdd: '', profitFactor: '', trades: '', memo: '' });
  const [analyzing, setAnalyzing] = useState(false);

  useEffect(() => {
    try { const raw = localStorage.getItem(STORAGE_KEY); if (raw) setRecords(JSON.parse(raw)); } catch {}
  }, []);

  const persist = (list: BtRecord[]) => {
    setRecords(list);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch {}
  };

  const copyCode = () => {
    try { navigator.clipboard.writeText(SAMPLE_PINE); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {}
  };

  // 로컬 규칙 기반 분석 (AI API 없이도 동작)
  const analyzeResult = (r: { netProfit: string; winRate: string; mdd: string; profitFactor: string; trades: string }): string => {
    const np = parseFloat(r.netProfit), wr = parseFloat(r.winRate), mdd = Math.abs(parseFloat(r.mdd)), pf = parseFloat(r.profitFactor), tr = parseInt(r.trades);
    const issues: string[] = [];
    const goods: string[] = [];
    if (!isNaN(tr)) { if (tr < 30) issues.push(`거래 ${tr}건 — 표본 부족(과최적화 위험)`); else goods.push(`표본 충분(${tr}건)`); }
    if (!isNaN(pf)) { if (pf < 1) issues.push(`손익비 ${pf} — 손실 전략`); else if (pf >= 1.5) goods.push(`손익비 우수(${pf})`); }
    if (!isNaN(mdd)) { if (mdd > 30) issues.push(`MDD ${mdd}% — 낙폭 과도`); else if (mdd <= 15) goods.push(`낙폭 양호(${mdd}%)`); }
    if (!isNaN(wr) && wr >= 80 && tr < 20) issues.push('높은 승률+적은 표본 = 과최적화 의심');
    if (!isNaN(np) && np <= 0) issues.push('순익 음수');
    const verdict = issues.length === 0 ? '✅ 실전 적합 — 모의매매 7일 후 소액 투입 권장' :
      issues.length >= 2 ? '❌ 실전 부적합 — 전략 수정 필요' : '⚠️ 주의 — 모의매매로 추가 검증';
    return `${verdict}\n\n${goods.length ? '좋음: ' + goods.join(', ') + '\n' : ''}${issues.length ? '문제: ' + issues.join(', ') : ''}`;
  };

  const saveRecord = () => {
    if (!form.netProfit && !form.winRate) return;
    const analysis = analyzeResult(form);
    const rec: BtRecord = { id: `bt_${Date.now()}`, ...form, at: Date.now(), analysis };
    persist([rec, ...records].slice(0, 50));
    setForm({ symbol: 'BTCUSDT', period: '', timeframe: '1D', netProfit: '', winRate: '', mdd: '', profitFactor: '', trades: '', memo: '' });
  };

  const del = (id: string) => persist(records.filter(r => r.id !== id));

  const inp = (k: keyof typeof form, ph: string, half = true) => (
    <div style={{ flex: half ? 1 : 'unset', width: half ? 'auto' : '100%' }}>
      <input value={(form as any)[k]} onChange={e => setForm({ ...form, [k]: e.target.value })} placeholder={ph}
        style={{ width: '100%', background: T.alt, border: `1px solid ${T.border}`, borderRadius: 8, padding: '10px 12px', color: T.txt, fontSize: 12, outline: 'none' }} />
    </div>
  );

  return (
    <div style={{ padding: '0 0 24px' }}>
      <div style={{ marginBottom: 14 }}>
        <div style={{ color: T.txt, fontWeight: 900, fontSize: 18, display: 'flex', alignItems: 'center', gap: 8 }}>
          <FlaskConical size={20} color={T.prp} /> Pine Script 백테스트
        </div>
        <div style={{ color: T.muted, fontSize: 11, marginTop: 3 }}>TradingView에서 전략 검증 → 결과 기록 → 분석</div>
      </div>

      {/* 1. 가이드 */}
      <Card style={{ padding: 16, marginBottom: 12 }}>
        <div style={{ color: T.txt, fontWeight: 800, fontSize: 13, marginBottom: 10 }}>① TradingView 백테스트 방법</div>
        {[
          'TradingView 차트 열기 (BTCUSDT, SPY, QQQ 등)',
          '시간봉 1D 선택 (권장)',
          '하단 Pine 에디터 열기',
          '아래 코드 복사 → 붙여넣기',
          'Add to Chart 클릭',
          'Strategy Tester 탭에서 결과 확인',
        ].map((step, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 7, alignItems: 'flex-start' }}>
            <span style={{ flexShrink: 0, width: 18, height: 18, borderRadius: '50%', background: T.acg, color: T.acl, fontSize: 10, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{i + 1}</span>
            <span style={{ color: T.sub, fontSize: 11, lineHeight: 1.5 }}>{step}</span>
          </div>
        ))}
        <a href="https://www.tradingview.com/chart/" target="_blank" rel="noopener noreferrer"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 10, padding: '11px', background: T.acc, color: '#fff', borderRadius: 10, fontWeight: 700, fontSize: 12, textDecoration: 'none' }}>
          <ExternalLink size={14} /> TradingView 열기
        </a>
      </Card>

      {/* 2. Pine 코드 */}
      <Card style={{ padding: 16, marginBottom: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <button onClick={() => setCodeOpen(!codeOpen)} style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', color: T.txt, fontWeight: 800, fontSize: 13, cursor: 'pointer', padding: 0 }}>
            {codeOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}② 예제 전략 코드
          </button>
          <button onClick={copyCode} style={{ display: 'flex', alignItems: 'center', gap: 4, background: copied ? T.grn + '20' : T.alt, border: `1px solid ${copied ? T.grn : T.border}`, borderRadius: 7, padding: '5px 11px', color: copied ? T.grn : T.acl, fontSize: 10, fontWeight: 700, cursor: 'pointer' }}>
            {copied ? <><Check size={12} /> 복사됨</> : <><Copy size={12} /> 코드 복사</>}
          </button>
        </div>
        {codeOpen && (
          <pre style={{ background: '#05080F', border: `1px solid ${T.border}`, borderRadius: 8, padding: 12, overflow: 'auto', margin: 0, maxHeight: 280 }}>
            <code style={{ color: '#A5D6FF', fontSize: 10, fontFamily: 'monospace', lineHeight: 1.5, whiteSpace: 'pre' }}>{SAMPLE_PINE}</code>
          </pre>
        )}
        <div style={{ color: T.muted, fontSize: 9, marginTop: 8, lineHeight: 1.4 }}>
          이 전략엔 고정 리스크 사이징 + ATR 손절이 들어있어요. VIX/공포지수 조건은 TradingView에서 추가 가능.
        </div>
      </Card>

      {/* 3. 결과 입력 */}
      <Card style={{ padding: 16, marginBottom: 12 }}>
        <div style={{ color: T.txt, fontWeight: 800, fontSize: 13, marginBottom: 4 }}>③ 백테스트 결과 입력</div>
        <div style={{ color: T.muted, fontSize: 10, marginBottom: 12 }}>Strategy Tester에서 본 값을 입력하면 자동 분석</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 8 }}>{inp('symbol', '종목 (BTCUSDT)')}{inp('timeframe', '시간봉 (1D)')}</div>
          {inp('period', '기간 (예: 2020-2024)', false)}
          <div style={{ display: 'flex', gap: 8 }}>{inp('netProfit', '순익 % (Net Profit)')}{inp('winRate', '승률 % (Win Rate)')}</div>
          <div style={{ display: 'flex', gap: 8 }}>{inp('mdd', 'MDD % (낙폭)')}{inp('profitFactor', '손익비 (PF)')}</div>
          {inp('trades', '거래 횟수', false)}
          {inp('memo', '메모 (선택)', false)}
        </div>
        <button onClick={saveRecord} style={{ width: '100%', marginTop: 12, padding: '12px', background: T.prp, color: '#fff', border: 'none', borderRadius: 10, fontWeight: 800, fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
          <Bot size={15} /> 결과 저장 + AI 분석
        </button>
      </Card>

      {/* 4. 기록 목록 */}
      {records.length > 0 && (
        <Card style={{ padding: 16, marginBottom: 12 }}>
          <div style={{ color: T.txt, fontWeight: 800, fontSize: 13, marginBottom: 10 }}>④ 백테스트 기록 ({records.length})</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {records.map(r => (
              <div key={r.id} style={{ background: T.alt, borderRadius: 10, padding: '11px 13px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
                  <span style={{ color: T.txt, fontWeight: 800, fontSize: 12 }}>{r.symbol} · {r.timeframe}</span>
                  <button onClick={() => del(r.id)} style={{ background: 'none', border: 'none', color: T.red, fontSize: 10, cursor: 'pointer' }}>삭제</button>
                </div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 9, color: T.muted, marginBottom: 6 }}>
                  <span>순익 <b style={{ color: parseFloat(r.netProfit) >= 0 ? T.grn : T.red }}>{r.netProfit}%</b></span>
                  <span>승률 <b style={{ color: T.txt }}>{r.winRate}%</b></span>
                  <span>MDD <b style={{ color: T.red }}>{r.mdd}%</b></span>
                  <span>PF <b style={{ color: T.txt }}>{r.profitFactor}</b></span>
                  <span>{r.trades}건</span>
                </div>
                {r.analysis && (
                  <div style={{ background: T.bg, borderRadius: 7, padding: '8px 10px', color: T.sub, fontSize: 10, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{r.analysis}</div>
                )}
                {r.memo && <div style={{ color: T.muted, fontSize: 9, marginTop: 5 }}>📝 {r.memo}</div>}
              </div>
            ))}
          </div>
        </Card>
      )}

      <div style={{ color: T.muted, fontSize: 10, lineHeight: 1.5, padding: '0 4px' }}>
        ⚠️ 백테스트 결과는 미래 수익을 보장하지 않습니다. 실전 전 테스트넷/모의매매가 필수입니다.
      </div>
    </div>
  );
}
