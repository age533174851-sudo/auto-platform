// POST /api/risk/kill-switch/reset
// { connectionId } — 스냅샷 baseline을 현재 equity로 재설정 + active 해제

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { decryptSecret } from '@/lib/exchanges/crypto';
import { getFuturesBalance } from '@/lib/exchanges/binanceFutures';
import { loadKillSwitch, saveKillSwitch, computeUsdtEquity, logKillEvent } from '@/lib/risk/killSwitch';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }
  const uid = await resolveUserId(req.headers.get('authorization'), req.headers.get('x-user-id'));
  if (!uid) return NextResponse.json({ error: 'auth_required' }, { status: 401 });
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ error: 'supabase_not_configured' }, { status: 503 });

  const { connectionId } = body;
  if (!connectionId) return NextResponse.json({ error: 'missing_connectionId' }, { status: 400 });

  const { data: conn } = await (sb.from('exchange_connections') as any)
    .select('*').eq('id', connectionId).eq('user_id', uid).single();
  if (!conn) return NextResponse.json({ error: 'connection_not_found' }, { status: 404 });

  const s = await loadKillSwitch(sb, uid, connectionId);
  if (s.noTable) return NextResponse.json({ error: 'table_missing', message: 'kill_switch_state 테이블이 없습니다.' }, { status: 503 });

  let secret = '';
  try { secret = decryptSecret(conn.api_secret_enc || conn.encrypted_secret || ''); } catch {}
  const testnet = conn.is_testnet === true;
  const bal = await getFuturesBalance(conn.api_key || '', secret, testnet);
  const equity = bal.success ? computeUsdtEquity(bal.balances as any) : 0;

  const now = Date.now();
  s.active = false; s.triggeredAt = null; s.triggerReason = null;
  s.dailyStartEquity = equity;   s.dailyStartAt = now;
  s.weeklyStartEquity = equity;  s.weeklyStartAt = now;
  s.monthlyStartEquity = equity; s.monthlyStartAt = now;

  const ok = await saveKillSwitch(sb, uid, connectionId, s);
  if (!ok) return NextResponse.json({ error: 'save_failed' }, { status: 500 });
  await logKillEvent(sb, uid, connectionId, { reason: '사용자 리셋', equity, drawdownPct: 0, action: 'RESET', mode: testnet ? 'TESTNET' : 'LIVE' });
  return NextResponse.json({ ok: true, equity, resetAt: now });
}
