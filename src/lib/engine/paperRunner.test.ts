// src/lib/engine/paperRunner.test.ts
//
// 데모 자동매매의 판정. 여기서 틀리면 **성적표가 거짓말을 한다.**
//
// 모의는 실패해도 돈을 잃지 않는다 — 그래서 더 위험하다. 실전이면 손실로
// 드러날 버그가 모의에서는 "생각보다 잘 나오네"로 보인다. 그 성적을 믿고
// 실계좌를 켜는 순간 처음으로 청구서가 온다.
//
// 특히 세 가지를 지킨다:
//   · 가격을 모르면 아무것도 닫지 않는다 (추측가로 닫힌 손익이 장부에 남는다)
//   · 같은 봉에서 여러 개가 닿으면 **가장 나쁜 것**이 먼저다
//   · 수량은 손절까지의 거리로 정한다 (잔고 × 배율은 위험을 정한 것이 아니다)

import { test, eq, assert } from '../../test/harness';
import {
  planExits, planEntry, readRunnerConfig,
  DEFAULT_RUNNER, type OpenPaperPos,
} from './paperRunner';
import {
  ENTRY_SIGNAL_IDS, DEFAULT_ENTRY_SIGNAL, BREAKOUT_BUFFER_ATR,
  MEAN_REVERT_MIN_BOX_ATR, parseEntrySignal, type EntrySignalId,
} from './entrySignals';
import { detectRegime, type RegimeView } from '../risk/regime';

const HOUR = 3_600_000;
const NOW = 1_700_000_000_000;

const pos = (o: Partial<OpenPaperPos> = {}): OpenPaperPos => ({
  id: 'p1', symbol: 'BTCUSDT', side: 'LONG',
  fillPrice: 100, quantity: 1,
  stopLoss: 98, takeProfit: 104, liquidationPrice: 90,
  openedAt: NOW - HOUR,
  ...o,
});

