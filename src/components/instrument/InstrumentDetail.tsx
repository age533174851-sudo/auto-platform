'use client';
// src/components/instrument/InstrumentDetail.tsx
//
// **종목 상세 — 사는 화면이 아니라 보는 화면이다.**
//
// 왜 분리했나
// ───────────
// 한 화면에 차트와 주문폼을 같이 넣으면 둘 다 작아진다. 실측에서
// 320×600일 때 차트가 96px까지 밀렸다. 그런데 사람이 이 화면에서 하는
// 일은 대부분 **보는 것**이고, 주문은 마음을 정한 뒤 한 번 한다.
//
// 그래서 여기서는 화면 대부분을 자산에 쓴다. 증거금·배율·호가·청산가는
// 보이지 않는다 — 그것들은 주문할 때 필요한 값이지 판단할 때 필요한
// 값이 아니다. 아래 [매수]/[매도]를 누르면 주문 화면으로 간다.
//
// 값을 지어내지 않는다
// ────────────────────
// 칸을 먼저 만들어 두면 누군가 숫자를 채운다. 이 저장소에 이미 그렇게
// 들어온 값이 있다 — 손으로 적은 시가총액, 손으로 쓴 뉴스 기사,
// `AutoBotLabPage`의 삼성전자 ROE 11.2.
//
// 그래서 **무엇을 그려도 되는지 먼저 묻는다**(`instrumentFieldPlan`).
// 출처가 없으면 칸을 안 만들거나(코인의 배당) 없다고 적는다(시가총액).
import React, { useEffect, useMemo, useState } from 'react';
import { C, FS, NUM } from '@/components/terminal/theme';
import { PriceChart, type ChartInterval } from '@/components/trading/PriceChart';
import { useBinanceStream } from '@/lib/hooks/useBinanceStream';
import { usePaperTarget } from '@/lib/trading/usePaperTarget';
import { usePaperLedger } from '@/lib/trading/usePaperLedger';
import { changeView } from '@/lib/markets/changeBasis';
import { instrumentFieldPlan } from '@/lib/markets/instrumentFields';
import { tradingValueOf } from '@/lib/markets/ranking';
import type { IndicatorId } from '@/lib/trading/indicators';

/**
 * 주문 화면으로 넘길 것. **이 계약이 Phase 3의 입구다.**
 *
 * 방향을 여기서 정해 보낸다 — 예전에는 바깥 버튼이 시트를 열기만 하고
 * 방향을 안 넘겨서, SHORT를 눌러도 주문판이 LONG으로 열렸다.
 */
export interface OrderIntent {
  symbol: string;
  market: 'SPOT' | 'USDM';
  side: 'BUY' | 'SELL';
}
//
// **장부(tradeMode/target)는 여기 없다.**
//
// 이 화면은 그 값을 소유하지 않는다. 들고 다니면 터미널의
// `TerminalContext.tradeMode`·`usePaperTarget`과 **두 번째 권위**가 되고,
// 둘이 갈리는 순간 "본 화면과 주문 간 장부"가 달라진다 — 이미 한 번
// 겪었다(주문은 챌린지로, 포지션 표시는 기본 계좌로).
//
// 주문 화면이 제 정본에서 읽는다.

export interface InstrumentDetailProps {
  symbol: string;
  market: 'SPOT' | 'USDM';
  /** 화면에 적을 이름. 없으면 심볼을 쓴다 */
  name?: string;
  auth?: string;
  onBack: () => void;
  /** Phase 3에서 주문 화면이 붙는 자리. 지금은 바깥이 정한다 */
  onOrder: (intent: OrderIntent) => void;
}

