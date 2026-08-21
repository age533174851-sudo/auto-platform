// src/lib/ops/recoveryCenter.test.ts
//
// 복구 화면은 대개 "고칠 것 목록 + 고치기 버튼"으로 만들어진다.
// 그러면 사람이 매번 목록을 읽고 버튼을 누르게 되고, 그건 자동화가
// 아니라 **숙제를 예쁘게 만든 것**이다.
//
// 이 시험은 두 가지를 지킨다: 자동으로 된 것을 사람에게 넘기지 않을 것,
// 그리고 **자동으로 하면 안 되는 것을 자동 목록에 넣지 않을 것.**

import { test, eq, assert } from '../../test/harness';
import { recoveryView, NEVER_AUTO } from './recoveryCenter';

export function runRecoveryCenterTests() {
  console.log('[복구 센터 — 버튼을 매번 누르는 곳이 아니다]');

  test('전부 정상이면 사람이 할 일이 없다', () => {
    const v = recoveryView({
      migration: { code: 'UP_TO_DATE', detail: '전부 적용됨', blockedReason: null, entryAllowed: true },
      worker: { code: 'HEALTHY', summary: '돌고 있습니다', canRun: true },
      exitMonitor: { code: 'OK', reason: '1분 전에 돌았습니다', blockEntry: false },
    });
    eq(v.decisions.length, 0);
    eq(v.canTrade, true);
    assert(/하실 일은 없습니다/.test(v.summary), v.summary);
  });

  test('시스템이 고친 것은 사람 목록에 넣지 않는다', () => {
    const v = recoveryView({
      heals: [{ trigger: 'STALE_HEARTBEAT', action: 'RESTART_WORKER', outcome: 'HEALED',
        verified: true, detail: '정상으로 돌아왔습니다' }],
    });
    eq(v.handled.length, 1);
    eq(v.decisions.length, 0);
    eq(v.handled[0].kind, 'AUTO_DONE');
  });

  test('**복구했다고 적혔지만 확인이 안 된 것은 처리된 것이 아니다**', () => {
    const v = recoveryView({
      heals: [{ trigger: 'STALE_HEARTBEAT', action: 'RESTART_WORKER', outcome: 'HEALED',
        verified: null, detail: '확인하지 못했습니다' }],
    });
    eq(v.decisions.length, 1);
  });

  test('**워커 상태를 모르는 것을 처리됨으로 세지 않는다**', () => {
    const v = recoveryView({ worker: { code: 'UNKNOWN', summary: '읽지 못했습니다', canRun: false } });
    eq(v.decisions.length, 1);
    assert(/정상이라는 뜻이 아닙니다/.test(String(v.decisions[0].needed)), String(v.decisions[0].needed));
  });

  test('값을 바꿔야 하는 고장은 자동 목록에 넣지 않는다', () => {
    // 재시작으로 안 낫는다. 자동 목록에 넣으면 영원히 재시작만 한다.
    const v = recoveryView({
      worker: { code: 'DIFFERENT_ENCRYPTION_KEY', summary: '키가 다릅니다', canRun: false },
    });
    eq(v.decisions[0].kind, 'NEEDS_DECISION');
    assert(/지문만 비교/.test(String(v.decisions[0].needed)), String(v.decisions[0].needed));
  });

  test('멈춘 워커는 자동으로 고칠 수 있다고 말한다 — 사람에게 넘기지 않는다', () => {
    const v = recoveryView({
      worker: { code: 'STALE_HEARTBEAT', summary: '신호가 오래됐습니다', canRun: false },
    });
    eq(v.decisions.length, 0);
    eq(v.handled[0].kind, 'AUTO_PENDING');
  });

  test('**내 보호주문이 남은 것은 자동으로 치운다**', () => {
    const v = recoveryView({ leftoverProtection: ['2089209928026685417', '2089209928026685418'] });
    eq(v.decisions.length, 0);
    eq(v.handled[0].kind, 'AUTO_PENDING');
    // 번호는 문자열 그대로 — int64를 숫자로 다루면 끝자리가 뭉개진다
    assert(/2089209928026685417/.test(v.handled[0].detail), v.handled[0].detail);
  });

  test('**소유를 모르는 주문은 절대 자동으로 손대지 않는다**', () => {
    const v = recoveryView({ unknownOwnership: 2 });
    eq(v.decisions[0].kind, 'NEVER_AUTO');
    assert(/손대지 않습니다/.test(String(v.decisions[0].needed)), String(v.decisions[0].needed));
  });

  test('소유를 모르는 주문이 0건이면 항목 자체가 없다', () => {
    eq(recoveryView({ unknownOwnership: 0 }).decisions.length, 0);
  });

  test('진입을 막는 것이 하나라도 있으면 canTrade가 false다', () => {
    eq(recoveryView({
      migration: { code: 'APPLYING', detail: '적용 중', blockedReason: null, entryAllowed: false },
    }).canTrade, false);
    eq(recoveryView({
      exitMonitor: { code: 'OVERDUE', reason: '30분째', blockEntry: true },
    }).canTrade, false);
    eq(recoveryView({
      parity: { code: 'DIFFERENT', summary: '다릅니다', entryAllowed: false, entryReason: '막습니다' },
    }).canTrade, false);
  });

  test('**절대 자동으로 하지 않는 것이 값으로 박혀 있다**', () => {
    const ids = NEVER_AUTO.map(n => n.id);
    assert(ids.includes('foreign_cancel'), '남의 주문 취소');
    assert(ids.includes('cancel_all'), 'Cancel All');
    assert(ids.includes('unknown_destructive'), '소유 미확인 파괴적 행동');
    for (const n of NEVER_AUTO) assert(n.why.length > 10, `${n.id}에 이유가 있어야 한다`);
  });

  test('아무것도 안 주면 처리됐다고 말하지 않는다', () => {
    const v = recoveryView(null);
    eq(v.handled.length, 0);
    eq(v.decisions.length, 0);
    assert(!/하실 일은 없습니다/.test(v.summary), v.summary);
  });
}
