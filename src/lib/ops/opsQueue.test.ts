// src/lib/ops/opsQueue.test.ts
//
// 화면은 자격이 없고 실행기는 자격이 있다. 그 사이를 큐가 잇는데,
// **큐가 두 번 실행하거나 오래된 요청을 뒤늦게 실행하면** 그게 더 나쁘다.

import { test, eq, assert } from '../../test/harness';
import {
  claimDecision, runOutcomeOf, CLAIM_TTL_MS, REQUEST_TTL_MS, type QueueRow,
} from './opsQueue';

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
}
