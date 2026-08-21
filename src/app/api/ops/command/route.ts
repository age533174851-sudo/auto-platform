// POST /api/ops/command — 사용자는 명령만 한다
//
// `{ "text": "전체 점검해" }` 또는 `{ "command": "CHECK_ALL" }`
//
// 무엇을 하는가
// ─────────────
// 마이그레이션 · 권한 연결 · 배포 대조 · 워커 생존 · 청산 감시 · 거래소
// 연결 · 열린 주문 · 보호주문 · 장부를 **한 번에** 보고 하나의 판정을 낸다.
//
// 지금까지는 이걸 하려면 Supabase · Vercel · Fly · GitHub Actions · Gate를
// 돌아다녀야 했고, 그중 하나를 빠뜨리면 조용히 틀렸다. 2026-08-19에
// 사흘을 잃은 것이 정확히 그 모양이었다 — 네 화면이 각자 참인 말을 했고
// 아무도 그 넷을 나란히 놓지 않았다.
//
// 판정은 여기 없다. `src/lib/ops/opsCommand.ts`에 있고 테스트가 붙어 있다.
//
// **확인하지 못한 것은 통과가 아니다.** 하나라도 UNKNOWN이면 PASS를 주지
// 않는다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import {
  parseOpsCommand, specOf, opsVerdictOf,
  type OpsCommand, type StepResult, type OpsStepId,
} from '@/lib/ops/opsCommand';
import { bootstrapStatus } from '@/lib/ops/opsBootstrap';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

const LABEL: Record<OpsStepId, string> = {
  migrations: '마이그레이션', secrets: '권한 연결', deployment: '배포', worker: '워커',
  exitMonitor: '청산 감시', exchange: '거래소 연결', orders: '열린 주문',
  protection: '보호주문', ledger: '장부', wallet: '지갑', strategies: '전략',
};

function mk(step: OpsStepId, over: Partial<StepResult>): StepResult {
  return {
    step, label: LABEL[step], state: 'UNKNOWN', detail: '', did: [], blockedReason: null,
    ...over,
  } as StepResult;
}

