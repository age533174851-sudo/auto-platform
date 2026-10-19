// /api/autotrade/smoke-test/preflight
//
// **주문만 빼고, 실주문 스모크가 거치는 관문을 전부 거친다.**
//
// 왜 이 경로가 필요한가
// ─────────────────────
// PR #335가 스모크 **시작**을 무인으로 열었다. 그런데 "시작해도 되는
// 상태인가"를 확인할 길은 아직 브라우저뿐이었다 —
// `/api/binance/futures/diagnose`도 `/api/exchange/testnet-check`도
// 사람의 JWT를 요구한다.
//
// 그래서 TESTNET 검증 절차에 이런 문장이 남아 있었다:
// *"실행 전에 화면을 열어 연결 상태를 확인해 주세요."*
// 그 문장을 지우는 것이 이 파일이다. 확인을 건너뛰면 **실주문으로
// 설정 문제를 발견하게 된다** — 배관을 확인하려고 물을 흘리는 셈이다.
//
// 무엇을 하지 않는가
// ──────────────────
// · **주문을 내지 않는다.** 거래소에는 조회만 한다
//   (포지션 · 조건부 주문). 쓰기 엔드포인트를 부르지 않는다.
// · **DB에 쓰지 않는다.** `smoke_runs` · `smoke_tests` 모두 select만.
// · **고치지 않는다.** 막힌 것을 치워 주지 않는다 — 치우는 길은
//   `/orphans`와 `/settle`에 따로 있고, 점검이 상태를 바꾸면
//   "점검했더니 통과"가 점검이 만든 결과가 된다.
// · **확인 문구를 요구하지 않는다.** 확인 문구는 실주문의 표시다
//   (`headlessPreflightVerdict` 주석 참조).
//
// 판정을 복제하지 않는다
// ──────────────────────
// 여기서 부르는 판정은 전부 `startAttempt`가 부르는 바로 그 함수들이다
// (`smokeTestnetVerdict` · `unresolvedExposureBlock` · `killSwitchGate` ·
// `resolveExitPolicy` · `liquidationGuard` · `preflightVerdict`).
// 같은 판단을 두 벌 두면 언젠가 갈리고, 그러면 **점검은 초록인데
// 시작은 막히는** 가장 쓸모없는 결과가 나온다.

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import {
  smokeTestnetVerdict, unresolvedExposureBlock, preflightVerdict,
} from '@/lib/smoke/smokePlan';
import { headlessPreflightVerdict } from '@/lib/smoke/smokeRun';
import { buildPreflightReport, type PreflightFacts } from '@/lib/smoke/preflightReport';
import { resolveExitPolicy, liquidationGuard, DEFAULT_EXIT_POLICY_ID } from '@/lib/strategies/exitPolicy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const isMissing = (m: any) => /does not exist|schema cache|relation/i.test(String(m));

