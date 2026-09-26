'use client';
// src/components/trading/markets/TradingScreenShell.tsx
//
// **네 거래 화면이 공유하는 껍데기. 시장을 한 글자도 모른다.**
//
// 배치 (바이낸스 모바일 골격)
// ───────────────────────────
//   ┌ 헤더        ‹  종목 · 현재가 · 등락            고정
//   │ 시장 정보   시장이 채운다(마크·펀딩·주문가능금액…) 고정
//   │ 차트 막대   접혀 있다                          고정
//   │ [주문폼 │ 호가]                                ← 첫 화면의 본문
//   │ 예상값·사유                                     고정
//   │ 실행 버튼                                       고정
//   ├ ── 여기까지가 첫 화면 ──────────────────────────
//   └ 탭: 포지션 · 미체결 · 체결                     내리면 나온다
//
// ★ 첫 화면에 **호가 · 주문 입력 · 실행 버튼**이 같이 있어야 한다
// ────────────────────────────────────────────────────────────────
// 이것이 이 배치의 목적 전부다. 셋 중 하나라도 화면 밖으로 밀리면 실패다.
// 그래서 첫 화면 높이를 **재서** 계산한다(`useMeasuredHeight`). 상수로
// 박아 두면 종목 이름이 길어지거나 경고 한 줄이 늘어난 날 조용히 밀린다 —
// 이 저장소에서 실제로 그렇게 [숏 진입] 버튼이 잘려 나간 적이 있다.
//
// 탭 줄만큼(`TAB_PEEK`) 남기는 이유: 그 줄이 안 보이면 **아래에 무언가
// 있다는 사실 자체가** 안 보인다. 스크롤은 아무도 배울 필요가 없지만,
// 내릴 것이 있다는 신호는 화면에 있어야 한다.
//
// ★ 이 파일은 시장을 모른다
// ─────────────────────────
// 레버리지·계약 수·주문가능금액은 여기 없다. 전부 `slot`으로 받는다.
// 껍데기가 시장을 알기 시작하면 네 화면의 의미가 한 파일에서 섞이고,
// 그때부터는 현물 화면에 청산가가 새어 들어가도 아무도 모른다
// (`marketScreenContract.SHARED_NEUTRAL_COMPONENTS`가 이것을 검사한다).
import React from 'react';
import { C, FS, NUM } from '@/components/terminal/theme';
import { useMeasuredHeight } from '@/lib/ui/useMeasuredHeight';
import { ChartDrawer, type ChartSource } from './ChartDrawer';

export interface ShellTab {
  id: string;
  label: string;
  body: React.ReactNode;
}

export interface TradingScreenShellProps {
  /** 화면 뿌리 표식. **시장 계약이 정한다**(`MARKET_SCREENS[].root`) */
  testid: string;
  symbol: string;
  name?: string;
  /** 시장 이름 한 줄. 예: `USDⓈ-M 선물` */
  marketLabel: string;
  price: number | null;
  changePct: number | null;
  changeLabel: string;
  onBack: () => void;
  /** 헤더 오른쪽 (밀도 전환 등) */
  headerRight?: React.ReactNode;
  /** 차트 서랍이 그릴 출처. **없으면 null**이고 이유를 적는다 */
  chartSource: ChartSource | null;
  chartUnavailableReason?: string;
  /** 시장별 핵심 정보 줄 (마크가·펀딩·주문가능금액…) */
  info: React.ReactNode;
  /** 왼쪽 — 주문 입력 */
  orderForm: React.ReactNode;
  /** 오른쪽 — 호가. **접을 수 있다** */
  orderBook: React.ReactNode;
  /** 예상값·막힌 사유. 스크롤 밖에 고정된다 */
  estimate?: React.ReactNode;
  /** 실행 버튼 줄 */
  cta: React.ReactNode;
  /** 아래 탭. 포지션·미체결·체결은 시장마다 다르다 */
  tabs: ShellTab[];
}

/** 탭 줄이 첫 화면 끝에 살짝 비치는 만큼 */
const TAB_PEEK = 72;

function fmt(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toLocaleString(undefined, { maximumFractionDigits: 8 });
}

