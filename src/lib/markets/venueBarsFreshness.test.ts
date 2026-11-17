// src/lib/markets/venueBarsFreshness.test.ts
//
// **오래된 봉으로 진입 판단을 하고 있었다 (#450).**
//
// `dropIncompleteBar`는 **미완성 봉 하나**만 잘라 낸다. 그 조건은
// `여는 시각 + 봉 길이 > 지금`이고, 3일 지연된 차트에서는 거짓이라
// 아무것도 자르지 않는다. 그래서 호출부가 받는 것은:
//
//   신선한 차트      droppedIncomplete=false · bars 있음
//   3일 지연된 차트  droppedIncomplete=false · bars 있음   ← 구별 불가
//
// 그 뒤 `scalpSignal`이 3일 전 고점으로 돌파를 판단하고, 장부에는
// `NO_SIGNAL · reasonCode NO_BREAKOUT`이 남는다. 사람이 읽으면
// **"시장이 조용했구나"**다.
//
// 이 파일은 `venueBars.ts` **한 파일만** 시험한다 (#450 후속 결정).
// N=3은 **후보값이고 정책으로 확정된 값이 아니다.**

import { test, eq, assert } from '../../test/harness';
import { fetchVenueBars, dropIncompleteBar, intervalMs,
  barFreshness, STALE_MAX_AGE_INTERVALS } from './venueBars';
import { outcomeOf } from '../strategies/runStrategy';

const MIN = 60_000;
const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);

/** 바이낸스 klines 모양. 마지막 봉이 `lastCloseMs`에 닫히도록 놓는다 */
function klines(lastCloseMs: number, step: number, n = 10) {
  return Array.from({ length: n }, (_, i) => {
    const open = lastCloseMs - (n - i) * step;
    return [open, '100', '110', '90', '105', '12.5', open + step - 1, '0', 0, '0', '0', '0'];
  });
}

/**
 * 응답을 값으로 주는 fetch. **전역을 건드리지 않는다.**
 *
 * 처음에는 `globalThis.fetch`를 갈아 끼웠다. 이 하네스는 비동기 시험을
 * 한꺼번에 flush 하므로, 그 사이 **다른 묶음의 주문 시험이 이 가짜를
 * 보고 8건 깨졌다.** 전역을 빌려 쓰는 시험은 자기 범위를 넘는다.
 */
function fakeFetch(rows: any) {
  return (async () => ({ ok: true, status: 200, json: async () => rows })) as any;
}

