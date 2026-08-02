// /api/exchange/kis — 한국투자증권 연결
//
// 왜 공용 거래소 라우트를 안 쓰는가
// ─────────────────────────────────
// 코인 거래소는 키·시크릿(+가끔 패스프레이즈)이면 끝이다. 증권사는
// **계좌번호**가 하나 더 필요하고, 접근토큰을 따로 발급받아 캐시해야 한다.
// 공용 라우트에 그것들을 끼워 넣으면 코인 쪽 흐름에 안 쓰는 분기가 늘고,
// 늘어난 분기는 언젠가 한쪽만 고쳐진다.
//
// 확인 안 된 연결은 저장하지 않는다
// ─────────────────────────────────
// 먼저 저장하고 나중에 테스트하면, 테스트가 실패해도 화면에는 연결이
// 하나 생긴다. 사용자는 그것을 보고 "연결됐다"고 믿는다. 그래서
// **성공한 것만 저장한다.**
//
// 그리고 토큰 발급만으로 성공이라 하지 않는다. 토큰은 앱키만 맞으면
// 나오므로 **계좌번호가 틀려도 통과한다.** 잔고까지 읽어야 진짜 확인이다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { splitAccountNo } from '@/lib/exchanges/kisCore';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function maskKey(k: string): string {
  const s = String(k || '');
  if (s.length <= 8) return '****';
  return `${s.slice(0, 4)}****${s.slice(-4)}`;
}

/** 계좌번호는 통째로 보여주지 않는다. 화면 확인용으로 뒤 네 자리만. */
function maskAccount(a: string): string {
  const s = String(a || '').replace(/[^0-9]/g, '');
  if (s.length !== 10) return '****';
  return `****${s.slice(4, 8)}-${s.slice(8)}`;
}

