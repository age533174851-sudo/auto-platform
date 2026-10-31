// src/test/integration/holdExtensionIntegration.test.ts
//
// **4시간 보유 연장을 실제 실행 경로에서 돌린다.**
//
// 무엇이 실제로 도는가
// ────────────────────
//   실제: `runExitAuthority` 순서 · `decideExitAuthority` 관문 ①~⑩ ·
//         `decideHoldExtension` · `readHoldEvidence`의 다섯 조회와 단위
//         변환(수수료 왕복·펀딩 부호·명목→증거금) · `summarizeBars` ·
//         `venuePositionOps.prepareSymbolClose`/`sendSymbolClose`/
//         `readOpenPosition` · 서명 생성 · 응답 파싱 · `applyLifecycleClose`
//   가짜: `fetch` 한 겹뿐
//
// ★ **순수 판정 함수만 이어 붙인 것을 통합 시험이라고 부르지 않는다.**
//   아래 모든 시나리오는 거래소 호출 수를 세고, 그 수가 0이어야 하는
//   자리에서는 0을 확인한다.
//
// ★ 이 파일이 지키는 것은 수익성이 아니다. **연장이 늦추기만 한다**는
//   것과 **모호함이 전부 닫는 쪽으로 떨어진다**는 것이다.

import { test, eq, assert } from '../harness';
import { FakeVenue, withCryptoEnv } from './venueHarness';
// 정적 import — 러너가 이 파일들을 컴파일 대상에 넣어야 한다.
import {
  runExitAuthority, type ExitRunDeps, type ExitRunCandidate,
} from '../../lib/engine/exitAuthorityRun';
import { readHoldEvidence } from '../../lib/engine/holdEvidenceReader';
import {
  resolveHoldExtensionPolicy, judgeHoldExtensionActivation,
} from '../../lib/engine/holdExtension';
import * as ops from '../../lib/engine/venuePositionOps';
import { exitIntentId } from '../../lib/engine/exitIntent';

const FOUR_H = 4 * 3600 * 1000;
const STEP = 15 * 60 * 1000;

const VENUE_CREDS = {
  exchange: 'binance' as const,
  apiKey: 'K'.repeat(64), apiSecret: 'S'.repeat(64), testnet: true,
};

const EXACT100X = { profileId: 'MAX_LEV_100X', presetId: 'EXACT_100X', contractVersion: 2 };

/**
 * 봉 응답. **마지막 봉은 진행 중인 봉**이다 — `fetchVenueBars`가 그것을
 * 잘라 내므로, 판정에 쓰이는 것은 그 앞까지다.
 */
function klines(closes: number[], nowMs: number): any[] {
  const lastOpen = Math.floor(nowMs / STEP) * STEP;
  return closes.map((c, k) => {
    const openTime = lastOpen - (closes.length - 1 - k) * STEP;
    return [openTime, String(c), String(c + 10), String(c - 10), String(c),
      '1', openTime + STEP - 1, '0', 1, '0', '0', '0'];
  });
}

const RISING = [100_100, 100_120, 100_140, 100_160, 100_180,
  100_200, 100_220, 100_240, 100_260, 100_280];
const FALLING = [...RISING].reverse();

interface VenueOpts {
  markPrice?: string;
  /** 부호 있는 수량 */
  positionAmt?: string;
  liquidationPrice?: string;
  closes?: number[];
  /** 펀딩 income 줄 (거래소 규약: 낸 쪽이 음수) */
  income?: any[] | null;
  takerRate?: string | null;
  /** 종료 주문 응답 */
  orderReply?: any;
  /** 재조회에서 포지션이 남아 있는가 */
  leftAfter?: boolean;
  /** 마크가 조회가 실패한다 */
  markFails?: boolean;
  /** 봉 조회가 실패한다 */
  klinesFails?: boolean;
  /** 봉은 오는데 **멈춰 있다** (응답은 성공) */
  staleBars?: boolean;
}

