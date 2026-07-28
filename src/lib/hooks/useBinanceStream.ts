'use client';
// src/lib/hooks/useBinanceStream.ts
//
// Binance 선물 실시간 스트림 (호가·체결·티커).
//
// 왜 필요한가
// ───────────
// TradingPage의 호가창은 현재가 주변에 Math.random()으로 수량을 만들어
// 보여주고 있었다. 화면은 그럴듯하지만 실제 시장 깊이와 무관하므로,
// 그걸 보고 슬리피지나 체결 강도를 판단하면 틀린 판단을 하게 된다.
//
// 설계
// ────
//  - 하나의 결합 스트림(combined stream)으로 세 채널을 함께 받는다.
//    연결을 셋으로 나누면 심볼을 바꿀 때마다 3배로 붙었다 떨어진다.
//  - 심볼이 바뀌면 이전 소켓을 확실히 닫는다. 안 닫으면 화면에 두 종목의
//    데이터가 섞여 들어온다.
//  - 끊기면 지수 백오프로 재연결한다. Binance는 24시간마다 연결을 끊는다.
//  - 탭이 백그라운드로 가면 브라우저가 소켓을 늦추거나 끊으므로,
//    다시 보이게 될 때 상태를 확인하고 필요하면 재연결한다.
import { useEffect, useRef, useState, useCallback } from 'react';

export interface DepthLevel { price: number; qty: number }

export interface StreamState {
  /** 매도 호가 — 낮은 가격부터 */
  asks: DepthLevel[];
  /** 매수 호가 — 높은 가격부터 */
  bids: DepthLevel[];
  /** 최근 체결 (최신이 앞) */
  trades: { price: number; qty: number; time: number; buyerMaker: boolean }[];
  lastPrice: number | null;
  markPrice: number | null;
  changePct: number | null;
  status: 'connecting' | 'live' | 'reconnecting' | 'error' | 'idle';
  error?: string;
}

const EMPTY: StreamState = {
  asks: [], bids: [], trades: [],
  lastPrice: null, markPrice: null, changePct: null,
  status: 'idle',
};

const MAX_TRADES = 30;
const MAX_BACKOFF_MS = 30_000;

/**
 * @param symbol   'BTCUSDT' 형식. 빈 값이면 연결하지 않는다.
 * @param enabled  false면 연결을 끊는다 (탭이 안 보일 때 등)
 */
