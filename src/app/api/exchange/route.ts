// /api/exchange — 거래소 연결 관리
// POST actions: connect / test / delete / toggle-auto / toggle-paper
// GET  actions: list / balances
//
// 보안:
// - api_secret은 AES-GCM 암호화 후 DB 저장
// - 응답에서 암호화된 필드는 제거
// - RLS + service_role
// - 출금 권한 있는 키는 등록 거부
import { NextRequest, NextResponse } from 'next/server';
import { encryptSecret, decryptSecret, maskKey } from '@/lib/exchanges/crypto';
import { testExchange, getExchangeBalances } from '@/lib/exchanges/router';
import { EXCHANGE_META } from '@/lib/exchanges/types';
import type { ExchangeId, ConnectPayload } from '@/lib/exchanges/types';
import { getSupabaseAdmin, resolveUserId, serviceRoleKeyRole } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MEM_STORE: any[] = [];   // supabase 미설정 시 fallback

/** 응답 직전 암호화 필드 제거 + 표준 형식으로 정규화 */
function safeConn(row: any) {
  if (!row) return row;
  const { encrypted_secret, encrypted_passphrase, api_secret_enc, api_passphrase_enc, api_key, ...safe } = row;
  // 클라이언트가 기대하는 필드명으로 매핑
  return {
    id:                row.id,
    exchange:          row.exchange_id ?? row.exchange,
    nickname:          row.label ?? row.nickname ?? '',
    apiKeyMasked:      row.api_key_masked ?? '****',
    hasPassphrase:     !!row.api_passphrase_enc,
    permissions: {
      read:       !!row.perm_read,
      trading:    !!row.perm_trading,
      withdrawal: !!row.has_withdrawal,
    },
    status:             row.is_active === false ? 'error' : 'active',
    lastTestAt:         row.last_tested_at ?? null,
    lastTestResult:     row.test_status ?? null,
    autoTradingEnabled: !!row.auto_trading_enabled,
    isPaper:            row.is_paper !== false,    // 기본 true
    isTestnet:          !!row.is_testnet,          // 테스트넷 여부
    createdAt:          row.created_at ?? null,
  };
}

async function getConn(id: string | null, userId: string, sb: any) {
  if (!id) return null;
  if (sb) {
    const { data } = await (sb.from('exchange_connections') as any).select('*').eq('id', id).eq('user_id', userId).single();
    return data ?? null;
  }
  return MEM_STORE.find(r => r.id === id && r.user_id === userId) ?? null;
}

