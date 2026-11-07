// /api/exchange/testnet-check
// 2단계 검증용: 거래소 테스트넷 연결 확인 (시세 수신 + 계좌 조회).
// 서버 전용. 키는 환경변수에서만 읽고 응답에 절대 포함하지 않는다.
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/isAdmin';
import { envHealthProbeVerdict } from '@/lib/exchanges/testnetHealthGate';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface CheckResult {
  exchange: string;
  configured: boolean;
  publicOk: boolean;
  privateOk: boolean;
  lastPrice?: string;
  balance?: string;
  latencyMs?: number;
  error?: string;
}

async function checkBinanceFutures(testnet: boolean): Promise<CheckResult> {
  const out: CheckResult = { exchange: `binance-futures(${testnet ? 'testnet' : 'live'})`, configured: false, publicOk: false, privateOk: false };
  const t0 = Date.now();
  const key = process.env.BINANCE_API_KEY;
  const secret = process.env.BINANCE_API_SECRET;
  out.configured = !!(key && secret);

  const base = testnet ? 'https://demo-fapi.binance.com' : 'https://fapi.binance.com';
  try {
    const r = await fetch(`${base}/fapi/v1/ticker/price?symbol=BTCUSDT`, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (r.ok) { const d = await r.json(); out.publicOk = true; out.lastPrice = d?.price; }
    else out.error = `시세 ${r.status}`;
  } catch (e: any) { out.error = `시세 실패: ${e?.message || e}`; }

  if (out.configured && out.publicOk) {
    try {
      const { getFuturesBalance } = await import('@/lib/exchanges/binanceFutures');
      const res: any = await getFuturesBalance(key!, secret!, testnet);
      if (res?.success) {
        out.privateOk = true;
        const usdt = (res.balances || []).find((b: any) => b.asset === 'USDT');
        out.balance = usdt ? String(usdt.availableBalance) : '0';
      } else {
        out.error = `계좌 실패: ${res?.message || '알 수 없음'}`;
      }
    } catch (e: any) { out.error = `계좌 실패: ${e?.message || e}`; }
  }
  out.latencyMs = Date.now() - t0;
  return out;
}

async function checkGateFutures(testnet: boolean): Promise<CheckResult> {
  const key = process.env.GATE_API_KEY;
  const secret = process.env.GATE_API_SECRET;
  const { checkGateFuturesConnection } = await import('@/lib/exchanges/gateFutures');
  const r = await checkGateFuturesConnection(key, secret, 'BTC_USDT', testnet);
  return {
    exchange: `gate-futures(${testnet ? 'testnet' : 'live'})`,
    configured: !!(key && secret),
    publicOk: r.publicOk, privateOk: r.privateOk,
    lastPrice: r.lastPrice, balance: r.balance, latencyMs: r.latencyMs, error: r.error,
  };
}

export async function GET(req: NextRequest) {
  // 환경변수 키의 계좌 상태는 서비스 전체의 비공개 정보다.
  // Authorization Bearer를 Supabase가 검증하고 profiles.role을 확인한다.
  // 쿠키나 x-user-id, 요청 쿼리의 역할 주장을 인증으로 사용하지 않는다.
  const guard = await requireAdmin(req.headers.get('authorization'));
  if (guard instanceof Response) return guard;

  const url = new URL(req.url);
  const policy = envHealthProbeVerdict({
    hasLiveQuery: url.searchParams.has('live'),
    exchange: url.searchParams.get('exchange'),
  });
  if (!policy.ok) {
    return NextResponse.json({ error: policy.code }, {
      status: policy.code === 'LIVE_PROBE_FORBIDDEN' ? 403 : 400,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
  const only = policy.exchange;
  // 이 경로에서는 LIVE를 선택할 방법이 없다. 실계좌 진단은 별도의
  // 명시적 승인/계정별 접근 제어가 있는 전용 경로에서만 해야 한다.
  const testnet = true;

  const tasks: Promise<CheckResult>[] = [];
  if (!only || only === 'binance') tasks.push(checkBinanceFutures(testnet));
  if (!only || only === 'gate') tasks.push(checkGateFutures(testnet));

  const results = await Promise.all(tasks.map(p => p.catch((e): CheckResult => ({
    exchange: 'unknown', configured: false, publicOk: false, privateOk: false, error: String(e?.message || e),
  }))));

  const allOk = results.some(r => r.publicOk && r.privateOk);
  return NextResponse.json({
    ok: allOk,
    mode: testnet ? 'testnet' : 'live',
    checkedAt: new Date().toISOString(),
    results,
    hint: results.every(r => !r.configured)
      ? 'API 키가 설정되지 않았습니다. Vercel 환경변수에 BINANCE_API_KEY/SECRET 또는 GATE_API_KEY/SECRET을 추가하세요.'
      : undefined,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