export function TradingScreenShell(p: TradingScreenShellProps) {
  const [boxRef, boxH] = useMeasuredHeight<HTMLDivElement>();
  const [topRef, topH] = useMeasuredHeight<HTMLDivElement>();
  const [bookOpen, setBookOpen] = React.useState(true);
  const [tab, setTab] = React.useState(p.tabs[0]?.id || '');

  // 첫 화면의 본문 높이 = 통 − (헤더+정보+차트막대) − 탭 줄이 비치는 만큼.
  // 아래 예상값·버튼 줄은 본문 밖에 있으므로 여기서 빼지 않는다 — 그 둘은
  // `flexShrink: 0`이라 절대 눌리지 않는다.
  const bodyH = Math.max(180, boxH - topH - TAB_PEEK);
  const active = p.tabs.find(t => t.id === tab) || p.tabs[0];

  return (
    <div
      data-testid={p.testid}
      data-region="tradingScreen"
      ref={boxRef}
      style={{
        // 차트 덮개가 이 통 안에서 절대 위치를 잡는다
        position: 'relative',
        height: '100%', minHeight: 0, background: C.bg, color: C.text,
        overflowY: 'auto', overscrollBehavior: 'contain',
        WebkitOverflowScrolling: 'touch' as any,
      }}
    >
      <div ref={topRef}>
        {/* ── 헤더 ── */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 10px', borderBottom: `1px solid ${C.hair}`,
        }}>
          <button type="button" onClick={p.onBack} data-testid="trading-back" aria-label="뒤로"
            style={{
              flexShrink: 0, background: 'none', border: 'none', color: C.text,
              fontSize: 20, cursor: 'pointer', padding: '0 4px', minHeight: 32,
            }}>‹</button>
          <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            <span data-testid="trading-symbol" style={{
              fontSize: FS.lead, fontWeight: 800, whiteSpace: 'nowrap',
              overflow: 'hidden', textOverflow: 'clip',
            }}>{p.name || p.symbol}</span>
            <span data-testid="trading-market-label" style={{ fontSize: FS.nano, color: C.faint }}>
              {p.symbol} · {p.marketLabel}
            </span>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
            <span data-testid="trading-price" style={{
              ...NUM, fontSize: FS.lead, fontWeight: 800,
              color: p.price == null ? C.faint : C.text, overflowWrap: 'anywhere',
            }}>{fmt(p.price)}</span>
            <span data-testid="trading-change" title={p.changeLabel} style={{
              ...NUM, fontSize: FS.micro, fontWeight: 700,
              color: p.changePct == null ? C.faint : p.changePct >= 0 ? C.up : C.down,
            }}>{p.changePct == null ? '—'
              : `${p.changePct >= 0 ? '+' : ''}${p.changePct.toFixed(2)}%`}</span>
          </div>
          {p.headerRight}
        </div>

        {/* ── 시장별 핵심 정보 — 시장이 채운다 ── */}
        <div data-testid="trading-info-strip" style={{
          borderBottom: `1px solid ${C.hair}`, background: C.panel,
        }}>{p.info}</div>

        {/* ── 차트: 접힌 막대 하나 ── */}
        <ChartDrawer
          label={`${p.symbol} 차트`}
          source={p.chartSource}
          unavailableReason={p.chartUnavailableReason}
        />
      </div>

      {/* ── 첫 화면 본문: [주문폼 │ 호가] ── */}
      <div style={{ height: bodyH, display: 'flex', overflow: 'hidden' }}>
        {/* 주문 칸은 **자기 스크롤을 갖는다.** hidden으로 두면 넘친 줄이
            말없이 사라지고, 사라진 것이 실행 버튼일 수도 있다. */}
        <div data-testid="trading-order-col" style={{
          width: bookOpen ? '58%' : '100%', flexShrink: 0, minHeight: 0,
          overflowY: 'auto', overscrollBehavior: 'contain',
          WebkitOverflowScrolling: 'touch' as any,
          borderRight: bookOpen ? `1px solid ${C.hair}` : 'none',
          padding: '6px 8px',
        }}>{p.orderForm}</div>

        {/* 호가는 접을 수 있다. 주문 설정을 만질 때 폼이 화면을 다 쓴다.
            **접어도 계속 받는다** — 다시 폈을 때 낡은 값을 보고 주문하면 안 된다. */}
        {bookOpen ? (
          <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden', position: 'relative' }}>
            <button type="button" onClick={() => setBookOpen(false)} aria-label="호가 접기"
              style={{
                position: 'absolute', top: 2, right: 4, zIndex: 3,
                minHeight: 0, padding: '2px 6px', borderRadius: 5,
                background: C.raised, border: `1px solid ${C.hair}`,
                color: C.faint, fontSize: FS.micro, fontWeight: 700, cursor: 'pointer',
              }}>호가 ›</button>
            {p.orderBook}
          </div>
        ) : (
          <button type="button" onClick={() => setBookOpen(true)} aria-label="호가 펴기"
            style={{
              width: 26, flexShrink: 0, minHeight: 0,
              background: C.raised, border: 'none', borderLeft: `1px solid ${C.hair}`,
              color: C.faint, fontSize: FS.micro, fontWeight: 700, cursor: 'pointer',
              writingMode: 'vertical-rl' as any, letterSpacing: '0.1em',
            }}>‹ 호가</button>
        )}
      </div>

      {/* ── 예상값 · 사유 — 본문 밖. 스크롤에 딸려 사라지지 않는다 ── */}
      {p.estimate ? <div style={{ flexShrink: 0 }}>{p.estimate}</div> : null}

      {/* ── 실행 버튼 ──
          `position: sticky`로 붙이지 않는다. 360×660 실측에서 붙인 줄이
          슬라이더를 덮어 **보이는데 눌리지 않는** 상태가 된 적이 있다. */}
      <div data-testid="trading-cta" style={{
        flexShrink: 0, padding: '6px 10px',
        background: C.panel, borderTop: `1px solid ${C.hair}`,
      }}>{p.cta}</div>

      {/* ── 아래: 포지션 · 미체결 · 체결 ── */}
      <div style={{ borderTop: `1px solid ${C.hair2}`, background: C.panel }}>
        <div data-testid="trading-tabs" style={{
          display: 'flex', gap: 2, padding: '0 6px',
          borderBottom: `1px solid ${C.hair}`,
          position: 'sticky', top: 0, zIndex: 2, background: C.panel,
        }}>
          {p.tabs.map(t => (
            <button key={t.id} type="button" data-testid={`trading-tab-${t.id}`}
              onClick={() => setTab(t.id)}
              style={{
                minHeight: 44, padding: '0 10px', background: 'none', border: 'none',
                borderBottom: `2px solid ${t.id === active?.id ? C.text : 'transparent'}`,
                color: t.id === active?.id ? C.text : C.faint,
                fontSize: FS.small, fontWeight: 800, cursor: 'pointer',
              }}>{t.label}</button>
          ))}
        </div>
        <div style={{ padding: 10 }}>{active?.body}</div>
      </div>
    </div>
  );
}