export function InstrumentDetail({
  symbol, market, name, auth, onBack, onOrder,
}: InstrumentDetailProps) {
  const [interval, setInterval] = useState<ChartInterval>('15m');
  const [indicators, setIndicators] = useState<IndicatorId[]>(['MA7', 'MA25']);
  const stream = useBinanceStream(symbol, true, market);
  const [target] = usePaperTarget();
  const ledger = usePaperLedger(target, !!auth);
  const plan = instrumentFieldPlan(market);

  // 변동률이 **무엇 대비인지** 화면에 적는다. 코인은 24시간, 주식은 전일.
  const change = changeView({ market, price: stream.lastPrice, changePct: stream.changePct });

  // 거래대금 — 거래소 원가 × 기초 거래량. 표시용 환산가를 쓰지 않는다.
  const tv = tradingValueOf({
    quotePrice: stream.lastPrice, quoteCurrency: quoteOf(symbol), volume: stream.volume24h,
  });

  const held = useMemo(
    () => ledger.openPositions.filter(p => String(p.symbol).toUpperCase() === symbol.toUpperCase()),
    [ledger.openPositions, symbol],
  );

  return (
    <div data-testid="instrument-detail" data-market={market} style={{
      display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
      background: C.bg, color: C.text,
    }}>
      {/* ── 머리 ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
        borderBottom: `1px solid ${C.hair}`, background: C.panel, flexShrink: 0,
      }}>
        <button type="button" onClick={onBack} data-testid="detail-back" aria-label="뒤로"
          style={{
            flexShrink: 0, background: 'none', border: 'none', color: C.text,
            fontSize: 20, cursor: 'pointer', padding: '0 4px',
          }}>‹</button>
        <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <span data-testid="detail-name" style={{
            fontSize: FS.lead, fontWeight: 800, whiteSpace: 'nowrap',
            overflow: 'hidden', textOverflow: 'clip',
          }}>{name || symbol}</span>
          <span data-testid="detail-symbol" style={{ fontSize: FS.nano, color: C.faint }}>
            {symbol} · {market === 'USDM' ? 'Perpetual' : 'Spot'}
          </span>
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
        {/* ── 가격 ── */}
        <div data-testid="detail-hero" style={{ padding: '14px 12px 10px' }}>
          <div data-testid="detail-price" style={{
            ...NUM, fontSize: 30, fontWeight: 800, lineHeight: 1.1,
            color: stream.lastPrice == null ? C.faint : C.text,
            overflowWrap: 'anywhere',
          }}>{fmt(stream.lastPrice)}</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
            <span data-testid="detail-change-label" style={{ fontSize: FS.micro, color: C.faint }}>
              {change.label}
            </span>
            <span data-testid="detail-change-pct" style={{
              ...NUM, fontSize: FS.lead, fontWeight: 800,
              color: change.pct == null ? C.faint : change.pct >= 0 ? C.up : C.down,
            }}>{change.pct == null ? '—' : `${change.pct >= 0 ? '+' : ''}${change.pct.toFixed(2)}%`}</span>
          </div>
          {change.unknownReason ? (
            <div data-testid="detail-change-unknown" style={{
              fontSize: FS.nano, color: C.warn, marginTop: 3, lineHeight: 1.4,
            }}>{change.unknownReason}</div>
          ) : null}
        </div>

        {/* ── 차트 ── */}
        <PriceChart
          symbol={symbol} market={market}
          interval={interval} onIntervalChange={setInterval}
          indicators={indicators}
          onToggleIndicator={(id) => setIndicators(prev =>
            prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])}
          height={260}
        />

        {/* ── 한눈에 ── */}
        <Section title="한눈에">
          <Grid>
            <Stat label="고가" value={fmt(stream.high24h)} testid="detail-high"/>
            <Stat label="저가" value={fmt(stream.low24h)} testid="detail-low"/>
            <Stat label="거래량" value={fmt(stream.volume24h, 4)} testid="detail-volume"/>
            <Stat label="거래대금"
              value={tv.value == null ? '—' : fmt(tv.value)}
              sub={tv.value == null ? tv.reason : tv.currency}
              testid="detail-trading-value"/>
            {/* 시가총액은 개념이 있으므로 칸을 지우지 않는다. 칸이 없으면
                "이 자산은 시총이 없다"로 읽힌다 — 없다고 적는다. */}
            <Stat label="시가총액" value="확인 불가"
              sub={plan.marketCap.reason} testid="detail-market-cap"/>
          </Grid>
        </Section>

        {/* ── 내 보유 ── */}
        {auth && held.length > 0 ? (
          <Section title="내 보유">
            {held.map(p => (
              <div key={p.id} data-testid="detail-holding" style={{
                display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'baseline',
                padding: '6px 0', fontSize: FS.micro,
              }}>
                <span style={{ fontWeight: 800, color: p.side === 'SHORT' ? C.down : C.up }}>
                  {p.side}
                </span>
                <Stat inline label="수량" value={fmt(p.quantity, 6)} testid="detail-hold-qty"/>
                <Stat inline label="진입가" value={fmt(p.fillPrice)} testid="detail-hold-entry"/>
                {/* 평가손익·수익률은 **정본이 없다.** 열린 포지션의 미실현
                    손익을 내는 계산이 이 저장소에 없고, 여기서 만들면 세
                    번째 손익 권위가 생긴다. 있는 값만 적는다. */}
              </div>
            ))}
          </Section>
        ) : null}

        {/* ── 뉴스 ── */}
        <NewsSection symbol={symbol}/>

        {/* ── 배당 · 기업정보 ──
            코인에는 개념이 없어 칸 자체를 그리지 않는다. 주식은 개념은
            있으나 공급자가 없어 없다고 적는다. */}
        {plan.dividend.availability !== 'HIDDEN' ? (
          <Section title="배당">
            <Unavailable testid="detail-dividend" reason={plan.dividend.reason}/>
          </Section>
        ) : null}
        {plan.companyInfo.availability !== 'HIDDEN' ? (
          <Section title="기업정보">
            <Unavailable testid="detail-company" reason={plan.companyInfo.reason}/>
          </Section>
        ) : null}

        <div style={{ height: 12 }}/>
      </div>

      {/* ── 사거나 팔거나 ──
          여기서 주문을 만들지 않는다. 방향만 정해서 주문 화면으로 넘긴다. */}
      <div data-testid="detail-actions" style={{
        flexShrink: 0, display: 'flex', gap: 8, padding: '8px 12px',
        borderTop: `1px solid ${C.hair}`, background: C.panel,
      }}>
        <Action side="BUY" label="매수" tone={C.up}
          onClick={() => onOrder({ symbol, market, side: 'BUY' })}/>
        <Action side="SELL" label="매도" tone={C.down}
          onClick={() => onOrder({ symbol, market, side: 'SELL' })}/>
      </div>
    </div>
  );
}

