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
  /** 마지막으로 데이터가 도착한 시각 (ms). 없으면 한 번도 못 받았다 */
  lastMessageAt: number | null;
  /**
   * 연결은 살아 있는데 데이터가 멈춘 상태.
   *
   * status만으로는 부족하다. 실제로 겪은 문제가 정확히 이것이었다 —
   * Binance가 연결은 받아주고 데이터는 안 보내서 화면에 '● 실시간'이
   * 떠 있는데 호가는 비어 있었다. onclose가 안 오므로 재연결 로직도
   * 돌지 않는다. 연결 여부(status)와 신선도(stale)는 다른 축이다.
   */
  stale: boolean;
  error?: string;
}

const EMPTY: StreamState = {
  asks: [], bids: [], trades: [],
  lastPrice: null, markPrice: null, changePct: null,
  status: 'idle', lastMessageAt: null, stale: false,
};

const MAX_TRADES = 30;
const MAX_BACKOFF_MS = 30_000;

// depth는 100ms마다 온다. 8초면 80회를 놓친 것이므로 정상이 아니다.
const STALE_MS = 8_000;
// 여기까지 조용하면 소켓이 살아 있어도 죽은 것으로 보고 다시 붙는다.
const DEAD_MS = 25_000;
// 감시 주기. 표시 지연을 1초 이내로 유지한다.
const WATCHDOG_MS = 1_000;

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
  // 마지막 수신 시각. 메시지마다 setState하면 100ms마다 리렌더가 한 번 더
  // 늘어나므로 ref에 두고, 감시 타이머가 1초에 한 번만 상태로 옮긴다.
  const lastMsgRef = useRef<number | null>(null);

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

    // ── 스트림 선택 ──
    // 이 서비스가 닿는 범위에서 Binance 선물 스트림이 선별적으로 제한된다.
    // 실측(2026-07): 9초 동안
    //   depth20     정상        bookTicker  1737건
    //   aggTrade    0건         ticker      0건
    //   markPrice   0건         kline_1m    0건
    // 체결·시세 계열은 오지 않고 호가·북 계열만 온다. 현물 aggTrade는 오지만
    // 선물 호가에 현물 체결을 섞으면 서로 다른 시장의 값이 한 화면에 놓인다.
    // 그래서 오는 것만 쓴다: depth(호가) + bookTicker(최우선 호가 → 현재가).
    // 24시간 변동률은 REST로 따로 받는다 (아래 pollTicker).
    const s = sym.toLowerCase();
    const url =
      `wss://fstream.binance.com/stream?streams=` +
      `${s}@depth20@100ms/${s}@bookTicker`;

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
      // 연결됐다고 해서 데이터가 오는 것은 아니다. 신선도 시계는 여기서
      // 시작하되, 실제 수신이 없으면 곧 stale로 넘어간다.
      lastMsgRef.current = Date.now();
      setState(prev => ({ ...prev, status: 'live', stale: false, error: undefined }));
    };

    ws.onmessage = (ev) => {
      if (!aliveRef.current) return;
      lastMsgRef.current = Date.now();
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

      if (stream.includes('@bookTicker')) {
        // b/a = 최우선 매수/매도 호가. 체결가 스트림이 오지 않으므로
        // 이 둘의 중간값을 현재가로 쓴다.
        const bid = parseFloat(d.b), ask = parseFloat(d.a);
        if (!Number.isFinite(bid) || !Number.isFinite(ask)) return;
        setState(prev => ({ ...prev, lastPrice: (bid + ask) / 2 }));
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
      // stale은 '연결됐는데 조용함'을 뜻한다. 끊긴 상태는 status가 말해주므로
      // 둘을 동시에 켜두면 같은 사실을 두 번 말하게 된다.
      setState(prev => ({ ...prev, status: 'reconnecting', stale: false }));
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
    lastMsgRef.current = null;
    connect(symbol);

    // ── 무응답 감시 ──
    // 소켓이 열려 있어도 데이터가 안 오면 화면은 옛 값을 계속 보여준다.
    // 그 상태에서 '실시간'이라고 표기하는 것이 가장 위험하다 — 멈춘 호가를
    // 보고 진입 판단을 하게 된다. 그래서 두 단계로 다룬다:
    //   8초 무응답  → stale 표시 (사용자에게 알린다)
    //  25초 무응답  → 소켓을 강제로 닫는다 (onclose가 백오프 재연결을 건다)
    const watchdog = setInterval(() => {
      if (!aliveRef.current) return;
      const last = lastMsgRef.current;
      if (last === null) return;                 // 아직 연결 중
      const age = Date.now() - last;

      setState(prev => {
        if (prev.status !== 'live') return prev;  // 끊긴 상태는 status가 이미 말해준다
        const nextStale = age > STALE_MS;
        if (nextStale === prev.stale && prev.lastMessageAt === last) return prev;
        return { ...prev, stale: nextStale, lastMessageAt: last };
      });

      if (age > DEAD_MS) {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          // 닫으면 onclose가 지수 백오프로 다시 붙인다. 여기서 직접
          // connect를 부르면 백오프를 건너뛰어 재연결 폭주가 된다.
          lastMsgRef.current = Date.now();       // 닫는 동안 반복 트리거 방지
          try { ws.close(); } catch { /* 이미 닫힘 */ }
        }
      }
    }, WATCHDOG_MS);

    // ── 24시간 변동률 (REST) ──
    // @ticker 스트림이 오지 않으므로 REST로 받는다. 5초 주기면 충분하다 —
    // 24시간 변동률은 초 단위로 의미가 바뀌는 값이 아니다.
    let pollAlive = true;
    const pollTicker = async () => {
      try {
        const r = await fetch(`https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${symbol}`);
        if (!r.ok || !pollAlive) return;
        const d = await r.json();
        const chg = parseFloat(d?.priceChangePercent);
        if (Number.isFinite(chg) && aliveRef.current) {
          setState(prev => ({ ...prev, changePct: chg }));
        }
      } catch { /* 실패하면 다음 주기에 다시 시도 */ }
    };
    pollTicker();
    const pollTimer = setInterval(pollTicker, 5000);

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
      pollAlive = false;
      clearInterval(pollTimer);
      clearInterval(watchdog);
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

/**
 * 호가 잔량 기준 매수 비중 (0~100).
 *
 * 원래는 체결(aggTrade)로 매수·매도 강도를 재려 했으나 그 스트림이 오지
 * 않는다. 대신 실제로 오는 호가 잔량으로 계산한다. 체결 강도와 같은 값은
 * 아니다 — "지금 어느 쪽에 주문이 더 쌓여 있는가"를 뜻한다.
 * 화면에서도 '호가 잔량'이라고 표기해야 오해가 없다.
 */
export function bookImbalance(state: Pick<StreamState, 'asks' | 'bids'>): number | null {
  const bidQty = state.bids.reduce((a, l) => a + l.qty, 0);
  const askQty = state.asks.reduce((a, l) => a + l.qty, 0);
  const total = bidQty + askQty;
  return total > 0 ? (bidQty / total) * 100 : null;
}
