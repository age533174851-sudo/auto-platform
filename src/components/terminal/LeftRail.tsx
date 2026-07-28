'use client';
// src/components/terminal/LeftRail.tsx
//
// 좌측 — 시장 · AI · 뉴스 · 일정.
//
// 여기서 갱신되는 것은 전부 **이 컴포넌트 안에** 둔다.
// 뉴스를 상위로 끌어올리면 30초마다 중앙 차트까지 다시 그려진다.
// 그래서 fetch도 상태도 여기서 끝낸다 — 밖으로 새어 나가는 것은
// "종목을 골랐다"는 이벤트 하나뿐이다.
import React, { memo, useEffect, useState } from 'react';
import { C, FS, NUM, tabStyle, chip, fmtPrice, pnlColor } from './theme';
import { useTerminal, type TerminalSymbol } from './TerminalContext';

type Tab = '시장' | 'AI' | '뉴스' | '일정';
const TABS: Tab[] = ['시장', 'AI', '뉴스', '일정'];

// ── 시장 ──────────────────────────────────────────────
function MarketList() {
  const { symbols, symbol, setSymbol } = useTerminal();
  const [rows, setRows] = useState<Record<string, { p: number; c: number }>>({});

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch('/api/prices?action=all_crypto&limit=200');
        const d = await r.json();
        const list: any[] = Array.isArray(d?.results) ? d.results : [];
        if (!alive) return;
        const next: Record<string, { p: number; c: number }> = {};
        for (const s of symbols) {
          const base = s.id.replace(/USDT$/, '');
          const hit = list.find(x =>
            String(x.symbol).toUpperCase() === base || String(x.symbol).toUpperCase() === s.id);
          if (hit) next[s.id] = { p: Number(hit.price) || 0, c: Number(hit.change24h) || 0 };
        }
        setRows(next);
      } catch { /* 다음 주기에 다시 */ }
    };
    load();
    const t = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(t); };
  }, [symbols]);

  return (
    <div>
      {symbols.map((s: TerminalSymbol) => {
        const r = rows[s.id];
        const on = s.id === symbol.id;
        return (
          <button key={s.id} onClick={() => setSymbol(s)} style={{
            display: 'flex', width: '100%', justifyContent: 'space-between', alignItems: 'center',
            padding: '9px 12px', cursor: 'pointer', border: 'none', textAlign: 'left',
            background: on ? C.active : 'transparent',
            boxShadow: on ? `inset 2px 0 0 ${C.accent}` : 'none',
            transition: 'background .12s',
          }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ color: on ? C.text : C.dim, fontSize: FS.body, fontWeight: 600 }}>
                {s.id.replace(/USDT$/, '')}
              </div>
              <div style={{ color: C.faint, fontSize: FS.micro, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {s.nameKr}
              </div>
            </div>
            <div style={{ textAlign: 'right', ...NUM }}>
              <div style={{ color: C.text, fontSize: FS.small }}>{r ? fmtPrice(r.p) : '—'}</div>
              <div style={{ color: pnlColor(r?.c), fontSize: FS.micro, fontWeight: 600 }}>
                {r ? `${r.c >= 0 ? '+' : ''}${r.c.toFixed(2)}%` : ''}
              </div>
            </div>
          </button>
        );
      })}
      <div style={{
        padding: '10px 12px', color: C.faint, fontSize: FS.micro,
        borderTop: `1px solid ${C.hair}`,
      }}>/api/prices · 15초 주기</div>
    </div>
  );
}

// ── 09시 전략 판정 ────────────────────────────────────
// AI 탭에는 범용 코멘트 대신 이 화면의 전략이 지금 뭐라고 하는지를 띄운다.
// 남의 지표를 옮겨오는 것보다 내 전략의 오늘 판단이 훨씬 쓸모 있다.
function StrategyView() {
  const { symbol, auth } = useTerminal();
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  const run = async () => {
    if (!auth) { setErr('로그인이 필요합니다'); return; }
    setLoading(true); setErr('');
    try {
      const r = await fetch('/api/autotrade/daily-ladder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({ symbol: symbol.id, dryRun: true }),
      });
      const j = await r.json();
      if (!j?.ok) setErr(j?.error || '판단 실패');
      setD(j);
    } catch (e: any) { setErr(e?.message || '요청 실패'); }
    finally { setLoading(false); }
  };

  useEffect(() => { setD(null); setErr(''); }, [symbol.id]);

  const side = d?.battle?.side;
  return (
    <div style={{ padding: 12, fontSize: FS.small, color: C.dim, lineHeight: 1.6 }}>
      <button onClick={run} disabled={loading} style={{
        width: '100%', minHeight: 38, background: C.accentBg, color: C.accent,
        border: `1px solid ${C.accent}44`, borderRadius: 8,
        fontSize: FS.small, fontWeight: 700, marginBottom: 10,
        cursor: loading ? 'default' : 'pointer', opacity: loading ? 0.6 : 1,
      }}>
        {loading ? '판단 중…' : `${symbol.id.replace(/USDT$/, '')} 오늘 판단 미리보기`}
      </button>

      {err && (
        <div style={{
          padding: '8px 10px', borderRadius: 8, background: C.warnBg,
          color: C.warn, marginBottom: 8,
        }}>{err}</div>
      )}

      {d && (
        <>
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            <span style={d.approved ? chip(C.up, C.upBg) : chip(C.dim)}>
              {d.approved ? '진입 조건 충족' : '오늘 진입 없음'}
            </span>
            {side && (
              <span style={chip(side === 'LONG' ? C.up : C.down,
                                side === 'LONG' ? C.upBg : C.downBg)}>{side}</span>
            )}
          </div>
          <div style={{ color: C.text }}>{d.reason}</div>
          {d.plan && (
            <div style={{ marginTop: 10, background: C.raised, borderRadius: 8, padding: '10px 12px' }}>
              <Row k="방향" v={d.plan.side}/>
              <Row k="배율" v={`${d.plan.leverage}x`}/>
              <Row k="증거금" v={`$${Number(d.plan.requiredMargin).toFixed(2)}`}/>
              <Row k="명목가" v={`$${Number(d.plan.positionSize).toFixed(0)}`}/>
              <Row k="청산가" v={Number(d.plan.liquidationPrice).toFixed(2)}/>
              <Row k="청산거리" v={`${Number(d.plan.liquidationDistancePct).toFixed(2)}%`}
                   warn={Number(d.plan.liquidationDistancePct) < 1}/>
            </div>
          )}
          <div style={{ marginTop: 8, color: C.faint, fontSize: FS.micro }}>
            미리보기입니다 — 주문은 나가지 않습니다 (dryRun)
          </div>
        </>
      )}
    </div>
  );
}

