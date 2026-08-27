// /api/autotrade/scheduled-exit — 시간 예약 청산
//
// GET  : 지금 나가야 할 예약을 실행한다 (크론 · 외부 스케줄러 · 앱 타이머)
// POST : 예약을 만든다
// DELETE: 예약을 끈다
//
// 실행기가 셋이고, 그게 이 파일 설계의 전부다
// ─────────────────────────────────────────────
//   · Vercel 크론      — 언제나 돌지만 **하루 1회**(무료 플랜). 늦는다
//   · 외부 스케줄러    — 분 단위로 이 주소를 부른다. 제 시각
//   · 앱 타이머        — 앱이 열려 있는 동안. 제 시각이지만 닫으면 멈춘다
//
// 셋 다 같은 GET을 부른다. **누가 불렀는지에 따라 판단이 달라지지 않는다** —
// 달라지면 "크론으로는 되는데 앱으로는 안 된다" 같은 것이 생기고, 그건
// 재현이 안 된다.
//
// 늦은 예약은 내지 않는다
// ───────────────────────
// 하루 1회 크론만 있으면 15:30 예약이 다음날 09:00에 걸린다. 17시간 반
// 늦게 시장가로 던지는 것은 사용자가 예약한 그 거래가 아니다. 그래서
// 유예를 넘긴 것은 **stale로 닫고 주문하지 않는다.** 그 사실이 표에 남아
// 화면이 "이 예약은 안 나갔습니다"라고 말할 수 있다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { checkDue, validateSchedule, DEFAULT_GRACE_MS } from '@/lib/engine/scheduleExit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** 타이밍 안전 비교 — 길이로 새는 것을 막는다 */
function safeEqual(a: string | null, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// ─────────────────────────────────────────────────────────────
// GET — 지금 나가야 할 것을 실행한다
// ─────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET || '';
  const adminSecret = process.env.ADMIN_SECRET || '';
  const auth = req.headers.get('authorization') || '';

  // 셋 중 하나면 된다:
  //  · Vercel 크론 (Bearer CRON_SECRET)
  //  · 외부 스케줄러 (x-admin-secret) — 이건 사용자가 직접 붙인다
  //  · 로그인한 사용자 (앱 타이머) — 자기 예약만 본다
  const byCron = !!cronSecret && safeEqual(auth.replace(/^Bearer\s+/i, ''), cronSecret);
  const byAdmin = !!adminSecret && safeEqual(req.headers.get('x-admin-secret'), adminSecret);
  let uid: string | null = null;
  if (!byCron && !byAdmin) {
    uid = await resolveUserId(auth, req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
    if (!uid) {
      return NextResponse.json({
        ok: false, error: 'auth_required',
        // 무엇이 없어서 막혔는지 적는다. '인증 필요'만 적으면 CRON_SECRET을
        // 안 넣은 것인지 값이 틀린 것인지 알 수 없다.
        hint: {
          cronSecretSet: !!cronSecret,
          adminSecretSet: !!adminSecret,
          note: 'Vercel 크론은 Bearer CRON_SECRET, 외부 스케줄러는 x-admin-secret, 앱은 로그인 토큰',
        },
      }, { status: 401 });
    }
  }

  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  // ── 목록만 보기 ──
  //
  // 실행과 조회를 **같은 호출로 묶지 않는다.** 화면이 목록을 새로고침할
  // 때마다 주문이 나갈 수 있으면, 새로고침이 위험한 조작이 된다.
  if (new URL(req.url).searchParams.get('list') === '1') {
    if (!uid) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });
    const { data, error } = await (sb as any).from('scheduled_exits')
      .select('id, symbol, run_at, time_zone, portion_pct, enabled')
      .eq('user_id', uid).is('fired_at', null).eq('enabled', true)
      .order('run_at', { ascending: true }).limit(50);
    if (error) {
      const missing = /does not exist|schema cache|relation/i.test(String(error.message));
      return NextResponse.json({
        ok: false, error: missing ? 'table_missing' : 'query_failed',
        message: missing
          ? 'scheduled_exits 표가 아직 없습니다 — 마이그레이션 032를 자동으로 적용하는 중입니다'
          : error.message,
      }, { status: missing ? 503 : 500 });
    }
    return NextResponse.json({ ok: true, pending: data || [] },
      { headers: { 'Cache-Control': 'no-store' } });
  }

  const started = Date.now();
  const now = started;

  // 아직 안 나간 것만. 시각 순서대로 — 오래된 것부터 처리해야 한 번에
  // 여러 개가 걸렸을 때 순서가 뒤집히지 않는다.
  let q = (sb as any).from('scheduled_exits')
    .select('*')
    .is('fired_at', null)
    .eq('enabled', true)
    .order('run_at', { ascending: true })
    .limit(50);
  if (uid) q = q.eq('user_id', uid);

  const { data: rows, error } = await q;
  if (error) {
    // 표가 없으면 무엇을 해야 하는지 말한다. 'relation does not exist'만
    // 돌려주면 마이그레이션 이야기인 줄 모른다.
    const missing = /does not exist|schema cache|relation/i.test(String(error.message));
    return NextResponse.json({
      ok: false, error: missing ? 'table_missing' : 'query_failed',
      message: missing
        ? 'scheduled_exits 표가 아직 없습니다 — 마이그레이션 032를 자동으로 적용하는 중입니다'
        : error.message,
    }, { status: missing ? 503 : 500 });
  }

  const list = Array.isArray(rows) ? rows : [];
  const results: any[] = [];

  for (const row of list) {
    const runAtMs = row?.run_at ? new Date(row.run_at).getTime() : null;
    const due = checkDue({
      id: row.id, symbol: row.symbol, runAtMs,
      action: row.action, portionPct: row.portion_pct,
      enabled: row.enabled, firedAtMs: null,
    }, now, DEFAULT_GRACE_MS);

    if (due.verdict === 'waiting') continue;      // 아직 — 건드리지 않는다

    // ── 선점 ──
    //
    // **예전에는 이 자리가 없었다.** 줄을 읽고 → 주문을 내고 → 그제서야
    // `fired_at`을 썼다. 그 사이가 통째로 열려 있었다:
    //
    //   · 사용자가 취소해도(enabled=false) 주문이 그대로 나갔다
    //   · 실행기가 둘이면(크론 5분 + 수동) 같은 줄을 둘 다 집어
    //     **같은 예약이 두 번 발사됐다**
    //
    // `fired_at`을 **먼저** 못 박는다. 조건이 그대로일 때만 성공하므로
    // 취소가 먼저면 0줄이고, 두 실행기 중 하나만 이긴다.
    // (실패해도 fired_at은 남는다 — 예전 주석의 의도 그대로다.
    //  안 남기면 다음 실행기가 같은 예약을 또 낸다.)
    let claimed = false;
    let claimErr: string | null = null;
    const firedIso = new Date().toISOString();
    try {
      let q = (sb as any).from('scheduled_exits')
        .update({ fired_at: firedIso })
        .eq('id', row.id)
        .eq('enabled', true)
        .is('fired_at', null);
      // 070이 아직인 DB에는 이 칸이 없다. 없으면 조건만 빠지고
      // 나머지 선점은 그대로 동작한다.
      const { data, error } = await q.is('cancelled_at', null).select('id');
      if (error && /cancelled_at|column|schema cache/i.test(String(error.message))) {
        const again = await (sb as any).from('scheduled_exits')
          .update({ fired_at: firedIso })
          .eq('id', row.id).eq('enabled', true).is('fired_at', null)
          .select('id');
        claimed = Array.isArray(again.data) && again.data.length > 0;
        claimErr = again.error ? String(again.error.message) : null;
      } else if (error) {
        claimErr = String(error.message);
      } else {
        claimed = Array.isArray(data) && data.length > 0;
      }
    } catch (e: any) { claimErr = String(e?.message || e); }

    if (!claimed) {
      // **못 잡은 것을 실패로도 성공으로도 적지 않는다.** 취소됐거나,
      // 다른 실행기가 이미 집었거나, 조회가 실패한 것이다.
      results.push({ id: row.id, symbol: row.symbol,
        result: claimErr ? 'claim_failed' : 'skipped',
        detail: claimErr
          ? `선점하지 못했습니다 — ${claimErr.slice(0, 140)}`
          : '취소됐거나 다른 실행기가 이미 처리했습니다 — 주문하지 않습니다',
        latenessMs: due.latenessMs });
      continue;
    }

    // 선점했으므로 이제 결과만 채운다. fired_at은 위에서 이미 박혔다.
    const close = async (result: string, detail: string) => {
      await (sb as any).from('scheduled_exits')
        .update({
          result, detail,
          lateness_ms: due.latenessMs == null ? null : Math.round(due.latenessMs),
        })
        .eq('id', row.id);
      results.push({ id: row.id, symbol: row.symbol, result, detail, latenessMs: due.latenessMs });
    };

    if (due.verdict !== 'due') {
      // stale · invalid · off · done — 주문하지 않는다
      await close(due.verdict === 'stale' ? 'stale' : 'failed', due.reason);
      continue;
    }

    if (!row.connection_id) {
      await close('failed', '연결이 지정되지 않아 주문할 수 없습니다');
      continue;
    }

    // ── 실제 청산 ──
    try {
      // **거래소를 가리지 않는다.**
      //
      // 예전에는 loadBinanceCreds라 Gate 연결이면 `not_binance`로 끝났다.
      // 그래서 Gate 사용자가 예약 청산을 걸어 두면 **실행 시각에 조용히
      // 실패했다.** 기록에는 남지만 아무도 안 보고, 사용자는 닫힐 것이라
      // 믿고 자고 있다. 못 여는 것은 불편이고 못 닫는 것은 사고다.
      const { loadFuturesCreds } = await import('@/lib/exchanges/loadCreds');
      const creds = await loadFuturesCreds(sb, row.user_id, row.connection_id);
      if (!creds.ok) { await close('failed', `연결을 쓸 수 없습니다: ${creds.message}`); continue; }

      const { futuresPositionRisk } = await import('@/lib/exchanges/futuresAdapter');

      // 어느 방향을 들고 있는지 먼저 읽는다. **모르면 주문하지 않는다** —
      // 방향을 찍으면 청산이 아니라 반대 진입이 된다.
      const rr = await futuresPositionRisk(
        creds.exchange!, creds.key!, creds.secret!, String(row.symbol), creds.testnet === true);
      if (!rr.risk || rr.risk.positionAmt == null) {
        await close('failed', `포지션을 확인하지 못했습니다: ${rr.error || '알 수 없음'}`);
        continue;
      }
      const amt = Number(rr.risk.positionAmt) || 0;
      if (amt === 0) {
        // 이미 닫혀 있다. 실패가 아니다 — 이 예약은 할 일이 없어진 것이다.
        await close('no_position', '실행 시각에 열린 포지션이 없었습니다');
        continue;
      }

      const pct = row.portion_pct == null ? 100 : Number(row.portion_pct);

      if (creds.exchange === 'gate') {
        // Gate는 심볼별 전량 종료가 있다. **부분 청산은 아직 없다** —
        // 여기서 계약 수를 직접 계산해 넣으면 배수 오독이 그대로 수량
        // 오류가 되고, 그건 이 저장소에서 이미 한 번 밟은 자리다.
        // 지원 안 하는 것을 지원하는 척하지 않고 그렇다고 적는다.
        if (pct < 100) {
          await close('failed',
            `Gate는 아직 부분 예약 청산(${pct}%)을 지원하지 않습니다 — `
            + '전량(100%)으로 다시 예약하거나 거래소에서 직접 닫으세요');
          continue;
        }
        const gf = await import('@/lib/exchanges/gateFutures');
        const gp = await import('@/lib/exchanges/gatePlan');
        const contract = gp.toGateContract(String(row.symbol));
        if (!contract) {
          await close('failed', `Gate 계약 이름을 만들 수 없습니다 (${row.symbol})`);
          continue;
        }
        const r = await gf.closePositionGateFutures(
          creds.key!, creds.secret!, contract, creds.testnet === true);
        await close(r.success ? 'ok' : 'failed', r.message);
        continue;
      }

      const bf = await import('@/lib/exchanges/binanceFutures');
      const r = await bf.closePositionPercent(
        creds.key!, creds.secret!, String(row.symbol),
        amt > 0 ? 'LONG' : 'SHORT', pct, creds.testnet === true);

      await close(r.success ? 'ok' : 'failed',
        `${r.message}${r.fullClose ? ' (전량)' : ''}`);
    } catch (e: any) {
      // 응답을 못 받았다. 나갔는지 모른다 — 그 사실을 그대로 적는다.
      // 여기서 '실패'로만 적으면, 실제로 나갔는데 안 나간 줄 알고 또 낸다.
      await close('failed',
        `응답을 받지 못했습니다 — 실제로 나갔는지 확인이 필요합니다 (${e?.message || e})`);
    }
  }

  // 크론이 불렀으면 실행 기록을 남긴다. 사용자 타이머까지 적으면 표가
  // 앱을 여는 횟수만큼 불어나고, 그러면 '크론이 도는가'를 못 읽는다.
  if (byCron || byAdmin) {
    try {
      const { recordCronRun } = await import('@/lib/system/cronLog');
      await recordCronRun(sb, 'scheduled-exit',
        results.length === 0 ? 'skipped' : results.some(r => r.result === 'failed') ? 'failed' : 'ok',
        results.length === 0
          ? `실행할 예약 없음 (대기 ${list.length}건)`
          : results.map(r => `${r.symbol}:${r.result}`).join(', '),
        Date.now() - started);
    } catch { /* 기록 실패가 실행을 되돌리지는 않는다 */ }
  }

  return NextResponse.json({
    ok: true,
    checked: list.length,
    fired: results.length,
    results,
    caller: byCron ? 'cron' : byAdmin ? 'external' : 'user',
    graceMs: DEFAULT_GRACE_MS,
  }, { headers: { 'Cache-Control': 'no-store' } });
}

