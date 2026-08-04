// src/lib/engine/autotradeHealth.test.ts
//
// 이 테스트가 막는 것
// ───────────────────
// **증거 없이 '돌고 있다'고 말하는 것.**
//
// 이 프로젝트에서 가장 비싼 결함은 전부 같은 모양이었다 — 켜져 있다고
// 믿는데 실제로는 안 도는 것. 크론이 vercel.json에 없어서 한 번도 안
// 돌았고, 예약 표가 없어서 실행기가 매번 조용히 끝났고, 손절 감시
// 워크플로는 30회 연속 실패 중이었다.
//
// 설정이 다 맞아도 **실행 기록이 없으면 안 돈 것이다.** 설정과 실행은
// 다르고, 그 둘을 같은 칸에 세면 사용자는 기다리기만 한다.
//
// 반대쪽도 막는다: **'확인 못 함'을 고장으로 적지 않는 것.** 조회에
// 실패한 것을 고장으로 적으면 멀쩡한 것을 고치러 간다.

import { test, eq, assert } from '../../test/harness';
import { autotradeHealth, agoText, nextCronText } from './autotradeHealth';

const NOW = Date.UTC(2026, 7, 3, 12, 0, 0);   // 2026-08-03 12:00 UTC
const iso = (ms: number) => new Date(ms).toISOString();

const good = (over: any = {}) => ({
  nowMs: NOW,
  adminSecretSet: true,
  cronUtcHour: 23,
  schedules: [{ symbol: 'BTCUSDT', enabled: true, connection_id: 'c1', last_run_at: iso(NOW - 3600_000), last_result: '진입 안 함: 조건 불충족' }],
  runs: [{ status: 'ok', detail: '1건 확인 · 진입 0건', started_at: iso(NOW - 3600_000) }],
  ...over,
});