function Row({ k, v, warn }: { k: string; v: any; warn?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}>
      <span style={{ color: C.faint }}>{k}</span>
      <span style={{ ...NUM, color: warn ? C.down : C.text, fontWeight: warn ? 700 : 600 }}>{v}</span>
    </div>
  );
}

// ── 뉴스 ──────────────────────────────────────────────
function NewsList() {
  const [items, setItems] = useState<any[] | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch('/api/news?limit=15');
        const d = await r.json();
        if (!alive) return;
        const list = Array.isArray(d?.articles) ? d.articles
          : Array.isArray(d?.results) ? d.results
          : Array.isArray(d) ? d : [];
        setItems(list);
      } catch { if (alive) setItems([]); }
    })();
    return () => { alive = false; };
  }, []);

  if (items === null) return <Empty t="불러오는 중…"/>;
  if (!items.length) return <Empty t="표시할 뉴스가 없습니다"/>;

  return (
    <div>
      {items.slice(0, 15).map((n, i) => (
        <a key={i} href={n.url || n.link || '#'} target="_blank" rel="noreferrer" style={{
          display: 'block', padding: '10px 12px', borderBottom: `1px solid ${C.hair}`,
          color: C.dim, fontSize: FS.small, lineHeight: 1.5, textDecoration: 'none',
        }}>
          <div style={{ color: C.text }}>{n.title || n.headline || '(제목 없음)'}</div>
          <div style={{ color: C.faint, fontSize: FS.micro, marginTop: 3 }}>
            {n.source?.name || n.source || n.publisher || ''}
          </div>
        </a>
      ))}
    </div>
  );
}

// ── 일정 ──────────────────────────────────────────────
function ScheduleList() {
  const { mode } = useTerminal();
  // 이 전략의 유일한 시각 기준은 09:00 KST다. 남은 시간을 계속 보여준다.
  const [left, setLeft] = useState('');
  useEffect(() => {
    const tick = () => {
      const now = new Date();
      const kst = new Date(now.getTime() + (9 * 60 + now.getTimezoneOffset()) * 60_000);
      const next = new Date(kst);
      next.setHours(9, 0, 0, 0);
      if (kst.getTime() >= next.getTime()) next.setDate(next.getDate() + 1);
      const ms = next.getTime() - kst.getTime();
      const h = Math.floor(ms / 3_600_000);
      const m = Math.floor((ms % 3_600_000) / 60_000);
      const s = Math.floor((ms % 60_000) / 1000);
      setLeft(`${h}시간 ${m}분 ${s}초`);
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <div style={{ padding: 12, fontSize: FS.small, color: C.dim, lineHeight: 1.6 }}>
      <div style={{ color: C.faint, fontSize: FS.micro }}>다음 09:00 KST 일봉 전환까지</div>
      <div style={{ ...NUM, color: C.accent, fontSize: 22, fontWeight: 700, margin: '4px 0 14px' }}>
        {left}
      </div>

      <div style={{ background: C.raised, borderRadius: 8, padding: '10px 12px' }}>
        <Row k="운영 모드" v={mode.unknown ? '확인 불가' : mode.label.split(' —')[0]}/>
        <Row k="주문 전송" v={mode.unknown ? '?' : mode.sendsOrders ? '보냄' : '안 보냄'}/>
        <Row k="실제 자금" v={mode.unknown ? '?' : mode.realMoney ? '사용' : '미사용'}
             warn={mode.realMoney}/>
      </div>

      <div style={{ marginTop: 12, color: C.faint, fontSize: FS.micro, lineHeight: 1.6 }}>
        09:00 전환 → 10~30분 관찰 → 1회 진입 → 다음 09:00 청산.
        이 화면의 모든 판단은 이 순서를 전제로 합니다.
      </div>
    </div>
  );
}

function Empty({ t }: { t: string }) {
  return (
    <div style={{ padding: '28px 16px', textAlign: 'center', color: C.faint, fontSize: FS.small }}>{t}</div>
  );
}

// ── 껍데기 ────────────────────────────────────────────
function LeftRailInner() {
  const [tab, setTab] = useState<Tab>('시장');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0 }}>
      <div style={{
        display: 'flex', gap: 4, padding: '7px 8px',
        borderBottom: `1px solid ${C.hair}`, flexShrink: 0,
      }}>
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)} style={{ ...tabStyle(tab === t), flex: 1 }}>{t}</button>
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {tab === '시장' && <MarketList/>}
        {tab === 'AI' && <StrategyView/>}
        {tab === '뉴스' && <NewsList/>}
        {tab === '일정' && <ScheduleList/>}
      </div>
    </div>
  );
}

export const LeftRail = memo(LeftRailInner);
