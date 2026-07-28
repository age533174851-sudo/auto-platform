'use client';
// src/lib/hooks/useBinanceStream.ts
//
// Binance 선물 실시간 스트림 (호가·현재가·변동률).
//
// 왜 필요한가
// ───────────
// TradingPage의 호가창은 현재가 주변에 Math.random()으로 수량을 만들어
// 보여주고 있었다. 화면은 그럴듯하지만 실제 시장 깊이와 무관하므로,
// 그걸 보고 슬리피지나 체결 강도를 판단하면 틀린 판단을 하게 된다.
//
// 심볼 하나당 연결 하나
// ─────────────────────
// 예전에는 훅을 부르는 곳마다 소켓을 새로 열었다. 터미널만 해도 상단
// 가격·호가창·주문폼 셋이 같은 심볼을 보므로 depth20@100ms 스트림이
// 세 벌 들어왔다. 모바일에서는 그게 그대로 배터리와 데이터가 된다.
//
// 그래서 심볼별 허브를 모듈 수준에 두고 구독자가 나눠 쓴다.
// 마지막 구독자가 떠나도 곧바로 끊지 않는다 — 탭을 옮기거나 시트를
// 여닫을 때마다 붙었다 떨어지면 그게 더 비싸다.
import { useEffect, useState, useSyncExternalStore } from 'react';

export interface DepthLevel { price: number; qty: number }

export interface StreamState {
  /** 매도 호가 — 낮은 가격부터 */
  asks: DepthLevel[];
  /** 매수 호가 — 높은 가격부터 */
  bids: DepthLevel[];
  /** 최근 체결 (최신이 앞). 선물 체결 스트림이 오지 않아 현재는 비어 있다 */
  trades: { price: number; qty: number; time: number; buyerMaker: boolean }[];
  lastPrice: number | null;
  markPrice: number | null;
  changePct: number | null;
  status: 'connecting' | 'live' | 'reconnecting' | 'error' | 'idle';
  /** 마지막으로 데이터가 도착한 시각 (ms). 없으면 한 번도 못 받았다 */
  lastMessageAt: number | null;
  // ── 값별 수신 시각 ──
  // 하나로 묶으면 안 된다. 호가는 100ms마다 오고 변동률은 5초마다 오므로,
  // 같은 나이 표시를 붙이면 둘 중 하나는 반드시 거짓말이 된다.
  /** 호가(depth) 수신 시각 */
  depthAt: number | null;
  /** 현재가(bookTicker) 수신 시각 */
  priceAt: number | null;
  /** 24시간 변동률(REST) 수신 시각 */
  changeAt: number | null;
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

export const EMPTY_STREAM: StreamState = {
  asks: [], bids: [], trades: [],
  lastPrice: null, markPrice: null, changePct: null,
  status: 'idle', lastMessageAt: null, stale: false,
  depthAt: null, priceAt: null, changeAt: null,
};

const MAX_BACKOFF_MS = 30_000;
// depth는 100ms마다 온다. 8초면 80회를 놓친 것이므로 정상이 아니다.
const STALE_MS = 8_000;
// 여기까지 조용하면 소켓이 살아 있어도 죽은 것으로 보고 다시 붙는다.
const DEAD_MS = 25_000;
// 감시 주기. 표시 지연을 1초 이내로 유지한다.
const WATCHDOG_MS = 1_000;
// 마지막 구독자가 떠난 뒤 실제로 끊기까지 기다리는 시간.
// 시트를 여닫을 때마다 재연결하면 그게 더 비싸다.
const LINGER_MS = 10_000;

/**
 * 심볼 하나를 담당하는 연결. 구독자 수와 무관하게 소켓은 하나다.
 *
 * React 밖에 두는 이유: 컴포넌트 수명과 연결 수명이 달라야 한다.
 * 패널이 사라졌다고 연결까지 끊으면, 다시 열 때마다 처음부터 받는다.
 */
class SymbolHub {
  readonly symbol: string;
  private state: StreamState = { ...EMPTY_STREAM, status: 'connecting' };
  private listeners = new Set<() => void>();
  private ws: WebSocket | null = null;
  private retry = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lingerTimer: ReturnType<typeof setTimeout> | null = null;
  private lastMsgAt: number | null = null;
  private closed = false;

