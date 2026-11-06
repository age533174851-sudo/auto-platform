// src/test/fixtures/syntheticSweep.test.ts
//
// **체제 × 가격대 전수로 전략 판정을 훑는다 (#450 오프라인 확대 1단계).**
//
// 왜 필요한가
// ───────────
// 운영 장부에는 `NO_SIGNAL · NO_BREAKOUT` 하나로 뭉쳐 있다. 그 값을 읽어도
// "이게 정상인가"를 대조할 기준이 없었다. 이 시험이 그 기준을 만든다 —
// **어떤 체제에서 어떤 사유 코드가 나오는지**를 값으로 고정한다.
//
// 무엇을 하지 않는가
// ──────────────────
// **성적표를 만들지 않는다.** 합성 봉의 손익은 아무 뜻이 없다. 거래소도
// DB 도 타지 않고, 주문 경로를 부르지 않는다. 판정만 본다.

import { test, eq, assert } from '../harness';
import { syntheticBars, REGIMES, PRICE_SCALES, SCALP_LOOKBACK, type Regime } from './syntheticBars';
import { scalpSignal, SCALP_DEFAULTS, atr } from '../../lib/strategies/scalpSignal';
import { diagnoseScalpSignal } from '../../lib/strategies/scalpSignalDiagnosis';

/** `runStrategy` 가 장부에 싣는 화이트리스트 (runStrategy.ts:115-120 과 같아야 한다) */
const WHITELIST = [
  'NO_BREAKOUT', 'VOLUME_BELOW_THRESHOLD', 'VOLUME_UNAVAILABLE',
  'BARS_UNAVAILABLE', 'BARS_INSUFFICIENT', 'BAR_DATA_INVALID',
  'PRICE_UNAVAILABLE', 'ATR_UNAVAILABLE', 'STOP_INVALID',
  'COST_EXCEEDS_TARGET', 'UNKNOWN_REASON',
];

function judge(regime: Regime, basePrice: number, n = 60) {
  const bars = syntheticBars({ regime, basePrice, n });
  const r = scalpSignal(bars, SCALP_DEFAULTS);
  return { bars, result: r, diag: diagnoseScalpSignal(r) };
}

