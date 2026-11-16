// src/lib/engine/entryBarSignals.test.ts
//
// **이 시험이 지키는 것: 봉이 없으면 방향을 내지 않는다.**
//
// 새로 들어온 네 전략(거래량 확인 돌파 · 유동성 사냥 · 공정가치 갭 ·
// 오더블록)은 전부 고가·저가·거래량을 본다. 그 값이 없을 때 0이나 종가로
// 메우면 "저가 0을 깼다" · "폭 0인 갭에 들어왔다"가 되어 **무조건 진입**이
// 된다. 그래서 없을 때 쉬는지를 전략마다 확인한다.
//
// 그리고 각 전략이 **자기만의 조건으로 갈라지는지**도 본다. 조건이 사실상
// 같으면 전략을 여럿 둔 뜻이 없다 — 이름만 다른 같은 기계가 된다.
import { test, eq, assert } from '../../test/harness';
import { entrySignal, ENTRY_SIGNAL_IDS, ENTRY_SIGNAL_LABEL,
  VOLUME_BREAKOUT_MULT, VOLUME_LOOKBACK, type EntrySignalId } from './entrySignals';
import type { Bar } from '../risk/bars';
import type { RegimeView } from '../risk/regime';

const bar = (o: Partial<Bar> & { close: number }): Bar => ({
  openTime: 0, open: o.open ?? o.close, high: o.high ?? o.close,
  low: o.low ?? o.close, close: o.close, volume: o.volume ?? 100,
});

const view = (v: Partial<RegimeView>): RegimeView => ({
  price: 100, ema20: 100, ema60: 100, atr: 5,
  recentHigh: 110, recentLow: 90, priorHigh: 110, priorLow: 90, ...v,
});

/** 봉이 필요한 전략만 — 추세추종·역추세·돌파는 종가만으로 돈다 */
const BAR_SIGNALS: EntrySignalId[] =
  ['volume-breakout', 'liquidity-sweep', 'fvg-fill', 'order-block'];

