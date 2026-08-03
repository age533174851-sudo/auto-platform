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
}