export function runVenueBarsFreshnessTests() {
  console.log('[봉 신선도 — 오래된 차트를 신선한 차트와 구별하는가 (#450)]');

  test('정본 확인 — dropIncompleteBar 는 72시간 지연을 신선과 같게 본다', () => {
    const step = MIN;
    const fresh = dropIncompleteBar(
      klines(NOW, step).map(k => ({ openTime: Number(k[0]) })), '1m', NOW);
    const old = dropIncompleteBar(
      klines(NOW - 72 * 60 * MIN, step).map(k => ({ openTime: Number(k[0]) })), '1m', NOW);
    eq(fresh.dropped, false, '방금 닫힌 봉은 자르지 않는다');
    eq(old.dropped, false, '72시간 지연도 자르지 않는다');
    eq(fresh.dropped, old.dropped, '두 경우가 같은 값이다 — 호출부가 구별할 수 없다');
  });

  test('★ RED — 한도를 주면 72시간 지연된 봉은 돌려주지 않아야 한다', async () => {
    const r = await fetchVenueBars({ fetchImpl: fakeFetch(klines(NOW - 72 * 60 * MIN, MIN)),
      exchange: 'binance', symbol: 'BTCUSDT', interval: '1m', limit: 5,
      testnet: true, nowMs: NOW, maxAgeIntervals: 3,
    } as any);
    eq(r.bars, null, '오래된 봉이 그대로 통과했다');
    assert(/오래/.test(String(r.error || '')), `이유가 적혀 있어야 한다: ${r.error}`);
  });

  test('★ RED — 한도를 주면 1시간 지연된 1분봉도 돌려주지 않아야 한다', async () => {
    const r = await fetchVenueBars({ fetchImpl: fakeFetch(klines(NOW - 60 * MIN, MIN)),
      exchange: 'binance', symbol: 'BTCUSDT', interval: '1m', limit: 5,
      testnet: true, nowMs: NOW, maxAgeIntervals: 3,
    } as any);
    eq(r.bars, null, '1분봉이 60분 지연됐는데 통과했다');
    // **'fetch failed'가 원하는 동작으로 위장하지 못하게 한다.** 네트워크가
    // 막혀서 bars 가 null 이면 이 시험은 아무것도 검증하지 않는다.
    assert(/오래/.test(String(r.error || '')), `망 오류가 아니라 지연이어야 한다: ${r.error}`);
  });

  test('★ RED — 한도를 줘도 신선한 봉은 그대로 돌려줘야 한다', async () => {
    const r = await fetchVenueBars({ fetchImpl: fakeFetch(klines(NOW, MIN)),
      exchange: 'binance', symbol: 'BTCUSDT', interval: '1m', limit: 5,
      testnet: true, nowMs: NOW, maxAgeIntervals: 3,
    } as any);
    assert(r.bars != null, `신선한 봉을 막았다: ${r.error}`);
    eq(r.error, null);
  });

  test('한도를 **주지 않으면** 지금 동작 그대로다 — 오래된 봉도 통과한다', async () => {
    const r = await fetchVenueBars({ fetchImpl: fakeFetch(klines(NOW - 72 * 60 * MIN, MIN)),
      exchange: 'binance', symbol: 'BTCUSDT', interval: '1m', limit: 5,
      testnet: true, nowMs: NOW,
    });
    assert(r.bars != null, '한도를 안 줬는데 막혔다 — 기존 호출부의 동작이 바뀐다');
    eq(r.error, null);
    eq(r.droppedIncomplete, false);
  });


  // ── 소유자가 지정한 검증 항목 (#450) ──
  //   정상 봉 · 미완성 봉 · 1·6·72시간 지연 · 거래소 시각 오차 ·
  //   타임프레임별 경계값

  test('N 후보값은 3이고 **정책이 아니라 상수 하나**다', () => {
    eq(STALE_MAX_AGE_INTERVALS, 3);
  });

  test('① 정상 봉 — 방금 닫힌 봉은 신선하다', () => {
    const f = barFreshness({ newestOpenTime: NOW - MIN, interval: '1m', nowMs: NOW, maxAgeIntervals: 3 });
    eq(f.ageMs, 0, '닫힌 직후면 나이 0이다');
    eq(f.stale, false);
    eq(f.reason, null);
  });

  test('② 미완성 봉을 일부러 남겼으면 진행 중인 것이 정상이다', () => {
    // 여는 시각이 30초 전인 1분봉 → 아직 30초 남았다
    const f = barFreshness({ newestOpenTime: NOW - 30_000, interval: '1m', nowMs: NOW,
      maxAgeIntervals: 3, keptIncomplete: true });
    eq(f.stale, false, '일부러 남긴 진행 중 봉을 오래됐다고 하면 안 된다');
    assert((f.ageMs ?? 0) < 0, `아직 안 닫혔으므로 음수다: ${f.ageMs}`);
    eq(f.futureSkewMs, null, '이것은 시각 오차가 아니다');
  });

  test('②-b 미완성 봉을 **안** 남겼는데 아직 안 닫혔으면 시각 오차다 — 판정하지 않는다', () => {
    const f = barFreshness({ newestOpenTime: NOW - 30_000, interval: '1m', nowMs: NOW, maxAgeIntervals: 3 });
    eq(f.stale, null, '모르는 것을 false(신선)로 적으면 진짜 지연을 놓친다');
    eq(f.futureSkewMs, 30_000);
    assert(/앞서/.test(String(f.reason)), f.reason ?? '');
  });

  test('③ 1·6·72시간 지연 — 1분봉에서는 셋 다 오래됐다', () => {
    for (const h of [1, 6, 72]) {
      const f = barFreshness({ newestOpenTime: NOW - h * 60 * MIN - MIN, interval: '1m',
        nowMs: NOW, maxAgeIntervals: 3 });
      eq(f.stale, true, `${h}시간 지연이 통과했다`);
      eq(Math.round((f.ageMs as number) / MIN), h * 60, `나이(분) · ${h}시간`);
      assert(/오래/.test(String(f.reason)), f.reason ?? '');
    }
  });

  test('③-b 같은 지연이 **봉 주기에 따라 다르게** 판정된다', () => {
    // 6시간 지연: 1분봉·1시간봉은 한도 초과, 1일봉은 아직 아니다
    const cases: [string, boolean][] = [['1m', true], ['5m', true], ['15m', true],
      ['1h', true], ['4h', false], ['1d', false]];
    for (const [iv, want] of cases) {
      const step = intervalMs(iv) as number;
      const f = barFreshness({ newestOpenTime: NOW - 6 * 60 * MIN - step, interval: iv,
        nowMs: NOW, maxAgeIntervals: 3 });
      eq(f.stale, want, `${iv} · 6시간 지연 · 한도 ${3 * step / MIN}분`);
    }
  });

  test('④ 경계값 — 한도와 **정확히 같으면 신선하다**', () => {
    for (const iv of ['1m', '5m', '15m', '1h', '4h', '1d']) {
      const step = intervalMs(iv) as number;
      const exact = barFreshness({ newestOpenTime: NOW - 3 * step - step, interval: iv,
        nowMs: NOW, maxAgeIntervals: 3 });
      eq(exact.ageMs, 3 * step, `${iv} 경계 나이`);
      eq(exact.stale, false, `${iv}: 경계에 정확히 걸린 봉을 버리면 멀쩡한 봉을 잃는다`);
      const over = barFreshness({ newestOpenTime: NOW - 3 * step - step - 1, interval: iv,
        nowMs: NOW, maxAgeIntervals: 3 });
      eq(over.stale, true, `${iv}: 1ms 넘으면 오래됐다`);
    }
  });

  test('⑤ 봉 간격을 못 읽으면 **판정하지 않는다** — 통과도 차단도 아니다', () => {
    for (const iv of ['nope', '', '0m', '1x']) {
      const f = barFreshness({ newestOpenTime: NOW - MIN, interval: iv, nowMs: NOW, maxAgeIntervals: 3 });
      eq(f.stale, null, `${iv}: 모르는 것을 false 로 적으면 확인 못 한 것이 통과가 된다`);
      eq(f.ageMs, null);
    }
  });

  test('⑤-b 여는 시각을 못 읽으면 판정하지 않는다 — 0으로 메우지 않는다', () => {
    for (const v of [null, undefined, '', NaN, 'abc']) {
      const f = barFreshness({ newestOpenTime: v, interval: '1m', nowMs: NOW, maxAgeIntervals: 3 });
      eq(f.stale, null, `${String(v)}: 1970년으로 읽으면 전부 오래된 것이 된다`);
      eq(f.ageMs, null);
    }
  });

  test('⑥ 한도를 주지 않으면 나이는 재고 판정은 하지 않는다', () => {
    const f = barFreshness({ newestOpenTime: NOW - 100 * MIN, interval: '1m', nowMs: NOW });
    eq(f.stale, null, '한도가 없으면 넘었는지도 없다');
    eq(f.ageMs, 99 * MIN, '나이는 그래도 잴 수 있다');
    eq(f.limitMs, null);
  });

  test('⑦ 미완성 봉은 여전히 잘린다 — 이 작업이 그 동작을 바꾸지 않는다', async () => {
    // 마지막 봉이 진행 중인 차트. 자른 뒤의 마지막 봉은 신선하다.
    const rows = klines(NOW + MIN, MIN);          // 마지막 봉이 1분 뒤에 닫힌다
    const r = await fetchVenueBars({ fetchImpl: fakeFetch(rows),
      exchange: 'binance', symbol: 'BTCUSDT', interval: '1m', limit: 5,
      testnet: true, nowMs: NOW, maxAgeIntervals: 3,
    } as any);
    eq(r.droppedIncomplete, true, '미완성 봉을 잘라야 한다');
    assert(r.bars != null, `자른 뒤의 봉은 신선하다: ${r.error}`);
  });

  test('⑧ 6시간 지연은 fetchVenueBars 에서도 막힌다 (Gate 표기도 같은 판정부)', async () => {
    const r = await fetchVenueBars({ fetchImpl: fakeFetch(klines(NOW - 360 * MIN, MIN)),
      exchange: 'binance', symbol: 'BTCUSDT', interval: '1m', limit: 5,
      testnet: true, nowMs: NOW, maxAgeIntervals: STALE_MAX_AGE_INTERVALS,
    } as any);
    eq(r.bars, null);
    assert(/오래/.test(String(r.error)), r.error ?? '');
    eq(r.source.startsWith('binance'), true, `출처를 적어야 한다: ${r.source}`);
  });

  // ── 막은 뒤 **어디로 가는지**를 사실대로 적는다 ──
  //
  // 소유자 지시: "오래된 봉은 기존 BARS_UNAVAILABLE 경로로 안전하게
  // 처리하는 방향을 검토". 검토 결과는 **그 코드로는 가지 않는다**다.
  //
  //   fetchVenueBars  bars: null
  //     → scalp route fetchBars 가 null → 502 { ok:false, error }
  //     → outcomeOf   httpOk=false → **FAILED** + 산문
  //
  // `BARS_UNAVAILABLE`은 `diagnoseScalpSignal`이 **봉을 받았지만 비었을 때**
  // 붙이는 코드다. 실패에 사유 코드를 붙이는 것은 기존 불변식
  // (`★ 진입·차단·실패에는 사유 코드를 붙이지 않는다`)을 깨는 일이라
  // 하지 않았다. 아래 시험이 그 착지점을 못 박는다.

  test('⑨ 오래된 봉의 착지점은 FAILED + 산문이다 — BARS_UNAVAILABLE 이 아니다', () => {
    const v = outcomeOf({ httpOk: false, status: 502, body: {
      ok: false, error: '봉이 오래됐습니다 — 마지막 봉이 360분 전에 닫혔습니다 (한도 3분 · 1m × 3)',
    } });
    eq(v.outcome, 'FAILED', '지금 설계에서는 실패로 적힌다');
    eq(v.reasonCode, undefined, '실패에 사유 코드를 붙이지 않는 불변식은 그대로다');
    assert(v.summary.includes('오래됐습니다'), `이유는 산문으로 남는다: ${v.summary}`);
    assert(v.summary.includes('360분'), `얼마나 오래됐는지가 남는다: ${v.summary}`);
  });

  // ── 과거 구간 조회는 '지금' 기준으로 판정하면 안 된다 ──
  //
  // 소유자 결정(#450): "`startTimeMs/endTimeMs`을 쓰는 과거 구간 조회·
  // 백테스트/리서치는 현재 시각 기준 stale 판정으로 모두 막으면 안 됨."
  //
  // 실제 호출부가 있다. `src/app/api/signals/ledger/route.ts:104-106`은
  // 신호가 난 **과거 구간**을 `startTimeMs`·`endTimeMs`로 받아 체결을
  // 대조한다. 그 봉은 당연히 오래됐다 — 오래된 것이 **정상**이다.
  // 지금 기준으로 막으면 신호 장부 대조가 통째로 멈춘다.

  test('★ RED — 과거 구간 조회(startTimeMs)는 한도를 줘도 막히지 않는다', async () => {
    const r = await fetchVenueBars({ fetchImpl: fakeFetch(klines(NOW - 72 * 60 * MIN, MIN)),
      exchange: 'binance', symbol: 'BTCUSDT', interval: '1m', limit: 5,
      testnet: true, nowMs: NOW, maxAgeIntervals: 3,
      startTimeMs: NOW - 80 * 60 * MIN,
    } as any);
    assert(r.bars != null, `과거 구간 조회가 막혔다 — 신호 장부 대조가 멈춘다: ${r.error}`);
    eq(r.error, null);
  });

  test('★ RED — 과거 구간 조회(endTimeMs)도 막히지 않는다', async () => {
    const r = await fetchVenueBars({ fetchImpl: fakeFetch(klines(NOW - 72 * 60 * MIN, MIN)),
      exchange: 'binance', symbol: 'BTCUSDT', interval: '1m', limit: 5,
      testnet: true, nowMs: NOW, maxAgeIntervals: 3,
      endTimeMs: NOW - 60 * 60 * MIN,
    } as any);
    assert(r.bars != null, `과거 구간 조회가 막혔다: ${r.error}`);
  });

  test('★ RED — 두 끝을 다 준 조회도 막히지 않는다 (signals/ledger 의 모양)', async () => {
    const r = await fetchVenueBars({ fetchImpl: fakeFetch(klines(NOW - 72 * 60 * MIN, MIN)),
      exchange: 'binance', symbol: 'BTCUSDT', interval: '1m', limit: 1000,
      testnet: true, nowMs: NOW, maxAgeIntervals: 3,
      startTimeMs: NOW - 80 * 60 * MIN, endTimeMs: NOW - 70 * 60 * MIN,
    } as any);
    assert(r.bars != null, `signals/ledger 모양이 막혔다: ${r.error}`);
  });

  test('구간을 안 준 실시간 조회는 여전히 막힌다 — 면제가 너무 넓지 않다', async () => {
    const r = await fetchVenueBars({ fetchImpl: fakeFetch(klines(NOW - 72 * 60 * MIN, MIN)),
      exchange: 'binance', symbol: 'BTCUSDT', interval: '1m', limit: 5,
      testnet: true, nowMs: NOW, maxAgeIntervals: 3,
    } as any);
    eq(r.bars, null, '실시간 조회에서 면제가 새면 검사가 무의미해진다');
    assert(/오래/.test(String(r.error)), r.error ?? '');
  });

  test('실시간 차트(keepIncomplete)는 진행 중 봉이 정상이다 — market/candles 의 모양', async () => {
    // 마지막 봉이 아직 안 닫혔다. `market/candles/route.ts:76`이 이 모양이다.
    const r = await fetchVenueBars({ fetchImpl: fakeFetch(klines(NOW + MIN, MIN)),
      exchange: 'binance', symbol: 'BTCUSDT', interval: '1m', limit: 5,
      testnet: true, nowMs: NOW, maxAgeIntervals: 3, keepIncomplete: true,
    } as any);
    assert(r.bars != null, `실시간 차트가 막혔다: ${r.error}`);
    eq(r.droppedIncomplete, false, 'keepIncomplete 면 자르지 않는다');
  });

  test('봉 길이 상수는 그대로다 — 이 작업이 바꾸지 않는다', () => {
    eq(intervalMs('1m'), 60_000);
    eq(intervalMs('5m'), 300_000);
    eq(intervalMs('1h'), 3_600_000);
    eq(intervalMs('4h'), 14_400_000);
    eq(intervalMs('1d'), 86_400_000);
    eq(intervalMs('nope'), null);
  });
}
