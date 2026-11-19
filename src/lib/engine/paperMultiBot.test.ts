// 봇 이름 판정이 DB와 갈리지 않는가.
//
// 102번이 `paper_automation_settings_bot_id_shape`로 같은 모양을 막는다.
// 두 곳이 갈리면 사용자는 400 대신 409를 받거나, 더 나쁘게는 앱이 통과시킨
// 이름을 DB가 거부해 봇이 조용히 안 켜진다.
//
// **그 대조는 여기서 못 한다** — 이 러너는 임시 디렉터리에서 돌아
// `supabase/migrations`를 읽을 수 없다(paperChallenge.test.ts가 같은 이유를
// 적어 뒀다). 그래서 `scripts/check-paper-multi-bot.mjs`가 저장소 루트에서
// 두 규칙이 같은지 센다.
//
// 그리고 **안 적으면 옛 봇**이어야 한다. 이 기본값이 틀리면 예전 화면이
// 보내던 요청이 새 봇을 만들고, 지금 돌던 봇은 멈춘 것처럼 보인다.
import { test, assert, eq } from '../../test/harness';
import {
  parsePaperAutomationControl, readBotSignal, PAPER_BOT_ID, DEFAULT_PAPER_BOT,
  derivePaperBotId, readBotTimeframe,
  readBotLeverage, parseBotLeverage, BOT_LEVERAGE_MIN, BOT_LEVERAGE_MAX, BOT_LEVERAGE_CHOICES } from './paperAutomation';
import { BAR_INTERVALS, BAR_INTERVAL_LABEL, BAR_INTERVAL_MS, DEFAULT_BAR_INTERVAL,
  parseBarInterval } from '../risk/bars';
import { ENTRY_SIGNAL_IDS, DEFAULT_ENTRY_SIGNAL } from './entrySignals';

const start = (o: any = {}) => parsePaperAutomationControl({ action:'start', symbol:'BTCUSDT', interval:60, ...o });