export function runEntryBarSignalsTests() {
  console.log('[봉을 보는 전략 — 봉이 없으면 쉰다]');

  test('새 전략도 전부 목록과 이름표에 등록돼 있다', () => {
    for (const id of BAR_SIGNALS) {
      assert(ENTRY_SIGNAL_IDS.includes(id), `${id}가 목록에 없습니다`);
      assert(!!ENTRY_SIGNAL_LABEL[id], `${id}에 이름표가 없습니다`);
    }
    eq(new Set(Object.values(ENTRY_SIGNAL_LABEL)).size, ENTRY_SIGNAL_IDS.length);
  });

  // ★ 이 시험이 이 파일의 이유다.
  test('★ 봉이 없으면 네 전략 모두 방향을 내지 않는다', () => {
    for (const id of BAR_SIGNALS) {
      const v = entrySignal(id, { trend: 'uptrend', view: view({}), markPrice: 200, bars: null });
      eq(v.side, null, `${id}가 봉 없이 진입했습니다: ${v.reason}`);
    }
  });

  test('봉이 모자라면 몇 개뿐인지 적고 쉰다', () => {
    const few = [bar({ close: 100 })];
    for (const id of BAR_SIGNALS) {
      const v = entrySignal(id, { trend: 'uptrend', view: view({}), markPrice: 200, bars: few });
      eq(v.side, null, `${id}가 봉 1개로 진입했습니다`);
    }
  });

  // ── 거래량 확인 돌파 ──
  const upBars = (lastVol: number): Bar[] => [
    ...Array.from({ length: VOLUME_LOOKBACK }, () => bar({ close: 100, volume: 100 })),
    bar({ close: 120, high: 121, low: 119, volume: lastVol }),
  ];

  test('거래량 확인 돌파 — 돌파 + 거래량이 따라오면 들어간다', () => {
    const v = entrySignal('volume-breakout', {
      trend: 'uptrend', view: view({ priorHigh: 110, atr: 4 }), markPrice: 120,
      bars: upBars(100 * VOLUME_BREAKOUT_MULT + 1),
    });
    eq(v.side, 'LONG');
    assert(/거래량 평소의/.test(v.reason), v.reason);
  });

  // 같은 돌파인데 거래량만 평소 수준 — 긁고 되돌릴 자리다.
  test('★ 거래량이 안 따라오면 같은 돌파에도 들어가지 않는다', () => {
    const plain = entrySignal('breakout', {
      trend: 'uptrend', view: view({ priorHigh: 110, atr: 4 }), markPrice: 120, bars: upBars(100),
    });
    eq(plain.side, 'LONG', '기준이 되는 돌파가 발동하지 않았습니다');
    const v = entrySignal('volume-breakout', {
      trend: 'uptrend', view: view({ priorHigh: 110, atr: 4 }), markPrice: 120, bars: upBars(100),
    });
    eq(v.side, null);
    assert(/거래량/.test(v.reason), v.reason);
  });

  // ── 유동성 사냥 ──
  test('유동성 사냥 — 전저점을 깼다가 위쪽에서 닫으면 LONG', () => {
    const v = entrySignal('liquidity-sweep', {
      trend: 'sideways', view: view({ priorLow: 100, priorHigh: 130 }), markPrice: 103,
      bars: [bar({ open: 102, high: 104, low: 95, close: 103 })],
    });
    eq(v.side, 'LONG');
    assert(/회수/.test(v.reason), v.reason);
  });

  test('★ 깨고 바닥에서 닫은 봉은 사냥이 아니다 — 들어가지 않는다', () => {
    const v = entrySignal('liquidity-sweep', {
      trend: 'sideways', view: view({ priorLow: 100, priorHigh: 130 }), markPrice: 96,
      bars: [bar({ open: 104, high: 104, low: 95, close: 96 })],
    });
    eq(v.side, null);
  });

  test('유동성 사냥 — 전고점을 넘었다가 아래쪽에서 닫으면 SHORT', () => {
    const v = entrySignal('liquidity-sweep', {
      trend: 'sideways', view: view({ priorLow: 70, priorHigh: 100 }), markPrice: 97,
      bars: [bar({ open: 98, high: 105, low: 96, close: 97 })],
    });
    eq(v.side, 'SHORT');
  });

  // ── 공정가치 갭 ──
  // a.high=100, c.low=110 → [100,110]이 비어 있다. 가격이 그 안으로 돌아오면 LONG.
  const gapUp: Bar[] = [
    bar({ open: 98, high: 100, low: 96, close: 99 }),
    bar({ open: 101, high: 112, low: 101, close: 111 }),
    bar({ open: 111, high: 115, low: 110, close: 114 }),
  ];

  test('공정가치 갭 — 빈 칸으로 가격이 돌아오면 LONG', () => {
    const v = entrySignal('fvg-fill', {
      trend: 'uptrend', view: view({ atr: 4 }), markPrice: 105, bars: gapUp,
    });
    eq(v.side, 'LONG');
    assert(/공정가치 갭/.test(v.reason), v.reason);
  });

  test('갭 밖에 있으면 들어가지 않는다', () => {
    const v = entrySignal('fvg-fill', {
      trend: 'uptrend', view: view({ atr: 4 }), markPrice: 130, bars: gapUp,
    });
    eq(v.side, null);
  });

  test('★ 이미 메워진 갭에는 들어가지 않는다', () => {
    const filled = [...gapUp, bar({ open: 110, high: 111, low: 95, close: 104 })];
    const v = entrySignal('fvg-fill', {
      trend: 'uptrend', view: view({ atr: 4 }), markPrice: 105, bars: filled,
    });
    eq(v.side, null);
  });

  test('ATR에 비해 먼지 같은 갭은 무시한다', () => {
    const tiny: Bar[] = [
      bar({ open: 99, high: 100, low: 98, close: 99 }),
      bar({ open: 100, high: 101, low: 100, close: 100.5 }),
      bar({ open: 100.5, high: 101, low: 100.4, close: 100.8 }),
    ];
    const v = entrySignal('fvg-fill', {
      trend: 'uptrend', view: view({ atr: 10 }), markPrice: 100.2, bars: tiny,
    });
    eq(v.side, null);
  });

  // ── 오더블록 ──
  // 음봉(시가 110 · 종가 100) 다음 봉이 그 고가(112)를 ATR(5) 넘겨 120에 닫았다.
  const obUp: Bar[] = [
    bar({ open: 110, high: 112, low: 99, close: 100 }),
    bar({ open: 101, high: 121, low: 100, close: 120 }),
    bar({ open: 120, high: 122, low: 118, close: 119 }),
  ];

  test('오더블록 — 밀어붙이기 직전 음봉 몸통으로 돌아오면 LONG', () => {
    const v = entrySignal('order-block', {
      trend: 'uptrend', view: view({ atr: 5 }), markPrice: 105, bars: obUp,
    });
    eq(v.side, 'LONG');
    assert(/오더블록/.test(v.reason), v.reason);
  });

  test('★ 블록이 깨졌으면(몸통 아래로 닫았으면) 쓰지 않는다', () => {
    const broken = [...obUp, bar({ open: 104, high: 106, low: 90, close: 95 })];
    const v = entrySignal('order-block', {
      trend: 'uptrend', view: view({ atr: 5 }), markPrice: 105, bars: broken,
    });
    eq(v.side, null);
  });

  test('밀어붙임이 ATR에 못 미치면 오더블록이 아니다', () => {
    const weak: Bar[] = [
      bar({ open: 110, high: 112, low: 99, close: 100 }),
      bar({ open: 101, high: 113, low: 100, close: 112.5 }),
      bar({ open: 112, high: 113, low: 111, close: 112 }),
    ];
    const v = entrySignal('order-block', {
      trend: 'uptrend', view: view({ atr: 20 }), markPrice: 105, bars: weak,
    });
    eq(v.side, null);
  });

  // 전략들이 서로 다른 조건에서 발동해야 봇을 나눈 뜻이 있다.
  test('★ 같은 입력에서 네 전략이 한목소리로 움직이지 않는다', () => {
    const input = {
      trend: 'sideways' as const, view: view({ priorLow: 100, priorHigh: 130, atr: 4 }),
      markPrice: 103,
      bars: [bar({ open: 102, high: 104, low: 95, close: 103 })],
    };
    const sides = BAR_SIGNALS.map(id => entrySignal(id, input).side);
    assert(new Set(sides).size > 1, `네 전략이 모두 같은 답을 냈습니다: ${JSON.stringify(sides)}`);
  });
}
