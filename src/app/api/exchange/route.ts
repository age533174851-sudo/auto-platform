// /api/exchange — connect / list / test / delete
// SECURITY: encrypted_secret NEVER returned to client
import { NextRequest, NextResponse } from 'next/server';
import { encryptSecret, decryptSecret, maskKey } from '@/lib/exchanges/crypto';
import { testExchange, getExchangeBalances } from '@/lib/exchanges/router';
import { EXCHANGE_META } from '@/lib/exchanges/types';
import type { ExchangeId, ConnectPayload } from '@/lib/exchanges/types';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';

const MEM_STORE: any[] = [];

/** Strip encrypted secret fields before sending to client */
function safeConn(row: any) {
  const { encrypted_secret, encrypted_passphrase, api_secret_enc, api_passphrase_enc, ...safe } = row;
  return safe;
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
    const { exchange, apiKey, apiSecret, passphrase, nickname } = body as ConnectPayload & { action: string };
    if (!exchange || !apiKey || !apiSecret)
      return NextResponse.json({ error: 'exchange, apiKey, apiSecret 필수' }, { status: 400 });
    if (!EXCHANGE_META[exchange as ExchangeId])
      return NextResponse.json({ error: '지원하지 않는 거래소' }, { status: 400 });

    const testResult = await testExchange(exchange as ExchangeId, apiKey, apiSecret, passphrase);
    if (!testResult.success)
      return NextResponse.json({ error: `연결 테스트 실패: ${testResult.message}` }, { status: 400 });

    if (testResult.permissions?.withdrawal)
      return NextResponse.json({
        error: '출금 권한이 있는 API 키는 등록할 수 없습니다.\n출금 권한을 제거한 후 다시 시도하세요.',
        code: 'WITHDRAWAL_PERMISSION_DENIED',
      }, { status: 403 });

    const encSecret = encryptSecret(apiSecret);
    const encPass   = passphrase ? encryptSecret(passphrase) : null;
    const meta       = EXCHANGE_META[exchange as ExchangeId];

    const record = {
      user_id:               uid,
      exchange_id:           exchange,
      label:                 nickname ?? meta.nameKr,
      api_key_masked:        maskKey(apiKey),
      api_secret_enc:        encSecret,      // server-only field
      api_passphrase_enc:    encPass,        // server-only field
      has_withdrawal:        false,
      is_active:             true,
      last_tested_at:        new Date().toISOString(),
      test_status:           testResult.message,
    };

    if (sb) {
      const { data, error } = await sb
        .from('exchange_connections')
        .upsert(record, { onConflict: 'user_id,exchange_id' })
        .select()
        .single();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ success: true, connection: safeConn(data) });
    }

    const saved = { ...record, id: 'mem-' + Date.now() };
    MEM_STORE.push(saved);
    return NextResponse.json({ success: true, connection: safeConn(saved) });
  }

  // ── TEST ──────────────────────────────────────────────────
  if (action === 'test') {
    const { connectionId } = body;
    const conn = await getConn(connectionId, uid, sb);
    if (!conn) return NextResponse.json({ error: '연결을 찾을 수 없습니다' }, { status: 404 });
    const secret     = decryptSecret(conn.api_secret_enc ?? conn.encrypted_secret ?? '');
    const pass       = conn.api_passphrase_enc ? decryptSecret(conn.api_passphrase_enc) : undefined;
    const result     = await testExchange(conn.exchange_id ?? conn.exchange, conn.api_key_masked?.slice(0, 4) + '...', secret, pass);
    if (sb) {
      await sb.from('exchange_connections').update({
        is_active: result.success,
        last_tested_at: new Date().toISOString(),
        test_status: result.message,
      }).eq('id', connectionId).eq('user_id', uid);
    }
    return NextResponse.json({ success: result.success, message: result.message, latencyMs: result.latencyMs });
  }

  // ── DELETE ────────────────────────────────────────────────
  if (action === 'delete') {
    const { connectionId } = body;
    if (sb) {
      await sb.from('exchange_connections').delete().eq('id', connectionId).eq('user_id', uid);
    } else {
      const idx = MEM_STORE.findIndex(r => r.id === connectionId);
      if (idx >= 0) MEM_STORE.splice(idx, 1);
    }
    return NextResponse.json({ success: true });
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
      // Explicitly exclude secret columns
      const { data, error } = await sb
        .from('exchange_connections')
        .select('id,exchange_id,label,api_key_masked,has_withdrawal,is_active,last_tested_at,test_status,created_at')
        .eq('user_id', uid)
        .order('created_at', { ascending: false });
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ connections: data ?? [] });
    }
    return NextResponse.json({
      connections: MEM_STORE.filter(r => r.user_id === uid).map(safeConn),
    });
  }

  if (action === 'balances') {
    const connectionId = searchParams.get('id');
    const conn = await getConn(connectionId, uid, sb);
    if (!conn) return NextResponse.json({ error: '연결을 찾을 수 없습니다' }, { status: 404 });
    const secret   = decryptSecret(conn.api_secret_enc ?? conn.encrypted_secret ?? '');
    const pass     = conn.api_passphrase_enc ? decryptSecret(conn.api_passphrase_enc) : undefined;
    const balances = await getExchangeBalances(conn.exchange_id ?? conn.exchange, conn.api_key_masked?.slice(0, 4) ?? '', secret, pass);
    return NextResponse.json({ balances: balances.slice(0, 20), updatedAt: new Date().toISOString() });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}

async function getConn(id: string | null, userId: string, sb: any) {
  if (!id) return null;
  if (sb) {
    const { data } = await sb.from('exchange_connections').select('*').eq('id', id).eq('user_id', userId).single();
    return data ?? null;
  }
  return MEM_STORE.find(r => r.id === id && r.user_id === userId) ?? null;
}
