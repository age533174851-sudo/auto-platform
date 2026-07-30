'use client';
// src/components/terminal/TerminalContext.tsx
//
// 터미널 전역 상태 — 심볼 하나, 인증 토큰 하나, 운영 모드 하나.
//
// 왜 컨텍스트인가
// ───────────────
// 차트가 보는 종목과 주문 폼이 보는 종목이 다르면 다른 종목을 사면서
// 맞는 차트를 보고 있다고 믿게 된다. 거래 화면에서 이것보다 위험한 건 없다.
// 그래서 심볼은 **한 곳에만** 두고 모든 패널이 그것을 읽는다.
//
// 여기에 넣지 않는 것
// ───────────────────
// 뉴스·AI·호가처럼 자주 바뀌는 값은 넣지 않는다. 컨텍스트 값이 바뀌면
// 모든 소비자가 다시 그려지므로, 뉴스가 30초마다 갱신되면 중앙 차트도
// 30초마다 흔들린다. 그런 상태는 그것을 쓰는 패널 안에 둔다.
import React, { createContext, useContext, useState, useEffect, useMemo, useCallback } from 'react';
import { loadFavorites, saveFavorites } from './SymbolSearch';
import { parseMarketType, type MarketType } from '@/lib/markets/marketType';
import { resolveTradeMode, TRADE_MODES, type TradeMode, type ModeResolution } from '@/lib/markets/tradeMode';

export interface TerminalSymbol {
  /** 거래소 심볼 — 'BTCUSDT' */
  id: string;
  /** 표시용 — 'BTC/USDT' */
  display: string;
  nameKr: string;
}

export const DEFAULT_SYMBOLS: TerminalSymbol[] = [
  { id: 'BTCUSDT', display: 'BTC/USDT', nameKr: '비트코인' },
  { id: 'ETHUSDT', display: 'ETH/USDT', nameKr: '이더리움' },
  { id: 'SOLUSDT', display: 'SOL/USDT', nameKr: '솔라나' },
  { id: 'XRPUSDT', display: 'XRP/USDT', nameKr: '리플' },
  { id: 'BNBUSDT', display: 'BNB/USDT', nameKr: '바이낸스코인' },
  { id: 'DOGEUSDT', display: 'DOGE/USDT', nameKr: '도지코인' },
];

export interface ModeInfo {
  mode: string;
  label: string;
  realMoney: boolean;
  sendsOrders: boolean;
  /** 조회 자체를 못 했다 — 모른다는 뜻이지 안전하다는 뜻이 아니다 */
  unknown: boolean;
}

interface TerminalState {
  symbol: TerminalSymbol;
  setSymbol: (s: TerminalSymbol) => void;
  /** 즐겨찾기 종목 (좌측 시장 목록·빠른 전환용) */
  symbols: TerminalSymbol[];
  /** 즐겨찾기 심볼 id 목록 */
  favorites: string[];
  toggleFavorite: (id: string) => void;
  /**
   * 시장 유형. 이게 바뀌면 주문창·잔고·위험 계산이 통째로 바뀐다.
   * 화면 어디서도 이 값을 무시하고 주문을 만들면 안 된다.
   */
  marketType: MarketType;
  setMarketType: (m: MarketType) => void;
  /** Bearer 토큰. 없으면 로그인 전이다 */
  auth: string;
  connId: string;
  setConnId: (id: string) => void;
  connections: any[];
  mode: ModeInfo;
  /**
   * 어디에 주문을 보내는가 — 모의 / 테스트넷 / 실전.
   *
   * `mode`(운영 단계)와 다른 값이다. 그쪽은 서버가 정하는 **사다리 단계**이고
   * 이쪽은 사용자가 지금 고른 **주문 대상**이다. 둘을 섞으면 화면이 말하는
   * 것과 실제로 주문이 가는 곳이 갈린다.
   *
   * 서버가 다시 검사한다. 이 값은 화면이 어느 라우트로 보낼지와 어떤 경고를
   * 띄울지를 정할 뿐, 권한을 주지 않는다.
   */
  tradeMode: TradeMode;
  setTradeMode: (m: TradeMode) => void;
  /** 이 모드에서 실제로 쓰이는 연결과 그 이유 */
  modeResolution: ModeResolution;
  /**
   * 앱 안에 들어가 있을 때 탭을 바꾸는 함수. 독립 경로(/terminal)로 열면
   * 없다 — 그때는 링크가 평소대로 페이지를 이동해야 한다. 그래서 optional이고,
   * 쓰는 쪽에서 없으면 기본 동작으로 떨어지게 둔다.
   */
  navigateApp?: (tabId: string) => void;
}

