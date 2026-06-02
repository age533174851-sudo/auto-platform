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
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';

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
      label:               nickname ?? meta.nameKr,
      api_key:             apiKey,                       // 평문 보관 (key는 시크릿이 아니라 식별자)
      api_key_masked:      maskKey(apiKey),
      api_secret_enc:      encSecret,                   // 암호화
      api_passphrase_enc:  encPass,                     // 암호화 (선택)
      has_withdrawal:      !!testResult.permissions?.withdrawal,
      perm_read:           !!testResult.permissions?.read,
      perm_trading:        !!testResult.permissions?.trading,
      is_active:           true,
      auto_trading_enabled: false,
      is_paper:            true,                        // 기본 모의
      is_testnet:          !!isTestnet,                 // 테스트넷 여부
      last_tested_at:      new Date().toISOString(),
      test_status:         testResult.message,
    };

    if (sb) {
      const { data, error } = await (sb
        .from('exchange_connections') as any)
        .upsert(record, { onConflict: 'user_id,exchange_id' })
        .select()
        .single();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({
        success: true,
        connection: safeConn(data),
        testResult: { success: true, message: testResult.message, latencyMs: testResult.latencyMs },
      });
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

    if (enabled === true && !conn.perm_trading) {
      return NextResponse.json({
        error: 'API 키에 거래(trading) 권한이 없습니다.\n거래소에서 권한을 부여하고 재연결하세요.',
      }, { status: 403 });
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
