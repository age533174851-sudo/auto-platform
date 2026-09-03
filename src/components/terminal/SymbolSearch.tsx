'use client';
// src/components/terminal/SymbolSearch.tsx
//
// 종목 검색·목록.
//
// 예전에는 6개짜리 고정 드롭다운이었다. 목록이 아니라 상수였고,
// 거기 없는 종목은 아예 볼 수 없었다. 실제 거래소는 USDT 무기한만
// 300개가 넘는다.
//
// 여기서 지키는 것
// ────────────────
//  - 값은 전부 거래소에서 온다. 없으면 '—'로 두고 0으로 채우지 않는다.
//    펀딩비 0.00000%와 "못 받았음"은 완전히 다른 뜻이다.
//  - 즐겨찾기는 사용자별로 저장한다. 매번 찾게 하면 검색이 무용지물이다.
//  - 검색은 입력 즉시 거르되 네트워크를 다시 부르지 않는다. 한 번 받은
//    목록 안에서 거른다 — 타이핑마다 요청하면 레이트리밋에 걸린다.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { C, FS, NUM, fmtPrice, pnlColor, tabStyle } from './theme';
import type { TerminalSymbol } from './TerminalContext';

export interface MarketRow {
  id: string;          // BTCUSDT
  base: string;        // BTC
  price: number | null;
  changePct: number | null;
  volumeUsd: number | null;
  /** 못 받았으면 null. 0과 구분한다 */
  fundingPct: number | null;
}

