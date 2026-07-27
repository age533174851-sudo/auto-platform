// /api/health/security
// 배포 전 보안 준비 상태 점검.
// 실제 키 값은 절대 노출하지 않고, 설정 여부와 위험 상태만 보고한다.
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface Check {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  blocksLiveTrading: boolean;
}

export async function GET() {
  const checks: Check[] = [];
  const isProd = process.env.NODE_ENV === 'production';

  // ── 암호화 키 ──
  const encKey = process.env.EXCHANGE_ENCRYPTION_KEY;
  checks.push({
    id: 'encryption_key',
    label: '거래소 secret 암호화 키',
    status: !encKey ? 'fail' : encKey.length < 32 ? 'fail' : 'ok',
    detail: !encKey
      ? 'EXCHANGE_ENCRYPTION_KEY 미설정 — 거래소 키를 저장·복호화할 수 없습니다. `openssl rand -hex 32`로 생성하세요'
      : encKey.length < 32 ? `길이 부족 (${encKey.length}자, 32자 이상 필요)` : '설정됨',
    blocksLiveTrading: true,
  });

  // ── 웹훅 시크릿 ──
  const tvSecret = process.env.TRADINGVIEW_WEBHOOK_SECRET;
  const legacySecret = process.env.WEBHOOK_SECRET;
  checks.push({
    id: 'webhook_secret',
    label: '웹훅 인증 시크릿',
    status: (tvSecret || legacySecret) ? 'ok' : 'fail',
    detail: (tvSecret || legacySecret)
      ? '설정됨 (미설정 시 웹훅은 503으로 거부됩니다)'
      : 'TRADINGVIEW_WEBHOOK_SECRET 미설정 — 웹훅이 모두 거부됩니다',
    blocksLiveTrading: true,
  });

  // ── 개발용 인증 우회 ──
  const devBypass = process.env.DEV_AUTH_BYPASS_TOKEN;
  checks.push({
    id: 'dev_auth_bypass',
    label: '개발용 인증 우회',
    status: isProd && devBypass ? 'fail' : devBypass ? 'warn' : 'ok',
    detail: isProd && devBypass
      ? '운영 환경에 DEV_AUTH_BYPASS_TOKEN이 설정되어 있습니다 — 즉시 제거하세요'
      : devBypass ? '개발 환경 우회 활성 (운영 배포 전 제거)' : '비활성 (정상)',
    blocksLiveTrading: isProd && !!devBypass,
  });

  // ── Supabase ──
  const hasSb = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!process.env.NEXT_PUBLIC_SUPABASE_URL;
  checks.push({
    id: 'supabase',
    label: 'Supabase 연결',
    status: hasSb ? 'ok' : 'fail',
    detail: hasSb ? '설정됨' : 'DB 미설정 — 중복 방지·손실 한도가 메모리에만 남아 재시작 시 사라집니다',
    blocksLiveTrading: true,
  });

  // ── 실거래 잠금 ──
  const liveAllowed = process.env.ALLOW_LIVE_TRADING === 'true';
  checks.push({
    id: 'live_trading_lock',
    label: '실거래 잠금',
    status: liveAllowed ? 'warn' : 'ok',
    detail: liveAllowed
      ? '⚠️ 실거래가 해제되어 있습니다 — 실제 자금이 움직입니다'
      : '잠김 (테스트넷/모의만 가능). 해제하려면 ALLOW_LIVE_TRADING=true',
    blocksLiveTrading: false,
  });

  // ── 키 분리 ──
  const keyReused = !!encKey && encKey === process.env.SUPABASE_SERVICE_ROLE_KEY;
  checks.push({
    id: 'key_separation',
    label: '암호화 키 분리',
    status: keyReused ? 'warn' : 'ok',
    detail: keyReused
      ? 'SUPABASE_SERVICE_ROLE_KEY를 암호화 키로 재사용 중 — 전용 키를 쓰세요'
      : '전용 키 사용 중',
    blocksLiveTrading: false,
  });

  const failed = checks.filter(c => c.status === 'fail');
  const blockers = checks.filter(c => c.status === 'fail' && c.blocksLiveTrading);

  return NextResponse.json({
    ok: failed.length === 0,
    readyForLiveTrading: blockers.length === 0 && liveAllowed,
    summary: failed.length === 0
      ? '보안 점검 통과'
      : `${failed.length}건 실패 — ${blockers.length}건은 거래를 차단합니다`,
    checks,
    checkedAt: new Date().toISOString(),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
