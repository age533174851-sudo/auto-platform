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
  symbols: TerminalSymbol[];
  /** Bearer 토큰. 없으면 로그인 전이다 */
  auth: string;
  connId: string;
  setConnId: (id: string) => void;
  connections: any[];
  mode: ModeInfo;
}

const Ctx = createContext<TerminalState | null>(null);

export function useTerminal(): TerminalState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTerminal은 TerminalProvider 안에서만 쓸 수 있습니다');
  return v;
}

const SYMBOL_KEY = 'tg_terminal_symbol';

/** 모드를 모를 때의 값. 실계좌가 아니라고 단정하지 않는다 */
const UNKNOWN_MODE: ModeInfo = {
  mode: 'UNKNOWN', label: '모드 확인 불가',
  realMoney: false, sendsOrders: false, unknown: true,
};

export function TerminalProvider({ children }: { children: React.ReactNode }) {
  const [symbol, setSymbolState] = useState<TerminalSymbol>(DEFAULT_SYMBOLS[0]);
  const [auth, setAuth] = useState('');
  const [connections, setConnections] = useState<any[]>([]);
  const [connId, setConnId] = useState('');
  const [mode, setMode] = useState<ModeInfo>(UNKNOWN_MODE);

  // 새로고침 후 보던 종목으로 돌아온다
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SYMBOL_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        if (s?.id) setSymbolState(s);
      }
    } catch { /* 저장값이 깨졌으면 기본값 */ }
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

  const value = useMemo<TerminalState>(() => ({
    symbol, setSymbol, symbols: DEFAULT_SYMBOLS,
    auth, connId, setConnId, connections, mode,
  }), [symbol, setSymbol, auth, connId, connections, mode]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
