// src/lib/supabase/exchangeConnectionRead.test.ts
//
// **구 버전 연결(`encrypted_secret`에만 비밀이 있는 연결)이 조용히
// 빠지지 않는가.** 그리고 **못 읽은 것을 "연결 없음"으로 적지 않는가.**

import { test, eq, assert } from '../../test/harness';
import {
  EXCHANGE_CONNECTION_COLUMNS, CREDENTIAL_COLUMNS,
  connectionReadVerdict, credentialColumnsPresent,
} from './exchangeConnectionRead';

/** 워커의 `connCreds`와 **같은 식**이다. 여기서 재현하는 대상이다. */
function secretOf(conn: any): string {
  return String(conn.api_secret_enc || conn.encrypted_secret || '');
}

/** 칸 목록 문자열을 실제 select처럼 행으로 투영한다. */
function project(row: Record<string, any>, columns: string): Record<string, any> {
  const want = columns.split(',').map((c) => c.trim());
  const out: Record<string, any> = {};
  for (const c of want) if (c in row) out[c] = row[c];
  return out;
}

export function runExchangeConnectionReadTests() {
  console.log('[연결 조회 — 구 버전 연결과 조회 실패]');

  // ── ① 칸 목록 자체 ─────────────────────────────────────────────
  test('★ 칸 목록에 자격증명 세 칸이 모두 있다', () => {
    for (const c of CREDENTIAL_COLUMNS) {
      assert(
        EXCHANGE_CONNECTION_COLUMNS.split(',').map((s) => s.trim()).includes(c),
        `칸 목록에 ${c}가 없습니다 — 그 칸이 비면 구 버전 연결이 자격증명 없는 연결로 보입니다`,
      );
    }
  });

  test('칸 목록은 한 줄 문자열이다 (이어 붙이면 타입 추론이 끊긴다)', () => {
    assert(!EXCHANGE_CONNECTION_COLUMNS.includes('\n'), '칸 목록에 줄바꿈이 있습니다');
    assert(EXCHANGE_CONNECTION_COLUMNS.trim().length > 0, '칸 목록이 비었습니다');
  });

  test('`select(\'*\')`로 되돌아가지 않았다', () => {
    assert(EXCHANGE_CONNECTION_COLUMNS.trim() !== '*', '칸 목록이 * 입니다 — 전송량이 다시 늘어납니다');
  });

  // ── ② 구 버전 연결 — 이것이 재현하려던 결함이다 ─────────────────
  //
  // 004가 `api_secret_enc`에 기본값 `''`를 준다. 그래서 구 버전 연결은
  // 그 칸이 **비어 있는 것이 정상**이고, 비밀은 063이 만든
  // `encrypted_secret`에 있다.
  const LEGACY_ROW = {
    id: 'conn-legacy', user_id: 'u1', exchange_id: 'binance',
    api_key: 'KEY-LEGACY',
    api_secret_enc: '',              // ← 004 기본값. 비어 있는 것이 정상
    encrypted_secret: 'ENC-LEGACY',  // ← 063. 진짜 비밀은 여기
    is_testnet: true, has_withdrawal: false,
    label: 'legacy', api_key_masked: '****', created_at: '2026-01-01T00:00:00Z',
  };

  test('★ 구 버전 연결도 정본 칸 목록으로 읽으면 비밀이 살아 온다', () => {
    const row = project(LEGACY_ROW, EXCHANGE_CONNECTION_COLUMNS);
    eq(secretOf(row), 'ENC-LEGACY', '구 버전 연결의 비밀을 읽지 못했습니다');
    assert(credentialColumnsPresent(row).ok, '자격증명 칸이 빠졌습니다');
  });

  test('★ encrypted_secret을 뺀 칸 목록이면 그 연결은 자격증명 없는 연결로 보인다 (막아야 할 모양)', () => {
    const SHORT = 'id, user_id, exchange_id, api_key, api_secret_enc, is_testnet, has_withdrawal';
    const row = project(LEGACY_ROW, SHORT);
    // 이것이 #388 초판의 monitorConnections가 하던 일이다.
    eq(secretOf(row), '', '재현에 실패했습니다 — 이 시험이 지키려는 결함이 아닙니다');
    const chk = credentialColumnsPresent(row);
    eq(chk.ok, false, '빠진 칸을 알아보지 못했습니다');
    eq(chk.missing.join(','), 'encrypted_secret', '빠진 칸을 정확히 짚지 못했습니다');
  });

  test('새 연결(api_secret_enc에 비밀이 있는 연결)은 그대로 동작한다', () => {
    const row = project(
      { ...LEGACY_ROW, id: 'conn-new', api_secret_enc: 'ENC-NEW', encrypted_secret: '' },
      EXCHANGE_CONNECTION_COLUMNS,
    );
    eq(secretOf(row), 'ENC-NEW', '새 연결의 비밀을 읽지 못했습니다');
  });

  test('빈 값과 빠진 칸은 다르다', () => {
    // 값이 비어 있다 = 이 연결에는 비밀이 없다 (칸은 읽었다)
    const empty = project({ ...LEGACY_ROW, encrypted_secret: '' }, EXCHANGE_CONNECTION_COLUMNS);
    eq(credentialColumnsPresent(empty).ok, true, '값이 빈 것을 칸이 빠진 것으로 읽었습니다');
    eq(secretOf(empty), '', '비밀이 없는 연결인데 값이 나왔습니다');
  });

  // ── ③ 조회 실패를 "연결 없음"으로 적지 않는다 ───────────────────
  test('★ 조회 오류는 READ_FAILED다 — NOT_FOUND가 아니다', () => {
    const v = connectionReadVerdict({ data: null, error: { message: 'column "encrypted_secret" does not exist' } });
    eq(v.code, 'READ_FAILED', '조회 실패를 연결 없음으로 읽었습니다');
    eq(v.conn, null);
    assert(v.reason.includes('encrypted_secret'), '사유에 원인이 남지 않았습니다');
  });

  test('★ 402도 READ_FAILED다', () => {
    const v = connectionReadVerdict({ data: null, error: { status: 402, message: 'Payment Required' } });
    eq(v.code, 'READ_FAILED', '한도 오류를 연결 없음으로 읽었습니다');
  });

  test('정말 없을 때만 NOT_FOUND다', () => {
    eq(connectionReadVerdict({ data: null, error: null }).code, 'NOT_FOUND');
    eq(connectionReadVerdict({ data: null }).code, 'NOT_FOUND');
  });

  test('읽었으면 FOUND이고 행이 그대로 실린다', () => {
    const v = connectionReadVerdict({ data: LEGACY_ROW, error: null });
    eq(v.code, 'FOUND');
    eq(v.conn.id, 'conn-legacy');
  });

  test('응답 자체가 없으면 READ_FAILED다 — 모르는 것을 없다고 적지 않는다', () => {
    eq(connectionReadVerdict(null).code, 'READ_FAILED');
    eq(connectionReadVerdict(undefined).code, 'READ_FAILED');
  });

  test('오류 객체가 문자열이어도 사유를 남긴다', () => {
    const v = connectionReadVerdict({ data: null, error: 'fetch failed' });
    eq(v.code, 'READ_FAILED');
    assert(v.reason.includes('fetch failed'), '사유가 비었습니다');
  });

  test('행이 아닌 것에 자격증명 칸 확인을 걸면 통과시키지 않는다', () => {
    eq(credentialColumnsPresent(null).ok, false);
    eq(credentialColumnsPresent('row' as any).ok, false);
  });
}