/** 이 종목과 **실제로 매핑된** 기사만. 지어낸 기사 경로는 쓰지 않는다. */
function NewsSection({ symbol }: { symbol: string }) {
  const [state, setState] = useState<'LOADING' | 'READY' | 'ERROR'>('LOADING');
  const [items, setItems] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState('LOADING'); setError(null);
    (async () => {
      try {
        // 정본은 이것뿐이다. `/api/market/news`는 공급자가 없으면 지어낸
        // 기사를 돌려주던 경로라 여기서 부르지 않는다.
        const r = await fetch('/api/news/stored?limit=30', { cache: 'no-store' });
        const d = await r.json().catch(() => null);
        if (cancelled) return;
        if (!r.ok || !d?.ok) {
          setState('ERROR');
          setError(String(d?.message || d?.error || `뉴스를 불러오지 못했습니다 (${r.status})`));
          return;
        }
        const base = String(symbol).toUpperCase().replace(/USDT$|USD$/, '');
        const mine = (Array.isArray(d.items) ? d.items : []).filter((n: any) =>
          (Array.isArray(n.affectedAssets) ? n.affectedAssets : [])
            .some((a: any) => String(a).toUpperCase() === base));
        setItems(mine); setState('READY');
      } catch (e: any) {
        if (!cancelled) { setState('ERROR'); setError(`뉴스를 불러오지 못했습니다 (${e?.message || e})`); }
      }
    })();
    return () => { cancelled = true; };
  }, [symbol]);

  return (
    <Section title="뉴스">
      {state === 'LOADING' ? (
        <div style={{ fontSize: FS.micro, color: C.faint }}>불러오는 중…</div>
      ) : state === 'ERROR' ? (
        <Unavailable testid="detail-news-error" reason={error}/>
      ) : items.length === 0 ? (
        <div data-testid="detail-news-empty" style={{ fontSize: FS.micro, color: C.faint }}>
          이 종목과 연결된 기사가 아직 없습니다
        </div>
      ) : items.slice(0, 5).map((n: any, i: number) => (
        <div key={n.hash || i} data-testid="detail-news-item" style={{
          padding: '7px 0', borderTop: i ? `1px solid ${C.hair2}` : 'none', minWidth: 0,
        }}>
          <div style={{ fontSize: FS.micro, lineHeight: 1.45, overflowWrap: 'anywhere' }}>
            {n.titleKo || n.title}
          </div>
          <div style={{ fontSize: FS.nano, color: C.faint, marginTop: 2 }}>
            {n.source || n.provider || '출처 미상'} · {fmtTime(n.publishedAt)}
          </div>
        </div>
      ))}
    </Section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ padding: '10px 12px', borderTop: `1px solid ${C.hair}`, minWidth: 0 }}>
      <div style={{ fontSize: FS.micro, color: C.faint, fontWeight: 700, marginBottom: 6 }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))',
      gap: '8px 12px', minWidth: 0,
    }}>{children}</div>
  );
}

