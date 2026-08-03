// /api/autotrade/schedule — 자동매매 예약을 화면에서 켜고 끈다
//
// GET    : 내 예약 + 최근 실행 기록
// POST   : 만들거나 고친다 (같은 심볼은 한 줄)
// DELETE : 끈다 (지우지 않는다)
//
// 왜 이 라우트가 필요한가
// ───────────────────────
// 지금까지 자동매매를 켜려면 **Supabase SQL 편집기에서 INSERT를 쳐야
// 했다.** 화면에는 봇 카드가 여섯 장 있는데 그건 실행기에 연결돼 있지
// 않고, 실제로 도는 것(daily-ladder 크론)이 읽는 표에는 화면에서 줄을
// 만들 방법이 없었다.
//
// 그래서 "자동매매를 켰다"고 믿는 사람과 실제로 켜진 상태 사이에 SQL
// 한 줄이 끼어 있었다. 그 줄을 안 친 동안 크론은 돌면서 아무 일도 하지
// 않았고, 화면 어디에도 그 사실이 없었다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** 표가 없을 때의 응답. '무엇을 해야 하는지'까지 적는다 */
function tableMissing(migration: string, table: string) {
  return NextResponse.json({
    ok: false, error: 'table_missing',
    message: `${table} 표가 없습니다 — 마이그레이션 ${migration}을 적용하세요`,
  }, { status: 503 });
}
const isMissing = (msg: any) => /does not exist|schema cache|relation/i.test(String(msg));

