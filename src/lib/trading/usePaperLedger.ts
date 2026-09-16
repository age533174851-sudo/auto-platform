'use client';
// src/lib/trading/usePaperLedger.ts
//
// **고른 장부 하나를 읽는다.** 기본 모의 계좌든 챌린지 계좌든 같은
// 라우트(`/api/paper/positions`)를 쓰고, 밖으로 나가는 식별자는
// `challengeId` 하나다 — 계좌 id는 화면이 알지 않는다.
//
// 왜 훅이 필요한가
// ────────────────
// 사이징 슬라이더가 나눌 잔고가 여기서 온다. 예전 비율 버튼은
// `loadPaperBalance().krw` — 브라우저에만 있는 **옛 원화 연습 장부**를
// 읽었다. 서버 모의 장부로 주문을 내면서 수량은 다른 장부의 잔고로
// 계산하고 있었다는 뜻이다.
//
// 못 읽으면 0이 아니다
// ────────────────────
// `available`이 `null`이면 슬라이더가 잠긴다. 0으로 두면 사용자는 "돈이
// 없다"로 읽고, 실제로는 못 읽은 것이다.
import { useCallback, useEffect, useState } from 'react';
import { targetQuery, type PaperTarget } from './paperTarget';

export interface PaperLedgerPosition {
  id: string;
  symbol: string;
  side: string;
  fillPrice: number;
  quantity: number;
  notional: number;
  leverage: number;
  margin: number;
  stopLoss: number | null;
  takeProfit: number | null;
  liquidationPrice: number | null;
  openedAt: string | null;
}

export interface PaperLedger {
  state: 'LOADING' | 'READY' | 'ERROR';
  /** 새 주문에 배정할 수 있는 잔고. **못 읽었으면 null** */
  available: number | null;
  /** 가용을 못 읽은 사유. 화면이 그대로 적는다 */
  availableUnknownReason: string | null;
  balance: number | null;
  openPositions: PaperLedgerPosition[];
  /** 읽기 실패 사유. 성공이면 null */
  error: string | null;
  reload: () => void;
}

async function authHeader(): Promise<Record<string, string>> {
  try {
    const { getSupabaseClient } = await import('@/lib/supabase/client');
    const sb = getSupabaseClient();
    if (!sb) return {};
    const { data } = await sb.auth.getSession();
    const tok = data?.session?.access_token;
    return tok ? { Authorization: `Bearer ${tok}` } : {};
  } catch { return {}; }
}

export function usePaperLedger(target: PaperTarget, enabled = true): PaperLedger {
  const [state, setState] = useState<'LOADING' | 'READY' | 'ERROR'>('LOADING');
  const [available, setAvailable] = useState<number | null>(null);
  const [unknownReason, setUnknownReason] = useState<string | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [positions, setPositions] = useState<PaperLedgerPosition[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => setTick(n => n + 1), []);

  // 장부가 바뀌면 이전 장부의 숫자를 남겨 두지 않는다 —
  // 챌린지를 고른 순간 기본 계좌 잔고가 잠깐 보이면 그걸로 수량을 정한다.
  const query = targetQuery(target);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setState('LOADING');
    setAvailable(null); setBalance(null); setPositions([]); setError(null);
    setUnknownReason(null);
    (async () => {
      try {
        const r = await fetch(`/api/paper/positions${query}`, {
          headers: await authHeader(), cache: 'no-store',
        });
        const d = await r.json().catch(() => null);
        if (cancelled) return;
        if (!r.ok || !d?.ok) {
          setState('ERROR');
          setError(String(d?.message || d?.error || `장부를 읽지 못했습니다 (HTTP ${r.status})`));
          return;
        }
        const acct = d.account || {};
        setBalance(acct.balance == null ? null : Number(acct.balance));
        setAvailable(acct.available == null ? null : Number(acct.available));
        setUnknownReason(acct.availableUnknownReason ?? null);
        setPositions(Array.isArray(d.openPositions) ? d.openPositions : []);
        setState('READY');
      } catch (e: any) {
        if (cancelled) return;
        setState('ERROR');
        setError(String(e?.message || '장부를 읽지 못했습니다'));
      }
    })();
    return () => { cancelled = true; };
  }, [query, enabled, tick]);

  return {
    state, available, availableUnknownReason: unknownReason, balance,
    openPositions: positions, error, reload,
  };
}