  constructor(symbol: string) {
    this.symbol = symbol;
  }

  getState = (): StreamState => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    if (this.lingerTimer) { clearTimeout(this.lingerTimer); this.lingerTimer = null; }
    if (!this.ws && !this.reconnectTimer && !this.closed) this.start();
    return () => {
      this.listeners.delete(fn);
      if (this.listeners.size === 0) this.scheduleClose();
    };
  };

  private emit(patch: Partial<StreamState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(fn => fn());
  }

  private start() {
    if (typeof window === 'undefined' || !this.symbol) return;
    this.closed = false;
    this.connect();
    this.watchdog = setInterval(this.tick, WATCHDOG_MS);
    this.poll();
    this.pollTimer = setInterval(this.poll, 5_000);
    document.addEventListener('visibilitychange', this.onVisible);
  }

  private scheduleClose() {
    if (this.lingerTimer) return;
    this.lingerTimer = setTimeout(() => {
      this.lingerTimer = null;
      if (this.listeners.size > 0) return;   // 그 사이 다시 붙었다
      this.destroy();
      HUBS.delete(this.symbol);
    }, LINGER_MS);
  }

  private destroy() {
    this.closed = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisible);
    }
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      // onclose가 재연결을 걸지 않도록 핸들러를 먼저 떼어낸다
      ws.onopen = null; ws.onmessage = null; ws.onerror = null; ws.onclose = null;
      try { ws.close(); } catch { /* 이미 닫힘 */ }
    }
  }

  private connect() {
    // ── 스트림 선택 ──
    // 이 서비스가 닿는 범위에서 Binance 선물 스트림이 선별적으로 제한된다.
    // 실측(2026-07): 9초 동안
    //   depth20     정상        bookTicker  1737건
    //   aggTrade    0건         ticker      0건
    //   markPrice   0건         kline_1m    0건
    // 체결·시세 계열은 오지 않고 호가·북 계열만 온다. 현물 aggTrade는 오지만
    // 선물 호가에 현물 체결을 섞으면 서로 다른 시장의 값이 한 화면에 놓인다.
    // 그래서 오는 것만 쓴다: depth(호가) + bookTicker(최우선 호가 → 현재가).
    const s = this.symbol.toLowerCase();
    const url = `wss://fstream.binance.com/stream?streams=${s}@depth20@100ms/${s}@bookTicker`;

    this.emit({ status: this.retry ? 'reconnecting' : 'connecting' });

    let ws: WebSocket;
    try { ws = new WebSocket(url); }
    catch (e: any) {
      this.emit({ status: 'error', error: e?.message || 'WebSocket 생성 실패' });
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.retry = 0;
      // 연결됐다고 데이터가 오는 것은 아니다. 시계는 여기서 시작하되
      // 실제 수신이 없으면 곧 stale로 넘어간다.
      this.lastMsgAt = Date.now();
      this.emit({ status: 'live', stale: false, error: undefined });
    };

    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.lastMsgAt = Date.now();
      let msg: any;
      try { msg = JSON.parse(ev.data); } catch { return; }
      const stream: string = msg?.stream || '';
      const d = msg?.data;
      if (!d) return;

      if (stream.includes('@depth')) {
        const toLevels = (rows: any): DepthLevel[] =>
          (Array.isArray(rows) ? rows : [])
            .map((r: any) => ({ price: parseFloat(r[0]), qty: parseFloat(r[1]) }))
            .filter(l => Number.isFinite(l.price) && Number.isFinite(l.qty) && l.qty > 0);
        this.emit({ asks: toLevels(d.a), bids: toLevels(d.b), depthAt: Date.now() });
        return;
      }

      if (stream.includes('@bookTicker')) {
        // b/a = 최우선 매수/매도 호가. 체결가 스트림이 오지 않으므로
        // 이 둘의 중간값을 현재가로 쓴다.
        const bid = parseFloat(d.b), ask = parseFloat(d.a);
        if (!Number.isFinite(bid) || !Number.isFinite(ask)) return;
        this.emit({ lastPrice: (bid + ask) / 2, priceAt: Date.now() });
      }
    };

    ws.onerror = () => {
      if (this.ws !== ws) return;
      this.emit({ status: 'reconnecting', error: '연결 오류' });
    };

    ws.onclose = () => {
      if (this.ws !== ws || this.closed) return;
      this.ws = null;
      // 지수 백오프. Binance는 24시간마다 정상적으로 끊으므로 재연결은 예외가 아니다.
      const wait = Math.min(1000 * 2 ** this.retry, MAX_BACKOFF_MS);
      this.retry += 1;
      // stale은 '연결됐는데 조용함'을 뜻한다. 끊긴 상태는 status가 말해주므로
      // 둘을 동시에 켜두면 같은 사실을 두 번 말하게 된다.
      this.emit({ status: 'reconnecting', stale: false });
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (!this.closed) this.connect();
      }, wait);
    };
  }

  // ── 무응답 감시 ──
  //   8초 무응답 → stale 표시 (사용자에게 알린다)
  //  25초 무응답 → 소켓을 강제로 닫는다 (onclose가 백오프 재연결을 건다)
  private tick = () => {
    const last = this.lastMsgAt;
    if (last === null) return;                     // 아직 연결 중
    const age = Date.now() - last;

    if (this.state.status === 'live') {
      const nextStale = age > STALE_MS;
      if (nextStale !== this.state.stale || this.state.lastMessageAt !== last) {
        this.emit({ stale: nextStale, lastMessageAt: last });
      }
    }

    if (age > DEAD_MS && this.ws && this.ws.readyState === WebSocket.OPEN) {
      // 닫으면 onclose가 지수 백오프로 다시 붙인다. 여기서 직접 connect를
      // 부르면 백오프를 건너뛰어 재연결 폭주가 된다.
      this.lastMsgAt = Date.now();                 // 닫는 동안 반복 트리거 방지
      try { this.ws.close(); } catch { /* 이미 닫힘 */ }
    }
  };

  // ── 24시간 변동률 (REST) ──
  // @ticker 스트림이 오지 않으므로 REST로 받는다. 5초 주기면 충분하다 —
  // 24시간 변동률은 초 단위로 의미가 바뀌는 값이 아니다.
  private poll = async () => {
    if (this.closed) return;
    try {
      const r = await fetch(`https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${this.symbol}`);
      if (!r.ok || this.closed) return;
      const d = await r.json();
      const chg = parseFloat(d?.priceChangePercent);
      if (Number.isFinite(chg)) this.emit({ changePct: chg, changeAt: Date.now() });
    } catch { /* 실패하면 다음 주기에 다시 시도 */ }
  };

  // 탭이 다시 보일 때 연결이 죽어 있으면 살린다
  private onVisible = () => {
    if (typeof document === 'undefined' || document.visibilityState !== 'visible') return;
    if (this.closed) return;
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING) {
      this.retry = 0;
      if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
      this.connect();
    }
  };
}

