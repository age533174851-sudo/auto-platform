'use client';
// src/components/trading/markets/StockTradingScreen.tsx
//
// **주식 거래 화면.**
//
// 이 시장의 말
// ────────────
//   매수 / 매도 / 정정·취소 · 호가 · 주문가능금액 · 수량 · 총 주문금액 ·
//   보유수량 · 평균단가 · 평가손익 · 미체결 · 체결 · 장 세션
//
// ★ 선물 개념은 **한 글자도** 들어오면 안 된다
// ─────────────────────────────────────────────
//   레버리지 · 격리/교차 · 펀딩 · 청산가 · 감축전용 · LONG/SHORT · 마크가
//
// 주식 화면에 레버리지가 보이면 사용자는 **레버리지가 있는 줄 안다.**
// 이 경로는 현금 매수·매도만 낸다 — 공매도는 대주/신용이 따로 필요하고
// 규칙도 다르다(`marketType.CAP.STOCK`). 없는 것을 있는 척하지 않는다.
//
// `marketScreenContract`의 STOCK `never` 목록이 이 파일에서 가장 중요하고,
// 검사기가 그 목록을 소스에서 직접 확인한다.
//
// ★ 거래소가 아니라 증권사를 탄다
// ────────────────────────────────
// 바이낸스 연결로는 주문이 안 나간다. 주문 경로는 `/api/stock/order`이고
// 한국투자증권 연결이 필요하다. 연결 여부를 화면이 **먼저** 말한다 —
// 누르고 나서 실패를 보는 것이 아니라.
//
// ★ 장이 열려 있는가를 먼저 본다
// ───────────────────────────────
// `marketHours.marketPhase`가 정본이다. **여기서 시간표를 다시 쓰지
// 않는다.** 그리고 휴장일 목록을 모르면 `holidaysKnown: false`가 그대로
// 화면에 적힌다 — 모르는 것을 "열려 있다"로 적지 않는다.
import React from 'react';
import { C, FS } from '@/components/terminal/theme';

import { TradingScreenShell, InfoStat, LockedField,
  type ShellTab, type MarketScreenCommonProps } from './TradingScreenShell';
import { fieldTestId, screenContract } from '@/lib/trading/marketScreenContract';
import { capability } from '@/lib/markets/marketType';
import { marketPhase, marketOfSymbol } from '@/lib/markets/marketHours';

export interface StockScreenProps extends MarketScreenCommonProps {
  /** 주문가능금액. **못 읽었으면 null** — 0으로 접지 않는다 */
  orderableCash: number | null;
  orderableCashUnknownReason?: string | null;
  heldQty: number | null;
  avgCost: number | null;
  /** 증권사 연결이 되어 있는가. 안 되어 있으면 사유를 적는다 */
  brokerReason?: string | null;
  /** 공휴일 목록. **없으면 null** — 그러면 화면이 "휴장일은 못 거릅니다"라고 적는다 */
  holidays?: string[] | null;
}

const CONTRACT = screenContract('STOCK');
const NO_BROKER = '증권사(한국투자증권) 연결이 없습니다 — 바이낸스 연결로는 주식 주문이 나가지 않습니다';