export function runPaperMultiBotTests() {
  test('★★ 봇을 안 적으면 옛 봇이다 — 돌던 봇이 멈추지 않는다', () => {
    eq(start().botId, DEFAULT_PAPER_BOT);
    eq(start({ botId: undefined }).botId, DEFAULT_PAPER_BOT);
    eq(start({ botId: '' }).botId, DEFAULT_PAPER_BOT);
    eq(parsePaperAutomationControl({ action:'stop' })!.botId, DEFAULT_PAPER_BOT);
  });


  test('쓸 수 있는 이름', () => {
    for (const id of ['trend-ema','mean-revert','grid-box','smc-orderblock','fear-dca','a1', DEFAULT_PAPER_BOT]) {
      assert(start({ botId: id })?.botId === id, `거부됐다: ${id}`);
    }
  });

  test('★ 못 쓰는 이름은 null — 조용히 기본값으로 바꾸지 않는다', () => {
    // 오타를 기본값으로 바꾸면 사용자는 A봇을 켠 줄 알고 B봇이 돈다.
    for (const id of ['A','Trend','트렌드','trend_ema','-lead','x','a'.repeat(64),'a b','a/b',"a';DROP"]) {
      eq(start({ botId: id }), null, `통과됐다: ${id}`);
    }
  });

  test('★ 봇 이름이 멀쩡해도 나머지 검사는 그대로다', () => {
    eq(start({ botId:'trend-ema', symbol:'DOGEUSDT' }), null);
    eq(start({ botId:'trend-ema', interval:7 }), null);
    eq(parsePaperAutomationControl({ action:'nope', botId:'trend-ema' }), null);
  });

  test('stop 도 봇을 가린다 — 한 봇만 끈다', () => {
    const v = parsePaperAutomationControl({ action:'stop', botId:'grid-box' });
    eq(v!.enabled, false);
    eq(v!.botId, 'grid-box');
  });

  console.log('[봇별 전략 — config.signal]');

  // 봇마다 **다른 진입 전략**으로 돌 수 있어야 비교가 성립한다. 전략을
  // 새 컬럼이 아니라 099부터 있던 `config`에 넣는다 — 컬럼·CHECK·RPC
  // 시그니처를 새로 만들면 서로 어긋날 자리가 세 개 생긴다.

  test('★★ 요청에 전략을 안 적으면 null이다 — "추세 추종"이 아니다', () => {
    // 이 구분이 없으면 고장이 난다: `paper_auto_control`의 ON CONFLICT가
    // `config=p_config`로 config를 **통째로 교체**하므로, 여기서 기본값을
    // 채우면 전략을 안 보내는 옛 화면이 봇을 다시 켤 때마다 그 봇이 조용히
    // 추세 추종으로 바뀐다. 이름은 그대로인 채 한 strategy_id 아래 두 전략의
    // 기록이 섞이고, 이 기능이 존재하는 이유인 비교가 그때 망가진다.
    //
    // 그래서 "안 적었다"를 그대로 올려 보내고, 저장하는 쪽이 이미 저장된
    // 전략을 지킨다.
    eq(start().signal, null);
    eq(start({ signal: undefined }).signal, null);
    eq(start({ signal: '' }).signal, null);
    eq(start({ signal: '   ' }).signal, null);
  });

  test('★★ 저장된 config에 전략이 없으면 지금까지 돌던 전략이다', () => {
    // 저장된 쪽은 다르다 — 읽을 때는 기본값이 맞다. 099 시절 config에는
    // signal이 아예 없고, 그 봇은 추세 추종으로 돌고 있었다.
    for (const cfg of [undefined, null, {}, { signal: null }, { signal: '' }, { signal: '  ' },
                       [1, 2], 'nope', 7]) {
      const r = readBotSignal(cfg as unknown);
      eq(r.signal, DEFAULT_ENTRY_SIGNAL, `${JSON.stringify(cfg)}에서 기본값이 아니다`);
      eq(r.bad, null, `${JSON.stringify(cfg)}가 경고를 냈다`);
    }
  });

  test('아는 전략은 그대로 쓴다 — 전수', () => {
    for (const id of ENTRY_SIGNAL_IDS) {
      eq(start({ signal: id }).signal, id);
      eq(readBotSignal({ signal: id }).signal, id);
      eq(readBotSignal({ signal: ` ${String(id).toUpperCase()} ` }).signal, id, '대소문자·공백을 봐야 한다');
    }
  });

  test('★★ 모르는 전략 이름은 400으로 거절한다 — 조용히 기본값으로 켜 주지 않는다', () => {
    // 켜 주면 사용자는 역추세 봇을 켰다고 생각하는데 추세 추종이 돈다.
    for (const bad of ['trend', 'trend-folow', 'MEAN', 'breakout2', '돌파', 'null', 0, {}, []]) {
      eq(start({ signal: bad }), null, `통과됐다: ${JSON.stringify(bad)}`);
    }
  });

  test('★★ 저장된 config에 모르는 전략이 있으면 그 사실을 들고 온다 — 기본값으로 덮지 않는다', () => {
    // 읽는 쪽은 던질 수 없다(러너가 멈춘다). 대신 bad를 채워 보내고,
    // evaluatePaperAutomation이 그 회차를 SIGNAL_UNKNOWN으로 끝낸다 —
    // 기본 전략으로 돌려서 그 체결이 이 봇의 기록이 되는 것이 최악이다.
    const r = readBotSignal({ signal: 'trend-folow' });
    assert(r.bad != null, '모르는 값인데 경고가 없다');
    assert(r.bad!.includes('trend-folow'), `무엇이 틀렸는지 적어야 한다: ${r.bad}`);
    for (const id of ENTRY_SIGNAL_IDS) {
      assert(r.bad!.includes(id), `가능한 값 ${id}를 적어야 한다`);
    }
    // 그래도 signal 자체는 기본값이다 — 호출자가 bad를 먼저 보게 되어 있다.
    eq(r.signal, DEFAULT_ENTRY_SIGNAL);
  });

  test('stop 은 전략과 무관하다 — 끄는 데 전략 이름이 필요하지 않다', () => {
    const v = parsePaperAutomationControl({ action: 'stop', botId: 'grid-box' });
    eq(v!.signal, null);
    eq(v!.enabled, false);
  });

  test('★ 봇 이름과 전략은 따로다 — 이름에서 전략을 유추하지 않는다', () => {
    // 'breakout-1'이라는 이름의 봇이 추세 추종으로 돌 수도 있다. 이름 규칙으로
    // 전략을 정하면 이름을 바꾸는 순간 전략이 바뀐다.
    eq(start({ botId: 'breakout-1' }).signal, null);
    eq(start({ botId: 'breakout-1', signal: 'mean-revert' }).signal, 'mean-revert');
  });

  // ── 봇 이름을 종목·전략에서 만든다 ──
  //
  // 같은 조합으로 다시 켜면 **같은 이름**이어야 한다. 켤 때마다 이름이
  // 달라지면 같은 전략의 기록이 여러 `strategy_id`로 쪼개지고, 봇을 나눈
  // 이유인 비교가 사라진다.
  // 이름 모양이 바뀌었다: `<종목>-<주기>-<전략>`.
  //
  // 주기가 빠진 이름은 1분봉 돌파와 일봉 돌파를 **같은 봇**으로 만든다. 그
  // 둘은 다른 기계이고, 한 `strategy_id`에 기록이 섞이면 비교가 망가진다.
  // 이미 옛 이름으로 만들어진 봇은 그대로 돌고 목록에서 끄고 켤 수 있다 —
  // 바뀌는 것은 **새로 만드는 이름**뿐이다.
  test('같은 종목·주기·전략은 항상 같은 봇 이름이 된다', () => {
    eq(derivePaperBotId('BTCUSDT', 'trend-follow', '1d'), 'btcusdt-1d-trend-follow');
    eq(derivePaperBotId('BTCUSDT', 'trend-follow', '1d'),
       derivePaperBotId('btcusdt', 'trend-follow', '1d'));
    eq(derivePaperBotId('ETHUSDT', 'breakout', '5m'), 'ethusdt-5m-breakout');
  });

  test('종목이 다르면 봇도 다르다 — BTC와 ETH가 한 장부에 섞이지 않는다', () => {
    assert(derivePaperBotId('BTCUSDT','trend-follow','1d') !== derivePaperBotId('ETHUSDT','trend-follow','1d'),
      '두 종목이 같은 이름을 받았습니다');
  });

  test('전략이 다르면 봇도 다르다 — 성적표가 섞이지 않는다', () => {
    const ids = ENTRY_SIGNAL_IDS.map(sig => derivePaperBotId('BTCUSDT', sig, '1d'));
    eq(new Set(ids).size, ENTRY_SIGNAL_IDS.length);
  });

  // **못 만들면 null이다.** 억지로 자르거나 이름을 지어내지 않는다 —
  // DB 제약과 갈리면 앱이 통과시킨 이름을 DB가 거부해 봇이 조용히 안 켜진다.
  test('모양을 못 맞추면 이름을 지어내지 않는다', () => {
    eq(derivePaperBotId('', 'trend-follow'), null);
    eq(derivePaperBotId('   ', 'trend-follow'), null);
    eq(derivePaperBotId(null, 'trend-follow'), null);
    eq(derivePaperBotId('!!!', 'trend-follow'), null);
    eq(derivePaperBotId('A'.repeat(70), 'trend-follow'), null);
  });

  test('만들어진 이름은 DB가 받는 모양이다', () => {
    for (const sig of ENTRY_SIGNAL_IDS) {
      for (const sym of ['BTCUSDT','ETHUSDT','SOLUSDT']) {
        const id = derivePaperBotId(sym, sig, '1d')!;
        assert(PAPER_BOT_ID.test(id), `${id}가 DB 모양에 안 맞습니다`);
      }
    }
  });

  // ── 봉 주기 ──
  //
  // 전략 일곱 개가 **일봉 하나에 묶여** 있었다 — 받아오는 주소에
  // `interval=1d`가 글자로 박혀 있었다. 주기를 고를 수 있게 하면 새 알고리즘
  // 없이도 전략 수가 주기만큼 곱해진다.
  test('주기 표가 빠짐없이 채워져 있다', () => {
    for (const tf of BAR_INTERVALS) {
      assert(BAR_INTERVAL_MS[tf] > 0, `${tf}에 길이가 없습니다`);
      assert(!!BAR_INTERVAL_LABEL[tf], `${tf}에 이름표가 없습니다`);
    }
    eq(new Set(Object.values(BAR_INTERVAL_LABEL)).size, BAR_INTERVALS.length);
    // 길이가 단조 증가해야 '1분봉 < 일봉'이라는 뜻이 유지된다.
    const ms = BAR_INTERVALS.map(tf => BAR_INTERVAL_MS[tf]);
    eq(ms.slice().sort((a, b) => a - b).join(','), ms.join(','));
  });

  test('기본 주기는 지금까지 돌던 일봉이다', () => {
    eq(DEFAULT_BAR_INTERVAL, '1d');
    eq(readBotTimeframe(null).timeframe, '1d');
    eq(readBotTimeframe({}).timeframe, '1d');
    eq(readBotTimeframe({ timeframe: '   ' }).timeframe, '1d');
    eq(readBotTimeframe(null).bad, null);
  });

  // ★ 모르는 주기를 조용히 일봉으로 돌리면, 사용자는 1분봉 봇을 켰다고
  //   생각하는데 일봉이 돌면서 그 봇의 성적표에 적힌다.
  test('★ 적혀 있는데 모르는 주기면 사유를 남긴다 — 조용히 일봉으로 돌리지 않는다', () => {
    const r = readBotTimeframe({ timeframe: '7m' });
    assert(!!r.bad, '모르는 주기가 통과했습니다');
    assert(/알 수 없는 봉 주기/.test(r.bad!), r.bad!);
  });

  test('아는 주기만 통과시킨다', () => {
    for (const tf of BAR_INTERVALS) eq(parseBarInterval(tf), tf);
    eq(parseBarInterval('1D'), '1d');
    for (const bad of ['7m', '1y', '', null, undefined, {}, [], 0, '1 d']) {
      eq(parseBarInterval(bad), null, `${JSON.stringify(bad)}가 통과했습니다`);
    }
  });

  // ★ 주기가 이름에 들어가야 1분봉 돌파와 일봉 돌파의 기록이 안 섞인다.
  test('★ 같은 전략·종목이라도 주기가 다르면 다른 봇이다', () => {
    eq(derivePaperBotId('BTCUSDT', 'breakout', '1m'), 'btcusdt-1m-breakout');
    eq(derivePaperBotId('BTCUSDT', 'breakout', '1d'), 'btcusdt-1d-breakout');
    assert(derivePaperBotId('BTCUSDT','breakout','1m') !== derivePaperBotId('BTCUSDT','breakout','1d'),
      '두 주기가 같은 이름을 받았습니다');
    for (const tf of BAR_INTERVALS) {
      const id = derivePaperBotId('ETHUSDT', 'order-block', tf)!;
      assert(PAPER_BOT_ID.test(id), `${id}가 DB 모양에 안 맞습니다`);
    }
  });

  test('주기를 안 주면 일봉 이름이 나온다 — 전과 같은 기본값', () => {
    eq(derivePaperBotId('BTCUSDT', 'trend-follow'), 'btcusdt-1d-trend-follow');
    eq(derivePaperBotId('BTCUSDT', 'trend-follow', '7m' as any), null);
  });

  test('요청에 주기를 안 적으면 null이다 — 저장된 값을 지키게', () => {
    eq(start().timeframe, null);
    eq(start({ timeframe: '' }).timeframe, null);
    eq(start({ timeframe: '5m' }).timeframe, '5m');
  });

  test('모르는 주기를 보내면 요청 자체를 거절한다', () => {
    eq(start({ timeframe: '7m' }), null);
    eq(start({ timeframe: 123 }), null);
  });

  // #658에서 화면 드롭다운에 SOLUSDT를 넣었는데 이 목록에 없어서 400이 났다 —
  // 고를 수 있는데 눌리지 않는 자리였다.
  test('화면이 고를 수 있는 종목은 요청도 받는다', () => {
    for (const sym of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']) {
      assert(start({ symbol: sym }) !== null, `${sym}가 거절됐습니다`);
    }
    eq(start({ symbol: 'DOGEUSDT' }), null);
  });

  // ── 봇마다 배율 ──
  //
  // 이 시험이 막는 것: **사용자가 20배 봇을 켰는데 5배가 도는 것.**
  // 배율은 계정 설정 하나였고, 모든 봇이 그 한 값을 같이 썼다.

  test('배율을 안 적었으면 받은 기본값이다 — 0으로 떨어지지 않는다', () => {
    eq(readBotLeverage({ signal: 'trend' }, 5).leverage, 5);
    eq(readBotLeverage({ signal: 'trend' }, 5).bad, null);
    eq(readBotLeverage(null, 7).leverage, 7);
  });

  test('★ 적힌 배율을 그대로 쓴다', () => {
    const r = readBotLeverage({ leverage: 20 }, 5);
    eq(r.leverage, 20);
    eq(r.bad, null);
  });

  test('★★ 범위를 벗어나면 조용히 깎지 않는다 — bad를 적고 기본값을 지킨다', () => {
    for (const bad of [0, -1, 126, 1000, 2.5, 'x', true, {}]) {
      const r = readBotLeverage({ leverage: bad as any }, 5);
      eq(r.leverage, 5, `${String(bad)}를 썼다`);
      assert(r.bad != null, `${String(bad)}를 통과시켰다`);
      assert(!r.bad!.includes('undefined'));
    }
  });

  test('경계값은 받는다', () => {
    eq(readBotLeverage({ leverage: BOT_LEVERAGE_MIN }, 5).leverage, BOT_LEVERAGE_MIN);
    eq(readBotLeverage({ leverage: BOT_LEVERAGE_MAX }, 5).leverage, BOT_LEVERAGE_MAX);
    eq(parseBotLeverage(BOT_LEVERAGE_MIN - 1), null);
    eq(parseBotLeverage(BOT_LEVERAGE_MAX + 1), null);
  });

  test('화면이 고르는 단계는 전부 받아들여진다 — 고를 수 있는데 거절되는 자리를 만들지 않는다', () => {
    for (const x of BOT_LEVERAGE_CHOICES) eq(parseBotLeverage(x), x);
  });

  test('★ 모르는 배율을 보내면 400이다 — 조용히 기본값으로 켜지 않는다', () => {
    const base = { action: 'start', botId: 'paper-auto-v1', symbol: 'BTCUSDT', interval: 60 };
    eq(parsePaperAutomationControl({ ...base, leverage: 999 }), null);
    eq(parsePaperAutomationControl({ ...base, leverage: 'x' }), null);
  });

  test('★ 배율을 안 보내면 null이다 — 저장된 값을 지키라는 뜻', () => {
    const got = parsePaperAutomationControl({ action: 'start', botId: 'paper-auto-v1', symbol: 'BTCUSDT', interval: 60 });
    assert(got != null);
    eq(got!.leverage, null);
  });

  test('받아들인 배율은 그대로 실려 간다', () => {
    const got = parsePaperAutomationControl({ action: 'start', botId: 'paper-auto-v1', symbol: 'BTCUSDT', interval: 60, leverage: 20 });
    eq(got!.leverage, 20);
  });

}