// ─────────────────────────────────────────────────────────────
// POST — 예약을 만든다
// ─────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });

  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 }); }

  const symbol = String(body?.symbol || '').toUpperCase().replace('/', '');
  const connectionId = String(body?.connectionId || '');
  const runAtMs = Number(body?.runAtMs);
  const timeZone = String(body?.timeZone || 'Asia/Seoul');
  const portionRaw = body?.portionPct;
  const portionPct = portionRaw == null || portionRaw === '' ? null : Number(portionRaw);

  if (!symbol) return NextResponse.json({ ok: false, error: 'missing_symbol' }, { status: 400 });
  if (!connectionId) {
    return NextResponse.json({
      ok: false, error: 'missing_connection',
      message: '연결이 없으면 예약이 실행될 때 주문할 수 없습니다',
    }, { status: 400 });
  }
  if (portionPct != null && (!Number.isFinite(portionPct) || portionPct <= 0 || portionPct > 100)) {
    return NextResponse.json({
      ok: false, error: 'invalid_portion',
      message: '비율은 1~100 사이여야 합니다 (비우면 전량)',
    }, { status: 400 });
  }

  // 과거·너무 먼 미래는 여기서 막는다. 지난 시각으로 만들면 저장되자마자
  // stale이 되는데 화면에는 '예약됨'으로 뜬다 — 영원히 안 나가는 예약이다.
  const v = validateSchedule(runAtMs, Date.now());
  if (!v.ok) return NextResponse.json({ ok: false, error: 'invalid_time', message: v.reason }, { status: 400 });

  const { data, error } = await (sb as any).from('scheduled_exits').insert({
    user_id: uid, connection_id: connectionId, symbol,
    action: 'CLOSE', portion_pct: portionPct,
    run_at: new Date(runAtMs).toISOString(), time_zone: timeZone,
    enabled: true,
  }).select('id').single();

  if (error) {
    const missing = /does not exist|schema cache|relation/i.test(String(error.message));
    return NextResponse.json({
      ok: false, error: missing ? 'table_missing' : 'insert_failed',
      message: missing
        ? 'scheduled_exits 표가 아직 없습니다 — 마이그레이션 032를 자동으로 적용하는 중입니다'
        : error.message,
    }, { status: missing ? 503 : 500 });
  }

  return NextResponse.json({ ok: true, id: data?.id, runAtMs, symbol },
    { headers: { 'Cache-Control': 'no-store' } });
}