export async function GET(req: NextRequest) {
  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  const { data: rows, error } = await (sb as any)
    .from('autotrade_schedules')
    .select('id, symbol, connection_id, mode, enabled, last_run_at, last_result, leverage_cap, risk_pct, interval_min, margin_pct')
    .eq('user_id', uid).order('symbol');
  if (error) {
    if (isMissing(error.message)) return tableMissing('031', 'autotrade_schedules');
    return NextResponse.json({ ok: false, error: 'query_failed', message: error.message }, { status: 500 });
  }

  // 최근 실행 기록. **없으면 없다고 말한다** — 빈 배열과 '표가 없다'는 다르다.
  let runs: any[] = [];
  let runsError: string | null = null;
  try {
    const { data, error: e2 } = await (sb as any)
      .from('cron_runs')
      .select('job, status, detail, started_at, duration_ms')
      .eq('job', 'daily-ladder')
      .order('started_at', { ascending: false }).limit(10);
    if (e2) runsError = isMissing(e2.message) ? '크론 실행 기록 표가 없습니다 (마이그레이션 029)' : e2.message;
    else runs = data || [];
  } catch (e: any) { runsError = String(e?.message || e); }

  // 고를 수 있는 연결. 화면이 이 목록에서만 고르게 해야 '없는 연결 id'가
  // 저장되는 일이 없다.
  let connections: any[] = [];
  try {
    const { data } = await (sb as any)
      .from('exchange_connections')
      .select('id, exchange_id, label, is_testnet')
      .eq('user_id', uid);
    connections = (data || []).filter((c: any) => String(c.exchange_id).toLowerCase() !== 'kis');
  } catch { /* 목록을 못 읽으면 화면이 그렇게 말한다 */ }

  return NextResponse.json({
    ok: true,
    schedules: rows || [],
    runs, runsError,
    connections,
    // 크론이 실제로 인증될 수 있는가. **값은 싣지 않는다**
    adminSecretSet: !!process.env.ADMIN_SECRET,
    cronSecretSet: !!process.env.CRON_SECRET,
    // 크론이 도는 시각. 화면이 '언제 도는지'를 적을 수 있어야 한다 —
    // 안 적으면 켠 직후에 안 도는 것을 고장으로 읽는다.
    cronUtcHour: 23,
  }, { headers: { 'Cache-Control': 'no-store' } });
}

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
  const enabled = body?.enabled !== false;
  const modeRaw = String(body?.mode || 'TESTNET').toUpperCase();

  // 배율 **상한**과 1회 위험 비율. 둘 다 선택이다 — 안 주면 코드 기본값.
  //
  // '상한'이지 '배율'이 아니다. 여기에 100을 저장하고 그대로 쓰면 손절이
  // 2%인 자리에도 100배가 나가는데, 그건 진입 직후 청산이다. 상한이면
  // 역산 결과가 더 작을 때 작은 쪽이 나간다 — 안전한 쪽으로 틀린다.
  const levRaw = body?.leverageCap;
  const riskRaw = body?.riskPct;
  let leverageCap: number | null = null;
  let riskPct: number | null = null;
  if (levRaw != null && levRaw !== '') {
    const n = Math.round(Number(levRaw));
    if (!Number.isFinite(n) || n < 1 || n > 125) {
      return NextResponse.json({
        ok: false, error: 'invalid_leverage',
        message: `배율 상한은 1~125 사이여야 합니다 (입력 ${levRaw})`,
      }, { status: 400 });
    }
    leverageCap = n;
  }
  if (riskRaw != null && riskRaw !== '') {
    const n = Number(riskRaw);
    if (!Number.isFinite(n) || n <= 0 || n > 100) {
      return NextResponse.json({
        ok: false, error: 'invalid_risk',
        message: `1회 위험 비율은 0보다 크고 100 이하여야 합니다 (입력 ${riskRaw})`,
      }, { status: 400 });
    }
    riskPct = n;
  }

  // 1회 증거금 비율(%). **이 값이 배율을 실제로 결정한다** —
  // 배율은 명목가 ÷ 증거금 예산으로 역산되므로, 예산을 작게 묶어야
  // 높은 배율이 나온다. "100배로 10%씩 10번"의 그 10%다.
  let marginPct: number | null = null;
  if (body?.marginPct != null && body.marginPct !== '') {
    const n = Number(body.marginPct);
    if (!Number.isFinite(n) || n <= 0 || n > 100) {
      return NextResponse.json({
        ok: false, error: 'invalid_margin',
        message: `1회 증거금 비율은 0보다 크고 100 이하여야 합니다 (입력 ${body.marginPct})`,
      }, { status: 400 });
    }
    marginPct = n;
  }

  // 얼마나 자주 진입을 볼 것인가(분). 안 주면 표 기본값(하루).
  let intervalMin: number | null = null;
  if (body?.intervalMin != null && body.intervalMin !== '') {
    const n = Math.round(Number(body.intervalMin));
    if (!Number.isFinite(n) || n < 1 || n > 10080) {
      return NextResponse.json({
        ok: false, error: 'invalid_interval',
        message: `실행 간격은 1분~7일(10080분) 사이여야 합니다 (입력 ${body.intervalMin})`,
      }, { status: 400 });
    }
    intervalMin = n;
  }

  if (!symbol) return NextResponse.json({ ok: false, error: 'missing_symbol' }, { status: 400 });

  // **연결이 없으면 만들지 않는다.** 연결 없는 줄은 크론이 읽어도 주문을
  // 못 내고, 화면에는 '켜짐'으로 보인다 — 가장 조용한 실패다.
  if (!connectionId) {
    return NextResponse.json({
      ok: false, error: 'missing_connection',
      message: '거래소 연결을 골라야 합니다 — 연결 없는 예약은 실행돼도 주문을 낼 수 없습니다',
    }, { status: 400 });
  }

  // 아는 값만 받는다. 오타가 실전으로 읽히면 안 된다.
  const ALLOWED = ['UI_DEMO', 'PAPER', 'TESTNET', 'SHADOW_LIVE', 'LIVE_SMALL', 'LIVE_LIMITED'];
  if (!ALLOWED.includes(modeRaw)) {
    return NextResponse.json({
      ok: false, error: 'invalid_mode',
      message: `모르는 운영 모드입니다: ${modeRaw}`, allowed: ALLOWED,
    }, { status: 400 });
  }

  // 이 연결이 정말 내 것인가. 남의 연결 id를 넣어 그 계좌로 주문이
  // 나가게 하면 안 된다.
  const { data: conn } = await (sb as any)
    .from('exchange_connections')
    .select('id, is_testnet, exchange_id')
    .eq('id', connectionId).eq('user_id', uid).maybeSingle();
  if (!conn) {
    return NextResponse.json({
      ok: false, error: 'connection_not_found',
      message: '그 거래소 연결을 찾지 못했습니다',
    }, { status: 404 });
  }

  // **모드와 연결이 어긋나면 막는다.**
  // is_testnet === false 만 실전이다(저장소 전체 규칙).
  const connIsLive = conn.is_testnet === false;
  const modeIsLive = modeRaw.startsWith('LIVE') || modeRaw === 'SHADOW_LIVE';
  if (modeIsLive && !connIsLive) {
    return NextResponse.json({
      ok: false, error: 'mode_conn_mismatch',
      message: '실전 모드인데 테스트넷 연결입니다 — 주문이 테스트넷으로 나갑니다',
    }, { status: 400 });
  }
  if (!modeIsLive && connIsLive) {
    // 이쪽이 훨씬 위험하다. 테스트넷인 줄 알고 켰는데 실계좌로 나간다.
    return NextResponse.json({
      ok: false, error: 'mode_conn_mismatch',
      message: `${modeRaw} 모드인데 **실전 연결**입니다 — 진짜 돈으로 주문이 나갑니다. `
        + '테스트넷 연결을 고르거나 모드를 올리세요.',
    }, { status: 400 });
  }

  const { data, error } = await (sb as any)
    .from('autotrade_schedules')
    .upsert({
      user_id: uid, symbol, connection_id: connectionId,
      mode: modeRaw, enabled, margin_pct: marginPct,
      leverage_cap: leverageCap, risk_pct: riskPct,
      ...(intervalMin != null ? { interval_min: intervalMin } : {}),
    }, { onConflict: 'user_id,symbol' })
    .select('id, symbol, mode, enabled, connection_id, leverage_cap, risk_pct, interval_min').single();

  if (error) {
    if (isMissing(error.message)) return tableMissing('031', 'autotrade_schedules');
    return NextResponse.json({ ok: false, error: 'upsert_failed', message: error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true, schedule: data,
    // 켠 직후에 안 도는 것을 고장으로 읽지 않게, 언제 도는지 같이 말한다.
    message: enabled
      ? `${symbol} 자동매매를 켰습니다`
        + (leverageCap ? ` · 배율 상한 ${leverageCap}배` : '')
        + (riskPct ? ` · 1회 위험 ${riskPct}%` : '')
        + ' — 다음 실행은 매일 23:00 UTC(한국 08:00)입니다'
      : `${symbol} 자동매매를 껐습니다`,
    // **상한이지 목표가 아니다.** 손절이 넓으면 역산 결과가 더 작게 나오고,
    // 그때는 작은 쪽이 나간다. 화면이 이걸 '100배로 나간다'로 읽으면 안 된다.
    leverageNote: leverageCap
      ? `배율은 손절 거리에서 역산되고 ${leverageCap}배에서 잘립니다. `
        + `${leverageCap}배가 실제로 나오려면 손절이 약 ${(100 / leverageCap * 0.26).toFixed(2)}% 안쪽이어야 합니다.`
      : null,
  }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function DELETE(req: NextRequest) {
  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  const id = new URL(req.url).searchParams.get('id') || '';
  if (!id) return NextResponse.json({ ok: false, error: 'missing_id' }, { status: 400 });

  // 지우지 않고 끈다. 지우면 '켠 적 없다'와 '껐다'가 같아진다.
  const { error } = await (sb as any)
    .from('autotrade_schedules')
    .update({ enabled: false }).eq('id', id).eq('user_id', uid);
  if (error) {
    return NextResponse.json({ ok: false, error: 'update_failed', message: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
}