/** 길이까지 숨기지는 못하지만 타이밍으로 값을 흘리지 않는다 */
function safeEqual(a: any, b: any): boolean {
  const x = String(a ?? ''); const y = String(b ?? '');
  if (!x || !y || x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
}

/** 스모크 장부 조회 상한. `startAttempt`와 같은 숫자여야 한다 */
const LEDGER_LIMIT = 1000;

export async function POST(req: NextRequest) {
  let body: any = {};
  try { body = await req.json(); } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }

  // ── 누가 불렀는가 ──
  const adminSecret = process.env.ADMIN_SECRET || '';
  const byAdmin = !!adminSecret && safeEqual(req.headers.get('x-admin-secret'), adminSecret);

  let userId: string | null;
  let connectionId: string;
  if (byAdmin) {
    const hv = headlessPreflightVerdict(body);
    if (!hv.ok || !hv.userId || !hv.connectionId) {
      return NextResponse.json({ ok: false, error: hv.code.toLowerCase(), message: hv.message },
        { status: 400 });
    }
    userId = hv.userId;
    connectionId = hv.connectionId;
  } else {
    userId = await resolveUserId(
      req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
    if (!userId) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });
    connectionId = String(body?.connectionId ?? '').trim();
    if (!connectionId) {
      return NextResponse.json({ ok: false, error: 'connection_required',
        message: '어느 거래소 연결인지 적어야 합니다' }, { status: 400 });
    }
  }

  const symbol = String(body?.symbol ?? 'BTCUSDT').trim().toUpperCase();
  // 청산가 관문은 배율에 따라 달라진다. 실제로 쓸 값으로 미리 본다.
  const leverageRaw = Number(body?.leverage);
  const leverage = Number.isFinite(leverageRaw) && leverageRaw > 0 ? leverageRaw : 10;
  const exitPolicyId = body?.exitPolicyId ?? DEFAULT_EXIT_POLICY_ID;

  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  // **전부 null로 시작한다.** 보지 못한 항목은 SKIPPED가 되고,
  // SKIPPED는 PASS가 아니다.
  const facts: PreflightFacts = {
    creds: null, testnet: null, ledger: null, exposure: null,
    killSwitch: null, exitPolicy: null, symbol: null, runTable: null,
  };

  // ── 1. 연결 소유권 ──
  //
  // `loadFuturesCreds`가 `id`와 `user_id`를 함께 걸어 읽는다.
  // 남의 연결 id를 적으면 여기서 끝난다.
  const { loadFuturesCreds } = await import('@/lib/exchanges/loadCreds');
  const creds: any = await loadFuturesCreds(sb, userId, connectionId);
  facts.creds = creds.ok
    ? { ok: true, detail: `${creds.exchange} 연결을 읽었습니다` }
    : { ok: false, detail: String(creds.message || '연결을 읽지 못했습니다') };

  // ── 2. 테스트넷 확인 ──
  if (creds.ok) {
    const tv = smokeTestnetVerdict(creds.isTestnetRaw);
    facts.testnet = { ok: tv.ok, reason: tv.reason };
  }

  // ── 3~4. 장부 + 연결 단위 미해결 노출 ──
  //
  // 두 항목을 한 번의 조회로 채운다. 상한에 닿으면 **읽은 것이
  // 아니므로** 장부 항목부터 FAIL이다.
  try {
    const { data, error } = await (sb as any).from('smoke_tests')
      .select('id, connection_id, steps, state')
      .eq('user_id', userId).eq('connection_id', connectionId)
      .order('created_at', { ascending: false }).limit(LEDGER_LIMIT);
    if (error) throw new Error(error.message);
    if (!Array.isArray(data)) throw new Error('스모크 장부 조회 결과가 배열이 아닙니다');

    if (data.length >= LEDGER_LIMIT) {
      facts.ledger = { readable: false,
        reason: `장부가 조회 상한(${LEDGER_LIMIT}건)에 도달했습니다 — `
          + '과거 미해결 노출을 전부 확인할 수 없습니다' };
      // 전부 보지 못했으므로 노출 판정도 하지 않는다 → SKIPPED
    } else {
      facts.ledger = { readable: true, reason: `${data.length}건을 끝까지 읽었습니다` };
      const blk = unresolvedExposureBlock({ rows: data, connectionId });
      facts.exposure = { blocked: blk.blocked, code: blk.code, reason: blk.reason };
    }
  } catch (e: any) {
    const msg = String(e?.message || e);
    facts.ledger = { readable: false,
      reason: isMissing(msg)
        ? `smoke_tests 표가 없습니다 — 마이그레이션 052·053이 적용되지 않았습니다 (${msg})`
        : `장부를 읽지 못했습니다 (${msg})` };
    // 못 읽은 것을 "없음"으로 보지 않는다 — 정본 판정이 그렇게 적는다.
    const blk = unresolvedExposureBlock({ rows: null, connectionId });
    facts.exposure = { blocked: blk.blocked, code: blk.code, reason: blk.reason };
  }

  // ── 5. 킬스위치 ──
  try {
    const { killSwitchGate } = await import('@/lib/risk/killSwitch');
    const ksg: any = await killSwitchGate(sb, connectionId);
    facts.killSwitch = { allowed: !!ksg.allowed, message: String(ksg.message || '') };
  } catch (e: any) {
    facts.killSwitch = { allowed: false,
      message: `킬스위치를 확인하지 못했습니다 (${e?.message || e})` };
  }

  // ── 6. 청산 정책 · 청산가 관문 ──
  {
    const ep = resolveExitPolicy(exitPolicyId);
    if (!ep.ok || !ep.spec) {
      facts.exitPolicy = { ok: false, reason: ep.message };
    } else {
      const lg = liquidationGuard({ leverage, stopPct: ep.spec.stopPct });
      facts.exitPolicy = { ok: lg.ok,
        reason: lg.ok ? `${exitPolicyId} · 배율 ${leverage} — ${lg.reason}` : lg.reason };
    }
  }

  // ── 7. 종목 사전 확인 (거래소 조회만) ──
  //
  // 이 조회가 성공한다는 것은 **주문 계열 인증이 산다**는 뜻이기도
  // 하다. `/fapi/v1/openOrders`는 주문 엔드포인트와 같은 인증 계층을
  // 쓰므로, 여기서 막히면 주문도 막힌다.
  if (creds.ok && facts.testnet?.ok) {
    try {
      const ops = await import('@/lib/engine/venuePositionOps');
      const venue = {
        exchange: creds.exchange, apiKey: creds.key, apiSecret: creds.secret,
        testnet: creds.testnet,
      };
      const pos = await ops.readOpenPosition(venue as any, symbol);
      const orders = await ops.readProtectiveOrders(venue as any, symbol);
      const pf = preflightVerdict({
        position: { ok: pos.ok, found: pos.found, qty: pos.qty },
        orders,
      });
      facts.symbol = { ok: pf.ok, code: pf.code, reason: `${symbol} — ${pf.reason}` };
    } catch (e: any) {
      facts.symbol = { ok: false, code: 'UNKNOWN',
        reason: `${symbol} 조회에 실패했습니다 (${e?.message || e}) — 0건과 다릅니다` };
    }
  }

  // ── 8. 묶음 표 ──
  //
  // 표가 없으면 시작이 503으로 끝난다. 실주문 명령을 누른 뒤에 알
  // 일이 아니다. **줄을 세지 않는다** — 존재만 본다.
  try {
    const { error } = await (sb as any).from('smoke_runs').select('id').limit(1);
    if (error) throw new Error(error.message);
    facts.runTable = { present: true, reason: 'smoke_runs 표가 있습니다' };
  } catch (e: any) {
    const msg = String(e?.message || e);
    facts.runTable = { present: false,
      reason: isMissing(msg)
        ? `smoke_runs 표가 없습니다 — 마이그레이션 053이 적용되지 않았습니다`
        : `묶음 표를 확인하지 못했습니다 (${msg})` };
  }

  const report = buildPreflightReport(facts);

  // **HTTP는 200이다.** 점검 자체는 성공했고, 결과가 "준비되지
  // 않음"일 뿐이다. 둘을 같은 축에 올리면 호출자가 "점검이 실패했다"와
  // "준비가 안 됐다"를 구분하지 못한다. 판정은 본문의 `ready`에 있다.
  return NextResponse.json({
    ok: true,
    ready: report.ready,
    symbol, leverage, exitPolicyId,
    // **id를 통째로 적지 않는다.** 응답은 로그에 그대로 남는다.
    connection: connectionId.slice(0, 8),
    checks: report.checks,
    blockers: report.blockers,
    message: report.summary,
  }, { status: 200, headers: { 'Cache-Control': 'no-store' } });
}
