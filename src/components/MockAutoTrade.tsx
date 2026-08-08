'use client';
import { A } from '@/lib/theme/colors';
// ─────────────────────────────────────────────────────────────
// MockAutoTrade — 앱 내부 완결형 모의(MOCK) 자동매매
// 거래소 API / Worker / jobs queue를 전혀 쓰지 않고, 브라우저 안에서
// 기본 테스트 전략을 주기적으로 돌려 paper 매매내역을 생성한다.
// 실제 주문 절대 없음. Kill Switch/권한/Worker 검사 없음(독립 실행).
// ─────────────────────────────────────────────────────────────
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { T } from '@/lib/constants';
import { DURABILITY_NOTE } from '@/lib/runtime/persistentRuntime';
import { SliderField } from '@/components/ui/SettingField';
import {
  SOURCE_LABEL, SOURCE_DESC, SOURCE_SUMMARY, sourceBadge, feedStatusOf, sourceOf,
  type PriceSource,
} from '@/lib/ui/priceSource';
import { notify } from '@/lib/notify/center';
import { writeMockHeartbeat } from '@/lib/engineStatus';
import { logDecision } from '@/lib/autotrade/auditLog';
import {
  paperBuy, closePaperPosition, getOpenPositions,
  loadLogs, saveLog, loadPaperBalance,
} from '@/lib/autotrade/store';
import type { ExecutionLog } from '@/lib/autotrade/types';
import { decide, type Decision } from '@/lib/autotrade/decision';
import {
  restoreVerdict, resumePlan, applyGap, performanceOf, equityOf,
  type MockSession,
} from '@/lib/runtime/mockSession';

const ASSET = 'BTC';
const STRAT_ID = 'mock-test-btc';
const STRAT_NAME = 'MOCK 테스트 전략 (BTC)';
const ENTRY_KRW = 1_000_000;   // 진입당 100만원 (시드 1000만의 10%)
const TP_PCT = 0.3;            // +0.3% 익절
const SL_PCT = 0.2;            // -0.2% 손절
const FALLBACK_PRICE = 140_000_000; // BTC 원화 대략치 (실시세 실패 시)

// ── 세션의 뼈대만 브라우저에 남긴다 ──────────────────────
//
// 잔고와 포지션은 이미 autotrade/store에 있다. 여기서 따로 챙기는 것은
// **"언제 마지막으로 돌았고, 얼마나 꺼져 있었나"** 뿐이다.
//
// 이게 왜 필요한가: 새로고침하면 컴포넌트 상태가 날아가면서 `lastRunAt`이
// null이 된다. 그러면 12시간을 꺼 두고 다시 켜도 화면은 아무 일 없었던
// 것처럼 이어 그린다. 사흘치 성과에 "그중 이틀은 안 돌았다"가 안 붙는다.
//
// **놓친 구간은 채우지 않고 센다.** 채우려면 그 사이 시장을 알아야 하는데
// 우리는 모르고, 지어낸 체결은 없던 거래를 만든다.
const SESSION_KEY = 'tg_mock_session_v1';
const MOCK_SEED = 10_000_000;

function loadSession(): { row: any; readFailed: boolean } {
  if (typeof window === 'undefined') return { row: null, readFailed: false };
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    if (!raw) return { row: null, readFailed: false };
    return { row: JSON.parse(raw), readFailed: false };
  } catch {
    // 깨진 것을 '없음'으로 읽으면 빈 구간이 통째로 사라진다.
    return { row: null, readFailed: true };
  }
}

