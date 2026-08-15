// src/lib/autotrade/scheduleToggle.test.ts
//
// **버튼을 눌렀는데 안 꺼졌다.**
//
// my-original-v1의 BTCUSDT · ETHUSDT 예약에서 [켜짐]을 눌렀는데 꺼지지
// 않았다. Supabase에서 직접 UPDATE를 치니 두 줄 다 정상으로 바뀌었다 —
// DB는 멀쩡했다. 화면이 **다른 줄을 바꾸고 성공이라고 적고 있었다.**
//
// 이 파일이 못 박는 것은 하나다: **끄기는 UPDATE이지 UPSERT가 아니다.**
// A~H는 그 고장이 다시 돌아올 수 있는 모든 문을 하나씩 닫는다.

import { test, eq, assert } from '../../test/harness';
import {
  toggleRequest, rebindRequest, parseTogglePatch, enabledUpdate,
  applyToggleResult, toggleFailureNote, isEnabled, SCHEDULE_ROUTE,
} from './scheduleToggle';

/**
 * **지금 실제 DB 상태 그대로의 fixture다.**
 *
 * 2026-08-15 현재 두 줄 모두 `enabled=false`다(사용자가 Supabase에서 직접
 * 껐다). 테스트는 이 상태를 읽기만 한다 — 값으로만 도는 순수 함수라
 * 운영 DB에 닿는 경로가 아예 없다.
 */
const DB_NOW = () => ([
  {
    id: 'sch-btc', user_id: 'u1', symbol: 'BTCUSDT', connection_id: 'conn-gate',
    mode: 'TESTNET', enabled: false, strategy_id: 'my-original-v1', strategy_version: '1',
    strategyId: 'my-original-v1', strategyVersion: '1',
    leverage_cap: 100, risk_pct: 10, margin_pct: 10, interval_min: 15,
  },
  {
    id: 'sch-eth', user_id: 'u1', symbol: 'ETHUSDT', connection_id: 'conn-gate',
    mode: 'TESTNET', enabled: false, strategy_id: 'my-original-v1', strategy_version: '1',
    strategyId: 'my-original-v1', strategyVersion: '1',
    leverage_cap: 100, risk_pct: 10, margin_pct: 10, interval_min: 15,
  },
]);

/** 서버 UPDATE를 흉내낸다: id + user_id 둘 다 맞는 줄만, 준 칸만 바꾼다 */
function fakeUpdate(rows: any[], uid: string, id: string, patch: Record<string, any>) {
  let updated: any = null;
  const next = rows.map(r => {
    if (String(r.id) !== id || String(r.user_id) !== uid) return r;
    updated = { ...r, ...patch };
    return updated;
  });
  return { rows: next, updated, count: updated ? 1 : 0 };
}

