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
  parsePaperAutomationControl, PAPER_BOT_ID, DEFAULT_PAPER_BOT,
} from './paperAutomation';

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

}