// ── POST ─────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  let body: any = {};
  try { body = await req.json(); } catch {}
  const { action } = body;

  const uid = await resolveUserId(
    req.headers.get('authorization'),
    req.headers.get('x-user-id')
  );
  if (!uid) return NextResponse.json({ error: '인증 필요' }, { status: 401 });

  const sb = getSupabaseAdmin();

  // ── CONNECT ───────────────────────────────────────────────
  if (action === 'connect') {
    const { exchange, apiKey, apiSecret, passphrase, nickname, isTestnet } = body as ConnectPayload & { action: string; isTestnet?: boolean };
    if (!exchange || !apiKey || !apiSecret) {
      return NextResponse.json({ error: 'exchange, apiKey, apiSecret 필수' }, { status: 400 });
    }
    if (!EXCHANGE_META[exchange as ExchangeId]) {
      return NextResponse.json({ error: '지원하지 않는 거래소' }, { status: 400 });
    }

    let testResult;
    try {
      testResult = await testExchange(exchange as ExchangeId, apiKey, apiSecret, passphrase, isTestnet);
    } catch (e) {
      return NextResponse.json({
        error: e instanceof Error ? e.message : '검증 실패',
      }, { status: 400 });
    }

    if (!testResult.success) {
      return NextResponse.json({ error: `연결 테스트 실패: ${testResult.message}` }, { status: 400 });
    }

    // 출금 권한 거부 (안전)
    if (testResult.permissions?.withdrawal) {
      return NextResponse.json({
        error: '출금 권한이 있는 API 키는 등록할 수 없습니다.\n거래소에서 출금 권한을 제거한 후 다시 시도하세요.',
        code:  'WITHDRAWAL_PERMISSION_DENIED',
      }, { status: 403 });
    }

    let encSecret: string, encPass: string | null = null;
    try {
      encSecret = encryptSecret(apiSecret);
      if (passphrase) encPass = encryptSecret(passphrase);
    } catch (e) {
      return NextResponse.json({
        error: e instanceof Error ? e.message : '암호화 실패',
      }, { status: 500 });
    }

    const meta = EXCHANGE_META[exchange as ExchangeId];
    const record = {
      user_id:             uid,
      exchange_id:         exchange,
      exchange:            exchange,                       // 옛 컬럼 호환 (not-null 대비)
      label:               nickname ?? meta.nameKr,
      nickname:            nickname ?? meta.nameKr,        // 옛 컬럼 호환
      api_key:             apiKey,                         // 평문 보관 (key는 시크릿이 아니라 식별자)
      api_key_encrypted:   apiKey,                         // 옛 컬럼 호환
      api_key_masked:      maskKey(apiKey),
      api_secret_enc:      encSecret,                      // 암호화
      encrypted_secret:    encSecret,                      // 옛 컬럼 호환
      api_passphrase_enc:  encPass,                        // 암호화 (선택)
      encrypted_passphrase: encPass,                       // 옛 컬럼 호환
      has_withdrawal:      !!testResult.permissions?.withdrawal,
      perm_read:           !!testResult.permissions?.read,
      permission_read:     !!testResult.permissions?.read, // 옛 컬럼 호환
      perm_trading:        !!testResult.permissions?.trading,
      is_active:           true,
      auto_trading_enabled: false,
      is_paper:            true,                           // 기본 모의
      is_testnet:          !!isTestnet,                    // 테스트넷 여부
      last_tested_at:      new Date().toISOString(),
      test_status:         testResult.message,
    };

    if (sb) {
      // insert 시도 → 없는 컬럼/제약 에러나면 자동 보정 후 재시도
      let rec: any = { ...record };
      let lastErr = '';
      for (let attempt = 0; attempt < 6; attempt++) {
        const { data, error } = await (sb
          .from('exchange_connections') as any)
          .upsert(rec, { onConflict: 'user_id,exchange_id' })
          .select()
          .single();
        if (!error) {
          return NextResponse.json({
            success: true,
            connection: safeConn(data),
            testResult: { success: true, message: testResult.message, latencyMs: testResult.latencyMs },
          });
        }
        lastErr = error.message || '';
        // "Could not find the 'X' column" → 그 컬럼 제거 후 재시도
        const m = lastErr.match(/find the '([^']+)' column/);
        if (m && rec[m[1]] !== undefined) { delete rec[m[1]]; continue; }
        // ON CONFLICT 제약 없음 → onConflict 없이 일반 insert로
        if (/ON CONFLICT/i.test(lastErr)) {
          const { data: d2, error: e2 } = await (sb.from('exchange_connections') as any).insert(rec).select().single();
          if (!e2) return NextResponse.json({ success: true, connection: safeConn(d2), testResult: { success: true, message: testResult.message } });
          lastErr = e2.message || lastErr;
          break;
        }
        break;
      }
      // RLS 위반 = admin 클라이언트가 service_role이 아님 (보통 SERVICE_ROLE_KEY에 anon 키를 넣음)
      if (/row-level security|row level security/i.test(lastErr)) {
        const role = serviceRoleKeyRole();
        const hint = role === 'anon'
          ? 'SUPABASE_SERVICE_ROLE_KEY에 anon 키가 들어가 있습니다. Supabase→Settings→API의 service_role secret으로 교체 후 재배포하세요.'
          : role === 'missing'
          ? 'SUPABASE_SERVICE_ROLE_KEY가 설정되지 않았습니다.'
          : role === 'service_role'
          ? 'service_role 키는 맞지만 RLS에 막혔습니다. exchange_connections_rls.sql 정책을 실행하세요.'
          : 'SUPABASE_SERVICE_ROLE_KEY 값을 확인하세요 (service_role secret이어야 함).';
        return NextResponse.json({ error: `RLS 정책에 막힘: ${hint}`, code: 'RLS_DENIED', keyRole: role }, { status: 500 });
      }
      return NextResponse.json({ error: lastErr || '저장 실패' }, { status: 500 });
    }

    const saved = { ...record, id: 'mem-' + Date.now(), created_at: new Date().toISOString() };
    MEM_STORE.push(saved);
    return NextResponse.json({
      success: true,
      connection: safeConn(saved),
      testResult: { success: true, message: testResult.message, latencyMs: testResult.latencyMs },
    });
  }

  // ── TEST ──────────────────────────────────────────────────
  if (action === 'test') {
    const { connectionId } = body;
    const conn = await getConn(connectionId, uid, sb);
    if (!conn) return NextResponse.json({ error: '연결을 찾을 수 없습니다' }, { status: 404 });

    let secret: string, pass: string | undefined;
    try {
      secret = decryptSecret(conn.api_secret_enc ?? conn.encrypted_secret ?? '');
      pass   = conn.api_passphrase_enc ? decryptSecret(conn.api_passphrase_enc) : undefined;
    } catch (e) {
      return NextResponse.json({
        success: false,
        message: e instanceof Error ? e.message : 'decrypt_failed',
      });
    }

    const apiKey = conn.api_key ?? '';
    if (!apiKey) {
      return NextResponse.json({
        success: false,
        message: 'API 키가 저장돼있지 않습니다. 다시 연결해주세요',
      });
    }

    let result;
    try {
      result = await testExchange(conn.exchange_id ?? conn.exchange, apiKey, secret, pass);
    } catch (e) {
      result = { success: false, message: e instanceof Error ? e.message : '테스트 실패' };
    }

    if (sb) {
      await (sb.from('exchange_connections') as any).update({
        is_active:       result.success,
        last_tested_at:  new Date().toISOString(),
        test_status:     result.message,
        perm_read:       !!result.permissions?.read,
        perm_trading:    !!result.permissions?.trading,
      }).eq('id', connectionId).eq('user_id', uid);
    }

    return NextResponse.json({
      success: result.success,
      message: result.message,
      latencyMs: result.latencyMs,
    });
  }

  // ── DELETE ────────────────────────────────────────────────
  if (action === 'delete') {
    const { connectionId } = body;
    if (sb) {
      await (sb.from('exchange_connections') as any).delete().eq('id', connectionId).eq('user_id', uid);
    } else {
      const idx = MEM_STORE.findIndex(r => r.id === connectionId);
      if (idx >= 0) MEM_STORE.splice(idx, 1);
    }
    return NextResponse.json({ success: true });
  }

  // ── TOGGLE AUTO ────────────────────────────────────────────
  // 자동매매 활성화는 안전 게이트
  if (action === 'toggle-auto') {
    const { connectionId, enabled } = body;
    const conn = await getConn(connectionId, uid, sb);
    if (!conn) return NextResponse.json({ error: '연결을 찾을 수 없습니다' }, { status: 404 });

    if (enabled === true) {
      // 출금 권한 키는 모든 모드에서 거부 (안전)
      if (conn.has_withdrawal === true) {
        return NextResponse.json({ error: '출금 권한이 있는 API 키는 자동매매에 사용할 수 없습니다.\n출금 권한 없는 키로 재연결하세요.' }, { status: 403 });
      }
      const isTestnet = conn.is_testnet === true;
      const isMock = !isTestnet && conn.is_paper === true;   // 순수 내부 모의
      // 디버깅용 — 권한 응답 상태를 로그로 (Vercel Function Logs에서 확인)
      console.log('[toggle-auto] mode=%s testnet=%s paper=%s perm_trading=%s perm_read=%s has_withdrawal=%s',
        isMock ? 'MOCK' : isTestnet ? 'TESTNET' : 'LIVE', conn.is_testnet, conn.is_paper, conn.perm_trading, conn.perm_read, conn.has_withdrawal);

      if (isMock) {
        // MOCK: 실제 거래소 거래 권한 검사하지 않음 (로컬 자동매매만)
      } else if (isTestnet) {
        // TESTNET: 선물 테스트넷 연결이 이미 검증됨 → 거래 가능으로 간주
        // (과거 버전에서 perm_trading이 false로 저장됐어도 테스트넷은 허용 — 가짜 자금)
      } else {
        // LIVE: 실거래 권한 필수
        if (!conn.perm_trading) {
          return NextResponse.json({ error: '실전(LIVE) 자동매매에는 거래(trading) 권한이 필요합니다.\nBinance에서 Futures 거래 권한을 활성화한 뒤 재연결하세요.' }, { status: 403 });
        }
      }
    }

    if (sb) {
      await (sb.from('exchange_connections') as any)
        .update({ auto_trading_enabled: !!enabled })
        .eq('id', connectionId).eq('user_id', uid);
    } else {
      const r = MEM_STORE.find(x => x.id === connectionId);
      if (r) r.auto_trading_enabled = !!enabled;
    }
    return NextResponse.json({ success: true, enabled: !!enabled });
  }

  // ── TOGGLE PAPER ───────────────────────────────────────────
  if (action === 'toggle-paper') {
    const { connectionId, isPaper } = body;
    if (sb) {
      await (sb.from('exchange_connections') as any)
        .update({ is_paper: !!isPaper })
        .eq('id', connectionId).eq('user_id', uid);
    } else {
      const r = MEM_STORE.find(x => x.id === connectionId);
      if (r) r.is_paper = !!isPaper;
    }
    return NextResponse.json({ success: true, isPaper: !!isPaper });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}