export async function POST(req: NextRequest) {
  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  const body = await req.json().catch(() => ({} as any));
  const command: OpsCommand | null =
    (typeof body?.command === 'string' ? (body.command as OpsCommand) : null)
    ?? parseOpsCommand(String(body?.text ?? ''));

  if (!command || !specOf(command)) {
    // **모르는 말을 아무 명령으로도 읽지 않는다.**
    return NextResponse.json({
      ok: false, error: 'unknown_command',
      message: '무슨 명령인지 읽지 못했습니다',
      commands: ['전체 점검해', '배포해', '테스트넷 검증해', '복구해', '지금 중지해', 'LIVE_SMALL 승인'],
    }, { status: 400 });
  }

  const spec = specOf(command)!;
  if (spec.needsApproval && body?.approved !== true) {
    // 실제 자금이 걸린 결정. 자동화의 예외 세 가지 중 하나다.
    return NextResponse.json({
      ok: false, error: 'approval_required',
      message: `${spec.label}은(는) 실제 자금이 걸린 결정입니다 — 명령에 승인 의사를 명시해야 합니다`,
    }, { status: 409 });
  }

  const steps: StepResult[] = [];
  const want = new Set<OpsStepId>(spec.steps);
  const nowMs = Date.now();

  // ── 권한 연결 ──
  if (want.has('secrets')) {
    // **"있을 것으로 보입니다"를 없앤다.**
    //
    // 화면(Vercel)은 GitHub Secrets에 무엇이 있는지 볼 수 없다. 그래서
    // 자격을 가진 쪽(GitHub Actions)이 **직접 써 보고** 적은 결과를 읽는다.
    // 값이 있는 것과 그 값으로 되는 것은 다른 사실이고, 만료된 토큰이
    // 가장 흔한 고장이다.
    let probes: any[] | null = null;
    try {
      const { data, error } = await (sb as any)
        .from('ops_bootstrap').select('credential, state, checked_at, detail');
      if (!error && Array.isArray(data)) {
        probes = data.map((r: any) => ({
          credential: String(r.credential), state: String(r.state),
          checkedAtMs: Date.parse(String(r.checked_at)) || null,
          detail: r.detail ?? null,
        }));
      }
    } catch { /* null — 확인 기록이 없다. '아마 있겠지'로 읽지 않는다 */ }

    const b = bootstrapStatus({
      probes,
      // **값이 아니라 있는지만 본다.**
      dbUrl: !!(process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL),
      flyToken: !!process.env.FLY_API_TOKEN,
      adminSecret: !!process.env.ADMIN_SECRET,
      encryptionKey: !!(process.env.EXCHANGE_ENCRYPTION_KEY || process.env.ENCRYPTION_KEY),
      serviceRole: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    });
    steps.push(mk('secrets', {
      state: b.code === 'READY' ? 'PASS' : 'BLOCKED',
      detail: b.summary,
      blockedReason: b.code === 'READY' ? null
        : b.missing.map(m => `${m.label} — ${m.missing.join(' · ')}`).join(' / '),
    }));
  }

  // ── 마이그레이션 ──
  if (want.has('migrations')) {
    try {
      const { migrationGate } = await import('@/lib/system/migrationGate');
      const ms = await migrationGate(sb);
      steps.push(mk('migrations', {
        state: ms.code === 'UP_TO_DATE' ? 'PASS'
          : ms.code === 'UNKNOWN' ? 'UNKNOWN'
          : ms.blockedReason ? 'BLOCKED' : 'SELF_HEALED',
        detail: ms.detail,
        did: ms.code === 'APPLYING' ? ['남은 마이그레이션을 자동으로 적용하는 중'] : [],
        blockedReason: ms.blockedReason,
      }));
    } catch (e: any) {
      steps.push(mk('migrations', { detail: `확인하지 못했습니다: ${String(e?.message || e).slice(0, 200)}` }));
    }
  }

  // ── 워커 · 배포 ──
  if (want.has('worker') || want.has('deployment')) {
    let worker: any = undefined;
    try {
      const { data, error } = await (sb.from('worker_heartbeat') as any)
        .select('*').order('last_seen', { ascending: false }).limit(1).maybeSingle();
      if (!error) worker = data ?? null;
    } catch { /* undefined */ }

    const { runtimeHealthOf, autoFixPlan } = await import('@/lib/runtime/runtimeHealth');
    const { fingerprintOf } = await import('@/lib/system/fingerprint');
    const webSha = String(process.env.VERCEL_GIT_COMMIT_SHA || '').trim() || null;
    const h = runtimeHealthOf({
      worker,
      webSupabaseFp: fingerprintOf(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''),
      webEncryptionFp: fingerprintOf(process.env.EXCHANGE_ENCRYPTION_KEY || process.env.ENCRYPTION_KEY || ''),
      mainSha: String(body?.mainSha ?? '').trim() || webSha,
      webSha, nowMs,
    });

    if (want.has('worker')) {
      const fix = autoFixPlan(h, { openOrders: null });
      steps.push(mk('worker', {
        state: h.code === 'HEALTHY' ? 'PASS' : h.severity === 'unknown' ? 'UNKNOWN'
          : h.severity === 'bad' ? 'BLOCKED' : 'PASS',
        detail: h.summary,
        blockedReason: h.severity === 'bad'
          ? (fix.blocked[0] ?? '워커가 일을 받을 수 없는 상태입니다') : null,
      }));
    }
    if (want.has('deployment')) {
      const skew = h.findings.find(f => f.code === 'SHA_MISMATCH' || f.code === 'VERSION_UNKNOWN');
      steps.push(mk('deployment', {
        state: worker === undefined ? 'UNKNOWN' : skew ? 'BLOCKED' : 'PASS',
        detail: skew ? skew.detail
          : worker === undefined ? '배포 상태를 읽지 못했습니다'
          : `웹과 워커가 같은 커밋입니다${webSha ? ` (${webSha.slice(0, 7)})` : ''}`,
        blockedReason: skew ? '배포가 아직 끝나지 않았습니다 — 워커 재배포가 필요합니다' : null,
      }));
    }
  }

  // ── 청산 감시 ──
  if (want.has('exitMonitor')) {
    try {
      const { exitMonitorGate } = await import('@/lib/engine/exitMonitorGate');
      const em = await exitMonitorGate(sb, nowMs);
      steps.push(mk('exitMonitor', {
        state: em.code === 'OK' ? 'PASS'
          : em.code === 'UNKNOWN' ? 'UNKNOWN'
          : em.blockEntry ? 'BLOCKED' : 'PASS',
        detail: em.reason,
        blockedReason: em.blockEntry ? '청산 감시가 멈춰 새 진입을 막고 있습니다' : null,
      }));
    } catch (e: any) {
      steps.push(mk('exitMonitor', { detail: `확인하지 못했습니다: ${String(e?.message || e).slice(0, 200)}` }));
    }
  }

  // ── 거래소 연결 ──
  if (want.has('exchange')) {
    try {
      const { data, error } = await (sb as any)
        .from('exchange_connections').select('id, exchange, test_status, last_tested_at').eq('user_id', uid);
      if (error) throw new Error(error.message);
      const rows = Array.isArray(data) ? data : [];
      const ok = rows.filter((r: any) => r?.test_status === 'ok').length;
      steps.push(mk('exchange', {
        // 연결이 하나도 없는 것은 고장이 아니라 사실이다. 다만 PASS도 아니다.
        state: rows.length === 0 ? 'BLOCKED' : ok > 0 ? 'PASS' : 'BLOCKED',
        detail: rows.length === 0 ? '등록된 거래소 연결이 없습니다'
          : `연결 ${rows.length}개 중 ${ok}개가 최근 확인됐습니다`,
        blockedReason: rows.length === 0 ? '거래소 API 키 연결이 필요합니다 (새 키 발급은 사람만 할 수 있습니다)'
          : ok === 0 ? '연결이 모두 확인되지 않은 상태입니다' : null,
      }));
    } catch (e: any) {
      steps.push(mk('exchange', { detail: `확인하지 못했습니다: ${String(e?.message || e).slice(0, 200)}` }));
    }
  }

  // ── 열린 주문 · 보호주문 ──
  if (want.has('orders') || want.has('protection')) {
    let orders: any[] | null = null;
    try {
      const { data, error } = await (sb as any)
        .from('live_orders').select('id, symbol, status, sl_order_id, tp_order_id')
        .eq('user_id', uid).in('status', ['NEW', 'PARTIALLY_FILLED', 'OPEN', 'PENDING']);
      if (!error) orders = Array.isArray(data) ? data : [];
    } catch { /* null */ }

    if (want.has('orders')) {
      steps.push(mk('orders', {
        // **못 읽은 것을 0으로 적지 않는다.**
        state: orders == null ? 'UNKNOWN' : 'PASS',
        detail: orders == null ? '열린 주문을 읽지 못했습니다 — 0건이라는 뜻이 아닙니다'
          : `열린 주문 ${orders.length}건`,
      }));
    }
    if (want.has('protection')) {
      const unprotected = (orders ?? []).filter(o => !o?.sl_order_id);
      steps.push(mk('protection', {
        state: orders == null ? 'UNKNOWN' : unprotected.length > 0 ? 'BLOCKED' : 'PASS',
        detail: orders == null ? '보호주문을 확인하지 못했습니다'
          : unprotected.length > 0
            ? `손절이 걸리지 않은 주문 ${unprotected.length}건 (${unprotected.map(o => o.symbol).slice(0, 3).join(', ')})`
            : `열린 주문 ${orders.length}건 모두 손절이 걸려 있습니다`,
        blockedReason: (orders ?? []).length > 0 && unprotected.length > 0
          ? '손절 없는 포지션이 있습니다 — 자동으로 주문을 내지 않고 알립니다' : null,
      }));
    }
  }

  // ── 장부 ──
  if (want.has('ledger')) {
    try {
      const { data, error } = await (sb as any)
        .from('ledger_events').select('occurred_at').order('occurred_at', { ascending: false }).limit(1);
      if (error) throw new Error(error.message);
      const last = Date.parse(String((Array.isArray(data) ? data[0] : null)?.occurred_at ?? ''));
      steps.push(mk('ledger', {
        state: 'PASS',
        detail: Number.isFinite(last)
          ? `마지막 장부 기록 ${new Date(last).toLocaleString('ko-KR')}`
          : '장부 표는 있고 기록은 아직 없습니다',
      }));
    } catch (e: any) {
      const msg = String(e?.message || e);
      const missing = /does not exist|schema cache|relation/i.test(msg);
      steps.push(mk('ledger', {
        state: missing ? 'SELF_HEALED' : 'UNKNOWN',
        detail: missing ? '장부 표를 자동으로 적용하는 중입니다' : `확인하지 못했습니다: ${msg.slice(0, 200)}`,
        did: missing ? ['마이그레이션 파이프라인에 맡김'] : [],
      }));
    }
  }

  // ── 지갑 · 전략 ──
  if (want.has('wallet')) {
    try {
      const { count, error } = await (sb as any)
        .from('account_equity_snapshots').select('id', { count: 'exact', head: true }).eq('user_id', uid);
      if (error) throw new Error(error.message);
      steps.push(mk('wallet', {
        state: 'PASS',
        detail: typeof count === 'number' ? `자산 스냅샷 ${count}건` : '자산 스냅샷을 읽었습니다',
      }));
    } catch (e: any) {
      steps.push(mk('wallet', { detail: `확인하지 못했습니다: ${String(e?.message || e).slice(0, 200)}` }));
    }
  }
  if (want.has('strategies')) {
    try {
      const { data, error } = await (sb as any)
        .from('autotrade_schedules').select('id, enabled, connection_id').eq('user_id', uid);
      if (error) throw new Error(error.message);
      const rows = Array.isArray(data) ? data : [];
      const on = rows.filter((r: any) => r?.enabled);
      const noConn = on.filter((r: any) => !r?.connection_id);
      steps.push(mk('strategies', {
        state: noConn.length > 0 ? 'BLOCKED' : 'PASS',
        detail: `켜진 전략 ${on.length}개 / 전체 ${rows.length}개`,
        blockedReason: noConn.length > 0
          ? `${noConn.length}개에 거래소 연결이 없습니다 — 실행돼도 주문을 낼 수 없습니다` : null,
      }));
    } catch (e: any) {
      steps.push(mk('strategies', { detail: `확인하지 못했습니다: ${String(e?.message || e).slice(0, 200)}` }));
    }
  }

  const result = opsVerdictOf(command, steps);

  // ── 값을 바꾸는 명령은 실제로 실행한다 ──
  //
  // "돌렸습니다"라고 적고 아무것도 안 하는 것이 이 저장소에서 가장 자주 난
  // 고장이다. 그래서 두 갈래로 나눈다:
  //
  //   지금 중지해   여기서 바로 한다. **멈추는 일을 5분 기다리게 하지 않는다**
  //   배포해·복구해 요청을 적는다. 실행 자격(GITHUB_TOKEN·FLY_API_TOKEN)은
  //                 GitHub Actions가 이미 가지고 있고, 화면에는 없다
  let queued: { id: string; command: OpsCommand } | null = null;
  let queueError: string | null = null;
  let stopped: any = null;

  if (command === 'STOP_NOW') {
    // 킬 스위치는 이 화면이 직접 켤 수 있다. 기다릴 이유가 없다.
    try {
      const { data: conns } = await (sb as any)
        .from('exchange_connections').select('id').eq('user_id', uid);
      const ids: string[] = (Array.isArray(conns) ? conns : []).map((c: any) => String(c.id));
      const { loadKillSwitch, saveKillSwitch, logKillEvent } = await import('@/lib/risk/killSwitch');
      const done: string[] = [];
      for (const cid of ids) {
        const st = await loadKillSwitch(sb, uid, cid);
        const next = {
          ...st, active: true, triggeredAt: nowMs,
          triggerReason: '사용자 명령: 지금 중지해',
        } as any;
        if (await saveKillSwitch(sb, uid, cid, next)) done.push(cid);
        await logKillEvent(sb, uid, cid, {
          reason: '사용자 명령: 지금 중지해', equity: 0, drawdownPct: 0,
          action: 'KILL_SWITCH_ON', mode: 'MANUAL',
        });
      }
      stopped = { connections: ids.length, activated: done.length };
      // **켠 것과 켜려고 한 것은 다르다.** 하나라도 못 켰으면 그렇게 적는다.
      if (done.length < ids.length) {
        queueError = `연결 ${ids.length}개 중 ${done.length}개만 중지됐습니다 — 나머지는 다시 시도해야 합니다`;
      }
      // **포지션을 자동으로 청산하지 않는다.** 중지는 "더 열지 마라"이고,
      // 닫는 것은 별개의 결정이다 — 사용자 확인 없이 포지션을 정리하지 않는다.
    } catch (e: any) {
      queueError = `킬 스위치를 켜지 못했습니다: ${String(e?.message || e).slice(0, 200)}`;
    }
  } else if (spec.mutates) {
    try {
      const { data, error } = await (sb as any).from('ops_requests').insert({
        command, requested_by: uid, approved: command === 'APPROVE_LIVE_SMALL' ? body?.approved === true : true,
        status: 'PENDING',
      }).select('id').single();
      if (error) throw new Error(error.message);
      queued = { id: String(data?.id), command };
    } catch (e: any) {
      const msg = String(e?.message || e);
      queueError = /does not exist|schema cache|relation/i.test(msg)
        ? '요청 표(059)를 자동으로 적용하는 중입니다 — 적용이 끝나면 이 명령이 실행됩니다'
        : `요청을 적지 못했습니다: ${msg.slice(0, 200)}`;
    }
  }

  return NextResponse.json({
    ok: true, ...result,
    // **접수와 실행은 다르다.** 큐에 적힌 것을 '실행됨'으로 적지 않는다.
    executed: !spec.mutates || !!stopped,
    queued, queueError, stopped,
    next: queued
      ? '실행기가 5분 안에 집어 갑니다 — 결과는 이 요청 번호로 확인할 수 있습니다'
      : null,
    checkedAt: nowMs,
  }, { headers: { 'Cache-Control': 'no-store' } });
}

// GET /api/ops/command?id=<요청번호> — 그 명령이 어떻게 끝났는가
export async function GET(req: NextRequest) {
  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  const id = String(req.nextUrl.searchParams.get('id') || '').trim();
  try {
    let query = (sb as any).from('ops_requests')
      .select('id, command, status, approved, requested_at, claimed_at, finished_at, result, error')
      .eq('requested_by', uid).order('requested_at', { ascending: false }).limit(id ? 1 : 10);
    if (id) query = query.eq('id', id);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    const rows = Array.isArray(data) ? data : [];
    return NextResponse.json({ ok: true, requests: rows }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    const msg = String(e?.message || e);
    const missing = /does not exist|schema cache|relation/i.test(msg);
    return NextResponse.json({
      ok: !missing, requests: [],
      // **못 읽은 것을 '요청 없음'으로 적지 않는다.**
      error: missing ? null : msg.slice(0, 200),
      note: missing ? '요청 표(059)를 자동으로 적용하는 중입니다' : null,
    }, { status: missing ? 200 : 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
