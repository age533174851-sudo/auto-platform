'use client';
// ─────────────────────────────────────────────────────────────
// MockAutoTrade — 앱 내부 완결형 모의(MOCK) 자동매매
// 거래소 API / Worker / jobs queue를 전혀 쓰지 않고, 브라우저 안에서
// 기본 테스트 전략을 주기적으로 돌려 paper 매매내역을 생성한다.
// 실제 주문 절대 없음. Kill Switch/권한/Worker 검사 없음(독립 실행).
// ─────────────────────────────────────────────────────────────
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { T } from '@/lib/constants';
import { notify } from '@/lib/notify/center';
import {
  paperBuy, closePaperPosition, getOpenPositions,
  loadLogs, saveLog, loadPaperBalance,
} from '@/lib/autotrade/store';
import type { ExecutionLog } from '@/lib/autotrade/types';

const ASSET = 'BTC';
const STRAT_ID = 'mock-test-btc';
const STRAT_NAME = 'MOCK 테스트 전략 (BTC)';
const ENTRY_KRW = 1_000_000;   // 진입당 100만원 (시드 1000만의 10%)
const TP_PCT = 0.3;            // +0.3% 익절
const SL_PCT = 0.2;            // -0.2% 손절
const FALLBACK_PRICE = 140_000_000; // BTC 원화 대략치 (실시세 실패 시)

function mkLog(action: 'buy' | 'sell', price: number, extra: Partial<ExecutionLog> = {}): ExecutionLog {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    strategyId: STRAT_ID, strategyName: STRAT_NAME,
    asset: ASSET, timeframe: 'MOCK', action, status: 'triggered',
    at: Date.now(), mode: 'paper',
    conditionsAll: 1, conditionsPass: 1, conditionDetails: [],
    indicators: { currentPrice: price },
    filledPrice: price,
    ...extra,
  };
}