const HUBS = new Map<string, SymbolHub>();

function getHub(symbol: string): SymbolHub {
  let h = HUBS.get(symbol);
  if (!h) { h = new SymbolHub(symbol); HUBS.set(symbol, h); }
  return h;
}

/** 열려 있는 연결 수 — 진단·테스트용 */
export function activeStreamCount(): number {
  return HUBS.size;
}

/**
 * @param symbol   'BTCUSDT' 형식. 빈 값이면 연결하지 않는다.
 * @param enabled  false면 구독하지 않는다 (패널이 닫혀 있을 때 등)
 */
export function useBinanceStream(symbol: string, enabled = true): StreamState {
  const on = enabled && !!symbol;
  // 훅을 여러 곳에서 불러도 같은 심볼이면 소켓은 하나다.
  const [hub, setHub] = useState<SymbolHub | null>(() => (on ? getHub(symbol) : null));

  useEffect(() => {
    setHub(on ? getHub(symbol) : null);
  }, [symbol, on]);

  return useSyncExternalStore(
    hub ? hub.subscribe : noopSubscribe,
    hub ? hub.getState : getEmpty,
    getEmpty,   // 서버 렌더에서는 빈 상태
  );
}

const noopSubscribe = () => () => {};
const getEmpty = () => EMPTY_STREAM;

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
