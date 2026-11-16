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
  derivePaperBotId,
} from './paperAutomation';
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
  test('같은 종목·전략은 항상 같은 봇 이름이 된다', () => {
    eq(derivePaperBotId('BTCUSDT', 'trend-follow'), 'btcusdt-trend-follow');
    eq(derivePaperBotId('BTCUSDT', 'trend-follow'), derivePaperBotId('btcusdt', 'trend-follow'));
    eq(derivePaperBotId('ETHUSDT', 'breakout'), 'ethusdt-breakout');
  });

  test('종목이 다르면 봇도 다르다 — BTC와 ETH가 한 장부에 섞이지 않는다', () => {
    assert(derivePaperBotId('BTCUSDT','trend-follow') !== derivePaperBotId('ETHUSDT','trend-follow'),
      '두 종목이 같은 이름을 받았습니다');
  });

  test('전략이 다르면 봇도 다르다 — 성적표가 섞이지 않는다', () => {
    const ids = ENTRY_SIGNAL_IDS.map(sig => derivePaperBotId('BTCUSDT', sig));
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
        const id = derivePaperBotId(sym, sig)!;
        assert(PAPER_BOT_ID.test(id), `${id}가 DB 모양에 안 맞습니다`);
      }
    }
  });
}
