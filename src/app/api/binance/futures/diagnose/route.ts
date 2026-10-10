// /api/binance/futures/diagnose
// 테스트넷 진단 — 실계좌 가기 전 시스템 검증 체크리스트
// POST { connectionId }
// API연결/잔고조회/시장가정보/레버리지/현재가 등 항목별 성공여부

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { decryptSecret } from '@/lib/exchanges/crypto';
import { binanceTestnetDiagnoseGate } from '@/lib/engine/testnetReadiness';
import { testFuturesConnection, getFuturesBalance, getFuturesPositions, getFuturesTicker, getSymbolFilters } from '@/lib/exchanges/binanceFutures';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface Check { name: string; ok: boolean; detail: string; ms: number; }

export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }

  const uid = await resolveUserId(req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ error: 'auth_required' }, { status: 401 });

  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ error: 'supabase_not_configured' }, { status: 503 });

  const { connectionId } = body;
  if (!connectionId) return NextResponse.json({ error: 'missing_connectionId' }, { status: 400 });

  const { data: conn, error } = await (sb.from('exchange_connections') as any)
    .select('*').eq('id', connectionId).eq('user_id', uid).single();
  if (error || !conn) return NextResponse.json({ error: 'connection_not_found' }, { status: 404 });

  // 호출 전에 검사한다. 이 진단은 Binance TESTNET 전용이고,
  // LIVE 연결의 키로 단 한 번도 거래소에 요청하지 않는다.
  const ciphertext = conn.api_secret_enc || conn.encrypted_secret || '';
  const gate = binanceTestnetDiagnoseGate({
    exchange: conn.exchange_id,
    testnet: conn.is_testnet,
    active: conn.is_active,
    hasWithdrawal: conn.has_withdrawal,
    keyPresent: !!String(conn.api_key ?? '').trim(),
    secretCipherPresent: !!String(ciphertext).trim(),
  });
  if (!gate.ok) {
    return NextResponse.json({ error: gate.code, message: gate.reason }, { status: 409 });
  }

  let secret = '';
  try { secret = decryptSecret(String(ciphertext)); } catch {}
  if (!secret) {
    return NextResponse.json({
      error: 'CREDENTIALS_UNUSABLE',
      message: 'API 시크릿 복호화에 실패했습니다 — 거래소에 요청하지 않았습니다',
    }, { status: 409 });
  }
  const apiKey = String(conn.api_key);
  const testnet = true; // TESTNET 외에는 위 게이트에서 거부했다.

  const checks: Check[] = [];
  const run = async (name: string, fn: () => Promise<{ ok: boolean; detail: string }>) => {
    const t0 = Date.now();
    try { const r = await fn(); checks.push({ name, ...r, ms: Date.now() - t0 }); }
    catch (e: any) { checks.push({ name, ok: false, detail: e?.message || '오류', ms: Date.now() - t0 }); }
  };

  // 1. API 연결과 선물 거래 가능 여부를 분리한다.
  // 계좌 조회 성공이 canTrade=true의 증거는 아니다.
  let exchangeCanTrade = false;
  await run('API 연결', async () => {
    const r = await testFuturesConnection(apiKey, secret, testnet);
    exchangeCanTrade = r.success === true && r.canTrade === true;
    return { ok: r.success, detail: r.success ? 'TESTNET 계정 인증 성공' : r.message };
  });
  checks.push({
    name: '선물 거래 권한',
    ok: exchangeCanTrade && conn.perm_trading === true,
    detail: exchangeCanTrade && conn.perm_trading === true
      ? '거래소와 저장된 거래 권한이 일치합니다 (실제 주문은 내지 않았습니다)'
      : '선물 거래 권한을 확인하지 못했습니다 — 진단 성공을 거래 가능으로 읽지 않습니다',
    ms: 0,
  });
  // 2. 잔고 조회
  await run('잔고 조회', async () => {
    const r = await getFuturesBalance(apiKey, secret, testnet);
    return { ok: r.success, detail: r.message };
  });
  // 3. 포지션 조회
  await run('포지션 조회', async () => {
    const r = await getFuturesPositions(apiKey, secret, testnet);
    return { ok: r.success, detail: r.message };
  });
  // 4. 현재가 조회
  await run('현재가 조회 (BTCUSDT)', async () => {
    const p = await getFuturesTicker('BTCUSDT', testnet);
    return { ok: p !== null && p > 0, detail: p ? `BTC $${Math.round(p).toLocaleString()}` : '실패' };
  });
  // 5. 심볼 규칙 (LOT_SIZE) 조회
  await run('주문 규칙 조회 (LOT_SIZE)', async () => {
    const f = await getSymbolFilters('BTCUSDT', testnet);
    return {
      ok: !!f,
      detail: f
        ? `지정가 step ${f.limitQty?.stepSize ?? '없음'} · 시장가 step ${f.marketQty?.stepSize ?? '없음'}`
          + ` · 최소금액 ${f.minNotional ?? '없음'}`
        : '실패',
    };
  });

  // ── 6~8. **주문 계열 엔드포인트를 따로 본다** ──
  //
  // 왜 필요한가: 화면에 잔고가 멀쩡히 떠 있는데 주문만 -2015로 막히는
  // 일이 있었다. 키 설정에는 Enable Futures까지 켜져 있었다. 위 1~5번은
  // 전부 통과하므로 진단이 'ready'라고 말하는데, 실제로는 주문이 안 된다.
  //
  // 주문을 실제로 내 보지는 않는다 — 진단이 부작용을 만들면 진단을 못
  // 돌린다. 대신 **주문 계열 조회**를 찔러 본다. 인증 계층은 같으므로,
  // 여기가 막히면 주문도 막힌다.
  const { diagnoseFutures, futuresOrderTypes, FUTURES_HOSTS } =
    await import('@/lib/exchanges/binanceFutures');
  const deep = await diagnoseFutures(apiKey, secret, testnet, 'BTCUSDT');

  // ── **이 환경이 어떤 주문 유형을 받는다고 스스로 말하는가** ──
  //
  // 데모가 STOP_MARKET을 거절하는 것을 지금까지는 주문을 실제로 내 봐야
  // 알 수 있었고, 시도마다 진입·청산 수수료가 나갔다(잔고가 4,997 →
  // 4,960으로 줄었다).
  //
  // exchangeInfo는 키도 서명도 필요 없는 공개 조회이고 심볼별 orderTypes를
  // 알려준다. 미리 물어보면 주문 전에 알 수 있다.
  //
  // 이 값을 판단에 그대로 쓰지는 않는다 — 목록에 적어 두고도 거절하는
  // 경우가 있다. **사실을 보여주는** 용도다.
  let stopSupport: any = null;
  try {
    const here = await futuresOrderTypes(testnet ? FUTURES_HOSTS.demo : FUTURES_HOSTS.live, 'BTCUSDT');
    const hasStop = here.ok && here.orderTypes.includes('STOP_MARKET');
    checks.push({
      name: '조건부 주문 지원 (STOP_MARKET)',
      ok: hasStop,
      detail: here.ok
        ? (hasStop
            ? `받습니다 · ${here.orderTypes.length}종`
            : `목록에 없습니다 — 손절을 거래소에 걸 수 없습니다. 지원: ${here.detail}`)
        : `확인하지 못했습니다 (${here.detail})`,
      ms: 0,
    });
    stopSupport = { host: testnet ? FUTURES_HOSTS.demo : FUTURES_HOSTS.live, ...here, hasStop };
  } catch { /* 못 물어봤으면 항목만 빠진다 */ }
  for (const c of deep.checks) {
    // 위에서 이미 본 항목은 건너뛴다
    if (c.path === '/fapi/v1/time' || c.path === '/fapi/v2/balance') continue;
    checks.push({ name: c.name, ok: c.ok, detail: c.detail, ms: 0 });
  }

  const passed = checks.filter(c => c.ok).length;
  const total = checks.length;
  const successRate = total > 0 ? Math.round((passed / total) * 100) : 0;

  // ── 무엇이 원인인지 읽어 준다 ──
  //
  // 표만 주면 사용자가 다시 해석해야 한다. 패턴은 정해져 있다.
  // **모르는 패턴이면 모른다고 한다.**
  const at = (p: string) => deep.checks.find(c => c.path === p)?.ok === true;
  const timeOk = at('/fapi/v1/time');
  const readOk = at('/fapi/v2/balance');
  const oneOk = at('/fapi/v1/order');
  const listOk = at('/fapi/v1/openOrders') || at('/fapi/v1/allOrders');

  let cause: string;
  if (!timeOk) {
    cause = '거래소에 아예 닿지 못했습니다 — 네트워크나 호스트 문제이고 키와 무관합니다.';
  } else if (!readOk && !oneOk && !listOk) {
    cause = '서명이 필요한 요청이 전부 막혔습니다 — 키·환경(테스트넷/실전)·IP 중 하나입니다. '
      + '권한만 문제였다면 잔고는 읽혔을 것입니다.';
  } else if (readOk && !oneOk && listOk) {
    cause = '잔고와 주문 목록은 읽히는데 단건 주문 조회만 막혔습니다 — 키도 환경도 IP도 정상입니다. '
      + '이 엔드포인트가 이 환경(데모)에서 동작하지 않는 것이고, 앱은 목록 조회로 우회해 중복을 확인합니다.';
  } else if (readOk && !listOk) {
    cause = '잔고는 읽히는데 주문 계열 조회가 막혔습니다 — 선물 거래 권한을 확인하세요.';
  } else if (readOk && oneOk && listOk) {
    cause = '주문 계열까지 전부 정상입니다. 주문이 막힌다면 원인은 인증이 아닙니다.';
  } else {
    cause = '흔치 않은 조합입니다 — 위 표를 그대로 보고하세요.';
  }

  return NextResponse.json({
    testnet, checks, passed, total, successRate,
    verdict: successRate === 100 ? 'ready' : successRate >= 60 ? 'partial' : 'failed',
    // TESTNET 호스트만 공개한다. API 키 일부라도 응답에 싣지 않는다.
    host: deep.host,
    stopSupport,
    cause,
    at: Date.now(),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
