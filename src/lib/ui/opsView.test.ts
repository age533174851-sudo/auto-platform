// src/lib/ui/opsView.test.ts
//
// 화면이 서버 판정을 다시 계산하면 기준이 두 곳에 생기고, 언젠가
// **서버는 BLOCKED인데 화면은 초록인 상태**가 온다.

import { test, eq, assert } from '../../test/harness';
import { verdictView, stepView, requestView } from './opsView';

export function runOpsViewTests() {
  console.log('[운영 화면 — 모르는 것을 초록으로 그리지 않는다]');

  test('네 판정에 각각 다른 색을 준다', () => {
    eq(verdictView('READY').tone, 'ok');
    eq(verdictView('SELF_HEALED').tone, 'info');
    eq(verdictView('BOOTSTRAP_REQUIRED').tone, 'warn');
    eq(verdictView('BLOCKED').tone, 'bad');
  });

  test('**모르는 값을 초록으로 그리지 않는다**', () => {
    eq(verdictView(undefined).tone, 'bad');
    eq(verdictView('WAT' as any).tone, 'bad');
    assert(/정상이라는 뜻이 아닙니다/.test(verdictView(null).note), verdictView(null).note);
  });

  test('자동 복구는 "하실 일은 없습니다"라고 적는다', () => {
    // 사람이 한 일이 아니라는 것을 분명히 한다.
    assert(/하실 일은 없습니다/.test(verdictView('SELF_HEALED').note));
  });

  test('권한 연결은 "최초 한 번"임을 적는다', () => {
    assert(/최초 한 번/.test(verdictView('BOOTSTRAP_REQUIRED').note));
    assert(/다시 요청하지 않습니다/.test(verdictView('BOOTSTRAP_REQUIRED').note));
  });

  test('막힌 단계는 왜 못 했는지 같이 보여 준다', () => {
    const v = stepView({ label: '권한 연결', state: 'BLOCKED', detail: '연결 안 됨',
      blockedReason: 'SUPABASE_DB_URL' });
    eq(v.tone, 'bad');
    assert(/SUPABASE_DB_URL/.test(v.detail), v.detail);
  });

  test('상태를 모르는 단계도 초록이 아니다', () => {
    const v = stepView({ label: '장부', state: 'UNKNOWN', detail: '' });
    eq(v.tone, 'bad');
    assert(/정상이라는 뜻이 아닙니다/.test(v.detail), v.detail);
  });

  test('보지 않은 단계와 확인 못 한 단계는 다르다', () => {
    eq(stepView({ label: 'x', state: 'SKIPPED' }).tone, 'muted');
    eq(stepView({ label: 'x', state: 'UNKNOWN' }).tone, 'bad');
  });

  test('**접수와 실행은 다르게 그린다**', () => {
    eq(requestView({ status: 'PENDING', command: 'DEPLOY' }).tone, 'info');
    eq(requestView({ status: 'DONE', command: 'DEPLOY', result: { summary: '2단계 완료' } }).tone, 'ok');
    eq(requestView({ status: 'FAILED', command: 'DEPLOY', error: 'flyctl 실패' }).tone, 'bad');
  });

  test('요청 상태를 못 읽으면 성공으로 그리지 않는다', () => {
    eq(requestView(null).tone, 'bad');
    eq(requestView({ status: 'WAT' } as any).tone, 'bad');
  });
}