export async function POST(req: NextRequest) {
  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  let body: any = {};
  try { body = await req.json(); } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }

  const action = String(body.action || 'connect');
  const { testKisConnection } = await import('@/lib/exchanges/kis');
  const { supabaseTokenCache } = await import('@/lib/exchanges/kisTokenCache');
  const { encryptSecret, decryptSecret } = await import('@/lib/exchanges/crypto');

  // ── 기존 연결 다시 테스트 ──
  if (action === 'test') {
    const { data: conn } = await (sb as any)
      .from('exchange_connections')
      .select('id, api_key, api_secret_enc, account_no, is_testnet')
      .eq('id', String(body.connectionId || '')).eq('user_id', uid).eq('exchange_id', 'kis')
      .maybeSingle();
    if (!conn) {
      return NextResponse.json({ ok: false, error: 'connection_not_found' }, { status: 404 });
    }
    const r = await testKisConnection({
      appKey: String(conn.api_key || ''),
      appSecret: decryptSecret(conn.api_secret_enc ?? ''),
      accountNo: String(conn.account_no || ''),
      env: conn.is_testnet === false ? 'LIVE' : 'PAPER',
    }, supabaseTokenCache(sb, conn.id));

    // 테스트 결과를 남긴다. 성공했든 실패했든 **언제 확인했는지**가
    // 없으면 화면은 그 연결이 지금도 되는지 알 수 없다.
    await (sb as any).from('exchange_connections').update({
      last_tested_at: new Date().toISOString(),
      test_status: r.ok ? 'ok' : 'failed',
    }).eq('id', conn.id);

    return NextResponse.json({ ...r }, { headers: { 'Cache-Control': 'no-store' } });
  }

  // ── 새 연결 ──
  const appKey = String(body.appKey || '').trim();
  const appSecret = String(body.appSecret || '').trim();
  const accountNo = String(body.accountNo || '').trim();
  // 모의투자가 기본이다. 실전은 **명시적으로** 골라야 한다 —
  // 이 저장소 전체가 쓰는 규칙과 같다(모르는 값이 실전이 되면 안 된다).
  const isLive = body.isLive === true;

  if (!appKey || !appSecret || !accountNo) {
    return NextResponse.json({ ok: false, error: 'missing_params',
      message: '앱키 · 앱시크릿 · 계좌번호가 모두 필요합니다' }, { status: 400 });
  }
  const acct = splitAccountNo(accountNo);
  if (!acct) {
    return NextResponse.json({ ok: false, error: 'invalid_account',
      message: '계좌번호는 숫자 10자리입니다 (앞 8자리 + 상품코드 2자리). 예: 12345678-01' },
      { status: 400 });
  }

  // **저장하기 전에** 확인한다. 확인 안 된 연결이 목록에 생기면
  // 사용자는 그것을 보고 연결됐다고 믿는다.
  //
  // 캐시는 아직 없다(연결 id가 없으니까). getAccessToken이 그 사실을
  // cacheNote로 알려주지만, 이 한 번은 캐시 없이 받는 것이 맞다.
  const creds = {
    appKey, appSecret,
    accountNo: `${acct.cano}${acct.acntPrdtCd}`,
    env: (isLive ? 'LIVE' : 'PAPER') as 'LIVE' | 'PAPER',
  };
  const test = await testKisConnection(creds, null);
  if (!test.ok) {
    return NextResponse.json({
      ok: false, error: 'kis_test_failed', message: test.message,
      // 어느 환경으로 시도했는지 적는다. 모의 키로 실전을 부르면
      // "인증 실패"만 뜨고 원인이 안 보인다.
      env: creds.env,
      hint: isLive
        ? '실전 앱키인지 확인하세요. 모의투자 앱키는 실전 서버에서 인증되지 않습니다'
        : '모의투자 앱키인지 확인하세요. 실전 앱키는 모의 서버에서 인증되지 않습니다',
    }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }

  const row = {
    user_id: uid,
    exchange_id: 'kis',
    exchange: 'kis',
    label: String(body.nickname || '').trim() || (isLive ? '한국투자증권 실전' : '한국투자증권 모의'),
    api_key: appKey,
    api_key_masked: maskKey(appKey),
    api_secret_enc: encryptSecret(appSecret),
    account_no: creds.accountNo,
    is_testnet: !isLive,
    is_active: true,
    // 증권사 앱키에는 출금 권한 개념이 없다. false로 **확인해서** 넣는다 —
    // null로 두면 다른 화면들이 '확인 불가'로 읽고 주문을 막는다.
    has_withdrawal: false,
    last_tested_at: new Date().toISOString(),
    test_status: 'ok',
  };

  const { data: saved, error } = await (sb as any)
    .from('exchange_connections')
    .upsert(row, { onConflict: 'user_id,exchange_id' })
    .select('id')
    .single();
  if (error) {
    return NextResponse.json({ ok: false, error: 'save_failed',
      // 연결은 됐는데 저장이 안 된 것이다. 그 구분을 그대로 전한다 —
      // '연결 실패'로 뭉개면 키를 다시 발급받으러 간다.
      message: `한국투자증권 연결은 확인됐는데 저장에 실패했습니다: ${error.message}` },
      { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    connectionId: saved?.id ?? null,
    env: creds.env,
    accountMasked: maskAccount(creds.accountNo),
    message: test.message,
    cacheNote: test.cacheNote,
  }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function GET(req: NextRequest) {
  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  const { data, error } = await (sb as any)
    .from('exchange_connections')
    .select('id, label, api_key_masked, account_no, is_testnet, last_tested_at, test_status, created_at')
    .eq('user_id', uid).eq('exchange_id', 'kis')
    .order('created_at', { ascending: false });
  if (error) {
    return NextResponse.json({ ok: false, error: 'read_failed', message: error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    connections: (data || []).map((c: any) => ({
      id: c.id,
      label: c.label,
      apiKeyMasked: c.api_key_masked,
      accountMasked: maskAccount(c.account_no),
      // is_testnet === false 만 실전이다. 모르는 값이 실전으로 읽히면 안 된다.
      isLive: c.is_testnet === false,
      lastTestedAt: c.last_tested_at,
      testStatus: c.test_status,
    })),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