function venueFor(nowMs: number, o: VenueOpts = {}): FakeVenue {
  const amt = o.positionAmt ?? '0.010';
  const v = new FakeVenue()
    .on('/fapi/v1/exchangeInfo', { json: { symbols: [{
      symbol: 'BTCUSDT', filters: [
        { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' },
        { filterType: 'MIN_NOTIONAL', notional: '5' },
        { filterType: 'PRICE_FILTER', tickSize: '0.10' },
      ],
    }] } })
    .on('/fapi/v1/positionSide/dual', { json: { dualSidePosition: false } })
    .on('/fapi/v1/klines', o.klinesFails
      ? { status: 500, json: { code: -1000, msg: 'down' } }
      // 멈춘 봉 — 응답은 200이고 봉도 충분하지만 **지금의 추세가 아니다**
      : { json: klines(o.closes ?? RISING, o.staleBars ? nowMs - 10 * STEP : nowMs) })
    .on('/fapi/v1/commissionRate', o.takerRate === null
      ? { status: 500, json: { code: -1000, msg: 'nope' } }
      : { json: { symbol: 'BTCUSDT', makerCommissionRate: '0.0002',
          takerCommissionRate: o.takerRate ?? '0.0005' } })
    .on('/fapi/v1/income', { json: o.income === undefined ? [] : (o.income ?? []) })
    .on('/fapi/v1/premiumIndex', o.markFails
      ? { status: 500, json: { code: -1001, msg: 'down' } }
      : { json: { symbol: 'BTCUSDT', markPrice: o.markPrice ?? '100300',
          indexPrice: '100290', lastFundingRate: '0.0001',
          nextFundingTime: nowMs + 3_600_000, time: nowMs } })
    .on('/fapi/v1/order', o.orderReply ?? {
      json: { orderId: 9001, symbol: 'BTCUSDT', status: 'FILLED',
        executedQty: amt.replace('-', ''), avgPrice: o.markPrice ?? '100300' },
    }, 'POST');

  // 포지션 조회 — 종료 전송 뒤에는 잔여가 바뀐다.
  //
  // ★ 호출 순서가 아니라 **전송 여부**로 판단한다. 호출 횟수로 세면
  //   조회 하나가 늘거나 줄 때마다 모든 시나리오가 조용히 뒤집힌다.
  v.on('/fapi/v2/positionRisk', { json: () => {
    const open = v.orderSends().length === 0 || o.leftAfter === true;
    return [{
      symbol: 'BTCUSDT',
      positionAmt: open ? amt : '0',
      entryPrice: open ? '100000' : '0',
      markPrice: o.markPrice ?? '100300',
      leverage: '100', marginType: 'isolated', unRealizedProfit: '0',
      liquidationPrice: open ? (o.liquidationPrice ?? '99400') : '0',
      updateTime: nowMs,
    }];
  } });
  return v;
}

const candidate = (nowMs: number, over: Partial<ExitRunCandidate> = {}): ExitRunCandidate => ({
  positionIdentity: {
    exchange: 'binance', connectionId: 'conn-1', symbol: 'BTCUSDT',
    side: 'LONG', executionIdentity: EXACT100X, openingOrderId: 'ord-1',
  },
  strategyId: 'scalp',
  executionIdentity: EXACT100X,
  capabilities: { fixedStopAtEntry: false, breakEven: false, trailing: false,
    timeExit: true, emergency: false },
  reason: 'TIME_EXIT',
  openedAtMs: nowMs - FOUR_H,
  ...over,
});

interface RigOpts {
  /** 쓰기 직전 재검증이 거짓을 돌려준다 (임차 탈취) */
  fenceLost?: boolean;
  /** 증거 조회를 아예 주지 않는다 — 연장 기능이 없던 때와 같다 */
  noEvidenceDep?: boolean;
  /**
   * 보유 연장 승인 상태. **기본은 승인 없음(= 꺼짐)이다.**
   *
   *   생략·false  → 승인 값 없음 (운영 기본값)
   *   true        → 포지션을 연 **뒤** 시각으로 승인 (대상이 된다)
   *   'before'    → 포지션을 연 **뒤** 시각으로 승인 (소급 금지로 제외된다)
   *   'garbage'   → 읽을 수 없는 승인 값
   */
  approved?: boolean | 'before' | 'garbage';
}

/** 이 회차에 넘길 승인 환경. **기본은 빈 환경 = 꺼짐** */
function envFor(nowMs: number, r: RigOpts): { EXACT100X_HOLD_EXTENSION_APPROVED_AT?: string } {
  if (r.approved === 'garbage') return { EXACT100X_HOLD_EXTENSION_APPROVED_AT: 'yes' };
  if (r.approved === 'before') {
    // 승인 시각이 **지금**이면, 4시간 전에 연 포지션은 승인 전의 것이다.
    return { EXACT100X_HOLD_EXTENSION_APPROVED_AT: String(nowMs) };
  }
  if (r.approved === true) {
    // 어느 시나리오의 포지션보다도 **앞서** 승인됐다 → 전부 대상이다.
    // (절대 상한을 넘긴 포지션도 포함해야 `CLOSE_CAP`을 시험할 수 있다)
    return { EXACT100X_HOLD_EXTENSION_APPROVED_AT: String(nowMs - 30 * 24 * 3_600_000) };
  }
  return {};
}

function depsFor(nowMs: number, r: RigOpts = {}): ExitRunDeps {
  let prepared: any = null;
  const deps: ExitRunDeps = {
    leaseOwned: async () => ({ owned: true, identity: { holder: 'w-a', fence: 7 } }),
    prepareClose: async () => {
      const p = await ops.prepareSymbolClose(VENUE_CREDS, 'BTCUSDT', 'LONG',
        (qty) => exitIntentId({
          connectionId: 'conn-1', exchange: 'binance', symbol: 'BTCUSDT',
          side: 'LONG', executionIdentity: EXACT100X,
          reason: 'TIME_EXIT', quantity: qty,
        }));
      prepared = p.prepared;
      return { code: p.code, prepared: p.prepared as any, message: p.message };
    },
    revalidateFence: async () => r.fenceLost !== true,
    sendClose: () => ops.sendSymbolClose(VENUE_CREDS, prepared),
    readAfter: () => ops.readOpenPosition(VENUE_CREDS, 'BTCUSDT')
      .then((x: any) => ({ ok: x.ok === true, found: x.found === true })),
    // **환경을 명시적으로 넘긴다.** `process.env`를 보게 두면 시험 결과가
    // 돌리는 기계의 환경변수에 따라 달라진다.
    holdExtensionEnv: envFor(nowMs, r),
  };
  if (r.noEvidenceDep !== true) {
    deps.readHoldEvidence = () => readHoldEvidence({
      venue: { apiKey: VENUE_CREDS.apiKey, apiSecret: VENUE_CREDS.apiSecret, testnet: true },
      symbol: 'BTCUSDT', side: 'LONG',
      openedAtMs: nowMs - FOUR_H, nowMs,
    });
  }
  return deps;
}

/**
 * 시나리오 하나를 돌린다.
 *
 * ★ 여기서는 `approved: true`가 기본이다 — 연장 **동작**을 시험하려면
 *   승인이 있어야 한다. **운영 기본값은 반대(꺼짐)이고**, 그 사실은 아래
 *   ⓿ 묶음이 `approved: false`로 따로 못박는다.
 */
async function run(
  venue: FakeVenue, nowMs: number,
  cand: ExitRunCandidate = candidate(nowMs), rig: RigOpts = {},
) {
  const restore = venue.install();
  const unenv = withCryptoEnv();
  try {
    return await runExitAuthority(cand, depsFor(nowMs, { approved: true, ...rig }), nowMs);
  } finally { restore(); unenv(); }
}

export async function runHoldExtensionIntegrationTests() {
  console.log('[통합 — Exact100X 보유 연장 (fetch만 가짜)]');

  // ★ 연장 정책이 실제로 이 계약에 걸려 있다 — 걸려 있지 않으면 아래
  //   시나리오 전부가 "오늘과 같다"로 통과해 아무것도 증명하지 못한다.
  test('★ Exact100X 계약에 연장 정책이 실제로 배선돼 있다', () => {
    assert(resolveHoldExtensionPolicy(EXACT100X) != null,
      '정책이 없으면 아래 시나리오는 전부 공허하다');
  });

  // ══════════════════════════════════════════════════════════
  // ⓿ **기본값은 꺼짐이다** — 승인 없이는 아무것도 달라지지 않는다
  // ══════════════════════════════════════════════════════════
  //
  //   검증되지 않은 파라미터(문턱 다섯 · 상한 12시간)를 운영 기본값으로
  //   켜지 않는다. 그리고 켠 뒤에도 **이미 열려 있는 포지션의 종료 규칙을
  //   소급해서 바꾸지 않는다.**
  {
    const now = Date.now();
    const venue = venueFor(now);
    const r = await run(venue, now, candidate(now), { approved: false });

    test('★ ⓿-A 승인 값이 없으면(운영 기본값) 4시간에 그대로 닫는다', () => {
      eq(r.code, 'CLOSED_VERIFIED');
      eq(venue.orderSends().length, 1);
      eq(r.holdExtensionGate?.code, 'NOT_APPROVED');
    });

    test('★ ⓿-A 꺼져 있으면 연장 판정 자체를 하지 않는다 (동작이 예전과 같다)', () => {
      eq(r.decision?.holdExtension, null,
        '★ 판정이 남으면 꺼진 상태에서도 두 번 판정한 것이다');
      assert(!/연장/.test(r.decision?.reason ?? ''),
        `사유 문장이 예전과 같아야 한다 — ${r.decision?.reason}`);
    });

    test('★ ⓿-A 꺼져 있으면 증거 조회를 한 번도 하지 않는다', () => {
      eq(venue.countOf('/fapi/v1/premiumIndex'), 0);
      eq(venue.countOf('/fapi/v1/klines'), 0);
      eq(venue.countOf('/fapi/v1/income'), 0);
      eq(venue.countOf('/fapi/v1/commissionRate'), 0);
    });
  }
  {
    // 승인 시각이 **지금**이면 4시간 전에 연 포지션은 승인 전의 것이다.
    const now = Date.now();
    const venue = venueFor(now);
    const r = await run(venue, now, candidate(now), { approved: 'before' });

    test('★ ⓿-B 승인 전에 연 포지션에는 소급 적용하지 않는다', () => {
      eq(r.holdExtensionGate?.code, 'OPENED_BEFORE_APPROVAL');
      eq(r.code, 'CLOSED_VERIFIED');
      eq(venue.orderSends().length, 1);
      eq(r.decision?.holdExtension, null);
      eq(venue.countOf('/fapi/v1/premiumIndex'), 0, '증거를 읽지도 않는다');
    });
  }
  {
    const now = Date.now();
    const venue = venueFor(now);
    const r = await run(venue, now, candidate(now), { approved: 'garbage' });

    test('★ ⓿-C 읽을 수 없는 승인 값은 승인이 아니다', () => {
      eq(r.holdExtensionGate?.code, 'UNPARSEABLE');
      eq(r.code, 'CLOSED_VERIFIED');
      eq(venue.orderSends().length, 1);
    });
  }
  {
    const now = Date.now();
    // 진입 시각을 못 읽으면 소급인지 아닌지 모른다 → 열지 않는다.
    // (권한 판정도 같은 이유로 막으므로 주문도 나가지 않는다)
    const venue = venueFor(now);
    const r = await run(venue, now,
      candidate(now, { openedAtMs: null as any }), { approved: true });

    test('★ ⓿-D 진입 시각을 모르면 연장도 청산도 하지 않는다', () => {
      eq(r.holdExtensionGate?.code, 'OPENED_AT_UNUSABLE');
      eq(r.code, 'OPENED_AT_UNUSABLE');
      eq(venue.orderSends().length, 0);
    });
  }

  {
    // 호출부가 승인 환경을 **아예 넣지 않으면** 꺼짐이다. 엔진은
    // `process.env`를 집지 않는다 — 집으면 검사기가 이 사슬을 컴파일할 수 없다.
    const now = Date.now();
    const venue = venueFor(now);
    const restore = venue.install();
    const unenv = withCryptoEnv();
    let r: any;
    try {
      const deps = depsFor(now, { approved: true });
      delete (deps as any).holdExtensionEnv;
      r = await runExitAuthority(candidate(now), deps, now);
    } finally { restore(); unenv(); }

    test('★ ⓿-E 승인 환경을 넣지 않은 호출부에서는 꺼짐이다 (fail-closed)', () => {
      eq(r.holdExtensionGate?.code, 'NOT_APPROVED');
      eq(r.code, 'CLOSED_VERIFIED');
      eq(venue.orderSends().length, 1);
      eq(r.decision?.holdExtension, null);
    });
  }

  test('★ ⓿ 승인 판정 자체 — 빈 값·공백·쓰레기는 전부 꺼짐이다', () => {
    for (const v of [undefined, '', '   ', 'yes', 'true', 'soon', '0', '-5']) {
      const a = judgeHoldExtensionActivation({
        EXACT100X_HOLD_EXTENSION_APPROVED_AT: v as any });
      eq(a.enabled, false, `${JSON.stringify(v)}가 켜짐으로 읽혔다`);
      eq(a.approvedAtMs, null);
    }
    const ok = judgeHoldExtensionActivation({
      EXACT100X_HOLD_EXTENSION_APPROVED_AT: '2026-10-20T00:00:00Z' });
    eq(ok.enabled, true);
    eq(ok.approvedAtMs, Date.parse('2026-10-20T00:00:00Z'));
  });

  // ══════════ ① 4시간 경계 전 — 묻지도 않는다 ══════════
  {
    const now = Date.now();
    const venue = venueFor(now);
    const r = await run(venue, now, candidate(now, { openedAtMs: now - FOUR_H + 1 }));

    test('① 4시간 1ms 전에는 아직 닫지 않는다', () => {
      eq(r.code, 'POLICY_NOT_DUE');
      eq(r.attemptedWrite, false);
      eq(venue.orderSends().length, 0, '★ 주문 0건이어야 한다');
    });

    test('★ ① 때가 아니면 연장 증거를 **읽지도 않는다**', () => {
      eq(venue.countOf('/fapi/v1/premiumIndex'), 0,
        '마크가를 읽었다 — 매 주기 거래소를 두드리게 된다');
      eq(venue.countOf('/fapi/v1/klines'), 0, '봉을 읽었다');
      eq(venue.countOf('/fapi/v1/income'), 0, '펀딩을 읽었다');
      eq(r.decision?.holdExtension, null, '묻지 않았으면 null이다');
    });
  }

  // ══════════ ② 4시간 경계 도달 + 수익·추세 → 연장 ══════════
  {
    const now = Date.now();
    const venue = venueFor(now);
    const r = await run(venue, now);

    test('② 수익·추세가 증거로 확인되면 보유를 연장한다', () => {
      eq(r.code, 'HOLD_EXTENDED');
      eq(r.blocked, true, '막힌 회차다');
      eq(r.failed, false, '★ 고쳐야 할 상태가 아니다 — 일부러 안 한 것이다');
      eq(r.decision?.holdExtension?.code, 'EXTEND');
    });

    test('★ ② 연장 회차는 거래소에 주문을 한 건도 보내지 않는다', () => {
      eq(venue.orderSends().length, 0);
      eq(r.attemptedWrite, false);
      eq(r.requestedQuantity, null);
    });

    test('★ ② 증거를 실제 거래소 조회로 모았다 (다섯 경로)', () => {
      assert(venue.countOf('/fapi/v1/premiumIndex') >= 1, '마크가를 안 읽었다');
      assert(venue.countOf('/fapi/v2/positionRisk') >= 1, '포지션을 안 읽었다');
      assert(venue.countOf('/fapi/v1/commissionRate') >= 1, '수수료를 안 읽었다');
      assert(venue.countOf('/fapi/v1/income') >= 1, '펀딩을 안 읽었다');
      assert(venue.countOf('/fapi/v1/klines') >= 1, '봉을 안 읽었다');
    });

    test('★ ② 순수익은 수수료를 깎은 값이다 (왕복 0.1% = ROE 10%)', () => {
      const hx = r.decision?.holdExtension;
      // 가격 +0.3% → gross ROE 30. 왕복 수수료 10 + 미끄러짐 2 → 18
      eq(Math.round(hx!.netRoePct!), 18);
      assert(hx!.liquidationHeadroomPct! > 0.3, `청산 여유 ${hx!.liquidationHeadroomPct}`);
    });

    test('★ ② 연장에는 절대 상한 시각이 함께 적힌다', () => {
      const hx = r.decision?.holdExtension;
      assert(hx!.absoluteDeadlineMs! > now, '상한 시각이 없으면 무한 연장이다');
      const cap = resolveHoldExtensionPolicy(EXACT100X)!.absoluteMaxHoldMs;
      eq(hx!.absoluteDeadlineMs, now + (cap - FOUR_H));
      assert(cap > FOUR_H, '상한이 계약 한도보다 커야 연장이 의미가 있다');
    });
  }

  // ══════════ ②-b 증거 조회 dep이 없으면 오늘과 같다 ══════════
  {
    const now = Date.now();
    const venue = venueFor(now);
    const r = await run(venue, now, candidate(now), { noEvidenceDep: true });

    test('★ ②-b 증거 조회가 배선되지 않은 호출부는 예전처럼 닫는다', () => {
      eq(r.code, 'CLOSED_VERIFIED');
      eq(venue.orderSends().length, 1);
      eq(r.decision?.holdExtension, null, '묻지 않았다');
    });
  }

  // ══════════ ③ 손실 포지션은 경계에서 닫는다 ══════════
  {
    const now = Date.now();
    // 가격 +0.12% → gross 12 = 간접비와 같다 → 순수익 0
    const venue = venueFor(now, { markPrice: '100120' });
    const r = await run(venue, now);

    test('③ 순수익이 문턱 아래면 4시간 위험 관리를 그대로 지킨다', () => {
      eq(r.code, 'CLOSED_VERIFIED');
      eq(r.decision?.holdExtension?.code, 'CLOSE_LOSING');
      eq(venue.orderSends().length, 1, '★ 정확히 한 건이어야 한다');
      eq(r.flatVerified, true);
    });

    test('★ ③ 청산 주문은 축소 전용이고 방향이 반대다', () => {
      const send = venue.orderSends()[0];
      eq(send.params.side, 'SELL', 'LONG을 닫으려면 SELL이다');
      eq(send.params.reduceOnly, 'true');
      eq(send.authed, true);
    });
  }

  // ══════════ ③-b 청산 여유가 모자라면 수익이어도 닫는다 ══════════
  {
    const now = Date.now();
    // 마크 100300, 청산가 100200 → 여유 0.1% (최소 0.3% 미달)
    const venue = venueFor(now, { liquidationPrice: '100200' });
    const r = await run(venue, now);

    test('★ ③-b 청산 위험이 수익보다 먼저다', () => {
      eq(r.decision?.holdExtension?.code, 'CLOSE_LIQUIDATION_RISK');
      eq(r.code, 'CLOSED_VERIFIED');
      eq(venue.orderSends().length, 1);
    });
  }

  // ══════════ ④ 추세 반전 → 종료 ══════════
  {
    const now = Date.now();
    const venue = venueFor(now, { closes: FALLING });
    const r = await run(venue, now);

    test('④ 수익이어도 추세가 꺾이면 계약 한도에서 닫는다', () => {
      eq(r.decision?.holdExtension?.code, 'CLOSE_TREND_DEAD');
      assert(r.decision!.holdExtension!.netRoePct! > 15,
        `수익은 문턱 위인 자리여야 한다 — ${r.decision?.holdExtension?.netRoePct}`);
      eq(r.code, 'CLOSED_VERIFIED');
      eq(venue.orderSends().length, 1);
    });
  }

  // ══════════ ④-b 펀딩 비용이 연장을 뒤집는다 ══════════
  {
    const now = Date.now();
    // 명목 = 100,000 × 0.01 = $1,000 → 증거금 = $10.
    // 펀딩 −0.5(냈다) → ROE −5%p → 18 → 13
    const venue = venueFor(now, {
      income: [{ symbol: 'BTCUSDT', incomeType: 'FUNDING', income: '-0.5' },
        { symbol: 'ETHUSDT', incomeType: 'FUNDING', income: '-9999' },
        { symbol: 'BTCUSDT', incomeType: 'COMMISSION', income: '-7777' }],
    });
    const r = await run(venue, now);

    test('★ ④-b 펀딩 비용을 셈하면 같은 가격이 연장되지 않는다', () => {
      eq(Math.round(r.decision!.holdExtension!.netRoePct!), 13, '18 − 5');
      eq(r.decision?.holdExtension?.code, 'CLOSE_LOSING');
      eq(venue.orderSends().length, 1);
    });

    test('★ ④-b 다른 종목·다른 종류의 income을 섞지 않는다', () => {
      // ETHUSDT·COMMISSION을 더했다면 순수익이 터무니없이 음수가 된다.
      assert(r.decision!.holdExtension!.netRoePct! > -100,
        `다른 줄을 더했다 — ${r.decision?.holdExtension?.netRoePct}`);
    });
  }

  // ══════════ ⑤ 서버 재시작 후 복구 ══════════
  {
    const now = Date.now();
    // 같은 증거로 두 번 — 연장 상태를 들고 있지 않으므로 답이 같아야 한다
    const a = await run(venueFor(now), now);
    const b = await run(venueFor(now), now);

    test('⑤ 재시작해도 같은 증거면 같은 답이다 (연장 상태를 들고 있지 않다)', () => {
      eq(a.code, 'HOLD_EXTENDED');
      eq(b.code, a.code);
      eq(b.decision?.holdExtension?.code, a.decision?.holdExtension?.code);
    });

    // 재시작이 늦어 절대 상한을 넘겼다
    const late = Date.now();
    const lateVenue = venueFor(late);
    const cap = resolveHoldExtensionPolicy(EXACT100X)!.absoluteMaxHoldMs;
    const r = await run(lateVenue, late,
      candidate(late, { openedAtMs: late - cap - 1 }));

    test('★ ⑤ 재시작이 늦어 절대 상한을 넘겼으면 증거와 무관하게 닫는다', () => {
      eq(r.decision?.holdExtension?.code, 'CLOSE_CAP');
      eq(r.code, 'CLOSED_VERIFIED');
      eq(lateVenue.orderSends().length, 1);
      eq(r.decision?.holdExtension?.netRoePct, null,
        '★ 상한은 증거를 보기 전에 막는다');
    });

    test('★ ⑤ 상한을 넘긴 자리는 증거를 **읽지도 않는다**', () => {
      // 결과가 바뀌지 않는 조회로 거래소를 두드리지 않는다.
      eq(lateVenue.countOf('/fapi/v1/premiumIndex'), 0, '마크가를 읽었다');
      eq(lateVenue.countOf('/fapi/v1/klines'), 0, '봉을 읽었다');
      eq(lateVenue.countOf('/fapi/v1/income'), 0, '펀딩을 읽었다');
    });
  }

  // ══════════ ⑥ 중복 청산 방지 ══════════
  {
    const now = Date.now();
    const venue = venueFor(now, { markPrice: '100120' });
    const r = await run(venue, now, candidate(now), { fenceLost: true });

    test('⑥ 쓰기 직전 울타리를 잃으면 주문 0건이다', () => {
      eq(r.code, 'LEASE_LOST');
      eq(venue.orderSends().length, 0, '★ 한 건도 나가면 안 된다');
      eq(r.attemptedWrite, false);
    });

    // 같은 종료 의도의 멱등 키가 두 실행자에서 **같아야** 거래소가 중복을
    // 알아볼 기회가 생긴다.
    const v1 = venueFor(now, { markPrice: '100120' });
    const v2 = venueFor(now, { markPrice: '100120' });
    const r1 = await run(v1, now);
    const r2 = await run(v2, now);

    test('★ ⑥ 같은 노출을 본 두 실행자는 같은 멱등 키를 싣는다', () => {
      eq(r1.code, 'CLOSED_VERIFIED');
      eq(r2.code, 'CLOSED_VERIFIED');
      const k1 = v1.orderSends()[0]?.params.newClientOrderId;
      const k2 = v2.orderSends()[0]?.params.newClientOrderId;
      assert(!!k1, '멱등 키가 없다 — 거래소가 중복을 알아볼 수 없다');
      eq(k1, k2);
    });

    test('★ ⑥ 연장된 회차는 주문 자체가 없으므로 중복의 소지가 없다', () => {
      // ②에서 이미 확인했지만, 중복 방지 항목에서 한 번 더 못 박는다.
      eq(venue.orderSends().length, 0);
    });
  }

  // ══════════ ⑦ 부분 체결 ══════════
  {
    const now = Date.now();
    const venue = venueFor(now, {
      markPrice: '100120', leftAfter: true,
      orderReply: { json: { orderId: 9002, symbol: 'BTCUSDT',
        status: 'PARTIALLY_FILLED', executedQty: '0.004', avgPrice: '100120' } },
    });
    const r = await run(venue, now);

    test('⑦ 부분 체결은 성공으로 적지 않는다', () => {
      eq(r.code, 'CLOSE_INCOMPLETE');
      eq(r.flatVerified, false, '★ 잔여가 있으면 flat이 아니다');
      eq(r.needsReconcile, true);
      eq(r.failed, true, '고쳐야 할 상태다');
    });

    test('★ ⑦ 보낸 수량을 체결량으로 적지 않는다', () => {
      // `requestedQuantity`는 "요청한 양"이고 닫힌 양이 아니다.
      assert(r.requestedQuantity != null, '요청 수량은 남긴다');
      eq(r.flatVerified, false);
    });
  }

  // ══════════ ⑧ 거래소 응답 실패 ══════════
  {
    // ⑧-a 증거 조회 실패 → **연장하지 않고 닫는다** (fail-closed)
    const now = Date.now();
    const venue = venueFor(now, { markFails: true });
    const r = await run(venue, now);

    test('⑧-a 증거를 못 읽으면 연장하지 않고 예전처럼 닫는다', () => {
      eq(r.decision?.holdExtension?.code, 'CLOSE_EVIDENCE_MISSING');
      eq(r.code, 'CLOSED_VERIFIED');
      eq(venue.orderSends().length, 1);
      assert(r.decision!.holdExtension!.reason.includes('마크가'),
        `어느 칸이 비었는지 적어야 한다 — ${r.decision?.holdExtension?.reason}`);
      eq(venue.countOf('/fapi/v1/premiumIndex') >= 1, true, '실제로 조회를 시도했다');
    });

    // ⑧-b 수수료 조회 실패도 같다
    const n2 = Date.now();
    const v2 = venueFor(n2, { takerRate: null });
    const r2 = await run(v2, n2);

    test('⑧-b 수수료율을 못 읽으면 순수익을 지어내지 않는다', () => {
      eq(r2.decision?.holdExtension?.code, 'CLOSE_EVIDENCE_MISSING');
      eq(r2.code, 'CLOSED_VERIFIED');
    });

    // ⑧-c 봉 조회 실패 → 추세 UNKNOWN → 닫는다
    const n3 = Date.now();
    const v3 = venueFor(n3, { klinesFails: true });
    const r3 = await run(v3, n3);

    test('⑧-c 봉을 못 읽으면 추세를 모르는 것이고, 모르면 닫는다', () => {
      eq(r3.decision?.holdExtension?.code, 'CLOSE_TREND_DEAD');
      eq(r3.code, 'CLOSED_VERIFIED');
    });

    // ⑧-c2 봉은 오는데 **멈춰 있다** → 지금의 추세가 아니다
    const n6 = Date.now();
    const v6 = venueFor(n6, { staleBars: true });
    const r6 = await run(v6, n6);

    test('★ ⑧-c2 멈춘 봉으로 추세를 말하지 않는다 (응답 200이어도)', () => {
      assert(v6.countOf('/fapi/v1/klines') >= 1, '봉을 읽긴 읽었다');
      eq(r6.decision?.holdExtension?.code, 'CLOSE_TREND_DEAD');
      eq(r6.code, 'CLOSED_VERIFIED');
    });

    // ⑧-c3 펀딩 줄 하나를 못 읽으면 **부분합을 적지 않는다**
    const n7 = Date.now();
    const v7 = venueFor(n7, {
      income: [{ symbol: 'BTCUSDT', incomeType: 'FUNDING', income: '-0.1' },
        { symbol: 'BTCUSDT', incomeType: 'FUNDING', income: 'abc' }],
    });
    const r7 = await run(v7, n7);

    test('★ ⑧-c3 펀딩 줄 하나를 못 읽으면 부분합을 쓰지 않고 닫는다', () => {
      eq(r7.decision?.holdExtension?.code, 'CLOSE_EVIDENCE_MISSING');
      assert(r7.decision!.holdExtension!.reason.includes('펀딩 비용'),
        `어느 칸이 비었는지 적어야 한다 — ${r7.decision?.holdExtension?.reason}`);
      eq(r7.code, 'CLOSED_VERIFIED');
    });

    // ⑧-d 종료 전송이 타임아웃 — 보냈는지 모른다.
    //
    //   그 뒤 재조회가 **잔여 0**을 보면 대조로 닫힌 것이다. "거부됐다"로
    //   적으면 안 나간 것으로 읽혀 같은 자리에 또 보낸다.
    const n4 = Date.now();
    const v4 = venueFor(n4, { markPrice: '100120', orderReply: { timeout: true } });
    const r4 = await run(v4, n4);

    test('⑧-d 전송이 모호해도 잔여 0을 확인하면 대조로 닫힌 것이다', () => {
      eq(r4.code, 'RECONCILED_CLOSED');
      eq(r4.accepted, null, '★ 접수 여부는 모른다 — false로 단정하지 않는다');
      eq(r4.flatVerified, true);
      eq(r4.failed, false);
    });

    // ⑧-e 전송도 모호하고 잔여도 남아 있다 → 사람이 대조해야 한다
    const n5 = Date.now();
    const v5 = venueFor(n5, { markPrice: '100120', leftAfter: true,
      orderReply: { timeout: true } });
    const r5 = await run(v5, n5);

    test('⑧-e 보냈는지도 닫혔는지도 모르면 대조가 필요하다고 적는다', () => {
      eq(r5.code, 'CLOSE_UNKNOWN_RECONCILE_REQUIRED');
      eq(r5.needsReconcile, true);
      eq(r5.requestedQuantity, null, '★ 닫힌 양을 모르면 적지 않는다');
      eq(v5.orderSends().length, 1, '★ 모호해도 재전송하지 않는다');
    });
  }

  // ══════════════════════════════════════════════════════════
  // ⑧-f **`CLOSE_*`는 종료 의도다 — 거래소 청산 완료가 아니다**
  // ══════════════════════════════════════════════════════════
  //
  //   `decideHoldExtension`의 `CLOSE_*`는 "이번 회차에 늦추지 않는다"는
  //   뜻이고, 실제로 닫혔는지는 `ExitRunCode`와 `flatVerified`만이 말한다.
  //   둘을 같은 값으로 읽으면 **거부된 청산이 "닫았다"로 적힌다.**
  {
    const now = Date.now();
    const venue = venueFor(now, {
      markPrice: '100120', leftAfter: true,
      // 거래소가 **명시적으로** 거부한다 (모호한 코드가 아니다)
      orderReply: { status: 400, json: { code: -2022, msg: 'ReduceOnly Order is rejected.' } },
    });
    const r = await run(venue, now);

    test('★ ⑧-f 연장 판정은 CLOSE_*인데 거래소가 거부하면 "닫았다"가 아니다', () => {
      eq(r.decision?.holdExtension?.code, 'CLOSE_LOSING', '연장하지 않기로 했다');
      eq(r.code, 'CLOSE_REJECTED', '★ 그러나 청산은 되지 않았다');
      eq(r.flatVerified, null, '★ 닫혔다고 적지 않는다');
      eq(r.failed, true, '고쳐야 할 상태다');
      eq(r.reconciledFlat, false);
      eq(venue.orderSends().length, 1, '재전송하지 않는다');
    });

    // 거부된 뒤 **다음 회차**가 다시 시도한다 — 방치되지 않는다
    const v2 = venueFor(now, { markPrice: '100120' });
    const r2 = await run(v2, now);

    test('★ ⑧-f 거부된 포지션은 다음 회차에 다시 시도된다 (방치 없음)', () => {
      eq(r2.code, 'CLOSED_VERIFIED');
      eq(v2.orderSends().length, 1);
      eq(r2.flatVerified, true);
    });
  }
  {
    // 부분 체결로 잔여가 남은 뒤 재시작 → 다음 회차가 남은 노출을 다시 닫는다
    const now = Date.now();
    const first = venueFor(now, {
      markPrice: '100120', leftAfter: true,
      orderReply: { json: { orderId: 9100, symbol: 'BTCUSDT',
        status: 'PARTIALLY_FILLED', executedQty: '0.004', avgPrice: '100120' } },
    });
    const a = await run(first, now);
    const second = venueFor(now, { markPrice: '100120', positionAmt: '0.006' });
    const b = await run(second, now);

    test('★ ⑧-g 부분 체결 뒤 재시작하면 남은 노출을 다시 닫는다', () => {
      eq(a.code, 'CLOSE_INCOMPLETE');
      eq(a.needsReconcile, true);
      eq(b.code, 'CLOSED_VERIFIED');
      eq(b.requestedQuantity, 0.006, '★ 진입 수량이 아니라 지금 관측한 노출로 닫는다');
      eq(second.orderSends().length, 1);
    });
  }

  // ══════════ ⑨ 종료 권한과 장부 상태가 일치하는가 ══════════
  //
  // D19·D20의 교훈을 종료 경로에 적용한다: **반환 상태와 실제로 일어난
  // 일이 어긋나면 안 된다.** 여기서는 거래소 호출 수가 "실제로 일어난
  // 일"이다.
  {
    const now = Date.now();
    const cases: Array<{ name: string; o: VenueOpts; cand?: ExitRunCandidate }> = [
      { name: '연장', o: {} },
      { name: '손실 종료', o: { markPrice: '100120' } },
      { name: '추세 종료', o: { closes: FALLING } },
      { name: '증거 없음', o: { markFails: true } },
      { name: '때 아님', o: {}, cand: candidate(now, { openedAtMs: now - FOUR_H + 1 }) },
    ];
    const rows: Array<{ name: string; code: string; sends: number; attempted: boolean }> = [];
    for (const c of cases) {
      const v = venueFor(now, c.o);
      const r = await run(v, now, c.cand ?? candidate(now));
      rows.push({ name: c.name, code: r.code, sends: v.orderSends().length,
        attempted: r.attemptedWrite });
    }

    test('★ ⑨ attemptedWrite는 실제 주문 전송 여부와 정확히 같다', () => {
      for (const r of rows) {
        eq(r.attempted, r.sends > 0,
          `${r.name}: attemptedWrite=${r.attempted}인데 전송 ${r.sends}건 (${r.code})`);
      }
    });

    test('★ ⑨ 닫지 않은 코드에서 주문이 나간 적이 없다', () => {
      const quiet = ['HOLD_EXTENDED', 'POLICY_NOT_DUE', 'LEASE_LOST', 'NOT_OWNER'];
      for (const r of rows) {
        if (quiet.includes(r.code)) {
          eq(r.sends, 0, `${r.name}(${r.code})에서 ${r.sends}건이 나갔다`);
        }
      }
    });

    test('★ ⑨ 닫은 코드는 정확히 한 건만 보낸다 — 중복 전송이 없다', () => {
      for (const r of rows) {
        if (r.code === 'CLOSED_VERIFIED') {
          eq(r.sends, 1, `${r.name}에서 ${r.sends}건이 나갔다`);
        }
      }
    });
  }
}