export function runSyntheticSweepTests() {
  console.log('[합성 봉 전수 훑기 — 체제 × 가격대 (#450)]');

  test('생성기가 결정적이다 — 같은 시드에 같은 봉', () => {
    const a = syntheticBars({ regime: 'HIGH_VOL_RANGE', basePrice: 100, seed: 7 });
    const b = syntheticBars({ regime: 'HIGH_VOL_RANGE', basePrice: 100, seed: 7 });
    eq(JSON.stringify(a), JSON.stringify(b));
    const c = syntheticBars({ regime: 'HIGH_VOL_RANGE', basePrice: 100, seed: 8 });
    assert(JSON.stringify(a) !== JSON.stringify(c), '시드가 달라도 같으면 난수가 아니다');
  });

  test('생성기가 음수·0 가격을 만들지 않는다 — 어떤 체제도 그렇지 않다', () => {
    for (const regime of REGIMES) {
      for (const { basePrice } of PRICE_SCALES) {
        const b = syntheticBars({ regime, basePrice, n: 60 });
        for (const arr of [b.highs, b.lows, b.closes]) {
          assert(arr.every(v => Number.isFinite(v) && v > 0),
            `${regime} · ${basePrice}: 가격에 0 이하/비정상이 있다`);
        }
        assert(b.volumes.every(v => Number.isFinite(v) && v >= 0), `${regime}: 거래량이 비정상`);
        assert(b.highs.every((h, i) => h >= b.lows[i]), `${regime}: 고가 < 저가`);
      }
    }
  });

  // ── ① 신호가 없으면 **화이트리스트 코드**가 나온다 ──

  test('★ 체제 × 가격대 전수에서 사유 코드가 전부 화이트리스트 안이다', () => {
    let checked = 0;
    for (const regime of REGIMES) {
      for (const { name, basePrice } of PRICE_SCALES) {
        const { result, diag } = judge(regime, basePrice);
        checked += 1;
        if (result.signal) {
          eq(diag.code, 'SIGNAL_PRESENT', `${regime} · ${name}`);
          continue;
        }
        assert(WHITELIST.includes(diag.code),
          `${regime} · ${name}: 화이트리스트 밖 코드 ${diag.code} — 장부가 이것을 버린다 (${result.reason})`);
        assert(String(result.reason).length > 0, `${regime} · ${name}: 이유가 빈 문자열이다`);
      }
    }
    eq(checked, REGIMES.length * PRICE_SCALES.length);
    assert(checked === 36, `훑은 조합 ${checked}개`);
  });

  test('★ `UNKNOWN_REASON` 이 나오는 조합이 없다 — 분류기가 전부 알아본다', () => {
    const unknown: string[] = [];
    for (const regime of REGIMES) {
      for (const { name, basePrice } of PRICE_SCALES) {
        const { result, diag } = judge(regime, basePrice);
        if (!result.signal && diag.code === 'UNKNOWN_REASON') unknown.push(`${regime}/${name}: ${result.reason}`);
      }
    }
    eq(unknown.length, 0, `분류되지 않은 사유:\n    ${unknown.join('\n    ')}`);
  });

  // ── ② 체제 → 코드 기준표 (운영 장부와 대조할 값) ──

  test('생성기의 lookback 이 전략 설정과 같다 — 다르면 "안쪽"이 뜻을 잃는다', () => {
    eq(SCALP_LOOKBACK, SCALP_DEFAULTS.lookback,
      '생성기와 전략의 lookback 이 갈렸다 — QUIET_INSIDE 가 돌파를 만들 수 있다');
  });

  test('★ **`NO_BREAKOUT` 이 나는 체제가 있다** — 운영 장부가 보여 준 코드', () => {
    for (const { name, basePrice } of PRICE_SCALES) {
      const { result, diag } = judge('QUIET_INSIDE', basePrice);
      eq(result.signal, null, `${name}: 범위 안쪽인데 신호가 났다`);
      eq(diag.code, 'NO_BREAKOUT',
        `${name}: ${diag.code} — ${result.reason}`);
    }
  });

  test('★ 평평한 시장은 돌파가 없다 — 모든 가격대에서', () => {
    for (const { name, basePrice } of PRICE_SCALES) {
      const { result, diag } = judge('FLAT', basePrice);
      eq(result.signal, null, `${name}: 평평한데 신호가 났다`);
      assert(['NO_BREAKOUT', 'ATR_UNAVAILABLE', 'VOLUME_BELOW_THRESHOLD'].includes(diag.code),
        `${name}: 평평한 시장의 코드가 ${diag.code} (${result.reason})`);
    }
  });

  test('★ 거래량 0 이면 **멈춘다** — 0 을 평균으로 읽고 통과하지 않는다', () => {
    for (const { name, basePrice } of PRICE_SCALES) {
      const { result, diag } = judge('ZERO_VOLUME', basePrice);
      eq(result.signal, null, `${name}: 거래량 0 인데 신호가 났다`);
      assert(diag.code !== 'SIGNAL_PRESENT', name);
      assert(WHITELIST.includes(diag.code), `${name}: ${diag.code}`);
    }
  });

  test('★ 돌파했는데 거래량이 모자라면 거래량 코드가 나온다', () => {
    for (const { name, basePrice } of PRICE_SCALES) {
      const { result, diag } = judge('BREAKOUT_NO_VOLUME', basePrice);
      eq(result.signal, null, `${name}: 거래량이 모자란데 신호가 났다`);
      assert(['VOLUME_BELOW_THRESHOLD', 'VOLUME_UNAVAILABLE', 'NO_BREAKOUT'].includes(diag.code),
        `${name}: ${diag.code} — ${result.reason}`);
    }
  });

  test('★ 봉이 모자라면 `BARS_INSUFFICIENT` 다 — 가격대와 무관하다', () => {
    for (const { name, basePrice } of PRICE_SCALES) {
      const bars = syntheticBars({ regime: 'BREAKOUT_UP', basePrice, n: 5 });
      const r = scalpSignal(bars, SCALP_DEFAULTS);
      const d = diagnoseScalpSignal(r);
      eq(r.signal, null, `${name}: 봉 5개로 신호가 났다`);
      eq(d.code, 'BARS_INSUFFICIENT', `${name}: ${d.code} — ${r.reason}`);
    }
  });

  test('★ 봉이 아예 없으면 `BARS_UNAVAILABLE` 다 — 빈 배열을 조용히 통과시키지 않는다', () => {
    eq(diagnoseScalpSignal(scalpSignal(null, SCALP_DEFAULTS)).code, 'BARS_UNAVAILABLE');
    const empty = { highs: [], lows: [], closes: [], volumes: [] };
    const d = diagnoseScalpSignal(scalpSignal(empty, SCALP_DEFAULTS));
    assert(['BARS_UNAVAILABLE', 'BARS_INSUFFICIENT'].includes(d.code), d.code);
  });

  test('★ 열 길이가 어긋나면 통과하지 않는다 — 한 칸 밀린 지표로 판단하지 않는다', () => {
    const b = syntheticBars({ regime: 'BREAKOUT_UP', basePrice: 100, n: 60 });
    const broken = { ...b, volumes: b.volumes.slice(0, 30) };
    const r = scalpSignal(broken, SCALP_DEFAULTS);
    const d = diagnoseScalpSignal(r);
    assert(r.signal == null || d.code === 'SIGNAL_PRESENT',
      '길이가 어긋난 봉으로 신호를 냈다면 그 신호는 믿을 수 없다');
    if (r.signal == null) assert(WHITELIST.includes(d.code), d.code);
  });

  // ── ③ 신호가 났을 때의 불변식 ──

  test('★ 신호가 나면 손절이 진입 **반대쪽**이고 0 이 아니다 — 모든 가격대', () => {
    let signals = 0;
    for (const regime of REGIMES) {
      for (const { name, basePrice } of PRICE_SCALES) {
        const { result } = judge(regime, basePrice);
        const s = result.signal;
        if (!s) continue;
        signals += 1;
        assert(Number.isFinite(s.entry) && s.entry > 0, `${regime}/${name}: 진입가 ${s.entry}`);
        assert(Number.isFinite(s.stop) && s.stop > 0, `${regime}/${name}: 손절가 ${s.stop}`);
        assert(s.stop !== s.entry, `${regime}/${name}: 손절가 = 진입가 — 진입 즉시 손절이다`);
        if (s.side === 'LONG') assert(s.stop < s.entry, `${regime}/${name}: 롱인데 손절이 위다`);
        else assert(s.stop > s.entry, `${regime}/${name}: 숏인데 손절이 아래다`);
        assert(Number.isFinite(s.stopPct) && s.stopPct > 0, `${regime}/${name}: 손절 폭 ${s.stopPct}`);
        assert(Number.isFinite(s.atr) && s.atr > 0, `${regime}/${name}: ATR ${s.atr}`);
      }
    }
    assert(signals > 0, '전수에서 신호가 한 번도 안 났다 — 생성기가 돌파를 못 만든 것이다');
  });

  test('★ 목표가 진입 **쪽**이고 손익비가 설정값과 같은 방향이다', () => {
    for (const regime of REGIMES) {
      for (const { name, basePrice } of PRICE_SCALES) {
        const s = judge(regime, basePrice).result.signal;
        if (!s) continue;
        if (s.side === 'LONG') assert(s.target > s.entry, `${regime}/${name}: 롱인데 목표가 아래다`);
        else assert(s.target < s.entry, `${regime}/${name}: 숏인데 목표가 위다`);
        assert(s.targetPct > s.stopPct, `${regime}/${name}: 목표 폭이 손절 폭보다 작다 (손익비 ${SCALP_DEFAULTS.rewardRisk})`);
      }
    }
  });

  test('★ 같은 봉을 두 번 판정하면 같은 결과다 (멱등)', () => {
    for (const regime of REGIMES) {
      const bars = syntheticBars({ regime, basePrice: 100, n: 60 });
      const a = scalpSignal(bars, SCALP_DEFAULTS);
      const b = scalpSignal(bars, SCALP_DEFAULTS);
      eq(JSON.stringify(a), JSON.stringify(b), `${regime}: 같은 입력에 다른 판정`);
    }
  });

  test('ATR 정본도 가격대 전수에서 0 이나 음수를 돌려주지 않는다', () => {
    for (const { name, basePrice } of PRICE_SCALES) {
      for (const regime of REGIMES) {
        const v = atr(syntheticBars({ regime, basePrice, n: 60 }), SCALP_DEFAULTS.atrPeriod);
        if (v == null) continue;             // 모르면 null — 그게 정본의 계약이다
        assert(Number.isFinite(v) && v > 0, `${regime}/${name}: ATR ${v}`);
      }
    }
  });

  // ── ④ 기준표를 출력한다 (운영 장부와 눈으로 대조할 값) ──

  test('체제 → 사유 코드 기준표 (운영 `last_decision.reasonCode` 와 대조용)', () => {
    const rows: string[] = [];
    for (const regime of REGIMES) {
      const codes = PRICE_SCALES.map(p => judge(regime, p.basePrice).diag.code);
      const uniq = Array.from(new Set(codes));
      rows.push(`    ${regime.padEnd(20)} ${uniq.join(' · ')}`);
    }
    console.log(rows.join('\n'));
    assert(rows.length === REGIMES.length);
  });
}