export function runPaperRunnerTests() {
  console.log('[데모 러너 — 청산 판정]');

  test('아무 선에도 안 닿으면 닫지 않는다', () => {
    eq(planExits([pos()], 101, NOW).length, 0);
  });

  test('열린 포지션이 없으면 빈 배열', () => {
    eq(planExits([], 100, NOW).length, 0);
    eq(planExits(null, 100, NOW).length, 0);
    eq(planExits(undefined, 100, NOW).length, 0);
  });

  test('가격을 모르면 **아무것도 닫지 않는다** — 추측가로 닫은 손익은 장부에 남는다', () => {
    // 손절선을 한참 지난 상태라도 마찬가지다. 여기서 임의의 가격을 쓰면
    // 그 뒤의 모든 잔고·승률이 그 값 위에 쌓인다.
    eq(planExits([pos()], null, NOW).length, 0);
    eq(planExits([pos()], 0, NOW).length, 0);
    eq(planExits([pos()], NaN, NOW).length, 0);
  });

  test('LONG 손절 — 마크가가 손절선 이하면 닫는다', () => {
    const a = planExits([pos()], 98, NOW);
    eq(a.length, 1);
    eq(a[0].kind, 'CLOSE');
    eq(a[0].exitReason, 'SL');
    eq(a[0].positionId, 'p1');
  });

  test('SHORT 손절은 방향이 반대다', () => {
    const p = pos({ side: 'SHORT', stopLoss: 102, takeProfit: 96, liquidationPrice: 110 });
    eq(planExits([p], 101, NOW).length, 0, '아직 안 닿았다');
    eq(planExits([p], 102.5, NOW)[0].exitReason, 'SL');
  });

  test('익절', () => {
    eq(planExits([pos()], 104, NOW)[0].exitReason, 'TP');
    const s = pos({ side: 'SHORT', stopLoss: 102, takeProfit: 96, liquidationPrice: 110 });
    eq(planExits([s], 95, NOW)[0].exitReason, 'TP');
  });

  console.log('[데모 러너 — 같은 봉에서 여러 개가 닿았을 때]');

  test('청산가가 손절보다 먼저다 — 모의가 실전보다 유리하면 성적표가 쓸모없다', () => {
    // 89면 손절(98)도 청산(90)도 지났다. 실제로는 청산이 먼저 일어난다.
    const a = planExits([pos()], 89, NOW);
    eq(a.length, 1);
    eq(a[0].exitReason, 'LIQUIDATION');
  });

  test('손절이 익절보다 먼저다', () => {
    // 손절 98 · 익절 99인 이상한 포지션. 둘 다 닿았다면 나쁜 쪽을 택한다.
    const p = pos({ stopLoss: 98, takeProfit: 99 });
    eq(planExits([p], 98, NOW)[0].exitReason, 'SL');
  });

  test('한 포지션에 지시는 하나만 나온다 — 두 번 닫으면 손익이 두 번 적힌다', () => {
    const a = planExits([pos({ openedAt: NOW - 100 * HOUR })], 89, NOW);
    eq(a.length, 1);
  });

  console.log('[데모 러너 — 시간 청산]');

  test('최대 보유 시간을 넘기면 닫는다', () => {
    const old = pos({ openedAt: NOW - 73 * HOUR });
    eq(planExits([old], 101, NOW)[0].exitReason, 'MAX_HOLD');
  });

  test('아직 안 넘겼으면 두고 본다', () => {
    eq(planExits([pos({ openedAt: NOW - 71 * HOUR })], 101, NOW).length, 0);
  });

  console.log('[데모 러너 — 없는 값은 없는 값이다]');

  test('손절이 없으면 손절로 닫지 않는다 (0을 손절선으로 읽지 않는다)', () => {
    eq(planExits([pos({ stopLoss: null, takeProfit: null, liquidationPrice: null })], 1, NOW).length, 0);
    eq(planExits([pos({ stopLoss: 0, takeProfit: 0, liquidationPrice: 0 })], 1, NOW).length, 0);
  });

  test('여러 포지션을 각각 판정한다', () => {
    const a = planExits([
      pos({ id: 'a' }),                                      // 101 → 유지
      pos({ id: 'b', stopLoss: 101.5 }),                     // 손절
      pos({ id: 'c', takeProfit: 100.5 }),                   // 익절
    ], 101, NOW);
    eq(a.length, 2);
    eq(a[0].positionId, 'b');
    eq(a[1].positionId, 'c');
  });

  console.log('[데모 러너 — 진입 판정]');

  const entry = (o: any = {}) => planEntry({
    symbol: 'BTCUSDT',
    regimeStatus: 'ok', regimeReason: '', trend: 'uptrend',
    markPrice: 100, availableUsd: 10000, openCount: 0,
    ...o,
  });

  test('상승 추세면 롱', () => {
    const a = entry();
    eq(a.kind, 'OPEN');
    eq(a.side, 'LONG');
  });

  test('하락 추세면 숏 — 손절은 위, 익절은 아래', () => {
    const a = entry({ trend: 'downtrend' });
    eq(a.side, 'SHORT');
    eq(a.stopPrice, 102);
    eq(a.takeProfit, 96);
  });

  test('횡보면 들어가지 않는다', () => {
    const a = entry({ trend: 'sideways' });
    eq(a.kind, 'NONE');
    assert(a.reason.includes('횡보'), a.reason);
  });

  test('추세를 모르면 들어가지 않는다', () => {
    eq(entry({ trend: null }).kind, 'NONE');
  });

  test('국면이 막으면 들어가지 않고, 그 이유를 그대로 전한다', () => {
    const a = entry({ regimeStatus: 'blocked', regimeReason: '고변동장' });
    eq(a.kind, 'NONE');
    eq(a.reason, '고변동장');
  });

  test('국면을 판정하지 못했으면 들어가지 않는다 — 모르는 것은 통과가 아니다', () => {
    eq(entry({ regimeStatus: 'unknown', regimeReason: '봉 0/60개' }).kind, 'NONE');
  });

  test('이미 최대만큼 열려 있으면 더 안 넣는다', () => {
    const a = entry({ openCount: 1 });
    eq(a.kind, 'NONE');
    assert(a.reason.includes('최대'), a.reason);
  });

  test('시세를 모르면 진입하지 않는다', () => {
    eq(entry({ markPrice: null }).kind, 'NONE');
    eq(entry({ markPrice: 0 }).kind, 'NONE');
  });

  test('가용 잔고를 모르면 진입하지 않는다 — 0과 모름은 다르다', () => {
    const a = entry({ availableUsd: null });
    eq(a.kind, 'NONE');
    assert(a.reason.includes('확인하지 못'), a.reason);
    eq(entry({ availableUsd: 0 }).kind, 'NONE');
    eq(entry({ availableUsd: -5 }).kind, 'NONE');
  });

  console.log('[데모 러너 — 수량은 손절 거리로 정한다]');

  test('위험 1% · 손절 2% · 잔고 10000 · 가격 100 → 50개', () => {
    // 걸 위험 100 USDT ÷ 손절까지 2 USDT = 50개.
    // 이 50개가 손절에 닿으면 정확히 100 USDT를 잃는다.
    const a = entry();
    eq(a.quantity, 50);
    eq(a.stopPrice, 98);
    eq(a.takeProfit, 104);
  });

  test('손절이 두 배 멀면 수량은 절반이다 — 잃는 금액은 같다', () => {
    const a = entry({ cfg: { stopPct: 4 } });
    eq(a.quantity, 25);
    eq(a.stopPrice, 96);
  });

  test('증거금으로 감당 못 하면 줄인다', () => {
    // 위험 50% → 수량 50개(=5000 USDT 명목)인데, 잔고 100 × 배율 5 = 500까지만
    // 가능하다 → 5개로 깎인다.
    const a = entry({ availableUsd: 100, cfg: { riskPctPerTrade: 50, stopPct: 1 } });
    eq(a.kind, 'OPEN');
    eq(a.quantity, 5);
  });

  test('잔고가 너무 작아 수량이 0이면 진입하지 않는다', () => {
    const a = entry({ availableUsd: 0.0000001, markPrice: 100000 });
    eq(a.kind, 'NONE');
  });

  test('익절 0이면 익절을 걸지 않는다 — 트레일링에 맡기는 설정', () => {
    const a = entry({ cfg: { takeProfitPct: 0 } });
    eq(a.kind, 'OPEN');
    eq(a.takeProfit, undefined);
  });

  console.log('[데모 러너 — 설정 읽기]');

  const envOf = (o: Record<string, string>) => (k: string) => o[k];

  test('기본값', () => {
    const c = readRunnerConfig(envOf({}));
    eq(c.riskPctPerTrade, DEFAULT_RUNNER.riskPctPerTrade);
    eq(c.maxOpenPositions, DEFAULT_RUNNER.maxOpenPositions);
    eq(c.maxHoldHours, DEFAULT_RUNNER.maxHoldHours);
  });

  test('환경변수로 바꾼다', () => {
    const c = readRunnerConfig(envOf({
      PAPER_RISK_PCT: '2', PAPER_STOP_PCT: '3', PAPER_TP_PCT: '9',
      PAPER_LEVERAGE: '10', PAPER_MAX_POSITIONS: '3', PAPER_MAX_HOLD_HOURS: '12',
    }));
    eq(c.riskPctPerTrade, 2);
    eq(c.stopPct, 3);
    eq(c.takeProfitPct, 9);
    eq(c.leverage, 10);
    eq(c.maxOpenPositions, 3);
    eq(c.maxHoldHours, 12);
  });

  test('쓸 수 없는 값이면 기본값 — 손절 0%짜리 설정이 들어가면 안 된다', () => {
    const c = readRunnerConfig(envOf({ PAPER_STOP_PCT: 'abc', PAPER_RISK_PCT: '-1' }));
    eq(c.stopPct, DEFAULT_RUNNER.stopPct);
    eq(c.riskPctPerTrade, DEFAULT_RUNNER.riskPctPerTrade);
  });

  console.log('[진입 전략 — 방향은 전략이, 크기는 공유]');

  // 전에는 "추세 방향으로만 들어간다"가 planEntry 안에 박혀 있었다.
  // 그래서 전략을 몇 개 만들든 전부 추세 추종의 변주였다.

  /** 박스 안에 있는 관측값. pos로 박스 안 위치(0=바닥, 1=천장)를 정한다 */
  const viewAt = (pos: number, o: Partial<RegimeView> = {}): RegimeView => {
    const low = 59_000, high = 61_000;
    const price = low + (high - low) * pos;
    return {
      price, ema20: 60_000, ema60: 60_000, atr: 100,
      recentHigh: Math.max(high, price), recentLow: Math.min(low, price),
      priorHigh: high, priorLow: low, ...o,
    };
  };

  test('★★ 전략을 지정하지 않으면 지금까지와 한 글자도 다르지 않다', () => {
    // 기본값이 조용히 바뀌면 paper-auto-v1의 기록이 다른 기계의 기록이 된다.
    for (const trend of ['uptrend', 'downtrend', 'sideways'] as const) {
      const before = entry({ trend });
      const after = entry({ trend, signal: DEFAULT_ENTRY_SIGNAL });
      eq(JSON.stringify(after), JSON.stringify(before), `${trend}에서 갈렸다`);
    }
    eq(DEFAULT_ENTRY_SIGNAL, 'trend-follow');
  });

  test('★★ 전략이 달라도 수량·손절·익절은 같다 — 다르면 성적표를 비교할 수 없다', () => {
    // 같은 방향·같은 가격·같은 잔고면 크기는 같아야 한다. 전략마다 사이징이
    // 다르면 어느 쪽이 좋았는지가 아니라 어느 쪽이 더 크게 걸었는지를 본다.
    const tf = entry({ trend: 'uptrend', markPrice: 60_000, signal: 'trend-follow' });
    const mr = entry({ trend: 'sideways', markPrice: 59_200, signal: 'mean-revert', view: viewAt(0.1) });
    const bo = entry({ trend: 'sideways', markPrice: 61_500, signal: 'breakout', view: viewAt(1) });
    eq(tf.side, 'LONG'); eq(mr.side, 'LONG'); eq(bo.side, 'LONG');
    // 수량은 위험금액 ÷ 손절거리이므로 가격이 다르면 수량도 다르다.
    // 같아야 하는 것은 **식**이다: 손절·익절 비율이 전략과 무관하다.
    for (const a of [tf, mr, bo]) {
      const px = a === tf ? 60_000 : a === mr ? 59_200 : 61_500;
      eq(+(a.stopPrice! / px).toFixed(6), +(1 - DEFAULT_RUNNER.stopPct / 100).toFixed(6),
        '손절 비율이 전략마다 다르다');
      eq(+(a.quantity!).toFixed(6),
        +((10000 * (DEFAULT_RUNNER.riskPctPerTrade / 100)) / (px * DEFAULT_RUNNER.stopPct / 100)).toFixed(6),
        '수량 식이 전략마다 다르다');
    }
  });

  test('★★ 관측값이 없으면 역추세·돌파는 들어가지 않는다 — 0으로 계산하지 않는다', () => {
    // null을 0으로 바꿔 계산하면 "폭 0인 박스의 바닥"·"전고점 0 돌파"가
    // 되어 무조건 진입이 된다.
    for (const signal of ['mean-revert', 'breakout'] as EntrySignalId[]) {
      for (const view of [undefined, null, viewAt(0.1, { atr: null }),
                          viewAt(0.1, { recentHigh: null, priorHigh: null })]) {
        const a = entry({ trend: 'sideways', signal, view });
        eq(a.kind, 'NONE', `${signal}가 관측값 없이 들어갔다`);
        assert(a.reason.includes('없습니다'), `무엇이 없었는지 적어야 한다: ${a.reason}`);
      }
    }
  });

  test('역추세는 박스 아래끝에서 롱, 위끝에서 숏, 가운데서는 쉰다', () => {
    eq(entry({ trend: 'sideways', markPrice: 59_100, signal: 'mean-revert', view: viewAt(0.05) }).side, 'LONG');
    eq(entry({ trend: 'sideways', markPrice: 60_900, signal: 'mean-revert', view: viewAt(0.95) }).side, 'SHORT');
    const mid = entry({ trend: 'sideways', markPrice: 60_000, signal: 'mean-revert', view: viewAt(0.5) });
    eq(mid.kind, 'NONE');
    assert(mid.reason.includes('가운데'), mid.reason);
  });

  test('★ 역추세는 추세장에서 들어가지 않는다 — 추세에 맞서는 것은 전략이 아니다', () => {
    for (const trend of ['uptrend', 'downtrend'] as const) {
      const a = entry({ trend, markPrice: 59_100, signal: 'mean-revert', view: viewAt(0.05) });
      eq(a.kind, 'NONE', `${trend}에서 역추세가 들어갔다`);
      assert(a.reason.includes('역추세는 들어가지 않습니다'), a.reason);
    }
  });

  test('★ 박스가 ATR보다 좁으면 역추세를 하지 않는다 — 손절이 잡음 안에 들어간다', () => {
    const narrow = viewAt(0.05, { atr: 2_000 }); // 박스 2,000 < ATR×2 = 4,000
    const a = entry({ trend: 'sideways', markPrice: 59_100, signal: 'mean-revert', view: narrow });
    eq(a.kind, 'NONE');
    assert(a.reason.includes(`ATR의 ${MEAN_REVERT_MIN_BOX_ATR}배`), a.reason);
  });

  test('★★ 돌파는 직전 고점을 본다 — recentHigh를 보면 영원히 발동하지 않는다', () => {
    // recentHigh는 **현재 종가를 포함한** 최댓값이므로 price > recentHigh가
    // 될 수 없다. 돌파가 그 값을 보면 신호가 한 번도 나지 않는다.
    //
    // 실제 파이프라인이 만드는 관측값으로 확인한다 — 손으로 만든 fixture는
    // 이 버그를 비껴갈 수 있다.
    const closes = Array.from({ length: 80 }, () => 60_000);
    closes[closes.length - 1] = 61_000;           // 마지막 봉만 튀어오른다
    const r = detectRegime(closes);
    eq(r.dataOk, true);
    eq(r.view.recentHigh, 61_000, 'recentHigh는 현재 봉을 포함한다');
    eq(r.view.priorHigh, 60_000, 'priorHigh는 현재 봉을 뺀다');
    assert(r.view.price! <= r.view.recentHigh!, 'price가 recentHigh를 넘을 수는 없다');

    const a = entry({ trend: r.view.price! > 60_000 ? 'sideways' : null, markPrice: r.view.price,
      signal: 'breakout', view: r.view });
    eq(a.kind, 'OPEN', `실제 돌파가 신호를 내지 못했다: ${a.reason}`);
    eq(a.side, 'LONG');
    assert(a.reason.includes('상향 돌파'), a.reason);
  });

  test('돌파는 여유만큼 넘겨야 한다 — 전고점에 닿기만 한 것은 돌파가 아니다', () => {
    const v = viewAt(0.5, { priorHigh: 61_000, atr: 100 });
    const pad = 100 * BREAKOUT_BUFFER_ATR;
    const touch = entry({ trend: 'sideways', markPrice: 61_000 + pad / 2, signal: 'breakout', view: v });
    eq(touch.kind, 'NONE', `여유 안쪽이 돌파가 됐다: ${touch.reason}`);
    const real = entry({ trend: 'sideways', markPrice: 61_000 + pad * 2, signal: 'breakout', view: v });
    eq(real.side, 'LONG');
  });

  test('돌파는 아래로도 본다 — 직전 저점 이탈이면 숏', () => {
    const a = entry({ trend: 'sideways', markPrice: 58_000, signal: 'breakout', view: viewAt(0) });
    eq(a.side, 'SHORT');
    assert(a.reason.includes('하향 이탈'), a.reason);
  });

  console.log('[진입 전략 — 이름]');

  test('★★ 모르는 전략 이름은 기본 전략으로 떨어지지 않는다', () => {
    // 떨어뜨리면 오타 하나로 추세 추종이 돌면서 다른 전략의 성적표에 적힌다.
    const a = entry({ trend: 'uptrend', signal: 'trend-folow' as EntrySignalId });
    eq(a.kind, 'NONE');
    assert(a.reason.includes('알 수 없는'), a.reason);
    for (const raw of ['', ' ', 'trend', 'TREND-FOLLOW2', null, undefined, 7, {}]) {
      eq(parseEntrySignal(raw), null, `${JSON.stringify(raw)}가 통과했다`);
    }
    eq(parseEntrySignal(' Trend-Follow '), 'trend-follow');
  });

  test('★ 모든 전략이 재료 없이도 터지지 않고 이유를 남긴다 — 전수', () => {
    // 전략을 새로 추가하면 이 테스트가 그것까지 돌린다. 재료가 없을 때
    // 던지거나 조용히 진입하는 전략이 들어오면 여기서 멈춘다.
    assert(ENTRY_SIGNAL_IDS.length >= 3, `전략이 ${ENTRY_SIGNAL_IDS.length}개뿐이다`);
    for (const signal of ENTRY_SIGNAL_IDS) {
      for (const o of [{ trend: null, view: null, markPrice: null },
                       { trend: 'sideways' as const, view: null, markPrice: 100 },
                       { trend: 'uptrend' as const, view: viewAt(0.5), markPrice: 60_000 }]) {
        const a = entry({ ...o, signal });
        assert(a.reason.trim().length > 0, `${signal}가 이유를 남기지 않았다`);
        if (a.kind === 'OPEN') {
          assert(a.quantity! > 0 && a.stopPrice! > 0, `${signal}가 수량·손절 없이 열었다`);
        }
      }
    }
  });
}
