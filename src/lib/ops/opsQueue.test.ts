// src/lib/ops/opsQueue.test.ts
//
// 화면은 자격이 없고 실행기는 자격이 있다. 그 사이를 큐가 잇는데,
// **큐가 두 번 실행하거나 오래된 요청을 뒤늦게 실행하면** 그게 더 나쁘다.

import { test, eq, assert } from '../../test/harness';
import {
  claimDecision, runOutcomeOf, CLAIM_TTL_MS, REQUEST_TTL_MS, type QueueRow,
} from './opsQueue';
import {
  parseOpsCommand, OPS_COMMANDS, runnableCommands, approvalCommands, queueInsertPlan,
} from './opsCommand';

const NOW = 1_800_000_000_000;
const row = (over: Partial<QueueRow>): QueueRow => ({
  id: 'r1', command: 'DEPLOY', status: 'PENDING', approved: false,
  requestedAtMs: NOW - 60_000, claimedAtMs: null, claimedBy: null, ...over,
});

export function runOpsQueueTests() {
  console.log('[운영 요청 큐 — 두 번 실행하지 않는다]');

  test('대기 중인 요청을 집어 간다', () => {
    const d = claimDecision({ rows: [row({})], me: 'runner1', nowMs: NOW });
    eq(d.code, 'CLAIM');
    eq(d.row!.command, 'DEPLOY');
  });

  test('오래된 순서대로 집어 간다', () => {
    const d = claimDecision({
      rows: [row({ id: 'b', requestedAtMs: NOW - 10_000 }), row({ id: 'a', requestedAtMs: NOW - 300_000 })],
      me: 'r', nowMs: NOW });
    eq(d.row!.id, 'a');
  });

  test('**남이 쥐고 있으면 집어 가지 않는다**', () => {
    const d = claimDecision({
      rows: [row({ status: 'CLAIMED', claimedBy: 'other', claimedAtMs: NOW - 1000 })],
      me: 'me', nowMs: NOW });
    eq(d.code, 'HELD');
  });

  test('쥔 채로 죽은 요청은 다시 집어 간다', () => {
    const d = claimDecision({
      rows: [row({ status: 'CLAIMED', claimedBy: 'dead', claimedAtMs: NOW - CLAIM_TTL_MS - 1 })],
      me: 'me', nowMs: NOW });
    eq(d.code, 'CLAIM');
  });

  test('**한참 전 요청은 실행하지 않는다**', () => {
    // 한 시간 전에 누른 "배포해"가 지금 도는 것은 사람이 예상하지 못한다.
    const d = claimDecision({ rows: [row({ requestedAtMs: NOW - REQUEST_TTL_MS - 1 })], me: 'r', nowMs: NOW });
    eq(d.code, 'EXPIRED');
  });

  test('**실제 자금이 걸린 명령은 승인 없이 실행하지 않는다**', () => {
    const d = claimDecision({ rows: [row({ command: 'APPROVE_LIVE_SMALL' })], me: 'r', nowMs: NOW });
    eq(d.code, 'NEEDS_APPROVAL');
  });

  test('승인이 있으면 실행한다', () => {
    const d = claimDecision({ rows: [row({ command: 'APPROVE_LIVE_SMALL', approved: true })], me: 'r', nowMs: NOW });
    eq(d.code, 'CLAIM');
  });

  test('모르는 명령은 실행하지 않는다', () => {
    eq(claimDecision({ rows: [row({ command: 'DROP_EVERYTHING' })], me: 'r', nowMs: NOW }).code, 'UNKNOWN_COMMAND');
  });

  test('읽지 못한 목록을 "없음"으로 보지 않는다', () => {
    const d = claimDecision({ rows: undefined, me: 'r', nowMs: NOW });
    eq(d.code, 'NOTHING');
    assert(/읽지 못했습니다/.test(d.reason), d.reason);
  });

  test('끝난 요청은 다시 실행하지 않는다', () => {
    eq(claimDecision({ rows: [row({ status: 'DONE' }), row({ status: 'FAILED' })], me: 'r', nowMs: NOW }).code, 'NOTHING');
  });

  // ── 결과 ──

  test('전부 성공해야 DONE이다', () => {
    const o = runOutcomeOf([{ step: '마이그레이션', ok: true, detail: '' }, { step: '워커', ok: true, detail: '' }]);
    eq(o.status, 'DONE');
  });

  test('**하나라도 실패하면 DONE이 아니다**', () => {
    // "배포했습니다"라고 적고 절반만 된 상태가 가장 자주 난 고장이다.
    const o = runOutcomeOf([
      { step: '마이그레이션', ok: true, detail: '' },
      { step: '워커 배포', ok: false, detail: 'flyctl 실패' },
    ]);
    eq(o.status, 'FAILED');
    assert(/워커 배포/.test(String(o.error)), String(o.error));
  });

  test('아무 단계도 안 돌았으면 성공이 아니다', () => {
    eq(runOutcomeOf([]).status, 'FAILED');
  });
  console.log('[운영 요청 큐 — 정의만 있고 실행되지 않던 명령]');

  test('"시크릿 동기화해"가 말 → 명령 → 큐 → 집어감까지 이어진다', () => {
    // **이 사슬의 한 칸이 비어 있었다.** opsCommand.ts에 SYNC_SECRETS를
    // 정의하고 ops-runner.mjs에 실행 분기까지 붙였는데, opsQueue.ts가
    // 따로 들고 있던 RUNNABLE 목록에만 안 들어갔다. 그래서 요청은 큐에
    // 들어간 뒤 UNKNOWN_COMMAND로 만료됐고, 그 다음부터 화면에는
    // "실행할 요청이 없습니다"만 떴다 — 영원히.
    const cmd = parseOpsCommand('시크릿 동기화해');
    eq(cmd, 'SYNC_SECRETS');
    const d = claimDecision({ rows: [row({ command: cmd! })], me: 'runner1', nowMs: NOW });
    eq(d.code, 'CLAIM');
  });

  test('실행 목록을 손으로 들지 않는다 — 명령 정의에서 뽑는다', () => {
    // 목록이 둘이면 언젠가 한쪽만 고쳐진다. 그게 이 버그였다.
    const fromSpec = OPS_COMMANDS.filter(c => c.runBy === 'QUEUE').map(c => c.command).sort();
    eq(runnableCommands().slice().sort().join(','), fromSpec.join(','));
    const needApproval = OPS_COMMANDS.filter(c => c.needsApproval).map(c => c.command).sort();
    eq(approvalCommands().slice().sort().join(','), needApproval.join(','));
  });

  test('값을 바꾸는 명령은 즉시 실행이거나 큐 실행이거나 — 둘 중 하나다', () => {
    // 값을 바꾸는데 어느 쪽도 아니면 그 명령은 아무 데서도 안 돈다.
    for (const c of OPS_COMMANDS) {
      assert(c.runBy === 'IMMEDIATE' || c.runBy === 'QUEUE',
        `${c.command}: runBy가 없습니다`);
    }
  });

  test('킬 스위치는 큐에 넣지 않는다 — 5분 뒤에 켜지면 안 켜진 것과 같다', () => {
    // **동작을 바꾸지 않았다는 확인이다.** STOP_NOW는 값을 바꾸지만
    // 요청받은 그 자리에서 켠다.
    const d = claimDecision({ rows: [row({ command: 'STOP_NOW' })], me: 'r', nowMs: NOW });
    eq(d.code, 'UNKNOWN_COMMAND');
  });

  test('조회 명령도 실행기가 집어 가지 않는다', () => {
    for (const c of ['CHECK_ALL', 'VERIFY_TESTNET']) {
      eq(claimDecision({ rows: [row({ command: c })], me: 'r', nowMs: NOW }).code, 'UNKNOWN_COMMAND');
    }
  });

  test('LIVE 소액 승인은 여전히 승인 없이는 안 간다', () => {
    const no = claimDecision({ rows: [row({ command: 'APPROVE_LIVE_SMALL', approved: false })], me: 'r', nowMs: NOW });
    eq(no.code, 'NEEDS_APPROVAL');
    const yes = claimDecision({ rows: [row({ command: 'APPROVE_LIVE_SMALL', approved: true })], me: 'r', nowMs: NOW });
    eq(yes.code, 'CLAIM');
  });

  test('시크릿 동기화는 승인을 요구하지 않는다 — 값이 한 곳에서만 온다', () => {
    const d = claimDecision({ rows: [row({ command: 'SYNC_SECRETS', approved: false })], me: 'r', nowMs: NOW });
    eq(d.code, 'CLAIM');
  });

  test('오래된 시크릿 동기화 요청은 여전히 실행하지 않는다', () => {
    const d = claimDecision({
      rows: [row({ command: 'SYNC_SECRETS', requestedAtMs: NOW - REQUEST_TTL_MS - 1 })],
      me: 'r', nowMs: NOW,
    });
    eq(d.code, 'EXPIRED');
  });

  console.log('[운영 요청 큐 — 무엇을 큐에 적는가]');

  test('IMMEDIATE 명령은 하나도 큐에 적지 않는다', () => {
    // 요청 생성 쪽이 `spec.mutates`로 독자 판단하고 있었다. 지금
    // 구성에서는 우연히 맞았지만, 값을 바꾸면서 즉시 실행되는 명령이
    // 하나 더 생기면 조용히 큐로 들어간다 — 사용자는 "지금" 눌렀는데
    // 5분 뒤에 실행된다.
    for (const c of OPS_COMMANDS.filter(x => x.runBy === 'IMMEDIATE')) {
      eq(queueInsertPlan(c.command).insert, false, c.command);
    }
  });

  test('QUEUE 명령은 전부 큐에 적는다', () => {
    for (const c of OPS_COMMANDS.filter(x => x.runBy === 'QUEUE')) {
      eq(queueInsertPlan(c.command).insert, true, c.command);
    }
  });

  test('값을 바꾸는데 즉시 실행인 명령도 큐에 안 적는다 — STOP_NOW', () => {
    // **mutates로 판단하면 이게 큐로 간다.** 킬 스위치가 5분 뒤에
    // 켜지면 안 켜진 것과 같다.
    const stop = OPS_COMMANDS.find(c => c.command === 'STOP_NOW')!;
    eq(stop.mutates, true);
    eq(stop.runBy, 'IMMEDIATE');
    eq(queueInsertPlan('STOP_NOW').insert, false);
  });

  test('모르는 명령을 큐에 적지 않는다', () => {
    // 적으면 실행기가 집어 가서 UNKNOWN_COMMAND로 만료시키고,
    // 사용자는 왜 아무 일도 없는지 모른다.
    eq(queueInsertPlan('NOPE').insert, false);
    eq(queueInsertPlan(null).insert, false);
  });

  test('큐에 적는 집합과 실행기가 집어 가는 집합이 정확히 같다', () => {
    // 한쪽만 있으면 영원히 안 도는 요청이 쌓이거나, 실행기가 못 알아보는
    // 명령이 큐에 들어간다.
    const inserted = OPS_COMMANDS.filter(c => queueInsertPlan(c.command).insert)
      .map(c => c.command).sort().join(',');
    eq(inserted, runnableCommands().slice().sort().join(','));
  });

}