/** 거래량을 사람이 읽는 단위로 */
export function fmtVol(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return '—';
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(2)}K`;
  return v.toFixed(0);
}

const FAV_KEY = 'tg_terminal_favorites';

export function loadFavorites(): string[] {
  try {
    const raw = localStorage.getItem(FAV_KEY);
    if (raw) {
      const a = JSON.parse(raw);
      if (Array.isArray(a)) return a.filter(x => typeof x === 'string');
    }
  } catch {}
  return ['BTCUSDT', 'ETHUSDT'];
}

export function saveFavorites(list: string[]) {
  try { localStorage.setItem(FAV_KEY, JSON.stringify(list)); } catch {}
}

/**
 * 24시간 티커 + 펀딩비를 한 번에 받는다.
 *
 * 둘 다 심볼 없이 부르면 전 종목이 한 번에 온다. 종목마다 부르면
 * 300번이 나가고 레이트리밋에 걸린다.
 */
export async function fetchMarkets(): Promise<MarketRow[]> {
  const [tickRes, fundRes] = await Promise.allSettled([
    fetch('https://fapi.binance.com/fapi/v1/ticker/24hr'),
    fetch('https://fapi.binance.com/fapi/v1/premiumIndex'),
  ]);

  let ticks: any[] = [];
  if (tickRes.status === 'fulfilled' && tickRes.value.ok) {
    ticks = await tickRes.value.json().catch(() => []);
  }
  if (!Array.isArray(ticks) || ticks.length === 0) return [];

  // 펀딩비는 실패해도 목록은 보여준다. 대신 그 칸만 '—'가 된다.
  const funding = new Map<string, number>();
  if (fundRes.status === 'fulfilled' && fundRes.value.ok) {
    const f = await fundRes.value.json().catch(() => []);
    for (const x of (Array.isArray(f) ? f : [])) {
      const v = parseFloat(x?.lastFundingRate);
      if (Number.isFinite(v)) funding.set(String(x.symbol), v);
    }
  }

  return ticks
    .filter((t: any) => String(t.symbol).endsWith('USDT'))
    .map((t: any): MarketRow => {
      const id = String(t.symbol);
      const fr = funding.get(id);
      return {
        id, base: id.replace(/USDT$/, ''),
        price: numOrNull(t.lastPrice),
        changePct: numOrNull(t.priceChangePercent),
        volumeUsd: numOrNull(t.quoteVolume),
        fundingPct: fr === undefined ? null : fr * 100,
      };
    })
    .sort((a, b) => (b.volumeUsd ?? 0) - (a.volumeUsd ?? 0));
}

function numOrNull(v: any): number | null {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

type Filter = '즐겨찾기' | '전체';

export function SymbolSearch({
  current, favorites, onToggleFav, onPick, onClose, embedded,
}: {
  current: string;
  favorites: string[];
  onToggleFav: (id: string) => void;
  onPick: (s: TerminalSymbol) => void;
  onClose?: () => void;
  /** 좌측 패널처럼 자리를 차지하고 붙는 형태 */
  embedded?: boolean;
}) {
  const [rows, setRows] = useState<MarketRow[] | null>(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>(embedded ? '즐겨찾기' : '즐겨찾기');
  const [err, setErr] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetchMarkets();
        if (!alive) return;
        if (r.length === 0) setErr('거래소 목록을 받지 못했습니다');
        else { setErr(''); setRows(r); }
      } catch (e: any) {
        if (alive) setErr(e?.message || '목록 조회 실패');
      }
    };
    load();
    const t = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  useEffect(() => { if (!embedded) inputRef.current?.focus(); }, [embedded]);

  // 검색어가 있으면 즐겨찾기 필터를 건너뛴다. 검색은 "여기 없는 것을
  // 찾는" 행동인데 즐겨찾기 안에서만 찾으면 목적과 반대가 된다.
  const list = useMemo(() => {
    const all = rows ?? [];
    const term = q.trim().toUpperCase();
    if (term) return all.filter(r => r.id.includes(term) || r.base.includes(term)).slice(0, 80);
    if (filter === '즐겨찾기') {
      const set = new Set(favorites);
      return all.filter(r => set.has(r.id));
    }
    return all.slice(0, 80);
  }, [rows, q, filter, favorites]);

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', minHeight: 0,
      height: embedded ? '100%' : undefined,
      maxHeight: embedded ? undefined : '70vh',
      background: C.panel,
      border: embedded ? 'none' : `1px solid ${C.hair2}`,
      borderRadius: embedded ? 0 : 12,
      boxShadow: embedded ? 'none' : '0 16px 48px rgba(0,0,0,.6)',
      overflow: 'hidden',
    }}>
      <div style={{ padding: embedded ? '8px 8px 6px' : '10px 10px 8px', flexShrink: 0 }}>
        <div style={{ position: 'relative' }}>
          <span style={{
            position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)',
            color: C.faint, fontSize: 13, pointerEvents: 'none',
          }}>⌕</span>
          <input
            ref={inputRef}
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') { if (q) setQ(''); else onClose?.(); } }}
            placeholder="종목 검색"
            style={{
              width: '100%', boxSizing: 'border-box',
              background: C.raised, color: C.text,
              border: `1px solid ${C.hair}`, borderRadius: 8,
              padding: '9px 10px 9px 28px', fontSize: FS.body, outline: 'none',
            }}
          />
        </div>

        {!q && (
          <div style={{ display: 'flex', gap: 4, marginTop: 8 }}>
            {(['즐겨찾기', '전체'] as Filter[]).map(f => (
              <button key={f} onClick={() => setFilter(f)} style={tabStyle(filter === f)}>
                {f}
                {f === '즐겨찾기' && (
                  <span style={{ ...NUM, color: C.faint, marginLeft: 5 }}>{favorites.length}</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* **한국어는 단어 중간에서 끊지 않는다.**
          예전에는 `1fr auto auto`에 세 번째 칸이 `minWidth:92`였다.
          레일이 200px일 때 첫 칸에 남는 폭이 40px 남짓이라
          "종목 · 거래대금"이 "종목 · 거" / "래대금"으로 쪼개졌다 —
          화면에서 읽을 수 없는 글자가 됐다.

          라벨을 줄이고(정렬 기준은 아래 "거래대금순"에 이미 적혀 있다),
          keep-all로 단어를 지키고, 넘치면 말줄임으로 끝낸다. */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto auto',
        gap: 8, padding: '0 12px 6px', flexShrink: 0,
        fontSize: FS.micro, color: C.faint,
        wordBreak: 'keep-all',
      }}>
        <span style={{ minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>종목</span>
        <span style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>가격</span>
        <span style={{ textAlign: 'right', minWidth: 78, whiteSpace: 'nowrap' }}>24h · 펀딩</span>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', borderTop: `1px solid ${C.hair}` }}>
        {err && (
          <div style={{ padding: '14px 12px', color: C.warn, fontSize: FS.small, lineHeight: 1.5 }}>
            {err}
          </div>
        )}
        {rows === null && !err && (
          <div style={{ padding: '24px 12px', textAlign: 'center', color: C.faint, fontSize: FS.small }}>
            목록을 받아오는 중
          </div>
        )}
        {rows !== null && list.length === 0 && (
          <div style={{ padding: '24px 12px', textAlign: 'center', color: C.faint, fontSize: FS.small }}>
            {q ? `'${q}'와 일치하는 종목이 없습니다` : '즐겨찾기가 비어 있습니다'}
          </div>
        )}

        {list.map(r => {
          const fav = favorites.includes(r.id);
          const on = r.id === current;
          return (
            <div key={r.id} style={{
              display: 'grid', gridTemplateColumns: '1fr auto auto',
              gap: 10, alignItems: 'center', padding: '7px 12px',
              background: on ? C.active : 'transparent',
              boxShadow: on ? `inset 2px 0 0 ${C.accent}` : 'none',
              borderBottom: `1px solid ${C.hair}`,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <button
                  onClick={() => onToggleFav(r.id)}
                  aria-label={fav ? '즐겨찾기 해제' : '즐겨찾기'}
                  style={{
                    background: 'none', border: 'none', cursor: 'pointer', padding: 2,
                    color: fav ? C.warn : C.faint, fontSize: 12, lineHeight: 1, flexShrink: 0,
                  }}
                >{fav ? '★' : '☆'}</button>
                <button
                  onClick={() => onPick({ id: r.id, display: `${r.base}/USDT`, nameKr: r.base })}
                  style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    textAlign: 'left', padding: 0, minWidth: 0, flex: 1,
                  }}>
                  <div style={{
                    color: on ? C.text : C.dim, fontSize: FS.body, fontWeight: 600,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>
                    {r.base}
                    <span style={{ color: C.faint, fontSize: FS.micro, fontWeight: 400 }}> USDT</span>
                  </div>
                  <div style={{ ...NUM, color: C.faint, fontSize: FS.micro }}>{fmtVol(r.volumeUsd)}</div>
                </button>
              </div>

              <div style={{ ...NUM, color: C.text, fontSize: FS.small, textAlign: 'right' }}>
                {r.price != null ? fmtPrice(r.price, r.price < 1 ? 4 : 2) : '—'}
              </div>

              <div style={{ textAlign: 'right', minWidth: 92 }}>
                <div style={{ ...NUM, color: pnlColor(r.changePct), fontSize: FS.small, fontWeight: 600 }}>
                  {r.changePct != null
                    ? `${r.changePct >= 0 ? '+' : ''}${r.changePct.toFixed(2)}%` : '—'}
                </div>
                {/* 펀딩비는 못 받으면 '—'다. 0.00000%로 적으면 "무료"로 읽힌다. */}
                <div style={{ ...NUM, color: pnlColor(r.fundingPct != null ? -r.fundingPct : null), fontSize: FS.micro }}>
                  {r.fundingPct != null ? `${r.fundingPct.toFixed(4)}%` : '—'}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div style={{
        flexShrink: 0, padding: '7px 12px', borderTop: `1px solid ${C.hair}`,
        color: C.faint, fontSize: FS.micro,
      }}>
        Binance 선물 · 15초 주기 · 거래대금순
      </div>
    </div>
  );
}
