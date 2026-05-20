// /api/exchange — unified handler for connect / test / balances / delete / toggle
import { NextRequest, NextResponse } from 'next/server';
import { encryptSecret, maskKey } from '@/lib/exchanges/crypto';
import { testExchange, getExchangeBalances } from '@/lib/exchanges/router';
import { EXCHANGE_META } from '@/lib/exchanges/types';
import type { ExchangeId, ConnectPayload } from '@/lib/exchanges/types';
import { getSupabaseAdmin } from '@/lib/supabase/admin';

// ── In-memory store (fallback when Supabase unavailable) ──────
const MEM_STORE: any[] = [];

function safeUserId(req: NextRequest): string {
  // In production use proper auth; for now use a demo user ID
  return req.headers.get('x-user-id') || 'demo-user';
}

// ─────────────────────────────────────────────────────────────
// POST /api/exchange  body: { action, ...payload }
// ─────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  let body: any = {};
  try { body = await req.json(); } catch {}
  const { action } = body;
  const userId = safeUserId(req);
  const supabase = getSupabaseAdmin();

  // ── CONNECT ────────────────────────────────────────────────
  if (action === 'connect') {
    const { exchange, apiKey, apiSecret, passphrase, nickname } = body as ConnectPayload & { action: string };

    if (!exchange || !apiKey || !apiSecret) {
      return NextResponse.json({ error: 'exchange, apiKey, apiSecret 필수' }, { status: 400 });
    }
    if (!EXCHANGE_META[exchange as ExchangeId]) {
      return NextResponse.json({ error: '지원하지 않는 거래소' }, { status: 400 });
    }

    // 1. Test connection first
    const testResult = await testExchange(exchange as ExchangeId, apiKey, apiSecret, passphrase);
    if (!testResult.success) {
      return NextResponse.json({ error: `연결 테스트 실패: ${testResult.message}` }, { status: 400 });
    }

    // 2. Check withdrawal permission — REFUSE if enabled
    if (testResult.permissions?.withdrawal) {
      return NextResponse.json({
        error: '출금 권한이 있는 API 키는 등록할 수 없습니다.\n출금 권한을 제거한 후 다시 시도하세요.',
        code: 'WITHDRAWAL_PERMISSION_DENIED',
      }, { status: 403 });
    }

    // 3. Encrypt secret — NEVER store plaintext
    const encryptedSecret     = encryptSecret(apiSecret);
    const encryptedPassphrase = passphrase ? encryptSecret(passphrase) : null;
    const keyMasked           = maskKey(apiKey);
    const meta                = EXCHANGE_META[exchange as ExchangeId];

    const record = {
      user_id:             userId,
      exchange:            exchange,
      nickname:            nickname || meta.nameKr,
      api_key:             apiKey.slice(0, 8) + '...',    // store prefix only for display
      api_key_masked:      keyMasked,
      api_secret_enc:      encryptedSecret,
      api_passphrase_enc:  encryptedPassphrase,
      has_passphrase:      !!passphrase,
      perm_read:           testResult.permissions?.read ?? true,
      perm_trading:        testResult.permissions?.trading ?? false,
      perm_withdrawal:     false,                          // always false — we refuse withdrawal keys
      status:              'active',
      last_test_at:        new Date().toISOString(),
      last_test_result:    testResult.message,
      auto_trading:        false,
      is_paper:            false,
      created_at:          new Date().toISOString(),
    };

    // 4. Save (Supabase or memory)
    let saved = record;
    if (supabase) {
      try {
        const { data, error } = await supabase
          .from('exchange_connections')
          .insert(record)
          .select()
          .single();
        if (!error && data) saved = data;
      } catch {}
    } else {
      const id = `mem-${Date.now()}`;
      saved = { ...record, id };
      MEM_STORE.push(saved);
    }

    // 5. Return safe response — NO secrets
    return NextResponse.json({
      success: true,
      connection: {
        id:           (saved as any).id,
        exchange,
        nickname:     record.nickname,
        apiKeyMasked: keyMasked,
        permissions:  { read: true, trading: record.perm_trading, withdrawal: false },
        status:       'active',
        latencyMs:    testResult.latencyMs,
        balanceCount: testResult.balances?.length ?? 0,
      },
    });
  }

  // ── TEST (re-test existing connection) ─────────────────────
  if (action === 'test') {
    const { connectionId } = body;
    const conn = await getConnection(connectionId, userId, supabase);
    if (!conn) return NextResponse.json({ error: '연결을 찾을 수 없습니다' }, { status: 404 });

    const { decryptSecret } = await import('@/lib/exchanges/crypto');
    const secret     = decryptSecret(conn.api_secret_enc);
    const passphrase = conn.api_passphrase_enc ? decryptSecret(conn.api_passphrase_enc) : undefined;
    const result     = await testExchange(conn.exchange, conn.api_key.split('...')[0] + '...', secret, passphrase);

    // Update status
    if (supabase) {
      await supabase.from('exchange_connections').update({
        status: result.success ? 'active' : 'error',
        last_test_at: new Date().toISOString(),
        last_test_result: result.message,
      }).eq('id', connectionId).eq('user_id', userId);
    }

    return NextResponse.json({ success: result.success, message: result.message, latencyMs: result.latencyMs });
  }

  // ── TOGGLE AUTO TRADING ────────────────────────────────────
  if (action === 'toggle-auto') {
    const { connectionId, enabled } = body;
    if (supabase) {
      await supabase.from('exchange_connections')
        .update({ auto_trading: !!enabled })
        .eq('id', connectionId).eq('user_id', userId);
    } else {
      const idx = MEM_STORE.findIndex(r => r.id === connectionId);
      if (idx >= 0) MEM_STORE[idx].auto_trading = !!enabled;
    }
    return NextResponse.json({ success: true, autoTrading: !!enabled });
  }

  // ── DELETE ─────────────────────────────────────────────────
  if (action === 'delete') {
    const { connectionId } = body;
    if (supabase) {
      await supabase.from('exchange_connections')
        .delete().eq('id', connectionId).eq('user_id', userId);
    } else {
      const idx = MEM_STORE.findIndex(r => r.id === connectionId);
      if (idx >= 0) MEM_STORE.splice(idx, 1);
    }
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}