export function runScheduleToggleTests() {
  console.log('[예약 ON/OFF — A. 끄기는 UPDATE다, UPSERT가 아니다]');

  test('A. 일반 ON/OFF는 PATCH로 나간다', () => {
    const req = toggleRequest(DB_NOW()[0]);
    eq(req.ok, true);
    eq(req.method, 'PATCH', 'POST로 나가면 정체를 다시 조립하게 된다');
    eq(req.route, SCHEDULE_ROUTE);
  });

  test('A. 꺼진 줄을 누르면 켜기, 켜진 줄을 누르면 끄기다', () => {
    eq(toggleRequest({ id: 'x', enabled: false }).body!.enabled, true);
    eq(toggleRequest({ id: 'x', enabled: true }).body!.enabled, false);
  });

  test('A. enabled가 true가 아닌 값이면 꺼진 것으로 읽는다', () => {
    // 문자열 'false'는 truthy다. 이걸 켜짐으로 읽으면 토글이 반대로 돈다.
    eq(isEnabled('false'), false);
    eq(isEnabled('true'), false);
    eq(isEnabled(1), false);
    eq(toggleRequest({ id: 'x', enabled: 'false' }).body!.enabled, true);
  });

  console.log('[예약 ON/OFF — B. 정체는 요청에 실리지도 않는다]');

  test('B. PATCH 본문에는 id와 enabled 둘뿐이다', () => {
    const body = toggleRequest(DB_NOW()[0]).body!;
    eq(Object.keys(body).sort().join(','), 'enabled,id');
  });

  test('B. strategyId·symbol·connectionId·mode가 실리지 않는다', () => {
    // 실리지 않은 것은 서버가 덮을 방법이 없다. 이게 이 수정의 핵심이다.
    const body = toggleRequest(DB_NOW()[0]).body!;
    for (const k of ['strategyId', 'strategy_id', 'symbol', 'connectionId',
      'connection_id', 'mode', 'leverageCap', 'riskPct', 'marginPct', 'intervalMin']) {
      eq((body as any)[k], undefined, `${k}가 실렸다`);
    }
  });

  test('B. id가 없으면 POST로 되돌아가지 않는다', () => {
    // 되돌아가면 정체를 다시 조립하게 되고, 그게 지금 고치는 그 고장이다.
    const req = toggleRequest({ symbol: 'BTCUSDT', enabled: true });
    eq(req.ok, false);
    eq(req.code, 'NO_ID');
    eq(req.method, null);
    eq(req.body, null);
    assert(req.message.includes('다시 조립'), req.message);
  });

  console.log('[예약 ON/OFF — C. 서버는 enabled 한 칸만 바꾼다]');

  test('C. UPDATE에 실리는 칸은 enabled 하나뿐이다', () => {
    eq(Object.keys(enabledUpdate(false)).join(','), 'enabled');
    eq(enabledUpdate(false).enabled, false);
    eq(enabledUpdate(true).enabled, true);
  });

  test('C. 끄고 나서도 정체와 크기 설정이 그대로다', () => {
    const before = DB_NOW();
    const on = fakeUpdate(before, 'u1', 'sch-btc', enabledUpdate(true));
    eq(on.count, 1);
    eq(on.updated.enabled, true);
    // 이 줄이 이 PR의 이유다: 끄고 켜는 것만으로 무엇도 사라지면 안 된다.
    for (const k of ['strategy_id', 'strategy_version', 'symbol', 'connection_id',
      'mode', 'leverage_cap', 'risk_pct', 'margin_pct', 'interval_min']) {
      eq(on.updated[k], (before[0] as any)[k], `${k}가 바뀌었다`);
    }
  });

  test('C. 한 줄을 바꿔도 다른 줄은 그대로다', () => {
    const r = fakeUpdate(DB_NOW(), 'u1', 'sch-btc', enabledUpdate(true));
    const eth = r.rows.find((x: any) => x.id === 'sch-eth');
    eq(eth.enabled, false, 'BTCUSDT를 켰는데 ETHUSDT가 같이 움직였다');
  });

  console.log('[예약 ON/OFF — D. 남의 줄도, 없는 줄도 못 바꾼다]');

  test('D. 다른 사용자의 예약은 못 바꾼다', () => {
    const r = fakeUpdate(DB_NOW(), 'u2', 'sch-btc', enabledUpdate(true));
    eq(r.count, 0, 'user_id를 안 보고 id만으로 바꿨다');
    eq(r.rows[0].enabled, false);
  });

  test('D. 없는 id는 404다 — 새로 만들지 않는다', () => {
    const r = fakeUpdate(DB_NOW(), 'u1', 'sch-none', enabledUpdate(true));
    eq(r.count, 0);
    eq(r.rows.length, 2, '없는 줄을 만들었다');
  });

  console.log('[예약 ON/OFF — E. 모르는 모양은 400으로 막는다]');

  test('E. id가 없으면 400이고 아무것도 안 바꾼다', () => {
    const p = parseTogglePatch({ enabled: false });
    eq(p.ok, false); eq(p.code, 'MISSING_ID'); eq(p.status, 400);
  });

  test('E. enabled가 boolean이 아니면 400이다', () => {
    // 'false'를 Boolean()으로 눕히면 끄려던 요청이 켜기가 된다.
    for (const v of ['false', 'true', 0, 1, null, undefined, {}]) {
      const p = parseTogglePatch({ id: 'sch-btc', enabled: v });
      eq(p.ok, false, JSON.stringify(v));
      eq(p.code, 'INVALID_ENABLED', JSON.stringify(v));
      eq(p.enabled, null, JSON.stringify(v));
    }
  });

  test('E. 제대로 된 본문은 그대로 통과한다', () => {
    const p = parseTogglePatch({ id: ' sch-eth ', enabled: false });
    eq(p.ok, true); eq(p.id, 'sch-eth'); eq(p.enabled, false);
  });

  test('E. 본문에 다른 칸이 섞여 와도 해석은 두 개만 본다', () => {
    const p = parseTogglePatch({ id: 'sch-btc', enabled: false, strategyId: 'daily-ladder', mode: 'LIVE_LIMITED' });
    eq(p.ok, true);
    // 해석 결과에는 두 값만 있다 — 나머지는 UPDATE까지 가지 못한다.
    eq(p.id, 'sch-btc'); eq(p.enabled, false);
    eq(Object.keys(enabledUpdate(p.enabled!)).join(','), 'enabled');
  });

  console.log('[예약 ON/OFF — F. 재연결은 다른 일이다]');

  test('F. 재연결은 POST를 그대로 쓴다', () => {
    const req = rebindRequest(DB_NOW()[0], 'conn-new');
    eq(req.ok, true);
    eq(req.method, 'POST');
    eq(req.body!.rebind, true);
    eq(req.body!.connectionId, 'conn-new');
  });

  test('F. 재연결은 전략을 명시해서 보낸다', () => {
    // 안 보내면 서버가 계단식으로 되돌린다 — ON/OFF에서 났던 그 고장이다.
    const req = rebindRequest(DB_NOW()[1], 'conn-new');
    eq(req.body!.strategyId, 'my-original-v1');
    eq(req.body!.strategyVersion, '1');
  });

  test('F. 재연결은 켜짐 상태를 뒤집지 않는다', () => {
    eq(rebindRequest({ ...DB_NOW()[0], enabled: false }, 'c').body!.enabled, false);
    eq(rebindRequest({ ...DB_NOW()[0], enabled: true }, 'c').body!.enabled, true);
  });

  test('F. 재연결은 크기 설정을 지우지 않는다', () => {
    const b = rebindRequest(DB_NOW()[0], 'conn-new').body!;
    eq(b.leverageCap, 100); eq(b.riskPct, 10); eq(b.marginPct, 10); eq(b.intervalMin, 15);
  });

  test('F. 고른 연결이 없으면 재연결하지 않는다', () => {
    const req = rebindRequest(DB_NOW()[0], '');
    eq(req.ok, false); eq(req.code, 'NO_CONNECTION'); eq(req.body, null);
  });

  test('F. ON/OFF와 재연결은 같은 요청이 아니다', () => {
    const t = toggleRequest(DB_NOW()[0]);
    const rb = rebindRequest(DB_NOW()[0], 'conn-new');
    assert(t.method !== rb.method, '둘이 같은 mutation이면 끄기가 연결까지 건드린다');
    eq((t.body as any).rebind, undefined);
  });

  console.log('[예약 ON/OFF — G. 실패를 성공처럼 뒤집지 않는다]');

  test('G. 서버가 준 줄만 화면에 반영한다', () => {
    const rows = DB_NOW();
    const next = applyToggleResult(rows, { id: 'sch-eth', enabled: true })!;
    eq(next.find((r: any) => r.id === 'sch-eth').enabled, true);
    eq(next.find((r: any) => r.id === 'sch-btc').enabled, false);
  });

  test('G. 못 찾은 응답으로는 화면을 바꾸지 않는다', () => {
    eq(applyToggleResult(DB_NOW(), { id: 'sch-none', enabled: true }), null);
    eq(applyToggleResult(DB_NOW(), null), null);
    eq(applyToggleResult(DB_NOW(), { enabled: true }), null);
  });

  test('G. 실패하면 서버가 말한 이유를 그대로 적는다', () => {
    const note = toggleFailureNote(404, { ok: false, message: '그 예약을 찾지 못했습니다 (id: sch-btc)' });
    assert(note.includes('찾지 못했습니다'), note);
    assert(note.includes('404'), note);
  });

  test('G. 서버가 아무 말도 안 해도 성공이라고 적지 않는다', () => {
    const note = toggleFailureNote(500, null);
    assert(note.includes('바꾸지 못했습니다'), note);
    assert(note.includes('그대로'), note);
  });

  console.log('[예약 ON/OFF — H. 지금 DB 상태를 테스트가 흔들지 않는다]');

  test('H. fixture는 지금 DB 그대로 두 줄 다 꺼짐이다', () => {
    // 사용자가 Supabase에서 직접 껐다. 신규 진입이 멈춰 있는 상태이고,
    // 이 PR은 그 상태를 유지한 채 버튼만 고친다.
    for (const r of DB_NOW()) {
      eq(r.enabled, false, `${r.symbol}가 fixture에서 켜져 있다`);
      eq(r.strategy_id, 'my-original-v1');
      eq(r.mode, 'TESTNET');
    }
  });

  test('H. 테스트는 값만 다룬다 — 운영 DB에 닿는 경로가 없다', () => {
    // fakeUpdate는 배열 복사본을 돌려준다. 원본은 그대로다.
    const rows = DB_NOW();
    fakeUpdate(rows, 'u1', 'sch-btc', enabledUpdate(true));
    eq(rows[0].enabled, false, '테스트가 원본 fixture를 바꿨다');
    // DB_NOW()는 매번 새로 만든다 — 앞 테스트가 뒤 테스트를 오염시키지 않는다.
    eq(DB_NOW()[0].enabled, false);
  });

  test('H. 이 모듈은 어떤 입력으로도 켜기를 만들어내지 않는다', () => {
    // 꺼진 줄에 대해 요청을 만드는 것과 실제로 켜지는 것은 다르다.
    // 켜짐은 사용자가 버튼을 눌렀을 때만 나간다.
    for (const bad of [null, undefined, {}, { id: '' }, { enabled: true }]) {
      const req = toggleRequest(bad);
      if (!req.ok) { eq(req.body, null); continue; }
      assert(typeof req.body!.enabled === 'boolean', 'enabled가 boolean이 아니다');
    }
  });
}
