// /api/binance/futures/diagnose
// 테스트넷 진단 — 실계좌 가기 전 시스템 검증 체크리스트
// POST { connectionId }
// API연결/잔고조회/시장가정보/레버리지/현재가 등 항목별 성공여부

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { decryptSecret } from '@/lib/exchanges/crypto';
import { testFuturesConnection, getFuturesBalance, getFuturesPositions, getFuturesTicker, getSymbolFilters } from '@/lib/exchanges/binanceFutures';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface Check { name: string; ok: boolean; detail: string; ms: number; }

export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }

  const uid = await resolveUserId(req.headers.get('authorization'), req.headers.get('x-user-id'));
  if (!uid) return NextResponse.json({ error: 'auth_required' }, { status: 401 });

  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ error: 'supabase_not_configured' }, { status: 503 });

  const { connectionId } = body;
  if (!connectionId) return NextResponse.json({ error: 'missing_connectionId' }, { status: 400 });

  const { data: conn, error } = await (sb.from('exchange_connections') as any)
    .select('*').eq('id', connectionId).eq('user_id', uid).single();
  if (error || !conn) return NextResponse.json({ error: 'connection_not_found' }, { status: 404 });

  let secret = '';
  try { secret = decryptSecret(conn.api_secret_enc || conn.encrypted_secret || ''); } catch {}
  const apiKey = conn.api_key || '';
  const testnet = conn.is_testnet === true;

  const checks: Check[] = [];
  const run = async (name: string, fn: () => Promise<{ ok: boolean; detail: string }>) => {
    const t0 = Date.now();
    try { const r = await fn(); checks.push({ name, ...r, ms: Date.now() - t0 }); }
    catch (e: any) { checks.push({ name, ok: false, detail: e?.message || '오류', ms: Date.now() - t0 }); }
  };

  // 1. API 연결
  await run('API 연결', async () => {
    const r = await testFuturesConnection(apiKey, secret, testnet);
    return { ok: r.success, detail: r.success ? `잔고 ${r.totalBalance?.toFixed(2)} USDT` : r.message };
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
    return { ok: !!f, detail: f ? `최소수량 ${f.minQty}, step ${f.stepSize}` : '실패' };
  });

  const passed = checks.filter(c => c.ok).length;
  const total = checks.length;
  const successRate = total > 0 ? Math.round((passed / total) * 100) : 0;

  return NextResponse.json({
    testnet, checks, passed, total, successRate,
    verdict: successRate === 100 ? 'ready' : successRate >= 60 ? 'partial' : 'failed',
    at: Date.now(),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