function saveSession(s: MockSession): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch {}
}

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
  const [priceMode, setPriceMode] = useState<PriceSource>('SIMULATED');
  /** 실시간을 골랐는데 못 읽은 상태. **가상으로 안 바꾼다** */
  const [feedDown, setFeedDown] = useState<string>('');
  const [lastRunAt, setLastRunAt] = useState<number | null>(null);
  const [lastCheck, setLastCheck] = useState<string>('아직 실행 안 함');
  const [now, setNow] = useState(Date.now());
  // 1초마다 now 갱신 (다음 체크 카운트다운용) — 실행 중일 때만
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  // ── 세션 ──
  //
  // `session`은 잔고가 아니라 **시간에 대한 기록**이다. 마지막 틱 시각과
  // 빈 구간 통계만 들고 있다.
  const [session, setSession] = useState<MockSession | null>(null);
  /** 세션을 못 읽었다 — 새로 시작하면 기록이 사라진다 */
  const [sessionBlock, setSessionBlock] = useState('');
  /** 마지막으로 재개할 때 빈 구간이 있었는가 */
  const [gapNote, setGapNote] = useState('');
  /** 이번 틱에서 실제로 읽은 가격. 못 읽으면 null — 직전 값을 안 남긴다 */
  const [mark, setMark] = useState<number | null>(null);

  useEffect(() => {
    const { row, readFailed } = loadSession();
    const v = restoreVerdict(readFailed ? undefined : row, { readFailed });
    if (v.action === 'BLOCK') { setSessionBlock(v.reason); return; }
    if (v.action === 'START_FRESH') {
      setSession({
        id: 'mock-btc', seed: MOCK_SEED, cash: MOCK_SEED,
        positions: [], openOrders: [],
        // 아직 안 켰다. **여기서 Date.now()를 넣으면 안 된다** — 화면을
        // 열어만 두고 안 켠 시간이 가동률의 분모에 들어간다.
        startedAtMs: null,
        lastTickAtMs: null, intervalSec: 10,
        status: 'STOPPED', configVersion: 1, gapCount: 0, gapMs: 0,
      });
      return;
    }
    setSession(v.session);
  }, []);

  const [tick, setTick]         = useState(0);          // 리렌더 트리거
  const [toast, setToast]       = useState('');
  const [decision, setDecision] = useState<Decision | null>(null);   // 최근 AI 판단 (XAI)
  const [confThreshold, setConfThreshold] = useState(70);            // 이 신뢰도 이상만 진입

  const simPriceRef = useRef<number>(0);
  const priceHistRef = useRef<number[]>([]);                          // 지표 계산용 가격 버퍼
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
  const getMarkPrice = useCallback(async (): Promise<number | null> => {
    if (priceMode === 'LIVE_MARKET') {
      // ── 못 읽으면 **가상으로 바꾸지 않는다** ──
      //
      // 예전에는 여기서 조용히 아래로 흘러 랜덤워크를 만들었다.
      // 사용자는 실제 시장으로 검증하고 있다고 믿는데 실제로는 ±0.2%
      // 난수를 보고 있었고, 그 승률·손익은 아무 뜻이 없다. 화면에도
      // 한 글자 안 떴다.
      //
      // 자동 전환은 사용자가 고른 것과 다른 것을 돌리는 일이다.
      // 멈추고 그렇다고 말하는 쪽이 언제나 낫다.
      let live: number | null = null;
      try {
        const r = await fetch(`/api/prices?action=coin&symbol=${ASSET}`);
        const d = await r.json();
        if (d?.price && d.price > 0) live = Number(d.price);
      } catch { /* live는 null로 남는다 */ }

      const v = feedStatusOf('LIVE_MARKET', live);
      setFeedDown(v.canTrade ? '' : v.reason);
      if (!v.canTrade) return null;
      simPriceRef.current = live!;
      return live;
    }
    setFeedDown('');
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
      // **가격이 없으면 이 회차를 통째로 건너뛴다.** 지어낸 값으로
      // 지표를 채우면 그 위에서 나온 판단이 전부 뜻을 잃는다.
      // **못 읽었으면 직전 가격을 지운다.** 남겨 두면 평가액이 멈춘 시계
      // 위에서 계속 그려지고, 급락 중에도 화면이 평온하다.
      if (price == null) { setMark(null); setLastRunAt(Date.now()); return; }
      // 가격 버퍼 업데이트 (지표 계산용, 최근 40개)
      const hist = [...priceHistRef.current, price].slice(-40);
      priceHistRef.current = hist;
      // 이 틱에서 실제로 읽은 가격. 평가에는 **이것만** 쓴다 —
      // 시세가 끊긴 뒤에는 아래에서 지운다.
      setMark(price);
      const pos = getOpenPositions().find(p => p.asset === ASSET);
      setLastRunAt(Date.now());

      // ── AI 판단 (설명가능) ──
      const d = decide({
        prices: hist, hasPosition: !!(pos && pos.qty > 0),
        entryPrice: pos?.avgPrice, side: (pos?.side as any) || 'long',
        tpPct: TP_PCT, slPct: SL_PCT, confThreshold,
      });
      setDecision(d);
      writeMockHeartbeat({
        running: true, intervalSec,
        lastDecision: d.summary, confidence: d.confidence, marketState: d.marketState,
        openPositions: getOpenPositions().filter(p => p.asset === ASSET).length,
      });
      setLastCheck(d.summary);

      // ── AI 감사 로그 (모든 판단 기록) ──
      logDecision({
        action: d.action, confidence: d.confidence, marketState: d.marketState,
        summary: d.summary, reasons: d.reasons, price, asset: ASSET,
        executed: d.action === 'enter_long' || d.action === 'exit_tp' || d.action === 'exit_sl',
        source: 'mock',
      });

      if (d.action === 'exit_tp' || d.action === 'exit_sl') {
        const isTp = d.action === 'exit_tp';
        const res = closePaperPosition(ASSET, price);
        saveLog(mkLog('sell', price, { reason: d.summary, filledQuantity: pos!.qty }));
        notify(isTp ? 'tp' : 'sl', isTp ? 'MOCK 익절 청산' : 'MOCK 손절 청산',
          `BTC · 실현손익 ${res.pnl >= 0 ? '+' : ''}₩${Math.round(res.pnl).toLocaleString('ko-KR')} · ${d.summary}`);
      } else if (d.action === 'enter_long') {
        const r = paperBuy(ASSET, price, ENTRY_KRW, { side: 'long', stratId: STRAT_ID, takeProfitPct: TP_PCT, stopLossPct: SL_PCT });
        if (r.ok) {
          saveLog(mkLog('buy', price, { filledAmount: ENTRY_KRW, filledQuantity: r.qty, aiSource: 'rule', reason: d.reasons.filter(x => x.met).map(x => x.label).join(', ') }));
          // 판단 이유를 알림에 포함 (XAI)
          notify('buy', 'MOCK 진입 (롱)',
            `BTC @ ${Math.round(price).toLocaleString('ko-KR')} · 신뢰도 ${d.confidence}% · ${d.marketState}\n이유: ${d.reasons.filter(x => x.met).map(x => x.label).join(', ')}`);
        }
      }
      // hold / wait → 알림 없이 판단 카드에만 표시 (아무것도 안 하는 이유가 UI에 항상 보임)
    } finally {
      busyRef.current = false;
      // **실제로 한 틱을 돈 시각만 남긴다.** 이 줄이 없으면 새로고침
      // 이후의 빈 구간을 잴 기준이 없다.
      setSession(s => {
        if (!s) return s;
        const next: MockSession = { ...s, lastTickAtMs: Date.now(), status: 'RUNNING' };
        saveSession(next);
        return next;
      });
      refresh();
    }
  }, [getMarkPrice, refresh, confThreshold]);

  // 자동 루프
  useEffect(() => {
    if (!running) { if (timerRef.current) clearInterval(timerRef.current); timerRef.current = null; return; }

    // ── 다시 켤 때: 빈 구간을 세되 채우지 않는다 ──
    //
    // 12시간 꺼져 있었으면 12시간 안 돈 것이다. 놓친 720번을 되돌려
    // 계산하면 실제로 한 번도 일어나지 않은 거래로 성과가 채워지고,
    // **사용자는 그 성과를 보고 실전 전환을 결정한다.**
    setSession(s => {
      if (!s) return s;
      const plan = resumePlan(s, Date.now());
      setGapNote(plan.note);
      if (!plan.markGap) return s;
      const next = applyGap(s, plan, Date.now());
      saveSession(next);
      return next;
    });

    runOnce();  // 시작 즉시 1회
    timerRef.current = setInterval(runOnce, intervalSec * 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [running, intervalSec, runOnce]);

  // ── 테스트 버튼 핸들러 ──
  const testBuy = async () => {
    const price = await getMarkPrice();
    if (price == null) { showToast('시세를 읽지 못해 매수하지 않았습니다'); return; }
    const r = paperBuy(ASSET, price, ENTRY_KRW, { side: 'long', stratId: STRAT_ID, takeProfitPct: TP_PCT, stopLossPct: SL_PCT });
    if (r.ok) { saveLog(mkLog('buy', price, { filledAmount: ENTRY_KRW, filledQuantity: r.qty, reason: '수동 테스트 매수' })); showToast('테스트 매수 체결'); }
    else showToast(`매수 실패: ${r.reason}`);
    refresh();
  };
  const testSell = async () => {
    const price = await getMarkPrice();
    // **못 읽었으면 청산도 지어낸 가격으로 하지 않는다.** 손익 기록이
    // 난수 위에서 만들어지면 그 장부 전체가 뜻을 잃는다.
    if (price == null) { showToast('시세를 읽지 못해 청산하지 않았습니다'); return; }
    const pos = getOpenPositions().find(p => p.asset === ASSET);
    if (!pos) { showToast('청산할 포지션 없음'); return; }
    const res = closePaperPosition(ASSET, price);
    saveLog(mkLog('sell', price, { filledQuantity: pos.qty, reason: `수동 테스트 매도 (PnL ${Math.round(res.pnl).toLocaleString('ko-KR')})` }));
    showToast(`테스트 매도 체결 (PnL ${res.pnl >= 0 ? '+' : ''}${Math.round(res.pnl).toLocaleString('ko-KR')}원)`);
    refresh();
  };

  // ── 표시 데이터 ──
  const bal = loadPaperBalance();
  // 모의 성과. **가동률과 '모의라서 좋게 나온다'는 사실을 같이 낸다.**
  // 수익률만 크게 띄우면 그 숫자가 실전에서도 나올 거라고 읽힌다.
  // 평가액 = 현금 + 포지션. **현재가를 못 읽었으면 내지 않는다.**
  // bal.krw만 쓰면 포지션을 든 동안 평가액이 통째로 빠져 수익률이
  // 실제보다 나쁘게 나오고, 직전 가격을 쓰면 급락이 안 보인다.
  const mockEq = equityOf(
    bal.readFailed ? null : {
      cash: bal.krw,
      positions: Object.entries(bal.positions || {}).map(([symbol, p]: [string, any]) => ({
        symbol, side: p?.side === 'short' ? 'SHORT' as const : 'LONG' as const,
        qty: p?.qty, entryPrice: p?.avgPrice,
      })),
    },
    mark != null ? { [ASSET]: mark } : {},
  );
  const perf = performanceOf(session, mockEq.equity, now);
  const openPos = getOpenPositions().filter(p => p.asset === ASSET);
  const allLogs = Array.isArray(loadLogs()) ? loadLogs() : [];
  const logs = allLogs.filter(l => l.strategyId === STRAT_ID).slice(0, 12);
  const tradeCount = allLogs.filter(l => l.strategyId === STRAT_ID).length;
  // 오늘 체결 횟수
  const todayStr = new Date().toDateString();
  const todayFills = allLogs.filter(l => l.strategyId === STRAT_ID && new Date(l.at).toDateString() === todayStr).length;
  // 다음 체크까지 남은 시간
  const nextRunAt = lastRunAt ? lastRunAt + intervalSec * 1000 : null;
  const nextInSec = running && nextRunAt ? Math.max(0, Math.ceil((nextRunAt - now) / 1000)) : null;
  // 정지 사유 (실행 중이 아닐 때)
  const stoppedReason = !running
    ? (lastRunAt ? '사용자가 정지함' : '시작 대기 중 — [자동매매 시작]을 누르세요')
    : null;
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
            <span style={{ background: A(T.prp,'20'), color: T.prp, fontSize: 9, fontWeight: 800, padding: '2px 7px', borderRadius: 5 }}>MOCK</span>
          </div>
          <span style={{ fontSize: 11, fontWeight: 800, color: running ? T.ylw : T.muted }}>
            {/* **'실행중'이라고만 쓰지 않는다.** 이건 브라우저 타이머라
                이 화면을 떠나면 멈춘다. 그 사실을 상태 옆에 붙인다 —
                사용자는 '실행중'을 앱을 닫아도 된다는 뜻으로 읽는다. */}
            {running ? '● 이 화면에서만 실행중' : '○ 정지'}
          </span>
        </div>

        {/* 컨트롤 */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {/* **못 여는 것은 불편이고 못 닫는 것은 사고다** — 그래서
              세션을 못 읽었을 때도 정지는 언제나 눌린다. 막는 것은
              시작뿐이다. */}
          <button
            disabled={!!sessionBlock && !running}
            onClick={() => setRunning(r => {
              const nv = !r;
              if (nv) {
                // 처음 켜는 순간을 남긴다. 이게 가동률의 분모다.
                setSession(s => {
                  if (!s) return s;
                  const next = s.startedAtMs == null ? { ...s, startedAtMs: Date.now() } : s;
                  if (next !== s) saveSession(next);
                  return next;
                });
              }
              notify('bot', nv ? 'MOCK 자동매매 시작' : 'MOCK 자동매매 중지', nv ? `BTC · ${intervalSec}초 주기` : undefined);
              writeMockHeartbeat({ running: nv, intervalSec });
              return nv;
            })}
            style={{ ...btn(running ? T.red : T.grn), opacity: (!!sessionBlock && !running) ? 0.45 : 1, cursor: (!!sessionBlock && !running) ? 'not-allowed' : 'pointer' }}>
            {running ? '정지' : '자동매매 시작'}
          </button>
          <select value={intervalSec} onChange={e => setIv(Number(e.target.value))}
            style={{ padding: '8px 10px', borderRadius: 8, background: T.alt, color: T.txt, border: `1px solid ${T.border}`, fontSize: 12, fontWeight: 700 }}>
            <option value={5}>5초</option><option value={10}>10초</option><option value={30}>30초</option>
          </select>
          {/* **'실제 시세'라고 쓰지 않는다.** 그 말은 실제 주문으로
              읽힌다 — 가격만 진짜고 체결은 여전히 MOCK이다. */}
          <select value={priceMode} onChange={e => setPriceMode(sourceOf(e.target.value))}
            style={{ padding: '8px 10px', borderRadius: 8, background: T.alt, color: T.txt, border: `1px solid ${T.border}`, fontSize: 12, fontWeight: 700 }}>
            <option value="SIMULATED">{SOURCE_LABEL.SIMULATED}</option>
            <option value="LIVE_MARKET">{SOURCE_LABEL.LIVE_MARKET}</option>
          </select>
          {/* 실시간을 골라도 MOCK 표시는 사라지지 않는다 */}
          <span style={{
            padding: '4px 8px', borderRadius: 6, background: T.alt,
            color: T.muted, fontSize: 10, fontWeight: 700,
          }}>{sourceBadge(priceMode)}</span>
        </div>

        {/* **고른 것이 무엇인지 늘 한 줄로 적는다.**
            이름만으로는 둘의 차이를 알 수 없다. */}
        <div style={{ marginTop: 6, fontSize: 10, color: T.muted, lineHeight: 1.6 }}>
          {SOURCE_SUMMARY[priceMode]} — {SOURCE_DESC[priceMode]}
        </div>

        {/* ── 세션을 못 읽었다 ──
            **여기서 새로 시작하면 사흘치 기록이 사라진다.** 그리고
            잔고가 종잣돈으로 되돌아가 아무 일 없던 것처럼 보인다 —
            사용자는 그게 조회 실패였다는 것을 영영 모른다. */}
        {sessionBlock && (
          <div style={{
            marginTop: 8, padding: '9px 11px', borderRadius: 8,
            background: T.alt, color: T.red, fontSize: 11, lineHeight: 1.6,
            border: `1px solid ${T.red}55`,
          }}>
            <b>세션을 읽지 못했습니다 — 시작을 막았습니다</b>
            <div style={{ color: T.muted, marginTop: 3 }}>{sessionBlock}</div>
          </div>
        )}

        {/* ── 꺼져 있던 구간 ──
            **놓친 만큼 되돌려 계산하지 않는다.** 12시간 꺼져 있었으면
            12시간 안 돈 것이고, 그 720번을 지어내면 실제로 한 번도
            일어나지 않은 거래로 성과가 채워진다. */}
        {gapNote && (
          <div style={{
            marginTop: 8, padding: '9px 11px', borderRadius: 8,
            background: T.alt, color: T.ylw, fontSize: 11, lineHeight: 1.6,
            border: `1px solid ${T.ylw}55`,
          }}>
            <b>꺼져 있던 구간이 있습니다</b>
            <div style={{ color: T.muted, marginTop: 3 }}>{gapNote}</div>
          </div>
        )}

        {/* ── 시세가 끊겼다 ──
            **가상 가격으로 바꾸지 않는다.** 자동 전환은 사용자가 고른 것과
            다른 것을 돌리는 일이고, 그 결과로 나온 승률은 아무 뜻이 없다. */}
        {feedDown && (
          <div style={{
            marginTop: 8, padding: '8px 10px', borderRadius: 8,
            background: T.alt, color: T.red, fontSize: 11, lineHeight: 1.6,
            border: `1px solid ${T.red}55`,
          }}>
            <b>시세 연결 끊김</b>
            <div style={{ color: T.muted, marginTop: 2 }}>{feedDown}</div>
          </div>
        )}

        {/* 상태 그리드 */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginTop: 12 }}>
          <div style={{ background: T.alt, borderRadius: 8, padding: '8px 10px' }}>
            <div style={{ fontSize: 9, color: T.muted, marginBottom: 2 }}>마지막 체크</div>
            <div style={{ fontSize: 12, fontWeight: 700, color: T.txt }}>{lastRunAt ? new Date(lastRunAt).toLocaleTimeString('ko-KR') : '-'}</div>
          </div>
          <div style={{ background: T.alt, borderRadius: 8, padding: '8px 10px' }}>
            <div style={{ fontSize: 9, color: T.muted, marginBottom: 2 }}>다음 체크</div>
            <div style={{ fontSize: 12, fontWeight: 700, color: running ? T.grn : T.muted }}>{nextInSec != null ? `${nextInSec}초 후` : '정지'}</div>
          </div>
          <div style={{ background: T.alt, borderRadius: 8, padding: '8px 10px' }}>
            <div style={{ fontSize: 9, color: T.muted, marginBottom: 2 }}>활성 포지션</div>
            <div style={{ fontSize: 12, fontWeight: 700, color: T.txt }}>{openPos.length}개</div>
          </div>
          <div style={{ background: T.alt, borderRadius: 8, padding: '8px 10px' }}>
            <div style={{ fontSize: 9, color: T.muted, marginBottom: 2 }}>오늘 체결</div>
            <div style={{ fontSize: 12, fontWeight: 700, color: T.txt }}>{todayFills}건</div>
          </div>
          <div style={{ background: T.alt, borderRadius: 8, padding: '8px 10px' }}>
            <div style={{ fontSize: 9, color: T.muted, marginBottom: 2 }}>총 매매</div>
            <div style={{ fontSize: 12, fontWeight: 700, color: T.txt }}>{tradeCount}회</div>
          </div>
          <div style={{ background: T.alt, borderRadius: 8, padding: '8px 10px' }}>
            <div style={{ fontSize: 9, color: T.muted, marginBottom: 2 }}>활성 전략</div>
            <div style={{ fontSize: 12, fontWeight: 700, color: T.txt }}>1개 (기본)</div>
          </div>
        </div>
        {/* ── AI 판단 카드 (XAI: 왜 행동했고 왜 대기하는지) ── */}
        <div style={{ background: T.alt, borderRadius: 8, padding: '10px', marginTop: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <div style={{ fontSize: 10, color: T.muted }}>AI 판단</div>
            {decision && (() => {
              const actC = decision.action === 'enter_long' ? T.grn : decision.action.startsWith('exit') ? T.ylw : decision.action === 'hold' ? T.blu || '#3B82F6' : T.muted;
              const actL = decision.action === 'enter_long' ? '진입' : decision.action === 'exit_tp' ? '익절' : decision.action === 'exit_sl' ? '손절' : decision.action === 'hold' ? '보유' : '대기';
              return <span style={{ background: actC + '22', color: actC, fontSize: 10, fontWeight: 800, padding: '2px 8px', borderRadius: 6 }}>{actL}</span>;
            })()}
          </div>
          {!decision ? (
            <div style={{ fontSize: 11, color: T.muted }}>{lastCheck}</div>
          ) : (
            <>
              {/* 시장 상태 + 신뢰도 바 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 10, color: T.muted }}>시장</span>
                <span style={{ fontSize: 11, fontWeight: 800, color: T.txt }}>{decision.marketState}</span>
                <span style={{ fontSize: 9, color: T.muted, marginLeft: 4 }}>추천: {decision.recommendedStrategy}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 10, color: T.muted, minWidth: 44 }}>신뢰도</span>
                <div style={{ flex: 1, height: 8, background: T.card, borderRadius: 4, overflow: 'hidden' }}>
                  <div style={{ width: `${decision.confidence}%`, height: '100%', background: decision.confidence >= confThreshold ? T.grn : decision.confidence >= 50 ? (T.ylw) : T.red, transition: 'width .3s' }} />
                </div>
                <span style={{ fontSize: 11, fontWeight: 800, color: decision.confidence >= confThreshold ? T.grn : T.txt, minWidth: 34, textAlign: 'right' }}>{decision.confidence}%</span>
              </div>
              {/* 판단 이유 (met/unmet) */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginBottom: 6 }}>
                {decision.reasons.map((r, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 9.5 }}>
                    <span style={{ color: r.met ? T.grn : T.red, fontWeight: 800 }}>{r.met ? '✓' : '✗'}</span>
                    <span style={{ color: T.muted }}>{r.label}</span>
                    <span style={{ color: T.txt, fontWeight: 600 }}>{r.value}</span>
                  </div>
                ))}
              </div>
              {/* 대기/보유 사유 강조 */}
              {(decision.action === 'wait' || decision.action === 'hold') && (
                <div style={{ fontSize: 10, color: decision.action === 'wait' ? T.ylw : T.txt, fontWeight: 700, marginTop: 4, paddingTop: 6, borderTop: `1px solid ${T.border}` }}>
                  {decision.action === 'wait' ? '지금 대기하는 이유' : '보유 상태'}: {decision.summary}
                </div>
              )}
            </>
          )}
        </div>
        {/* 신뢰도 임계값. 슬라이더만 두면 정확한 값을 못 넣는다 —
            폰에서 72를 맞추려면 손가락을 1px 단위로 움직여야 한다. */}
        <div style={{ marginTop: 8 }}>
          <SliderField label="진입 임계값 (이 신뢰도 이상만 진입)"
            value={confThreshold} base={70} unit="%"
            min={40} max={95} step={5}
            onChange={setConfThreshold}/>
        </div>
        {/* ── 이 실행기는 상시 실행이 아니다 ──
            브라우저가 살아 있어야만 동작하는 것을 '상시 실행'이라고 부르면
            사용자는 앱을 닫아도 된다는 뜻으로 읽는다. 돌고 있을 때 늘 적는다. */}
        {running && (
          <div style={{ background: A(T.ylw,'10'), border: `1px solid ${A(T.ylw,'28')}`, borderRadius: 8, padding: '8px 10px', marginTop: 8 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: T.ylw }}>⚠ 상시 실행이 아닙니다</div>
            <div style={{ fontSize: 9, color: T.muted, marginTop: 3, lineHeight: 1.55 }}>
              {DURABILITY_NOTE.BROWSER}
            </div>
          </div>
        )}
        {stoppedReason && (
          <div style={{ background: A(T.ylw,'12'), border: `1px solid ${A(T.ylw,'30')}`, borderRadius: 8, padding: '8px 10px', marginTop: 8 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: T.ylw }}>정지 사유: {stoppedReason}</div>
            <div style={{ fontSize: 9, color: T.muted, marginTop: 3 }}>참고: 이 실행기는 이 화면 안에서만 돕니다 — 상시 실행은 서버 Worker가 필요합니다.</div>
          </div>
        )}

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

        {/* ── 평가액과 성과 ──
            **수익률만 크게 띄우지 않는다.** 이 숫자에는 슬리피지도
            부분체결도 거래소 지연도 없고, 꺼져 있던 시간도 안 들어 있다.
            그 사실을 같이 안 적으면 사용자는 이 숫자가 실전에서도
            나올 거라고 읽고, 그 믿음으로 실전 전환을 결정한다. */}
        <div style={{ borderTop: `1px solid ${T.border}`, marginTop: 8, paddingTop: 8 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontSize: 10, color: T.muted }}>평가액</span>
            <span style={{ fontSize: 12, fontWeight: 800, color: mockEq.equity == null ? T.muted : T.txt }}>
              {mockEq.equity == null ? '확인 불가' : `${Math.round(mockEq.equity).toLocaleString('ko-KR')}원`}
            </span>
            {perf.returnPct != null && (
              <span style={{ fontSize: 11, fontWeight: 800, color: perf.returnPct >= 0 ? T.grn : T.red }}>
                {perf.returnPct >= 0 ? '+' : ''}{perf.returnPct.toFixed(2)}%
              </span>
            )}
            {perf.uptimePct != null && (
              <span style={{ fontSize: 10, color: perf.uptimePct >= 99 ? T.muted : T.ylw }}>
                가동 {perf.uptimePct.toFixed(0)}%
              </span>
            )}
          </div>
          {mockEq.note && (
            <div style={{ fontSize: 9.5, color: T.ylw, marginTop: 4, lineHeight: 1.6 }}>{mockEq.note}</div>
          )}
          <div style={{ fontSize: 9.5, color: T.muted, marginTop: 4, lineHeight: 1.6 }}>{perf.note}</div>
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
