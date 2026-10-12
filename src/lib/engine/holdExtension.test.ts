// src/lib/engine/holdExtension.test.ts
//
// **"늦춰도 되는가"만 시험한다.**
//
// 이 파일이 지키려는 것은 수익성이 아니다. 세 가지 안전 속성이다:
//
//   ① 연장은 **늦추기만 한다.** 새 종료를 당기지 않고, 정책이 없으면
//      오늘과 글자 그대로 같다.
//   ② 상한은 증거로 뚫리지 않는다.
//   ③ 모호함은 전부 **닫는 쪽**으로 떨어진다 — 없음·낡음·모름 모두.
//
// ★ 수익률 비교·백테스트는 여기 없다. 이 컨테이너에 시장 데이터가
//   없으므로 그 부분은 UNKNOWN이고, 모르는 것을 시험으로 적지 않는다.
import { test, eq, assert } from '../../test/harness';
import {
  decideHoldExtension, resolveHoldExtensionPolicy, holdExtensionContractKeys,
  netRoeOf, summarizeBars, TREND_MIN_BARS,
  type HoldEvidence, type HoldExtensionInput, type HoldExtensionPolicy,
} from './holdExtension';

const NOW = 1_800_000_000_000;
const FOUR_H = 4 * 3600 * 1000;

const POLICY = resolveHoldExtensionPolicy(
  { profileId: 'MAX_LEV_100X', presetId: 'EXACT_100X' }) as HoldExtensionPolicy;

/**
 * 기준 증거 — **연장이 실제로 일어나는 자리.**
 *
 * 100배·왕복 수수료 0.1%·미끄러짐 여유 0.02% → 간접비가 ROE 12%다.
 * 가격 +0.3%는 gross ROE 30%이므로 순수익 18%, 문턱 15% 위다.
 */
const EV = (over: Partial<HoldEvidence> = {}): HoldEvidence => ({
  observedAtMs: NOW - 1_000,
  entryPrice: 100_000,
  markPrice: 100_300,
  leverage: 100,
  roundTripFeeRate: 0.001,
  fundingPaidQuote: 0,
  notionalAtEntryQuote: 100_000,
  bestPrice: 100_380,
  liquidationHeadroomPct: 0.45,
  trendAlive: true,
  atrPct: 0.5,
  ...over,
});

const IN = (over: Partial<HoldExtensionInput> = {}): HoldExtensionInput => ({
  policy: POLICY,
  evidence: EV(),
  side: 'LONG',
  heldMs: FOUR_H,
  nowMs: NOW,
  ...over,
});