const Ctx = createContext<TerminalState | null>(null);

export function useTerminal(): TerminalState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTerminal은 TerminalProvider 안에서만 쓸 수 있습니다');
  return v;
}

const SYMBOL_KEY = 'tg_terminal_symbol';
const TRADE_MODE_KEY = 'tg_terminal_trade_mode';
const MARKET_KEY = 'tg_terminal_market';

/** 모드를 모를 때의 값. 실계좌가 아니라고 단정하지 않는다 */
const UNKNOWN_MODE: ModeInfo = {
  mode: 'UNKNOWN', label: '모드 확인 불가',
  realMoney: false, sendsOrders: false, unknown: true,
};

export function TerminalProvider(
  { children, navigateApp }: { children: React.ReactNode; navigateApp?: (tabId: string) => void },
) {
  const [symbol, setSymbolState] = useState<TerminalSymbol>(DEFAULT_SYMBOLS[0]);
  const [favorites, setFavorites] = useState<string[]>(() => DEFAULT_SYMBOLS.map(s => s.id));
  // 기본은 선물이다. 지금까지 이 화면이 하던 일이 선물이었으므로,
  // 새로고침 한 번에 사용자의 주문 대상이 바뀌면 안 된다.
  const [marketType, setMarketTypeState] = useState<MarketType>('USDT_FUTURES');
  const [auth, setAuth] = useState('');
  const [connections, setConnections] = useState<any[]>([]);
  const [connId, setConnId] = useState('');
  const [mode, setMode] = useState<ModeInfo>(UNKNOWN_MODE);
  // **기본은 모의다.** 새로 열었을 때 실전에 서 있으면 안 된다 —
  // 모르고 누르는 첫 주문이 실제 돈이 되는 것이 이 화면의 최악이다.
  const [tradeMode, setTradeModeState] = useState<TradeMode>('PAPER');

  // 고른 매매 모드를 기억한다. **실전은 기억하지 않는다** —
  // 어제 실전으로 켜뒀다는 이유로 오늘 첫 화면이 실전이면 안 된다.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(TRADE_MODE_KEY);
      if (raw && (TRADE_MODES as string[]).includes(raw) && raw !== 'LIVE') {
        setTradeModeState(raw as TradeMode);
      }
    } catch { /* 기본값(모의)으로 둔다 */ }
  }, []);

  const setTradeMode = useCallback((m: TradeMode) => {
    setTradeModeState(m);
    try {
      // 실전은 저장하지 않는다 (위 주석). 저장된 값을 지워 다음 방문이
      // 모의로 시작하게 한다.
      if (m === 'LIVE') localStorage.removeItem(TRADE_MODE_KEY);
      else localStorage.setItem(TRADE_MODE_KEY, m);
    } catch { /* 저장 실패는 이번 세션에만 영향 */ }
  }, []);

  // 새로고침 후 보던 종목으로 돌아온다
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SYMBOL_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        if (s?.id) setSymbolState(s);
      }
    } catch { /* 저장값이 깨졌으면 기본값 */ }
    setFavorites(loadFavorites());
    // 저장값이 이상하면 무시하고 기본값을 쓴다. parseMarketType은
    // 모르는 값에 null을 주므로 오타가 다른 시장으로 새지 않는다.
    try {
      const m = parseMarketType(localStorage.getItem(MARKET_KEY));
      if (m) setMarketTypeState(m);
    } catch { /* 기본값 유지 */ }
  }, []);

  const setMarketType = useCallback((m: MarketType) => {
    setMarketTypeState(m);
    try { localStorage.setItem(MARKET_KEY, m); } catch {}
  }, []);

  const toggleFavorite = useCallback((id: string) => {
    setFavorites(prev => {
      // 마지막 하나까지 지울 수 있게 둔다. 강제로 남기면 "왜 안 지워지지"가 된다.
      const next = prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id];
      saveFavorites(next);
      return next;
    });
  }, []);

  const setSymbol = useCallback((s: TerminalSymbol) => {
    setSymbolState(s);
    try { localStorage.setItem(SYMBOL_KEY, JSON.stringify(s)); } catch {}
  }, []);

  // 인증 → 연결 목록 → 운영 모드. 순서대로 한 번만.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let token = '';
      try {
        const { getSupabaseClient } = await import('@/lib/supabase/client');
        const sbc = getSupabaseClient();
        if (sbc) {
          const { data } = await sbc.auth.getSession();
          if (data?.session?.access_token) token = `Bearer ${data.session.access_token}`;
        }
      } catch { /* 로그인 전 */ }
      if (cancelled) return;
      setAuth(token);
      if (!token) return;

      const h = { Authorization: token };
      try {
        const r = await fetch('/api/exchange?action=list', { headers: h });
        const d = await r.json();
        const usable = (Array.isArray(d.connections) ? d.connections : [])
          .filter((c: any) => !c.has_withdrawal);
        if (cancelled) return;
        setConnections(usable);
        if (usable[0]) setConnId(usable[0].id);
      } catch { /* 연결 목록 실패 — 주문 패널이 안내한다 */ }

      try {
        const r = await fetch('/api/autotrade/mode', { headers: h });
        if (!r.ok) return;
        const d = await r.json();
        if (cancelled || !d?.ok) return;
        setMode({
          mode: d.current, label: d.capability?.label || d.current,
          realMoney: !!d.capability?.realMoney,
          sendsOrders: !!d.capability?.sendsOrders,
          unknown: false,
        });
      } catch { /* 모르는 채로 둔다 — UNKNOWN_MODE가 그 사실을 보여준다 */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // 즐겨찾기를 좌측 목록이 쓰는 형태로. 한국어 이름은 아는 것만 붙인다 —
  // 모르는 종목에 임의로 이름을 지어 붙이면 그게 더 헷갈린다.
  const symbols = useMemo<TerminalSymbol[]>(() => favorites.map(id => {
    const known = DEFAULT_SYMBOLS.find(s => s.id === id);
    if (known) return known;
    const base = id.replace(/USDT$/, '');
    return { id, display: `${base}/USDT`, nameKr: base };
  }), [favorites]);

  // 이 모드에서 실제로 쓸 연결. 판정은 순수 함수가 한다 —
  // '모르는 is_testnet은 실전이 아니다' 같은 규칙이 화면마다 갈리면 안 된다.
  const modeResolution = useMemo(
    () => resolveTradeMode(tradeMode, connections, connId || null),
    [tradeMode, connections, connId]);

  const value = useMemo<TerminalState>(() => ({
    symbol, setSymbol, symbols, favorites, toggleFavorite,
    marketType, setMarketType,
    auth, connId, setConnId, connections, mode, navigateApp,
    tradeMode, setTradeMode, modeResolution,
  }), [symbol, setSymbol, symbols, favorites, toggleFavorite,
       marketType, setMarketType, auth, connId, connections, mode, navigateApp,
       tradeMode, setTradeMode, modeResolution]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
