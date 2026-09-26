'use client';
// src/components/trading/markets/CoinMFuturesTradingScreen.tsx
//
// **COIN-M(코인 마진) 선물 거래 화면.**
//
// ★ 왜 USDⓈ-M 화면을 재사용하지 않는가
// ────────────────────────────────────
// 껍데기는 같아도 **주문의 의미가 다르다.** `coinM.ts` 머리말이 네 가지를
// 적어 뒀고, 그중 셋이 화면에 그대로 드러난다:
//
//   ① 수량 단위가 **계약(contract)**이다. 코인 개수가 아니다.
//      BTCUSD_PERP은 1계약 = 100 USD. 사용자가 `0.5`를 넣으며 "0.5 BTC"를
//      생각했다면 실제로는 0.5계약 = 50 USD다. 100을 넣으면 10,000 USD다.
//      **이 오해가 이 시장에서 가장 흔한 사고다.**
//   ② 증거금과 손익이 **코인**으로 계산된다. "$50 필요"라고 적으면 틀린다.
//   ③ 역방향 계약이라 손익이 가격에 선형이 아니다.
//
// USDⓈ-M의 수량 계산을 그대로 가져다 쓰면 ①이 조용히 깨진다. 화면은
// 멀쩡해 보이고 숫자도 나온다 — 100배 틀린 숫자가. 그래서 이 화면은
// `useTradeForm`을 **쓰지 않는다.** 그 훅은 코인 개수를 다루는 훅이다.
//
// ★ 지금 주문을 낼 수 없다 — 그 사실을 화면이 먼저 말한다
// ────────────────────────────────────────────────────────
// 모의 장부(`/api/paper/order`)는 `SPOT`과 `USDM`만 받는다
// (`paperOrderUiWiring`). COIN-M 모의 주문 경로가 없다. 그래서 실행
// 버튼을 **잠그고 능력표의 사유를 그대로 적는다.** 버튼을 열어 두면
// 눌러서 아무 일도 안 일어나거나 다른 시장으로 나간다.
//
// 계약 크기를 모르면 계산하지 않는다
// ──────────────────────────────────
// `resolveContractSize`가 null을 주면 **추측하지 않는다.** 알트가 대개
// 10 USD인 것은 알지만, 그 '대개'로 주문을 내면 BTC에서 10배 틀린다.
import React from 'react';
import { C, FS } from '@/components/terminal/theme';
import { OrderBookView, useFunding, useCountdown } from '../OrderBookView';
import { TradingScreenShell, InfoStat, LockedField, type ShellTab } from './TradingScreenShell';
import { fieldTestId, screenContract } from '@/lib/trading/marketScreenContract';
import { paperOrderUiWiring } from '@/lib/trading/capability';
import { capability } from '@/lib/markets/marketType';
import { liquidationDistancePct } from '@/lib/engine/leverageMath';
import {
  baseAssetOf, resolveContractSize, contractsToCoin, inverseLiquidationPrice,
} from '@/lib/markets/coinM';

export interface CoinMScreenProps {
  /** `BTCUSD_PERP` 형식 */
  symbol: string;
  name?: string;
  price: number | null;
  markPrice: number | null;
  changePct: number | null;
  changeLabel: string;
  /** exchangeInfo에서 온 계약 크기. **없으면 null** — 기본값을 넣지 않는다 */
  contractUsdFromExchange?: number | null;
  onBack: () => void;
  headerRight?: React.ReactNode;
}

const CONTRACT = screenContract('COIN_FUTURES');
const LEVERAGES = [1, 2, 3, 5, 10, 20, 50, 75, 100, 125];

