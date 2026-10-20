// src/lib/engine/exitDependency.test.ts
//
// **유일한 종료 수단을 지우는 변경은 어떤 근거로도 통과하지 않는다.**
import { test, assert, eq } from '../../test/harness';
import {
  countExitPaths, judgeTimeExitRelax, judgeUnresolvedClose,
  type ExitCapabilityFacts,
} from './exitDependency';
import { seatExitCapabilities } from './managedPosition';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function runExitDependencyTests() {

  // ── ① 지금 Exact100X의 실제 권한을 정본에서 읽어 센다 ──
  //
  //   이 시험이 중요한 이유: 숫자를 베껴 적지 않는다. `seatExitCapabilities`
  //   가 바뀌면 이 시험이 먼저 반응한다.
  test('★ Exact100X의 자동 종료 수단은 시간청산 하나뿐이다 (정본에서 읽는다)', () => {
    const seat = seatExitCapabilities({
      stopPolicy: 'NO_FIXED_SL', hasStopValue: false,
      executionIdentity: { profileId: 'MAX_LEV_100X', presetId: 'EXACT_100X',
        contractVersion: 2 } as any,
    });
    eq(seat.exposureClass, 'NO_FIXED_SL_EXACT100X');
    const paths = countExitPaths(seat.capabilities as any);
    eq(paths.count, 'TIME_ONLY',
      '시간청산 외에 자동 종료 수단이 생겼거나 사라졌다 — 변경안을 다시 봐야 한다');
    eq(paths.withoutTimeExit, 0,
      '★ 시간청산을 빼면 자동 종료가 0개다. 4시간 상수는 지울 수 있는 숫자가 아니다');
  });

  test('수단 세기 — true만 센다', () => {
    eq(countExitPaths({ timeExit: true }).count, 'TIME_ONLY');
    eq(countExitPaths({ trailing: true }).count, 'SIGNAL_ONLY');
    eq(countExitPaths({ timeExit: true, trailing: true }).count, 'MULTIPLE');
    eq(countExitPaths({}).count, 'NONE');
    eq(countExitPaths(null).count, 'NONE');
  });

  test('★ 수단 세기 — null·undefined를 "있다"로 세지 않는다', () => {
    const c: ExitCapabilityFacts = {
      timeExit: true, trailing: null, breakEven: undefined,
      signalExit: null, emergency: null, fixedStopAtEntry: null,
    };
    eq(countExitPaths(c).withoutTimeExit, 0, '모르는 권한을 있는 것으로 세면 완화가 열린다');
  });

  // ── ② 시간청산 완화 허가 ──

  const full: ExitCapabilityFacts = { timeExit: true, signalExit: true, trailing: true };

  test('완화 ① 신호 청산이 배선되고 감시가 확인되면 허가한다', () => {
    const v = judgeTimeExitRelax({ capabilities: full, monitorVerified: true });
    eq(v.allowed, true); eq(v.code, 'ALLOWED'); eq(v.keepTimeExit, false);
  });

  test('★ 완화 ② 시간청산이 유일하면 막는다', () => {
    // 지금 Exact100X의 상태가 정확히 이것이다.
    const v = judgeTimeExitRelax({
      capabilities: { timeExit: true }, monitorVerified: true });
    eq(v.code, 'BLOCKED_ONLY_EXIT_PATH'); eq(v.allowed, false); eq(v.keepTimeExit, true);
    assert(/강제청산/.test(v.reason), '무엇이 남는지 이유에 적는다');
  });

  test('★ 완화 ②-b 이 분기가 죽어 있지 않다 (도달 가능하다)', () => {
    // 처음에 신호 청산 검사를 먼저 뒀더니 이 코드가 **도달 불가능**해졌다.
    // 신호 청산이 켜져야 그 검사를 통과하는데, 켜지면 이미 유일이 아니다.
    // 순서를 바꿔 고쳤고, 이 시험이 다시 죽는 것을 막는다.
    const reachable = judgeTimeExitRelax({
      capabilities: { timeExit: true }, monitorVerified: true });
    eq(reachable.code, 'BLOCKED_ONLY_EXIT_PATH');
    const other = judgeTimeExitRelax({
      capabilities: { timeExit: true, trailing: true }, monitorVerified: true });
    eq(other.code, 'BLOCKED_NO_SIGNAL_EXIT', '두 코드가 모두 도달 가능해야 한다');
  });

  test('★ 완화 ③ 신호 청산이 배선되지 않으면 막는다 (지금 상태)', () => {
    for (const s of [false, null, undefined] as any[]) {
      const v = judgeTimeExitRelax({
        capabilities: { timeExit: true, trailing: true, signalExit: s },
        monitorVerified: true });
      eq(v.code, 'BLOCKED_NO_SIGNAL_EXIT', String(s));
      eq(v.keepTimeExit, true);
    }
  });

  test('★ 완화 ④ 감시 확인이 없으면 막는다', () => {
    for (const m of [false, null, undefined] as any[]) {
      const v = judgeTimeExitRelax({ capabilities: full, monitorVerified: m });
      eq(v.code, 'BLOCKED_MONITOR_UNVERIFIED', String(m));
    }
  });

  test('★ 완화 ⑤ 권한을 못 읽으면 막는다 — 모르는 것은 허가가 아니다', () => {
    for (const i of [null, undefined, {}, { capabilities: null }] as any[]) {
      const v = judgeTimeExitRelax(i);
      eq(v.allowed, false, String(JSON.stringify(i)));
      eq(v.keepTimeExit, true);
    }
  });

  test('★ 완화 ⑥ 어떤 입력으로도 "유일한 종료 수단"을 지울 수 없다', () => {
    // 완화가 허가되는 모든 입력에서 다른 수단이 반드시 남는지 확인한다.
    const vals = [true, false, null, undefined] as any[];
    let allowedCount = 0;
    for (const timeExit of vals) for (const signalExit of vals)
      for (const trailing of vals) for (const monitorVerified of vals) {
        const caps = { timeExit, signalExit, trailing };
        const v = judgeTimeExitRelax({ capabilities: caps, monitorVerified });
        if (!v.allowed) continue;
        allowedCount += 1;
        assert(countExitPaths(caps).withoutTimeExit > 0,
          `완화를 허가했는데 남는 수단이 0개다: ${JSON.stringify(caps)}`);
        eq(monitorVerified, true, '감시 미확인에서 허가가 났다');
      }
    assert(allowedCount > 0, '허가되는 경우가 하나도 없으면 시험이 의미가 없다');
  });

  // ── ③ 미해결 종료의 내구성 ──

  test('미해결 ① 해결됐으면 알리지 않는다', () => {
    const v = judgeUnresolvedClose({ needsReconcile: false, monitorVerified: true });
    eq(v.code, 'NONE'); eq(v.alertOperator, false);
  });

  test('미해결 ② 감시가 돌고 있으면 다음 회차가 재발견한다', () => {
    const v = judgeUnresolvedClose({ needsReconcile: true, monitorVerified: true });
    eq(v.code, 'PENDING_MONITOR_ALIVE'); eq(v.alertOperator, false);
  });

  test('★ 미해결 ③ 미해결 + 감시 중단이면 사람을 부른다', () => {
    for (const m of [false, null, undefined] as any[]) {
      const v = judgeUnresolvedClose({ needsReconcile: true, monitorVerified: m });
      eq(v.code, 'OPERATOR_REQUIRED', String(m));
      eq(v.alertOperator, true,
        '다음 회차가 없으면 "보냈는데 닫혔는지 모른다"가 응답과 함께 사라진다');
    }
  });

  test('★ 미해결 ④ 모르면 해결됐다고 적지 않는다', () => {
    for (const nr of [null, undefined] as any[]) {
      const v = judgeUnresolvedClose({ needsReconcile: nr, monitorVerified: true });
      eq(v.code, 'UNKNOWN'); eq(v.alertOperator, true);
    }
    eq(judgeUnresolvedClose(null).alertOperator, true);
  });

  // ── ④ 정본이 순수한가 ──

  test('★ 판정 정본은 import·주문·상수 변경 수단이 0이다', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/lib/engine/exitDependency.ts'), 'utf8');
    eq(/^import /m.test(src), false);
    eq(src.includes('process.env'), false);
    // 주석은 벗긴다 — 주석에서 상수를 **설명하는 것**은 괜찮고,
    // 코드에서 그 값을 **쓰는 것**이 안 된다.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
    for (const forbidden of ['maxHoldSec', 'placeFuturesOrder', 'fetch(', '14400']) {
      eq(code.includes(forbidden), false,
        `${forbidden}가 코드에 보인다 — 이 파일은 정책을 바꾸지 않는다`);
    }
  });
}