export function runHoldExtensionTests() {
  // ══════════════════════════════════════════════════════════
  // 대조군 — 연장이 **실제로 일어난다**
  // ══════════════════════════════════════════════════════════
  test('수수료·펀딩을 셈한 순수익이 문턱 위이고 추세가 살아 있으면 연장한다', () => {
    const d = decideHoldExtension(IN());
    assert(d.extend, `연장되어야 하는데 막혔다 — ${d.reason}`);
    eq(d.code, 'EXTEND');
    eq(d.policyId, 'hold-extension-100x-v1');
    eq(Math.round(d.netRoePct!), 18, '★ gross 30 − 수수료 10 − 미끄러짐 2');
    eq(d.absoluteDeadlineMs, NOW + (POLICY.absoluteMaxHoldMs - FOUR_H));
  });

  test('SHORT도 같은 셈으로 연장한다 — 방향만 뒤집는다', () => {
    const d = decideHoldExtension(IN({
      side: 'SHORT',
      evidence: EV({ markPrice: 99_700, bestPrice: 99_620 }),
    }));
    assert(d.extend, `SHORT가 막혔다 — ${d.reason}`);
    eq(Math.round(d.netRoePct!), 18);
  });

  // ══════════════════════════════════════════════════════════
  // ① 연장은 **늦추기만 한다**
  // ══════════════════════════════════════════════════════════
  test('★ 정책이 선언돼 있지 않으면 CLOSE_DISABLED — 오늘과 같은 동작이다', () => {
    const d = decideHoldExtension(IN({ policy: null }));
    eq(d.extend, false);
    eq(d.code, 'CLOSE_DISABLED');
    eq(d.netRoePct, null, '증거를 보지도 않는다');
  });

  test('★ 선언되지 않은 계약은 정책이 null이다 — 다른 전략의 의미를 바꾸지 않는다', () => {
    for (const t of [
      { profileId: 'SCALP_HIGH_LEV', presetId: 'BALANCED' },
      { profileId: 'SWING_LOW_LEV', presetId: 'CONSERVATIVE' },
      { profileId: 'DAILY_HIGH_LEV', presetId: 'AGGRESSIVE' },
      { profileId: 'MAX_LEV_100X', presetId: 'BALANCED' },
      { profileId: '', presetId: 'EXACT_100X' },
      { profileId: 'MAX_LEV_100X', presetId: '' },
      null, undefined,
    ]) {
      eq(resolveHoldExtensionPolicy(t as any), null,
        `${JSON.stringify(t)}에 연장이 열려서는 안 된다`);
    }
  });

  test('★ 연장이 열려 있는 계약은 Exact100X 하나뿐이다', () => {
    const keys = holdExtensionContractKeys();
    eq(keys.length, 1, `열린 계약이 ${keys.length}개다 — ${keys.join(', ')}`);
    eq(keys[0], 'MAX_LEV_100X/EXACT_100X');
  });

  test('★ 어떤 입력으로도 extend와 CLOSE_* 코드가 같이 나오지 않는다', () => {
    const cases: Array<Partial<HoldExtensionInput>> = [
      {}, { policy: null }, { evidence: null },
      { heldMs: POLICY.absoluteMaxHoldMs },
      { evidence: EV({ trendAlive: false }) },
      { evidence: EV({ markPrice: 100_100 }) },
      { evidence: EV({ liquidationHeadroomPct: 0.1 }) },
    ];
    for (const c of cases) {
      const d = decideHoldExtension(IN(c));
      eq(d.extend, d.code === 'EXTEND',
        `extend=${d.extend}인데 코드가 ${d.code}다`);
    }
  });

  // ══════════════════════════════════════════════════════════
  // ② 상한은 증거로 뚫리지 않는다
  // ══════════════════════════════════════════════════════════
  test('★ 절대 상한에 닿으면 수익이 아무리 좋아도 닫는다', () => {
    const d = decideHoldExtension(IN({
      heldMs: POLICY.absoluteMaxHoldMs,
      evidence: EV({ markPrice: 120_000, bestPrice: 120_000, trendAlive: true }),
    }));
    eq(d.extend, false);
    eq(d.code, 'CLOSE_CAP');
    eq(d.netRoePct, null, '★ 상한은 증거를 보기 전에 막는다');
  });

  test('상한 1ms 전은 아직 연장할 수 있다 — 경계가 >= 다', () => {
    const d = decideHoldExtension(IN({ heldMs: POLICY.absoluteMaxHoldMs - 1 }));
    eq(d.code, 'EXTEND');
    const at = decideHoldExtension(IN({ heldMs: POLICY.absoluteMaxHoldMs }));
    eq(at.code, 'CLOSE_CAP');
  });

  // ══════════════════════════════════════════════════════════
  // ③ 모호함은 닫는 쪽으로
  // ══════════════════════════════════════════════════════════
  test('★ 증거가 없으면 닫는다', () => {
    for (const ev of [null, undefined]) {
      const d = decideHoldExtension(IN({ evidence: ev }));
      eq(d.code, 'CLOSE_EVIDENCE_MISSING', `evidence=${String(ev)}`);
    }
  });

  test('★ 관측 시각이 없거나 낡았으면 닫는다 — 낡은 증거는 증거가 아니다', () => {
    for (const v of [null, 0]) {
      const d = decideHoldExtension(IN({ evidence: EV({ observedAtMs: v }) }));
      eq(d.code, 'CLOSE_EVIDENCE_MISSING');
      assert(d.reason.includes('관측 시각'), `무엇이 비었는지 적어야 한다 — ${d.reason}`);
    }
    eq(decideHoldExtension(IN({
      evidence: EV({ observedAtMs: NOW - POLICY.maxEvidenceAgeMs - 1 }) })).code,
      'CLOSE_EVIDENCE_STALE');
    // 경계 — 정확히 허용치면 아직 쓴다
    eq(decideHoldExtension(IN({
      evidence: EV({ observedAtMs: NOW - POLICY.maxEvidenceAgeMs }) })).code, 'EXTEND');
  });

  test('★ 관측 시각이 한참 미래면(시계 어긋남) 0으로 깎지 않고 닫는다', () => {
    const d = decideHoldExtension(IN({
      evidence: EV({ observedAtMs: NOW + POLICY.maxEvidenceAgeMs + 1 }) }));
    eq(d.code, 'CLOSE_EVIDENCE_STALE');
    assert(d.reason.includes('시계'), `시계 어긋남으로 적어야 한다 — ${d.reason}`);
  });

  test('★ 같은 회차 안에서 판정 시각보다 조금 뒤에 읽힌 증거는 쓴다', () => {
    // 판정 시각은 회차 시작에 고정되고, 증거는 그 뒤에 읽힌다. 이것을
    // 미래 관측으로 막으면 연장이 영원히 일어나지 않는다.
    for (const d of [1, 250, POLICY.maxEvidenceAgeMs]) {
      eq(decideHoldExtension(IN({ evidence: EV({ observedAtMs: NOW + d }) })).code,
        'EXTEND', `${d}ms 뒤 관측이 막혔다`);
    }
  });

  test('★ 필요한 관측이 하나라도 null이면 닫는다 — 0으로 적지 않는다', () => {
    const fields: Array<[keyof HoldEvidence, string]> = [
      ['observedAtMs', '관측 시각'],
      ['entryPrice', '진입가'], ['markPrice', '마크가'], ['leverage', '배율'],
      ['roundTripFeeRate', '왕복 수수료율'], ['fundingPaidQuote', '펀딩 비용'],
      ['liquidationHeadroomPct', '청산 여유'],
    ];
    for (const [f, label] of fields) {
      const d = decideHoldExtension(IN({ evidence: EV({ [f]: null } as any) }));
      eq(d.code, 'CLOSE_EVIDENCE_MISSING', `${String(f)}=null인데 ${d.code}`);
      assert(d.reason.includes(label), `${label}이 이유에 적혀야 한다 — ${d.reason}`);
    }
  });

  test('★ 0과 빈 문자열을 "못 읽었다"로 섞지 않는다 — 펀딩 0은 유효한 관측이다', () => {
    eq(decideHoldExtension(IN({ evidence: EV({ fundingPaidQuote: 0 }) })).code, 'EXTEND');
    eq(decideHoldExtension(IN({ evidence: EV({ fundingPaidQuote: '' as any }) })).code,
      'CLOSE_EVIDENCE_MISSING');
  });

  test('★ 보유 경과를 읽지 못하면 닫는다', () => {
    for (const v of [null, undefined, NaN, -1, 'x']) {
      const d = decideHoldExtension(IN({ heldMs: v as any }));
      eq(d.code, 'CLOSE_EVIDENCE_MISSING', `heldMs=${String(v)}인데 ${d.code}`);
    }
  });

  // ══════════════════════════════════════════════════════════
  // ④ 청산 여유가 **수익보다 먼저**다
  // ══════════════════════════════════════════════════════════
  test('★ 청산 여유가 모자라면 수익이어도 닫는다', () => {
    const d = decideHoldExtension(IN({
      evidence: EV({ liquidationHeadroomPct: POLICY.minLiquidationHeadroomPct - 0.001 }) }));
    eq(d.code, 'CLOSE_LIQUIDATION_RISK');
    eq(d.extend, false);
    // 경계 — 정확히 최소치면 통과한다
    eq(decideHoldExtension(IN({
      evidence: EV({ liquidationHeadroomPct: POLICY.minLiquidationHeadroomPct }) })).code,
      'EXTEND');
  });

  test('★ 손실이면서 청산 여유도 없으면 청산 위험으로 적는다 — 위험이 먼저다', () => {
    const d = decideHoldExtension(IN({
      evidence: EV({ markPrice: 99_000, liquidationHeadroomPct: 0.05 }) }));
    eq(d.code, 'CLOSE_LIQUIDATION_RISK');
  });

  // ══════════════════════════════════════════════════════════
  // ⑤ 손실 포지션 위험 관리 — **오늘의 동작을 유지하는 자리**
  // ══════════════════════════════════════════════════════════
  test('★ 손실 포지션은 연장하지 않는다 (4시간 위험 관리를 유지한다)', () => {
    const d = decideHoldExtension(IN({ evidence: EV({ markPrice: 99_500 }) }));
    eq(d.code, 'CLOSE_LOSING');
    assert(d.netRoePct! < 0, `순수익이 음수여야 한다 — ${d.netRoePct}`);
  });

  test('★ 수수료만큼 이기는 자리는 승자가 아니다 — gross가 아니라 net으로 본다', () => {
    // 가격 +0.12% → gross ROE 12% = 간접비와 같다 → net 0%
    const d = decideHoldExtension(IN({ evidence: EV({ markPrice: 100_120 }) }));
    eq(d.code, 'CLOSE_LOSING');
    eq(Math.round(d.netRoePct!), 0, '★ gross 12%가 net 0%다');
  });

  test('★ 펀딩 비용이 순수익에서 깎인다', () => {
    // 증거금 = 명목 100,000 / 100배 = 1,000. 펀딩 50 = ROE 5%p
    const paid = decideHoldExtension(IN({ evidence: EV({ fundingPaidQuote: 50 }) }));
    eq(Math.round(paid.netRoePct!), 13, '18 − 5');
    eq(paid.code, 'CLOSE_LOSING', '★ 펀딩을 무시하면 이 자리가 연장된다');
    // 받은 펀딩은 더해진다
    const got = decideHoldExtension(IN({ evidence: EV({ fundingPaidQuote: -50 }) }));
    eq(Math.round(got.netRoePct!), 23);
    eq(got.code, 'EXTEND');
  });

  test('★ 펀딩을 냈는데 명목을 모르면 ROE로 바꾸지 않고 닫는다', () => {
    const d = decideHoldExtension(IN({
      evidence: EV({ fundingPaidQuote: 50, notionalAtEntryQuote: null }) }));
    eq(d.code, 'CLOSE_EVIDENCE_MISSING');
  });

  test('순수익 문턱 경계 — 같아도 연장하지 않는다 (> 다)', () => {
    // net = 15%가 되는 마크가: gross 27% → 가격 +0.27%
    const d = decideHoldExtension(IN({
      evidence: EV({ markPrice: 100_270, bestPrice: 100_270 }) }));
    eq(Math.round(d.netRoePct!), 15);
    eq(d.code, 'CLOSE_LOSING', '★ 문턱과 같은 값은 연장 근거가 아니다');
  });

  // ══════════════════════════════════════════════════════════
  // ⑥ 이익 보호 — 고정 익절이 아니다
  // ══════════════════════════════════════════════════════════
  test('★ 고점 대비 수익을 되돌리면 보호 종료한다', () => {
    // 고점 +0.6% → peak net 48%. 지금 net 18% → 반납 30%p
    // 요구 반납폭 = max(48×0.4=19.2, ATR 바닥) → 넘는다
    const d = decideHoldExtension(IN({
      evidence: EV({ bestPrice: 100_600, atrPct: 0.1 }) }));
    eq(d.code, 'CLOSE_GIVEBACK');
    eq(Math.round(d.peakNetRoePct!), 48);
    assert(d.requiredGivebackRoePct! > 0, '요구 반납폭을 적어야 한다');
  });

  test('반납이 요구폭보다 작으면 계속 연장한다', () => {
    // 고점 +0.6% → peak 48%. 지금 +0.5% → net 38%. 반납 10%p < 19.2
    const d = decideHoldExtension(IN({
      evidence: EV({ bestPrice: 100_600, markPrice: 100_500, atrPct: 0.1 }) }));
    eq(d.code, 'EXTEND');
  });

  test('★ ATR 바닥이 노이즈 반납으로 닫히는 것을 막는다', () => {
    // 고점 +0.47% → peak net 35%. 지금 18% → 반납 17%p
    // 비율 요구 = 35×0.4 = 14%p → 비율만 보면 닫힌다
    // ATR 0.5% × 100배 × 0.5 = 25%p 바닥 → 17%p 반납으로는 닫지 않는다
    const d = decideHoldExtension(IN({ evidence: EV({ bestPrice: 100_470, atrPct: 0.5 }) }));
    eq(d.code, 'EXTEND');
    eq(d.requiredGivebackRoePct, 25, '★ 바닥이 비율 요구(14)를 덮어쓴다');
    // 같은 자리에서 ATR을 모르면 바닥이 0 → 비율만으로 닫는다
    const unknown = decideHoldExtension(IN({
      evidence: EV({ bestPrice: 100_470, atrPct: null }) }));
    eq(unknown.code, 'CLOSE_GIVEBACK', '★ ATR UNKNOWN은 닫는 쪽으로 떨어진다');
    eq(Math.round(unknown.requiredGivebackRoePct!), 14);
  });

  test('고점이 작동 문턱 아래면 보호가 걸리지 않는다', () => {
    // 고점 = 지금 = net 18% < 25%
    const d = decideHoldExtension(IN({ evidence: EV({ bestPrice: 100_300 }) }));
    eq(d.code, 'EXTEND');
    eq(d.requiredGivebackRoePct, null, '아직 안 걸렸으면 null이다');
  });

  test('★ 지금 가격이 봉의 고점보다 높으면 지금이 고점이다', () => {
    // 봉은 **완성된 것만** 쓰므로 진행 중인 봉의 고점이 빠진다. 그 창에서
    // 봉의 고점만 믿으면 고점을 실제보다 낮게 보고, 그러면 보호(⑥)가
    // 아직 안 걸린 것으로 읽혀 **급반전이 그대로 통과한다.**
    const d = decideHoldExtension(IN({
      evidence: EV({ markPrice: 100_400, bestPrice: 100_200 }) }));
    eq(d.code, 'EXTEND');
    eq(Math.round(d.netRoePct!), 28);
    eq(d.peakNetRoePct, d.netRoePct, '★ 지금이 고점이어야 한다');
    assert(d.requiredGivebackRoePct != null,
      '★ 고점이 작동 문턱을 넘었으니 보호가 걸려 있어야 한다');
  });

  test('★ 고점을 모르면 현재를 고점으로 본다 — 가짜 반납을 만들지 않는다', () => {
    const d = decideHoldExtension(IN({ evidence: EV({ bestPrice: null }) }));
    eq(d.code, 'EXTEND');
    eq(Math.round(d.peakNetRoePct!), 18);
  });

  test('★ 고점도 net으로 센다 — gross 고점과 net 현재를 비교하지 않는다', () => {
    // 고점과 현재가 같으면 반납은 0이어야 한다. gross/net을 섞으면
    // 간접비 12%p가 매번 가짜 반납으로 잡힌다.
    const d = decideHoldExtension(IN({
      evidence: EV({ markPrice: 100_600, bestPrice: 100_600, atrPct: 0.001 }) }));
    eq(d.code, 'EXTEND');
    eq(d.netRoePct, d.peakNetRoePct, '같은 가격이면 고점과 현재가 같아야 한다');
  });

  // ══════════════════════════════════════════════════════════
  // ⑦ 추세
  // ══════════════════════════════════════════════════════════
  test('★ 추세가 꺾였으면 수익이어도 계약 한도에서 닫는다', () => {
    const d = decideHoldExtension(IN({ evidence: EV({ trendAlive: false }) }));
    eq(d.code, 'CLOSE_TREND_DEAD');
    assert(d.netRoePct! > POLICY.minNetRoePct, '수익은 문턱 위인 자리여야 한다');
  });

  test('★ 추세를 모르면(null) 통과로 읽지 않는다', () => {
    const d = decideHoldExtension(IN({ evidence: EV({ trendAlive: null }) }));
    eq(d.code, 'CLOSE_TREND_DEAD');
    assert(d.reason.includes('증거가 없'), `모름과 꺾임을 구분해야 한다 — ${d.reason}`);
  });

  test('★ truthy 값을 true로 읽지 않는다', () => {
    for (const v of [1, 'true', 'yes', {}]) {
      const d = decideHoldExtension(IN({ evidence: EV({ trendAlive: v as any }) }));
      eq(d.code, 'CLOSE_TREND_DEAD', `trendAlive=${JSON.stringify(v)}인데 ${d.code}`);
    }
  });

  // ══════════════════════════════════════════════════════════
  // netRoeOf — 셈이 한 곳에 있다
  // ══════════════════════════════════════════════════════════
  test('netRoeOf: 100배에서 왕복 수수료 0.1%는 ROE 10%다', () => {
    const r = netRoeOf({
      side: 'LONG', entryPrice: 100_000, price: 100_000, leverage: 100,
      roundTripFeeRate: 0.001, slippageAllowancePct: 0,
      fundingPaidQuote: 0, notionalAtEntryQuote: 100_000,
    });
    eq(Math.round(r!), -10, '★ 본전 가격에서 ROE −10%');
  });

  test('netRoeOf: ROE 3%는 가격 0.03%다 — 수수료보다 작다', () => {
    const r = netRoeOf({
      side: 'LONG', entryPrice: 100_000, price: 100_030, leverage: 100,
      roundTripFeeRate: 0, slippageAllowancePct: 0,
      fundingPaidQuote: 0, notionalAtEntryQuote: 100_000,
    });
    eq(Math.round(r!), 3);
  });

  test('netRoeOf: 쓸 수 없는 입력은 null이다', () => {
    const b = {
      side: 'LONG' as const, roundTripFeeRate: 0.001, slippageAllowancePct: 0,
      fundingPaidQuote: 0, notionalAtEntryQuote: 100_000,
    };
    eq(netRoeOf({ ...b, entryPrice: 0, price: 100, leverage: 100 }), null);
    eq(netRoeOf({ ...b, entryPrice: 100, price: 0, leverage: 100 }), null);
    eq(netRoeOf({ ...b, entryPrice: 100, price: 100, leverage: 0 }), null);
  });

  // ══════════════════════════════════════════════════════════
  // summarizeBars — 추세·ATR·고점은 순수 함수가 뽑는다
  // ══════════════════════════════════════════════════════════
  const bars = (closes: number[]) => closes.map(c => ({
    high: c + 10, low: c - 10, close: c,
  }));

  test('summarizeBars: 봉이 모자라면 추세를 정하지 않는다', () => {
    const s = summarizeBars(bars([1, 2, 3, 4, 5, 6, 7]), 'LONG');
    eq(s.ok, false);
    eq(s.trendAlive, null, `★ ${TREND_MIN_BARS}개 미만은 UNKNOWN이다`);
    eq(s.atrPct, null);
    eq(s.bestPrice, null);
  });

  test('summarizeBars: 봉이 아예 없거나 쓰레기면 UNKNOWN이다', () => {
    for (const v of [null, undefined, [], [{ high: NaN, low: 1, close: 1 }]]) {
      eq(summarizeBars(v as any, 'LONG').trendAlive, null);
    }
  });

  test('summarizeBars: 오르는 봉에서 LONG은 추세가 살아 있다', () => {
    const s = summarizeBars(bars([100, 101, 102, 103, 104, 105, 106, 107]), 'LONG');
    eq(s.ok, true);
    eq(s.trendAlive, true);
    eq(s.bestPrice, 117, '고점은 high의 최대다');
    assert(s.atrPct! > 0, `ATR이 있어야 한다 — ${s.atrPct}`);
  });

  test('summarizeBars: 내리는 봉에서 LONG은 추세가 꺾였다', () => {
    const s = summarizeBars(bars([107, 106, 105, 104, 103, 102, 101, 100]), 'LONG');
    eq(s.trendAlive, false);
  });

  test('summarizeBars: SHORT는 방향을 뒤집어 본다', () => {
    const down = bars([107, 106, 105, 104, 103, 102, 101, 100]);
    eq(summarizeBars(down, 'SHORT').trendAlive, true);
    eq(summarizeBars(down, 'SHORT').bestPrice, 90, '★ SHORT의 고점은 low의 최소다');
    const up = bars([100, 101, 102, 103, 104, 105, 106, 107]);
    eq(summarizeBars(up, 'SHORT').trendAlive, false);
  });

  test('★ summarizeBars: 횡보는 추세로 읽지 않는다', () => {
    const flat = summarizeBars(bars([100, 100, 100, 100, 100, 100, 100, 100]), 'LONG');
    eq(flat.trendAlive, false, '평균과 종가가 같으면 추세가 아니다');
  });

  test('★ summarizeBars: 종가는 평균 위인데 평균이 꺾이면 추세가 아니다', () => {
    // 평균이 내려가는 중에 마지막 봉만 튄 모양
    const s = summarizeBars(bars([120, 118, 116, 114, 112, 110, 108, 115]), 'LONG');
    eq(s.trendAlive, false, '★ 한 봉의 반등을 추세 유지로 읽지 않는다');
  });
}