export function useBinanceStream(symbol: string, enabled = true): StreamState {
  const [state, setState] = useState<StreamState>(EMPTY);

  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 언마운트·심볼 변경 후 도착한 이벤트가 상태를 덮어쓰지 않게 하는 표식
  const aliveRef = useRef(true);

  const cleanup = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws) {
      // onclose가 재연결을 걸지 않도록 핸들러를 먼저 떼어낸다
      ws.onopen = null; ws.onmessage = null; ws.onerror = null; ws.onclose = null;
      try { ws.close(); } catch { /* 이미 닫힘 */ }
    }
  }, []);

  const connect = useCallback((sym: string) => {
    if (typeof window === 'undefined' || !sym) return;
    cleanup();

    const s = sym.toLowerCase();
    const url =
      `wss://fstream.binance.com/stream?streams=` +
      `${s}@depth20@100ms/${s}@aggTrade/${s}@ticker`;

    setState(prev => ({ ...prev, status: retryRef.current ? 'reconnecting' : 'connecting' }));

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e: any) {
      setState(prev => ({ ...prev, status: 'error', error: e?.message || 'WebSocket 생성 실패' }));
      return;
    }
    wsRef.current = ws;

    ws.onopen = () => {
      if (!aliveRef.current) return;
      retryRef.current = 0;
      setState(prev => ({ ...prev, status: 'live', error: undefined }));
    };

    ws.onmessage = (ev) => {
      if (!aliveRef.current) return;
      let msg: any;
      try { msg = JSON.parse(ev.data); } catch { return; }
      const stream: string = msg?.stream || '';
      const d = msg?.data;
      if (!d) return;

      if (stream.includes('@depth')) {
        // b: bids, a: asks — [[price, qty], ...] 문자열로 온다
        const toLevels = (rows: any): DepthLevel[] =>
          (Array.isArray(rows) ? rows : [])
            .map((r: any) => ({ price: parseFloat(r[0]), qty: parseFloat(r[1]) }))
            .filter(l => Number.isFinite(l.price) && Number.isFinite(l.qty) && l.qty > 0);
        setState(prev => ({ ...prev, asks: toLevels(d.a), bids: toLevels(d.b) }));
        return;
      }

      if (stream.includes('@aggTrade')) {
        const t = {
          price: parseFloat(d.p), qty: parseFloat(d.q),
          time: Number(d.T) || Date.now(),
          buyerMaker: !!d.m,     // true면 매도 체결(매수자가 메이커)
        };
        if (!Number.isFinite(t.price)) return;
        setState(prev => ({
          ...prev,
          lastPrice: t.price,
          trades: [t, ...prev.trades].slice(0, MAX_TRADES),
        }));
        return;
      }

      if (stream.includes('@ticker')) {
        const last = parseFloat(d.c);
        const chg = parseFloat(d.P);
        setState(prev => ({
          ...prev,
          lastPrice: Number.isFinite(last) ? last : prev.lastPrice,
          changePct: Number.isFinite(chg) ? chg : prev.changePct,
        }));
      }
    };

    ws.onerror = () => {
      if (!aliveRef.current) return;
      setState(prev => ({ ...prev, status: 'reconnecting', error: '연결 오류' }));
    };

    ws.onclose = () => {
      if (!aliveRef.current || wsRef.current !== ws) return;
      wsRef.current = null;
      // 지수 백오프. Binance는 24시간마다 정상적으로 끊으므로 재연결은 예외가 아니다.
      const wait = Math.min(1000 * 2 ** retryRef.current, MAX_BACKOFF_MS);
      retryRef.current += 1;
      setState(prev => ({ ...prev, status: 'reconnecting' }));
      timerRef.current = setTimeout(() => {
        if (aliveRef.current) connect(sym);
      }, wait);
    };
  }, [cleanup]);

  useEffect(() => {
    aliveRef.current = true;

    if (!enabled || !symbol) {
      cleanup();
      setState(EMPTY);
      return () => { aliveRef.current = false; cleanup(); };
    }

    // 심볼이 바뀌면 이전 데이터를 지운다. 남겨두면 새 종목의 값이 채워지기
    // 전까지 이전 종목의 호가가 그대로 보인다.
    setState({ ...EMPTY, status: 'connecting' });
    retryRef.current = 0;
    connect(symbol);

    // 탭이 다시 보일 때 연결이 죽어 있으면 살린다
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      const ws = wsRef.current;
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        retryRef.current = 0;
        connect(symbol);
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      aliveRef.current = false;
      document.removeEventListener('visibilitychange', onVisible);
      cleanup();
    };
  }, [symbol, enabled, connect, cleanup]);

  return state;
}

/** 호가 총량 대비 누적 비율 — 깊이 막대 그리기용 */
export function depthBars(levels: DepthLevel[]): { level: DepthLevel; cumPct: number }[] {
  const total = levels.reduce((a, l) => a + l.qty, 0);
  if (total <= 0) return levels.map(level => ({ level, cumPct: 0 }));
  let cum = 0;
  return levels.map(level => {
    cum += level.qty;
    return { level, cumPct: (cum / total) * 100 };
  });
}

/** 최근 체결의 매수/매도 강도 (0~100, 매수 비중) */
export function buyPressure(trades: StreamState['trades']): number | null {
  if (!trades.length) return null;
  let buy = 0, sell = 0;
  for (const t of trades) {
    const v = t.price * t.qty;
    if (t.buyerMaker) sell += v; else buy += v;
  }
  const total = buy + sell;
  return total > 0 ? (buy / total) * 100 : null;
}