export function CoinMFuturesTradingScreen(p: CoinMScreenProps) {
  const [intent, setIntent] = React.useState<'OPEN' | 'CLOSE'>('OPEN');
  const [leverage, setLeverage] = React.useState(10);
  const [marginMode, setMarginMode] = React.useState<'ISOLATED' | 'CROSSED'>('ISOLATED');
  const [contractsText, setContractsText] = React.useState('');
  const funding = useFunding(p.symbol);
  const nextIn = useCountdown(funding.nextAt);

  // 이 시장은 모의 장부가 다루지 않는다. 사유는 능력표에서 온다 —
  // 화면이 자기 말로 다시 적으면 두 문장이 갈린다.
  const wiring = paperOrderUiWiring('COINM');

  const base = baseAssetOf(p.symbol);
  const spec = resolveContractSize(p.symbol, p.contractUsdFromExchange ?? null);
  const contracts = Number(contractsText);
  const price = p.markPrice ?? p.price;

  // ★ 계약 → 코인. **추측하지 않는다** — 계약 크기나 가격이 없으면 null이다.
  const coinQty = spec && Number.isFinite(contracts) && contracts > 0 && price != null
    ? contractsToCoin(contracts, spec.contractUsd, price) : null;
  const notionalUsd = spec && Number.isFinite(contracts) && contracts > 0
    ? contracts * spec.contractUsd : null;
  const liqDist = liquidationDistancePct(leverage);
  // 역방향 청산가는 `coinM.inverseLiquidationPrice`가 정본이다.
  // 여기서 1/P 공식을 다시 쓰지 않는다 — 두 벌이면 언젠가 갈린다.
  const liqPrice = price != null ? inverseLiquidationPrice(price, leverage, 'LONG') : null;

  const info = (
    <div style={{ display: 'flex', gap: 14, padding: '6px 10px', overflowX: 'auto' }}>
      <InfoStat testid={fieldTestId('MARK_PRICE')} label="마크가"
        value={p.markPrice == null ? '—' : p.markPrice.toFixed(2)}
        sub={p.markPrice == null ? '스트림 미수신' : null}/>
      <InfoStat testid={fieldTestId('FUNDING')} label="펀딩"
        value={funding.rate == null ? '—' : `${funding.rate.toFixed(4)}%`}
        sub={funding.nextAt == null ? '다음 정산 미확인' : `다음 ${nextIn}`}/>
      {/* ★ COIN-M을 COIN-M이게 하는 칸들 */}
      <InfoStat testid={fieldTestId('CONTRACT_MULTIPLIER')} label="1계약"
        value={spec == null ? '확인 불가' : `${spec.contractUsd} USD`}
        sub={spec == null
          ? '거래소 계약 크기를 못 읽었습니다 — 추측하지 않습니다'
          : (spec.source === 'exchange' ? '거래소 값' : '우리가 아는 값')}
        tone={spec == null ? 'warn' : undefined}/>
      <InfoStat testid={fieldTestId('COLLATERAL_COIN')} label="담보"
        value={base == null ? '확인 불가' : base}
        sub={base == null ? 'COIN-M 심볼이 아닙니다' : '증거금·손익이 이 코인입니다'}/>
      <InfoStat testid={fieldTestId('PNL_UNIT')} label="손익 단위"
        value={base == null ? '확인 불가' : base}
        sub="역방향 계약 — USD 환산이 아닙니다"/>
      <InfoStat testid={fieldTestId('LIQUIDATION_PRICE')} label="청산가"
        value={liqPrice == null ? '—' : Number(liqPrice).toFixed(2)}
        sub={liqPrice == null ? '계약 수·가격이 필요합니다' : null}/>
      <InfoStat testid={fieldTestId('LIQUIDATION_DISTANCE')} label="청산까지"
        value={liqDist == null ? '—' : `${liqDist.toFixed(2)}%`}
        sub={`${leverage}배 기준`}
        tone={liqDist != null && liqDist < 2 ? 'warn' : undefined}/>
    </div>
  );

  const sel: React.CSSProperties = {
    minHeight: 28, borderRadius: 5, border: `1px solid ${C.hair}`,
    background: C.raised, color: C.text, fontSize: FS.nano, fontWeight: 700,
    padding: '0 4px',
  };

  const orderForm = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      <div data-testid={fieldTestId('OPEN_CLOSE')} style={{ display: 'flex', gap: 3 }}>
        {(['OPEN', 'CLOSE'] as const).map(k => (
          <button key={k} type="button" onClick={() => setIntent(k)}
            data-testid={`intent-${k}`} aria-pressed={intent === k}
            style={{
              flex: 1, minHeight: 30, borderRadius: 6,
              border: `1px solid ${intent === k ? C.accent : C.hair}`,
              background: intent === k ? C.accentBg : C.raised,
              color: intent === k ? C.accent : C.dim,
              fontSize: FS.nano, fontWeight: 800, cursor: 'pointer',
            }}>{k === 'OPEN' ? '진입' : '청산'}</button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 4 }}>
        <select data-testid={fieldTestId('MARGIN_MODE')} value={marginMode}
          onChange={e => setMarginMode(e.target.value as any)} style={sel}>
          <option value="ISOLATED">격리</option>
          <option value="CROSSED">교차</option>
        </select>
        <select data-testid={fieldTestId('LEVERAGE')} value={leverage}
          onChange={e => setLeverage(Number(e.target.value))} style={sel}>
          {LEVERAGES.map(l => <option key={l} value={l}>{l}x</option>)}
        </select>
      </div>

      {/* ★ 수량 칸의 이름이 '수량'이 아니라 '계약 수'다.
          이름을 '수량'으로 두면 사용자는 코인 개수를 넣는다. */}
      <label data-testid={fieldTestId('CONTRACT_COUNT')}
        style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
        <span style={{ fontSize: FS.nano, color: C.faint, fontWeight: 700 }}>
          계약 수 (contracts) — 코인 개수가 아닙니다
        </span>
        <input inputMode="numeric" value={contractsText}
          onChange={e => setContractsText(e.target.value.replace(/[^\d]/g, ''))}
          placeholder="정수만"
          style={{
            minHeight: 34, borderRadius: 6, border: `1px solid ${C.hair}`,
            background: C.raised, color: C.text, fontSize: FS.body,
            padding: '0 8px', minWidth: 0,
          }}/>
      </label>

      {/* 환산 base 수량 — 계약이 실제로 코인 몇 개인지 */}
      <InfoStat testid={fieldTestId('CONVERTED_BASE_QTY')}
        label={`환산 ${base || 'base'} 수량`}
        value={coinQty == null ? '—' : coinQty.toFixed(8)}
        sub={coinQty == null
          ? (spec == null ? '계약 크기를 모릅니다' : '계약 수와 가격이 필요합니다')
          : `명목 ${notionalUsd} USD · 역방향이라 가격이 오르면 코인 수가 줍니다`}/>

      <LockedField testid={fieldTestId('REDUCE_ONLY')} title="감축전용 (Reduce Only)"
        reason="COIN-M 모의 경로가 없어 감축전용도 보낼 곳이 없습니다"/>
    </div>
  );

  const tabs: ShellTab[] = [
    {
      id: 'positions', label: '포지션',
      body: <LockedField testid={fieldTestId('POSITIONS')} title="포지션"
        reason={wiring.reason}/>,
    },
    {
      id: 'open-orders', label: '미체결',
      body: <LockedField testid={fieldTestId('OPEN_ORDERS')} title="미체결"
        reason={wiring.reason}/>,
    },
  ];

  return (
    <TradingScreenShell
      testid={CONTRACT.root}
      symbol={p.symbol} name={p.name}
      marketLabel={capability('COIN_FUTURES').label}
      price={p.price} changePct={p.changePct} changeLabel={p.changeLabel}
      onBack={p.onBack} headerRight={p.headerRight}
      // ★ 우리 봉 출처는 SPOT·USDM만 안다. COIN-M 봉을 USDⓈ-M 봉으로
      //   대신 그리면 사용자는 그것을 이 계약의 차트로 읽는다.
      chartSource={null}
      chartUnavailableReason={
        'COIN-M 봉 출처가 아직 없습니다 — 다른 시장의 봉을 대신 그리지 않습니다'}
      info={info}
      orderForm={orderForm}
      orderBook={
        <div data-testid={fieldTestId('ORDER_BOOK')} style={{ height: '100%' }}>
          <OrderBookView symbolId={p.symbol} market="USDM" rows={7} dense/>
        </div>
      }
      cta={
        <div data-testid={fieldTestId('LONG_SHORT')} style={{ display: 'flex', gap: 6 }}>
          {(['LONG', 'SHORT'] as const).map(side => (
            <button key={side} type="button" data-testid={`coinm-cta-${side}`}
              disabled title={wiring.reason}
              style={{
                flex: 1, minWidth: 0, padding: '13px 0', borderRadius: 9,
                border: 'none', background: C.raised, color: C.faint,
                fontSize: FS.lead, fontWeight: 800, cursor: 'not-allowed',
              }}>{side}</button>
          ))}
        </div>
      }
      estimate={
        <div data-testid="coinm-blocked-reason" style={{
          padding: '5px 9px', borderTop: `1px solid ${C.hair}`, background: C.panel,
          fontSize: FS.nano, color: C.warn, lineHeight: 1.45,
        }}>{wiring.reason}</div>
      }
      tabs={tabs}
    />
  );
}