/** **값을 자르지 않는다.** 좁으면 줄을 나눈다 — 잘린 숫자는 자릿수를 속인다. */
function Stat({ label, value, sub, testid, inline }: {
  label: string; value: string; sub?: string | null; testid: string; inline?: boolean;
}) {
  return (
    <div style={{
      minWidth: 0,
      ...(inline ? { display: 'inline-flex', gap: 4, alignItems: 'baseline' } : null),
    }}>
      <div style={{ fontSize: FS.nano, color: C.faint, whiteSpace: 'nowrap' }}>{label}</div>
      <div data-testid={testid} style={{
        ...NUM, fontSize: FS.micro, fontWeight: 700, color: C.dim,
        minWidth: 0, overflowWrap: 'anywhere',
      }}>{value}</div>
      {sub && !inline ? (
        <div style={{ fontSize: FS.nano, color: C.faint, lineHeight: 1.35, overflowWrap: 'anywhere' }}>
          {sub}
        </div>
      ) : null}
    </div>
  );
}

function Unavailable({ reason, testid }: { reason: string | null; testid: string }) {
  return (
    <div data-testid={testid} style={{
      fontSize: FS.nano, color: C.faint, lineHeight: 1.45, overflowWrap: 'anywhere',
    }}>{reason || '확인하지 못했습니다'}</div>
  );
}

function Action({ side, label, tone, onClick }: {
  side: 'BUY' | 'SELL'; label: string; tone: string; onClick: () => void;
}) {
  return (
    <button type="button" data-testid={`detail-${side.toLowerCase()}`} onClick={onClick}
      style={{
        flex: 1, minWidth: 0, padding: '12px 0', borderRadius: 10, border: 'none',
        background: tone, color: '#fff', fontSize: FS.lead, fontWeight: 800,
        cursor: 'pointer', whiteSpace: 'nowrap',
      }}>{label}</button>
  );
}

/** 거래 통화. `BTCUSDT` → `USDT`. 모르면 null — 다른 통화와 안 섞는다. */
function quoteOf(symbol: string): string | null {
  const s = String(symbol || '').toUpperCase();
  for (const q of ['USDT', 'USDC', 'BUSD', 'KRW', 'BTC', 'ETH']) {
    if (s.endsWith(q) && s.length > q.length) return q;
  }
  return null;
}

/** 못 읽은 값은 `—`다. 0으로 적으면 "값이 0인 자산"이 된다. */
function fmt(v: any, digits = 2): string {
  if (v == null || v === '' || typeof v === 'boolean') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function fmtTime(s: any): string {
  const t = Date.parse(String(s ?? ''));
  if (!Number.isFinite(t)) return '시각 미상';
  return new Date(t).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