export function runAutotradeHealthTests() {
  console.log('[자동매매 점검 — 증거 없이 돌고 있다고 말하지 않는다]');

  // ── **이 파일의 이유** ───────────────────────────────
  test('설정이 다 맞아도 실행 기록이 없으면 안 돈 것이다', () => {
    const r = autotradeHealth(good({ runs: [] }));
    eq(r.running, false, '기록도 없는데 돌고 있다고 했다');
    assert(r.verdict.includes('돌지 않습니다'), r.verdict);
    assert(r.nextAction.length > 0, '무엇을 해야 하는지 안 적었다');
  });

  test('실행 기록이 있으면 돌고 있다고 말한다', () => {
    const r = autotradeHealth(good());
    eq(r.running, true);
    assert(r.verdict.includes('돌고 있습니다'), r.verdict);
  });

  // 조회 실패는 고장이 아니다. 고장으로 적으면 멀쩡한 것을 고치러 간다.
  test('기록을 못 읽으면 running은 null — false가 아니다', () => {
    const r = autotradeHealth(good({ runs: null, runsError: 'cron_runs 표 없음' }));
    eq(r.running, null, '확인 못 한 것을 고장으로 적었다');
    const ran = r.items.find(i => i.id === 'ran');
    eq(ran!.state, 'unknown');
    assert(ran!.action.includes('안 돌았다는 뜻은 아닙니다'), ran!.action);
  });

  // ── 막히는 경우들 ───────────────────────────────────
  test('표가 없으면 거기서 끝내고 무엇을 할지 적는다', () => {
    const r = autotradeHealth(good({ tableMissing: true }));
    eq(r.running, false);
    assert(r.nextAction.includes('마이그레이션'), r.nextAction);
    eq(r.items.length, 1, '표가 없는데 다른 항목까지 판정했다');
  });

  test('예약이 없으면 막힌 것으로 본다', () => {
    const r = autotradeHealth(good({ schedules: [], runs: [] }));
    const t = r.items.find(i => i.id === 'table');
    eq(t!.state, 'bad');
    assert(t!.action.includes('켜세요'), t!.action);
  });

  test('전부 꺼져 있으면 막힌 것으로 본다', () => {
    const r = autotradeHealth(good({ schedules: [{ symbol: 'BTCUSDT', enabled: false, connection_id: 'c1' }] }));
    eq(r.items.find(i => i.id === 'enabled')!.state, 'bad');
  });

  // 연결이 없으면 실행기가 불려도 주문을 못 낸다. 그런데 그건
  // '안 도는 것'처럼 보이지 않는다 — 매번 조용히 건너뛴다.
  test('연결이 없으면 어느 종목인지까지 적는다', () => {
    const r = autotradeHealth(good({
      schedules: [{ symbol: 'ETHUSDT', enabled: true, connection_id: null }],
    }));
    const c = r.items.find(i => i.id === 'conn');
    eq(c!.state, 'bad');
    assert(c!.detail.includes('ETHUSDT'), c!.detail);
  });

  test('ADMIN_SECRET이 없으면 막힌 것으로 본다', () => {
    const r = autotradeHealth(good({ adminSecretSet: false }));
    const s = r.items.find(i => i.id === 'secret');
    eq(s!.state, 'bad');
    assert(s!.action.includes('Vercel'), s!.action);
  });

  // 값을 받지 않는다는 것이 설계다. undefined는 '확인 못 함'이지 '없음'이 아니다.
  test('열쇠 여부를 모르면 unknown — 없다고 단정하지 않는다', () => {
    const r = autotradeHealth(good({ adminSecretSet: undefined }));
    eq(r.items.find(i => i.id === 'secret')!.state, 'unknown');
  });

  test('마지막 실행이 실패면 그렇게 말한다', () => {
    const r = autotradeHealth(good({
      runs: [{ status: 'failed', detail: '연결 없음', started_at: iso(NOW - 600_000) }],
    }));
    eq(r.running, false);
    assert(r.verdict.includes('실패'), r.verdict);
  });

  // 하루 1회 크론인데 이틀 넘게 기록이 없으면 멈춘 것이다.
  test('이틀 넘게 안 돌았으면 멈춘 것으로 본다', () => {
    const r = autotradeHealth(good({
      runs: [{ status: 'ok', detail: 'ok', started_at: iso(NOW - 3 * 24 * 3600_000) }],
    }));
    eq(r.running, false);
    const ran = r.items.find(i => i.id === 'ran');
    assert(ran!.detail.includes('3일 전'), ran!.detail);
  });

  test('어제 돈 것은 정상이다 — 하루 1회 크론이다', () => {
    const r = autotradeHealth(good({
      runs: [{ status: 'ok', detail: 'ok', started_at: iso(NOW - 20 * 3600_000) }],
    }));
    eq(r.running, true);
  });

  // ── 마지막 판단 ─────────────────────────────────────
  //
  // '돌았다'와 '진입했다'는 다르다. 대부분의 날은 진입하지 않고 그건
  // 정상이다. 그 사실이 보여야 사용자가 기다릴 수 있다.
  test('마지막에 무엇을 했는지 적는다', () => {
    const r = autotradeHealth(good());
    const res = r.items.find(i => i.id === 'result');
    assert(res != null, '마지막 판단이 없다');
    assert(res!.detail.includes('진입 안 함'), res!.detail);
  });

  // ── 시간 문구 ───────────────────────────────────────
  test('경과 시간을 사람 말로', () => {
    eq(agoText(NOW - 30_000, NOW), '방금');
    eq(agoText(NOW - 5 * 60_000, NOW), '5분 전');
    eq(agoText(NOW - 3 * 3600_000, NOW), '3시간 전');
    eq(agoText(NOW - 3 * 24 * 3600_000, NOW), '3일 전');
  });

  // 시계가 어긋나면 그 사실이 숨으면 안 된다 — 미래 시각은 이상 신호다.
  test('미래 시각은 미래라고 적는다', () => {
    assert(agoText(NOW + 600_000, NOW).includes('미래'), agoText(NOW + 600_000, NOW));
  });

  test('다음 크론 시각을 한국 시간으로 알려준다', () => {
    const t = nextCronText(23, NOW);
    assert(t.includes('한국 08:00'), t);
    assert(t.includes('11시간'), t);
  });

  test('크론 시각을 모르면 모른다고 한다', () => {
    assert(nextCronText(null, NOW).includes('알 수 없습니다'), nextCronText(null, NOW));
    assert(nextCronText(99, NOW).includes('알 수 없습니다'), nextCronText(99, NOW));
  });

  // ── 막힌 것이 여럿이면 가장 먼저 할 일 하나 ─────────
  test('막힌 것이 여럿이어도 다음 할 일은 하나다', () => {
    const r = autotradeHealth(good({ schedules: [], runs: [], adminSecretSet: false }));
    assert(r.nextAction.length > 0, '다음 할 일이 없다');
    // 여러 줄을 한꺼번에 던지면 사람은 아무것도 안 한다.
    assert(!r.nextAction.includes('\n'), '한 번에 여러 개를 시켰다');
  });

  // ══ 실전 예약 — 설정이 전부 초록인데 한 건도 안 나가던 것들 ══
  //
  // 아래 셋은 전부 같은 모양이다. 화면은 "켜짐"이고 점검은 전부 ✅인데,
  // 진입 엔진이 매일 403/409/-2015로 끝난다. 그 사실이 화면 어디에도
  // 없으면 사용자는 내일 아침에야 안 됐다는 것을 안다.
  const liveGood = (over: any = {}) => good({
    schedules: [{ symbol: 'BTCUSDT', enabled: true, connection_id: 'c1', mode: 'LIVE_LIMITED',
                  last_run_at: iso(NOW - 3600_000), last_result: '진입 안 함' }],
    connections: [{ id: 'c1', is_testnet: false }],
    liveUnlocked: true, cronSecretSet: true, marginColumnPresent: true,
    ...over,
  });

  const find = (r: any, id: string) => r.items.find((i: any) => i.id === id);

  test('실전 예약이 다 맞으면 새 항목들이 전부 통과한다', () => {
    const r = autotradeHealth(liveGood());
    for (const id of ['livelock', 'automode', 'dest', 'margincol', 'cronsecret']) {
      eq(find(r, id)?.state, 'ok', `${id}가 통과가 아니다: ${JSON.stringify(find(r, id))}`);
    }
    eq(r.running, true);
  });

  // ① ALLOW_LIVE_TRADING — 진입 엔진이 403으로 끝난다
  test('실거래가 잠겨 있으면 막힌 것으로 적는다', () => {
    const r = autotradeHealth(liveGood({ liveUnlocked: false }));
    eq(find(r, 'livelock').state, 'bad');
    assert(find(r, 'livelock').action.includes('ALLOW_LIVE_TRADING'),
      '무엇을 넣어야 하는지 안 적었다');
    assert(r.verdict.includes('돌지 않습니다'), r.verdict);
  });

  test('실거래 잠금을 확인 못 했으면 통과로도 고장으로도 적지 않는다', () => {
    eq(find(autotradeHealth(liveGood({ liveUnlocked: undefined })), 'livelock').state, 'unknown');
  });

  // 테스트넷 예약에는 이 항목이 아예 없어야 한다 — 상관없는 빨간 줄을
  // 띄우면 사용자가 점검 목록을 안 믿게 된다.
  test('테스트넷 예약에는 실전 항목이 안 뜬다', () => {
    const r = autotradeHealth(good({
      schedules: [{ symbol: 'BTCUSDT', enabled: true, connection_id: 'c1', mode: 'TESTNET' }],
      liveUnlocked: false,
    }));
    eq(find(r, 'livelock'), undefined, '테스트넷인데 실거래 잠금을 따졌다');
    eq(find(r, 'automode'), undefined);
  });

  // ② LIVE_SMALL — 크론에게는 확인해 줄 사람이 없다
  test('LIVE_SMALL 예약은 크론으로 못 돈다고 말한다', () => {
    const r = autotradeHealth(liveGood({
      schedules: [{ symbol: 'BTCUSDT', enabled: true, connection_id: 'c1', mode: 'LIVE_SMALL',
                    last_run_at: iso(NOW - 3600_000) }],
    }));
    eq(find(r, 'automode').state, 'bad');
    assert(find(r, 'automode').detail.includes('사람 확인'), find(r, 'automode').detail);
  });

  // ③ 모드와 연결의 목적지 — -2015의 뿌리
  test('실전 모드에 테스트넷 연결이면 막힌 것으로 적는다', () => {
    const r = autotradeHealth(liveGood({ connections: [{ id: 'c1', is_testnet: true }] }));
    eq(find(r, 'dest').state, 'bad');
    assert(find(r, 'dest').detail.includes('BTCUSDT'), '어느 예약인지 안 적었다');
  });

  test('연결 정보를 못 읽었으면 목적지를 판정하지 않는다', () => {
    eq(find(autotradeHealth(liveGood({ connections: [] })), 'dest').state, 'unknown');
  });

  // ④ 마이그레이션 036 — 배율이 조용히 낮아지던 것
  test('margin_pct 칸이 없으면 그 사실과 마이그레이션 번호를 적는다', () => {
    const r = autotradeHealth(liveGood({ marginColumnPresent: false }));
    eq(find(r, 'margincol').state, 'bad');
    assert(find(r, 'margincol').action.includes('036'), find(r, 'margincol').action);
  });

  test('칸이 있는지 확인 못 했으면 아예 안 적는다 — 있다고도 없다고도 안 한다', () => {
    eq(find(autotradeHealth(liveGood({ marginColumnPresent: null })), 'margincol'), undefined);
  });

  // ⑤ CRON_SECRET — 없으면 Vercel 크론이 매일 401
  test('CRON_SECRET이 없으면 막힌 것으로 적는다', () => {
    const r = autotradeHealth(good({ cronSecretSet: false }));
    eq(find(r, 'cronsecret').state, 'bad');
    assert(find(r, 'cronsecret').action.includes('CRON_SECRET'), find(r, 'cronsecret').action);
  });

  test('CRON_SECRET을 안 물어봤으면 줄을 만들지 않는다', () => {
    eq(find(autotradeHealth(good()), 'cronsecret'), undefined);
  });

  // 여러 개가 동시에 막혀도 할 일은 하나다.
  test('실전 항목이 여럿 막혀도 다음 할 일은 하나다', () => {
    const r = autotradeHealth(liveGood({
      liveUnlocked: false, marginColumnPresent: false,
      connections: [{ id: 'c1', is_testnet: true }],
    }));
    assert(r.nextAction.length > 0);
    assert(!r.nextAction.includes('\n'), '한 번에 여러 개를 시켰다');
    eq(r.running, true, '실행 기록은 있는데 안 돌았다고 했다');
    assert(r.verdict.includes('돌지 않습니다'), '막힌 게 있는데 정상이라고 했다: ' + r.verdict);
  });

  // ══ 여는 크론과 닫는 크론은 다르다 ══
  //
  // 지금까지 진입만 보고 있었다. 청산 감시(exit-monitor)가 멈춰 있으면
  // 트레일링 손절도 시간 청산도 안 된다 — 진입이 안 되는 것보다 나쁘다.
  test('열린 거래가 있는데 청산 감시가 안 돌았으면 막힌 것으로 적는다', () => {
    const r = autotradeHealth(good({ openTradeCount: 2, exitRuns: [] }));
    eq(find(r, 'exitmon').state, 'bad');
    assert(find(r, 'exitmon').detail.includes('2건'), find(r, 'exitmon').detail);
  });

  test('청산 감시가 최근에 돌았으면 통과다', () => {
    const r = autotradeHealth(good({
      openTradeCount: 1,
      exitRuns: [{ status: 'ok', detail: '1건 점검', started_at: iso(NOW - 3600_000) }],
    }));
    eq(find(r, 'exitmon').state, 'ok');
  });

  test('청산 감시가 실패했으면 이유를 적는다', () => {
    const r = autotradeHealth(good({
      openTradeCount: 1,
      exitRuns: [{ status: 'failed', detail: '401', started_at: iso(NOW - 3600_000) }],
    }));
    eq(find(r, 'exitmon').state, 'bad');
    assert(find(r, 'exitmon').detail.includes('401'), find(r, 'exitmon').detail);
  });

  test('이틀 넘게 안 돌았으면 방치로 적는다', () => {
    const r = autotradeHealth(good({
      openTradeCount: 3,
      exitRuns: [{ status: 'ok', detail: 'ok', started_at: iso(NOW - 5 * 86400_000) }],
    }));
    eq(find(r, 'exitmon').state, 'bad');
    assert(find(r, 'exitmon').detail.includes('방치'), find(r, 'exitmon').detail);
  });

  // 포지션이 없는데 빨간 줄을 띄우면 목록을 안 믿게 된다.
  test('열린 거래가 없으면 청산 감시를 따지지 않는다', () => {
    eq(find(autotradeHealth(good({ openTradeCount: 0, exitRuns: [] })), 'exitmon'), undefined);
  });

  // **0건과 '못 읽음'은 다르다.**
  test('열린 거래 수를 못 읽었으면 판정하지 않는다', () => {
    eq(find(autotradeHealth(good({ openTradeCount: null, exitRuns: [] })), 'exitmon'), undefined);
  });

  test('열린 거래는 있는데 감시 기록을 못 읽었으면 확인 못 함이다', () => {
    eq(find(autotradeHealth(good({ openTradeCount: 2, exitRuns: null })), 'exitmon').state, 'unknown');
  });

  // 미리보기에서 막힌 것과 스위치가 꺼진 것은 다른 문제다.
  // 둘 다 "잠겨 있습니다"로 적으면 이미 켠 스위치를 또 켜러 간다.
  // 미리보기에서 막힌 것은 **고장이 아니다.** ❌로 두면 사용자가 고치러
  // 가고, 고치면 방금 닫은 구멍이 다시 열린다. 실제로 그렇게 안내했었다.
  test('미리보기라 막힌 것은 고장이 아니다 — 고치라고 하지 않는다', () => {
    const r = autotradeHealth(liveGood({
      liveUnlocked: false,
      liveGate: { env: 'preview', reason: '미리보기(Preview) 배포라 실주문을 내지 않습니다 — 이건 정상입니다.' },
    }));
    const it = find(r, 'livelock');
    eq(it.state, 'unknown', '정상 동작을 고장으로 적었다');
    assert(it.detail.includes('Preview'), it.detail);
    assert(!/넣고 재배포/.test(it.action), '되돌리라고 시킨다: ' + it.action);
    assert(it.action.includes('Production'), '어디서 확인할지 안 적었다: ' + it.action);
  });

  test('Production에서 잠겨 있으면 그때는 고장이고, 넣으라고 한다', () => {
    const it = find(autotradeHealth(liveGood({
      liveUnlocked: false, liveGate: { env: 'production' },
    })), 'livelock');
    eq(it.state, 'bad');
    assert(it.action.includes('ALLOW_LIVE_TRADING'), it.action);
  });

  test('미리보기 예외로 열린 것은 초록이 아니다', () => {
    const it = find(autotradeHealth(liveGood({
      liveUnlocked: true, liveGate: { env: 'preview', previewOverride: true },
    })), 'livelock');
    eq(it.state, 'unknown', '예외 상태를 정상으로 적었다');
    assert(it.action.includes('끄세요'), it.action);
  });

  test('Production에서 열린 것은 환경까지 적는다', () => {
    const it = find(autotradeHealth(liveGood({
      liveUnlocked: true, liveGate: { env: 'production' },
    })), 'livelock');
    eq(it.state, 'ok');
    assert(it.detail.includes('production'), it.detail);
  });
}