export function StockTradingScreen(p: StockScreenProps) {
  const [side, setSide] = React.useState<'BUY' | 'SELL'>('BUY');
  const [qtyText, setQtyText] = React.useState('');

  // ★ 종목이 없으면 거래소도 세션도 정하지 않는다. 코인 티커를 주식으로
  //   읽어 미국장 시간표를 적용하면 조용히 틀린 판정이 나온다.
  const sym = p.instrument?.symbol ?? null;
  const venue = sym == null ? null : marketOfSymbol(sym);
  const session = venue ? marketPhase(venue, Date.now(), { holidays: p.holidays ?? null }) : null;
  const blocked = p.instrumentReason || p.brokerReason || NO_BROKER;
  // 종목이 없거나 증권사 연결이 없거나 장이 닫혀 있으면 **누를 수 없다.**
  // 세 사유를 한 값으로 접어야 버튼마다 빠뜨리지 않는다.
  const locked = sym == null || !!blocked || !session?.canOrder;

  const qty = Number(qtyText);
  // 총 주문금액은 **수량 × 현재가**다. 가격을 못 읽으면 계산하지 않는다 —
  // 0원으로 적으면 "공짜"로 읽힌다.
  const totalAmount = !locked && p.price != null && Number.isFinite(qty) && qty > 0
    ? p.price * qty : null;
  // 평가손익 = (현재가 − 평균단가) × 보유수량. 셋 중 하나라도 없으면 null.
  const evalPnl = !locked && p.price != null && p.avgCost != null && p.heldQty != null
    ? (p.price - p.avgCost) * p.heldQty : null;

  const info = (
    <div style={{ display: 'flex', gap: 14, padding: '6px 10px', overflowX: 'auto' }}>
      <InfoStat testid={fieldTestId('SESSION_INFO')} label="장"
        value={session == null ? '확인 불가' : session.phase}
        sub={session == null
          ? (locked ? '종목이 없어 거래소를 정하지 않았습니다'
                    : '이 심볼의 거래소를 정하지 못했습니다')
          : `${session.reason}${session.holidaysKnown ? '' : ' · 휴장일 목록 없음'}`}
        tone={session?.canOrder ? 'up' : 'warn'}/>
      <InfoStat testid={fieldTestId('ORDERABLE_CASH')} label="주문가능금액"
        value={p.orderableCash == null ? '—' : p.orderableCash.toLocaleString()}
        sub={p.orderableCash == null
          ? (p.orderableCashUnknownReason || '증권사에서 읽지 못했습니다')
          : null}/>
      <InfoStat testid={fieldTestId('HELD_QTY')} label="보유수량"
        value={p.heldQty == null ? '—' : p.heldQty.toLocaleString()}
        sub={p.heldQty == null ? '보유를 읽지 못했습니다' : null}/>
      <InfoStat testid={fieldTestId('AVG_COST')} label="평균단가"
        value={p.avgCost == null ? '—' : p.avgCost.toLocaleString()}
        sub={p.avgCost == null ? '체결평균가 없음' : null}/>
      <InfoStat testid={fieldTestId('EVAL_PNL')} label="평가손익"
        value={evalPnl == null ? '—' : evalPnl.toLocaleString()}
        sub={evalPnl == null ? '현재가·평균단가·보유수량이 모두 필요합니다' : null}
        tone={evalPnl == null ? undefined : evalPnl >= 0 ? 'up' : 'down'}/>
    </div>
  );

  const orderForm = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      {/* 주식은 산다/판다다 */}
      <div data-testid={fieldTestId('BUY_SELL')} style={{ display: 'flex', gap: 3 }}>
        {(['BUY', 'SELL'] as const).map(k => (
          <button key={k} type="button" onClick={() => setSide(k)}
            data-testid={`stock-side-${k}`} aria-pressed={side === k}
            style={{
              flex: 1, minHeight: 30, borderRadius: 6,
              border: `1px solid ${side === k ? (k === 'BUY' ? C.up : C.down) : C.hair}`,
              background: side === k ? C.raised : 'transparent',
              color: side === k ? (k === 'BUY' ? C.up : C.down) : C.dim,
              fontSize: FS.nano, fontWeight: 800, cursor: 'pointer',
            }}>{k === 'BUY' ? '매수' : '매도'}</button>
        ))}
      </div>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
        <span style={{ fontSize: FS.nano, color: C.faint, fontWeight: 700 }}>수량 (주)</span>
        <input inputMode="numeric" value={qtyText}
          onChange={e => setQtyText(e.target.value.replace(/[^\d]/g, ''))}
          placeholder="주 단위"
          style={{
            minHeight: 34, borderRadius: 6, border: `1px solid ${C.hair}`,
            background: C.raised, color: C.text, fontSize: FS.body,
            padding: '0 8px', minWidth: 0,
          }}/>
      </label>

      <InfoStat testid={fieldTestId('TOTAL_ORDER_AMOUNT')} label="총 주문금액"
        value={totalAmount == null ? '—' : Math.round(totalAmount).toLocaleString()}
        sub={totalAmount == null ? '수량과 현재가가 모두 필요합니다' : null}/>

      {/* 정정·취소는 미체결이 있어야 뜻이 있다. 증권사 연결이 없으면
          미체결을 읽을 수 없으므로 잠그고 사유를 적는다. */}
      <LockedField testid={fieldTestId('AMEND_CANCEL')} title="정정 · 취소"
        reason={blocked}/>
    </div>
  );

  const tabs: ShellTab[] = [
    {
      id: 'open-orders', label: '미체결',
      body: <LockedField testid={fieldTestId('OPEN_ORDERS')} title="미체결" reason={blocked}/>,
    },
    {
      id: 'fills', label: '체결',
      body: <LockedField testid={fieldTestId('FILLS')} title="체결" reason={blocked}/>,
    },
  ];

  return (
    <TradingScreenShell
      testid={CONTRACT.root}
      market={p.market} onMarket={p.onMarket}
      instrumentReason={p.instrumentReason}
      symbol={sym ?? '종목 없음'} name={p.name}
      marketLabel={capability('STOCK').label}
      price={locked ? null : p.price} changePct={locked ? null : p.changePct}
      changeLabel={p.changeLabel}
      onBack={p.onBack} headerRight={p.headerRight}
      // 주식 봉 출처가 아직 이어지지 않았다(`instrumentRoute` 머리말).
      // 코인 봉을 대신 그리지 않는다.
      chartSource={null}
      chartUnavailableReason={p.instrumentReason
        || '주식 봉 출처가 아직 이어지지 않았습니다 — 코인 봉을 대신 그리지 않습니다'}
      info={info}
      orderForm={orderForm}
      orderBook={
        <div data-testid={fieldTestId('ORDER_BOOK')} style={{ height: '100%' }}>
          {/* 바이낸스 호가 스트림은 주식을 모른다. 칸을 비워 두면 "호가가
              없는 종목"으로 읽히므로 이유를 적는다. */}
          <div data-testid="stock-book-unavailable" style={{
            padding: 10, fontSize: FS.nano, color: C.faint, lineHeight: 1.6,
          }}>
            주식 호가는 증권사에서 받습니다. {blocked}
          </div>
        </div>
      }
      estimate={
        <div data-testid="stock-blocked-reason" style={{
          padding: '5px 9px', borderTop: `1px solid ${C.hair}`, background: C.panel,
          fontSize: FS.nano, color: C.warn, lineHeight: 1.45,
        }}>
          {blocked}
          {session && !session.canOrder ? ` · ${session.reason}` : ''}
        </div>
      }
      cta={
        <button type="button" data-testid="stock-cta" disabled={locked} title={blocked}
          style={{
            width: '100%', padding: '13px 0', borderRadius: 9, border: 'none',
            background: C.raised, color: C.faint,
            fontSize: FS.lead, fontWeight: 800,
            cursor: locked ? 'not-allowed' : 'pointer',
          }}>{side === 'BUY' ? capability('STOCK').buyLabel(p.name || sym || '종목')
            : capability('STOCK').sellLabel(p.name || sym || '종목')}</button>
      }
      tabs={tabs}
    />
  );
}