// ─────────────────────────────────────────────────────────────
// GET /api/exchange?action=list|balances
// ─────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const action = searchParams.get('action') || 'list';
  const userId = safeUserId(req);
  const supabase = getSupabaseAdmin();

  // ── LIST connections (safe — no secrets) ───────────────────
  if (action === 'list') {
    let rows: any[] = [];
    if (supabase) {
      const { data } = await supabase
        .from('exchange_connections')
        .select('id,exchange,nickname,api_key_masked,has_passphrase,perm_read,perm_trading,perm_withdrawal,status,last_test_at,last_test_result,auto_trading,is_paper,created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });
      rows = data || [];
    } else {
      rows = MEM_STORE.filter(r => r.user_id === userId);
    }

    const connections = rows.map(r => ({
      id:             r.id,
      exchange:       r.exchange,
      nickname:       r.nickname,
      apiKeyMasked:   r.api_key_masked,
      hasPassphrase:  r.has_passphrase,
      permissions:    { read: r.perm_read, trading: r.perm_trading, withdrawal: false },
      status:         r.status,
      lastTestAt:     r.last_test_at,
      lastTestResult: r.last_test_result,
      autoTradingEnabled: r.auto_trading,
      isPaper:        r.is_paper,
      createdAt:      r.created_at,
    }));

    return NextResponse.json({ connections });
  }

  // ── BALANCES ───────────────────────────────────────────────
  if (action === 'balances') {
    const connectionId = searchParams.get('id');
    const conn = await getConnection(connectionId, userId, supabase);
    if (!conn) return NextResponse.json({ error: '연결을 찾을 수 없습니다' }, { status: 404 });

    const { decryptSecret } = await import('@/lib/exchanges/crypto');
    const secret     = decryptSecret(conn.api_secret_enc);
    const passphrase = conn.api_passphrase_enc ? decryptSecret(conn.api_passphrase_enc) : undefined;
    const balances   = await getExchangeBalances(conn.exchange, conn.api_key.split('...')[0], secret, passphrase);

    // Sort by value, top 20
    return NextResponse.json({
      balances: balances.slice(0, 20),
      exchange: conn.exchange,
      updatedAt: new Date().toISOString(),
    });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}

// ── Helper ──────────────────────────────────────────────────
async function getConnection(id: string | null, userId: string, supabase: any) {
  if (!id) return null;
  if (supabase) {
    const { data } = await supabase
      .from('exchange_connections')
      .select('*')
      .eq('id', id).eq('user_id', userId)
      .single();
    return data;
  }
  return MEM_STORE.find(r => r.id === id && r.user_id === userId) || null;
}