// ── GET ──────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const action = searchParams.get('action') ?? 'list';

  const uid = await resolveUserId(
    req.headers.get('authorization'),
    req.headers.get('x-user-id')
  );
  if (!uid) return NextResponse.json({ connections: [] });

  const sb = getSupabaseAdmin();

  if (action === 'list') {
    if (sb) {
      const { data, error } = await sb
        .from('exchange_connections')
        .select('id, exchange_id, label, api_key_masked, has_withdrawal, perm_read, perm_trading, is_active, auto_trading_enabled, is_paper, last_tested_at, test_status, api_passphrase_enc, created_at')
        .eq('user_id', uid)
        .order('created_at', { ascending: false });
      if (error) return NextResponse.json({ error: error.message, connections: [] }, { status: 500 });
      return NextResponse.json({
        connections: (data ?? []).map(safeConn),
      }, { headers: { 'Cache-Control': 'no-store' } });
    }
    return NextResponse.json({
      connections: MEM_STORE.filter(r => r.user_id === uid).map(safeConn),
    });
  }

  if (action === 'balances') {
    const connectionId = searchParams.get('id');
    const conn = await getConn(connectionId, uid, sb);
    if (!conn) return NextResponse.json({ error: '연결을 찾을 수 없습니다', balances: [] }, { status: 404 });

    let secret: string, pass: string | undefined;
    try {
      secret = decryptSecret(conn.api_secret_enc ?? conn.encrypted_secret ?? '');
      pass   = conn.api_passphrase_enc ? decryptSecret(conn.api_passphrase_enc) : undefined;
    } catch (e) {
      return NextResponse.json({
        error: e instanceof Error ? e.message : 'decrypt_failed',
        balances: [],
      }, { status: 500 });
    }

    const apiKey = conn.api_key ?? '';
    if (!apiKey) {
      return NextResponse.json({
        error: 'API 키가 저장돼있지 않습니다. 다시 연결해주세요',
        balances: [],
      }, { status: 400 });
    }

    let balances;
    try {
      balances = await getExchangeBalances(conn.exchange_id ?? conn.exchange, apiKey, secret, pass);
    } catch (e) {
      return NextResponse.json({
        error: e instanceof Error ? e.message : '잔고 조회 실패',
        balances: [],
      }, { status: 500 });
    }

    return NextResponse.json({
      balances: balances.slice(0, 30),
      updatedAt: new Date().toISOString(),
    }, { headers: { 'Cache-Control': 'no-store' } });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