/**
 * 정보 한 칸. **없는 값을 0으로 적지 않는다** — 못 읽으면 `—`이고
 * 사유가 있으면 사유를 같이 적는다.
 */
export function InfoStat({ testid, label, value, sub, tone }: {
  testid: string; label: string; value: string;
  sub?: string | null; tone?: 'up' | 'down' | 'warn';
}) {
  const col = tone === 'up' ? C.up : tone === 'down' ? C.down : tone === 'warn' ? C.warn : C.text;
  return (
    <div data-testid={testid} style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
      <span style={{ fontSize: FS.nano, color: C.faint, whiteSpace: 'nowrap' }}>{label}</span>
      <span style={{ ...NUM, fontSize: FS.micro, fontWeight: 700, color: col, overflowWrap: 'anywhere' }}>
        {value}
      </span>
      {sub ? <span style={{ fontSize: FS.nano, color: C.faint, lineHeight: 1.3 }}>{sub}</span> : null}
    </div>
  );
}

/**
 * 할 수 없는 것. **숨기지 않고 잠그고 이유를 적는다.**
 *
 * 칸을 지우면 "이 시장에는 그 개념이 없다"로 읽히고, 열어 두면 "되는데
 * 지금 비어 있다"로 읽힌다. 둘 다 틀릴 때가 있다 — 개념은 있는데 우리가
 * 아직 못 하는 것이 그렇다. 그때는 잠근 칸에 사유를 적는다.
 */
export function LockedField({ testid, title, reason }: {
  testid: string; title: string; reason: string;
}) {
  return (
    <div data-testid={testid} data-locked="1" style={{
      border: `1px solid ${C.hair}`, borderRadius: 8, background: C.raised,
      padding: '7px 9px', display: 'grid', gap: 3, minWidth: 0,
    }}>
      <div style={{ fontSize: FS.nano, fontWeight: 800, color: C.dim }}>{title}</div>
      <div style={{ fontSize: FS.nano, color: C.faint, lineHeight: 1.5, overflowWrap: 'anywhere' }}>
        {reason}
      </div>
    </div>
  );
}