export default function MockAutoTrade() {
  const [running, setRunning]   = useState(false);
  const [intervalSec, setIv]    = useState(10);
  const [priceMode, setPriceMode] = useState<'sim' | 'real'>('sim');
  const [lastRunAt, setLastRunAt] = useState<number | null>(null);
  const [lastCheck, setLastCheck] = useState<string>('아직 실행 안 함');
  const [tick, setTick]         = useState(0);          // 리렌더 트리거
  const [toast, setToast]       = useState('');

  const simPriceRef = useRef<number>(0);
  const busyRef     = useRef(false);
  const timerRef    = useRef<ReturnType<typeof setInterval> | null>(null);

  const showToast = useCallback((m: string) => {
    const [title, ...rest] = m.split(' · ');
    let kind: any = 'info';
    if (/매수|진입|long/i.test(title)) kind = 'buy';
    else if (/매도|청산|익절|손절|short/i.test(title)) kind = title.includes('익절') ? 'tp' : title.includes('손절') ? 'sl' : 'sell';
    else if (/실패|오류/i.test(title)) kind = 'error';
    notify(kind, title, rest.join(' · ') || undefined);
    setToast(''); void toast;
  }, [toast]);
  const refresh   = useCallback(() => setTick(t => t + 1), []);

  // 현재가 조회 (sim = 랜덤워크, real = /api/prices)
  const getMarkPrice = useCallback(async (): Promise<number> => {
    if (priceMode === 'real') {
      try {
        const r = await fetch(`/api/prices?action=coin&symbol=${ASSET}`);
        const d = await r.json();
        if (d?.price && d.price > 0) { simPriceRef.current = d.price; return d.price; }
      } catch {}
    }
    // sim: 직전가 기준 ±0.2% 랜덤워크 (익절/손절이 몇 틱 안에 걸리도록)
    let base = simPriceRef.current;
    if (!base || base <= 0) {
      try {
        const r = await fetch(`/api/prices?action=coin&symbol=${ASSET}`);
        const d = await r.json();
        base = (d?.price && d.price > 0) ? d.price : FALLBACK_PRICE;
      } catch { base = FALLBACK_PRICE; }
    }
    const drift = (Math.random() - 0.5) * 0.004; // ±0.2%
    const next = base * (1 + drift);
    simPriceRef.current = next;
    return next;
  }, [priceMode]);

  // 1회 실행 (진입/청산 판단)
  const runOnce = useCallback(async (): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const price = await getMarkPrice();
      const pos = getOpenPositions().find(p => p.asset === ASSET);
      setLastRunAt(Date.now());

      if (pos && pos.qty > 0) {
        const dir = pos.side === 'short' ? -1 : 1;
        const pnlPct = ((price - pos.avgPrice) / pos.avgPrice) * 100 * dir;
        if (pnlPct >= TP_PCT || pnlPct <= -SL_PCT) {
          const isTp = pnlPct >= TP_PCT;
          const res = closePaperPosition(ASSET, price);
          saveLog(mkLog('sell', price, {
            reason: isTp ? `익절 +${pnlPct.toFixed(2)}%` : `손절 ${pnlPct.toFixed(2)}%`,
            filledQuantity: pos.qty,
          }));
          setLastCheck(`${isTp ? '✅ 익절' : '🛑 손절'} 청산 (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%, PnL ${res.pnl >= 0 ? '+' : ''}${Math.round(res.pnl).toLocaleString('ko-KR')}원)`);
        } else {
          setLastCheck(`보유중 · 평가손익 ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% (익절 ${TP_PCT}% / 손절 -${SL_PCT}%)`);
        }
      } else {
        // 무포지션 → 진입 (단순 조건: 비어있으면 롱 진입)
        const r = paperBuy(ASSET, price, ENTRY_KRW, { side: 'long', stratId: STRAT_ID, takeProfitPct: TP_PCT, stopLossPct: SL_PCT });
        if (r.ok) {
          saveLog(mkLog('buy', price, { filledAmount: ENTRY_KRW, filledQuantity: r.qty }));
          setLastCheck(`📈 진입 long @ ${Math.round(price).toLocaleString('ko-KR')}원`);
        } else {
          setLastCheck(`진입 실패: ${r.reason || '알 수 없음'}`);
        }
      }
    } finally {
      busyRef.current = false;
      refresh();
    }
  }, [getMarkPrice, refresh]);

  // 자동 루프
  useEffect(() => {
    if (!running) { if (timerRef.current) clearInterval(timerRef.current); timerRef.current = null; return; }
    runOnce();  // 시작 즉시 1회
    timerRef.current = setInterval(runOnce, intervalSec * 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [running, intervalSec, runOnce]);

  // ── 테스트 버튼 핸들러 ──
  const testBuy = async () => {
    const price = await getMarkPrice();
    const r = paperBuy(ASSET, price, ENTRY_KRW, { side: 'long', stratId: STRAT_ID, takeProfitPct: TP_PCT, stopLossPct: SL_PCT });
    if (r.ok) { saveLog(mkLog('buy', price, { filledAmount: ENTRY_KRW, filledQuantity: r.qty, reason: '수동 테스트 매수' })); showToast('테스트 매수 체결'); }
    else showToast(`매수 실패: ${r.reason}`);
    refresh();
  };
  const testSell = async () => {
    const price = await getMarkPrice();
    const pos = getOpenPositions().find(p => p.asset === ASSET);
    if (!pos) { showToast('청산할 포지션 없음'); return; }
    const res = closePaperPosition(ASSET, price);
    saveLog(mkLog('sell', price, { filledQuantity: pos.qty, reason: `수동 테스트 매도 (PnL ${Math.round(res.pnl).toLocaleString('ko-KR')})` }));
    showToast(`테스트 매도 체결 (PnL ${res.pnl >= 0 ? '+' : ''}${Math.round(res.pnl).toLocaleString('ko-KR')}원)`);
    refresh();
  };

  // ── 표시 데이터 ──
  const bal = loadPaperBalance();
  const openPos = getOpenPositions().filter(p => p.asset === ASSET);
  const logs = (Array.isArray(loadLogs()) ? loadLogs() : []).filter(l => l.strategyId === STRAT_ID).slice(0, 12);
  const tradeCount = (Array.isArray(loadLogs()) ? loadLogs() : []).filter(l => l.strategyId === STRAT_ID).length;
  void tick;

  const box: React.CSSProperties = { background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 14 };
  const btn = (bg: string): React.CSSProperties => ({ padding: '9px 12px', borderRadius: 9, border: 'none', background: bg, color: '#fff', fontSize: 12, fontWeight: 800, cursor: 'pointer' });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16 }}>
      {toast && <div style={{ position: 'fixed', left: '50%', bottom: 90, transform: 'translateX(-50%)', zIndex: 9999, background: '#111', color: '#fff', padding: '10px 16px', borderRadius: 10, fontSize: 12, fontWeight: 700, boxShadow: '0 8px 24px rgba(0,0,0,.35)' }}>{toast}</div>}

      {/* 헤더 + 상태 */}
      <div style={box}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 800, color: T.txt }}>🧪 MOCK 자동매매</span>
            <span style={{ background: T.prp + '20', color: T.prp, fontSize: 9, fontWeight: 800, padding: '2px 7px', borderRadius: 5 }}>MOCK</span>
          </div>
          <span style={{ fontSize: 11, fontWeight: 800, color: running ? T.grn : T.muted }}>
            {running ? '● 실행중' : '○ 정지'}
          </span>
        </div>

        {/* 컨트롤 */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button onClick={() => setRunning(r => { const nv = !r; notify('bot', nv ? 'MOCK 자동매매 시작' : 'MOCK 자동매매 중지', nv ? `BTC · ${intervalSec}초 주기` : undefined); return nv; })} style={btn(running ? T.red : T.grn)}>
            {running ? '정지' : '자동매매 시작'}
          </button>
          <select value={intervalSec} onChange={e => setIv(Number(e.target.value))}
            style={{ padding: '8px 10px', borderRadius: 8, background: T.alt, color: T.txt, border: `1px solid ${T.border}`, fontSize: 12, fontWeight: 700 }}>
            <option value={5}>5초</option><option value={10}>10초</option><option value={30}>30초</option>
          </select>
          <select value={priceMode} onChange={e => setPriceMode(e.target.value as any)}
            style={{ padding: '8px 10px', borderRadius: 8, background: T.alt, color: T.txt, border: `1px solid ${T.border}`, fontSize: 12, fontWeight: 700 }}>
            <option value="sim">시뮬 시세</option><option value="real">실제 시세</option>
          </select>
        </div>

        {/* 상태 그리드 */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 12 }}>
          <div style={{ background: T.alt, borderRadius: 8, padding: '8px 10px' }}>
            <div style={{ fontSize: 9, color: T.muted, marginBottom: 2 }}>마지막 실행</div>
            <div style={{ fontSize: 12, fontWeight: 700, color: T.txt }}>{lastRunAt ? new Date(lastRunAt).toLocaleTimeString('ko-KR') : '-'}</div>
          </div>
          <div style={{ background: T.alt, borderRadius: 8, padding: '8px 10px' }}>
            <div style={{ fontSize: 9, color: T.muted, marginBottom: 2 }}>총 매매 횟수</div>
            <div style={{ fontSize: 12, fontWeight: 700, color: T.txt }}>{tradeCount}회</div>
          </div>
        </div>
        <div style={{ background: T.alt, borderRadius: 8, padding: '8px 10px', marginTop: 8 }}>
          <div style={{ fontSize: 9, color: T.muted, marginBottom: 2 }}>마지막 조건 체크</div>
          <div style={{ fontSize: 12, fontWeight: 700, color: T.txt }}>{lastCheck}</div>
        </div>

        {/* 전략 설명 */}
        <div style={{ fontSize: 10, color: T.muted, marginTop: 10, lineHeight: 1.5 }}>
          기본 전략: BTC · 무포지션이면 롱 진입 · +{TP_PCT}% 익절 / -{SL_PCT}% 손절 · 진입 {ENTRY_KRW.toLocaleString('ko-KR')}원.
          거래소·Worker 없이 앱 내부에서만 동작합니다.
        </div>
      </div>

      {/* 테스트 버튼 */}
      <div style={{ ...box, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button onClick={testBuy} style={btn(T.grn)}>MOCK 테스트 매수</button>
        <button onClick={testSell} style={btn(T.red)}>MOCK 테스트 매도</button>
        <button onClick={() => runOnce()} style={btn(T.blu || '#2563EB')}>MOCK 1회 실행</button>
      </div>

      {/* 현재 포지션 */}
      <div style={box}>
        <div style={{ fontSize: 12, fontWeight: 800, color: T.txt, marginBottom: 8 }}>현재 모의 포지션</div>
        {openPos.length === 0 ? (
          <div style={{ fontSize: 11, color: T.muted }}>보유 포지션 없음</div>
        ) : openPos.map(p => (
          <div key={p.asset} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: T.txt, padding: '4px 0' }}>
            <span>{p.asset} · {p.side === 'short' ? '숏' : '롱'}</span>
            <span>{p.qty.toFixed(6)} @ {Math.round(p.avgPrice).toLocaleString('ko-KR')}원</span>
          </div>
        ))}
        <div style={{ fontSize: 10, color: T.muted, marginTop: 8 }}>
          모의 잔고: {Math.round(bal.krw).toLocaleString('ko-KR')}원 · 누적 PnL {bal.totalPnL >= 0 ? '+' : ''}{Math.round(bal.totalPnL).toLocaleString('ko-KR')}원
        </div>
      </div>

      {/* 매매내역 */}
      <div style={box}>
        <div style={{ fontSize: 12, fontWeight: 800, color: T.txt, marginBottom: 8 }}>매매내역 (최근 {logs.length})</div>
        {logs.length === 0 ? (
          <div style={{ fontSize: 11, color: T.muted }}>아직 매매내역이 없습니다. [시작] 또는 [테스트 매수]를 눌러보세요.</div>
        ) : logs.map(l => (
          <div key={l.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: `1px solid ${T.border}` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 10, fontWeight: 800, color: l.action === 'buy' ? T.grn : T.red }}>{l.action === 'buy' ? '매수' : '매도'}</span>
              <span style={{ fontSize: 11, color: T.txt }}>{Math.round(l.filledPrice || 0).toLocaleString('ko-KR')}원</span>
              {l.reason && <span style={{ fontSize: 9, color: T.muted }}>{l.reason}</span>}
            </div>
            <span style={{ fontSize: 9, color: T.muted }}>{new Date(l.at).toLocaleTimeString('ko-KR')}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