// ─────────────────────────────────────────────────────────────
// DELETE — 예약을 끈다 (지우지 않는다)
// ─────────────────────────────────────────────────────────────
//
// 지우면 "예약한 적 없다"와 "취소했다"가 같아진다. 뒤쪽은 남아야 한다.
export async function DELETE(req: NextRequest) {
  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });

  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  const id = new URL(req.url).searchParams.get('id') || '';
  if (!id) return NextResponse.json({ ok: false, error: 'missing_id' }, { status: 400 });

  // ── 몇 줄을 고쳤는지 본다 ──
  //
  // 예전에는 `.select()`가 없어서 **0줄을 고쳐도 `ok: true`** 였다.
  // 남의 id를 넣거나 없는 id를 넣어도 "취소했습니다"가 나갔다 —
  // 화면에서는 사라지고 예약은 그대로 남는다.
  const { cancelVerdict } = await import('@/lib/autotrade/scheduleCancel');
  const nowIso = new Date().toISOString();

  let existed = false;
  let alreadyCancelled = false;
  try {
    const { data } = await (sb as any).from('scheduled_exits')
      .select('id, enabled, fired_at, result').eq('id', id).eq('user_id', uid).maybeSingle();
    if (data) {
      existed = true;
      // 이미 쐈으면 취소할 것이 없다 — 그건 이력이다.
      alreadyCancelled = (data as any).enabled === false || !!(data as any).fired_at;
    }
  } catch { /* 아래에서 updated로 판단한다 */ }

  const patch: Record<string, any> = {
    enabled: false, result: 'cancelled', detail: '사용자가 취소했습니다',
    cancelled_at: nowIso, cancelled_by: uid,
  };

  let updated: number | null = null;
  let errMsg: string | null = null;
  try {
    const { data, error } = await (sb as any).from('scheduled_exits')
      .update(patch).eq('id', id).eq('user_id', uid)
      // **이미 쏜 예약을 취소로 덮지 않는다.** 그 줄은 실행 이력이다.
      .is('fired_at', null)
      .select('id');
    if (error) errMsg = String(error.message);
    else updated = Array.isArray(data) ? data.length : null;
  } catch (e: any) { errMsg = String(e?.message || e); }

  // 070이 아직인 DB에서는 취소 칸이 없다. **예약을 못 끄는 것이 더 나쁘다.**
  let degraded = false;
  if (errMsg && /cancelled_at|cancelled_by|column|schema cache/i.test(errMsg)) {
    delete patch.cancelled_at; delete patch.cancelled_by;
    try {
      const { data, error } = await (sb as any).from('scheduled_exits')
        .update(patch).eq('id', id).eq('user_id', uid).is('fired_at', null).select('id');
      if (error) errMsg = String(error.message);
      else { updated = Array.isArray(data) ? data.length : null; errMsg = null; degraded = true; }
    } catch (e: any) { errMsg = String(e?.message || e); }
  }

  const v = cancelVerdict({ updated, existed, alreadyCancelled, error: errMsg });
  if (!v.ok) {
    return NextResponse.json({
      ok: false, error: v.code === 'NOT_FOUND' ? 'not_found' : 'cancel_failed',
      code: v.code, message: v.reason,
    }, { status: v.code === 'NOT_FOUND' ? 404 : 500 });
  }
  return NextResponse.json({
    ok: true, code: v.code, message: v.reason,
    cancelledAt: v.code === 'CANCELLED' && !degraded ? nowIso : null,
    note: degraded ? '취소 표식을 남기지 못해 끄기만 했습니다 (마이그레이션 070 대기)' : null,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
