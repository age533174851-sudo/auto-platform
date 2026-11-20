import { NextRequest,NextResponse } from 'next/server';
import { getSupabaseAdmin,resolveUserId } from '@/lib/supabase/admin';
import { parsePaperAutomationControl,readBotSignal,readBotTimeframe,readBotLeverage,DEFAULT_PAPER_BOT } from '@/lib/engine/paperAutomation';
import { barIntervalLabel,DEFAULT_BAR_INTERVAL } from '@/lib/risk/bars';
import { ENTRY_SIGNAL_LABEL,DEFAULT_ENTRY_SIGNAL } from '@/lib/engine/entrySignals';
import { readRunnerConfig } from '@/lib/engine/paperRunner';
import { paperRunnerStatus } from '@/lib/engine/paperRunnerStatus';
import { summarizeBotPerf, PERF_ROW_CAP } from '@/lib/engine/paperBotPerf';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const json = (body: unknown,status=200) => NextResponse.json(body,{ status,headers:{'Cache-Control':'no-store'} });
async function context(req: NextRequest) {
  const uid = await resolveUserId(req.headers.get('authorization'),req.headers.get('x-user-id'),req.headers.get('x-dev-token'));
  // Generated legacy Database types omit current PAPER migrations; existing
  // PAPER routes use the same runtime client until schema generation is repaired.
  const sb: any = uid ? getSupabaseAdmin() : null;
  return { uid,sb };
}

/**
 * 봇이 배율을 안 적었을 때 쓸 값. **여기에 숫자를 적지 않는다** —
 * 배포 설정(`PAPER_LEVERAGE`)을 읽는 같은 함수를 쓴다. 적어 두면
 * 배포값을 바꿨을 때 저장되는 값과 돌아가는 값이 갈린다.
 */
const defaultLeverage = () => readRunnerConfig(k => process.env[k]).leverage;

export async function GET(req: NextRequest) {
  const { uid,sb } = await context(req);
  if (!uid) return json({ok:false,error:'auth_required'},401);
  if (!sb) return json({ok:false,error:'supabase_not_configured'},503);
  const [settings,runs,account,bots] = await Promise.all([
    // **`maybeSingle()`을 봇 하나에 묶어 둔다.** 102번으로 봇이 여럿이 될 수
    // 있는데, 그대로 두면 두 번째 봇이 생기는 순간 이 줄이 "여러 행" 오류로
    // 죽는다 — 화면 전체가 503이 된다.
    sb.from('paper_automation_settings').select('enabled,symbol,interval_seconds,config,next_run_at,updated_at')
      .eq('user_id',uid).eq('bot_id',DEFAULT_PAPER_BOT).maybeSingle(),
    sb.from('paper_automation_runs').select('id,state,result,entry_position_id,created_at,finished_at').eq('user_id',uid).order('created_at',{ascending:false}).limit(20),
    sb.from('paper_accounts').select('id,balance,total_pnl,total_fees,started_at').eq('user_id',uid).eq('is_default',true).maybeSingle(),
    // 봇 전부. **더하기만 한다** — 위 `settings`의 모양은 그대로 둬서
    // 예전 화면이 깨지지 않는다.
    // `config`까지 읽는다 — 봇이 **어느 전략으로** 도는지는 화면이 꼭 알아야
    // 한다. 이름만 보여 주면 역추세 봇인지 돌파 봇인지 구분할 수 없다.
    sb.from('paper_automation_settings').select('bot_id,enabled,symbol,interval_seconds,config,next_run_at,updated_at')
      .eq('user_id',uid).order('bot_id'),
  ]);
  // **`bots.error`도 본다.** 보지 않으면 `bots.data`가 null이 되고, 아래
  // 포지션 질의가 기본 봇으로만 좁혀져 **다른 봇의 거래가 조용히 사라진다.**
  // 못 읽은 것을 "없음"으로 적는 셈이다 — 목록을 못 읽었으면 화면이 그
  // 사실을 말해야 한다.
  if (settings.error || runs.error || account.error || bots.error || !Array.isArray(runs.data)
      || !Array.isArray(bots.data))
    return json({ok:false,error:'automation_unreadable',message:'서버 반복 상태를 확인하지 못했습니다'},503);
  const positions = account.data ? await sb.from('paper_positions')
    // `strategy_id`를 **되살린다.** 이 조회는 봇으로 걸러 읽으면서 정작
    // 그 칸을 빼고 보냈다 — 그래서 화면은 "이 체결이 어느 봇의 것인가"를
    // 알 수 없었고, 봇 카드에 손익을 적을 방법이 없었다.
    .select('id,strategy_id,symbol,side,status,fill_price,exit_price,stop_loss,take_profit,liquidation_price,quantity,realized_pnl,exit_reason,opened_at,closed_at')
    // **봇 전부의 체결을 읽는다.** 예전에는 `paper-auto-v1`만 봤다 — 그대로
    // 두면 새 봇이 낸 거래가 화면에도 점수판에도 안 잡힌다.
    .eq('user_id',uid).eq('paper_account_id',account.data.id)
    .in('strategy_id',bots.data.map((b:any)=>String(b.bot_id)).concat(DEFAULT_PAPER_BOT))
    .order('opened_at',{ascending:false}).limit(10) : { data:[],error:null };
  if (positions.error) return json({ok:false,error:'positions_unreadable',message:'모의 체결 이력을 읽지 못했습니다'},503);
  // ── 누가 이 회차를 깨우는가 ──
  //
  // 모의 자동매매를 깨우는 것은 **Fly 워커 하나뿐**이다
  // (`worker/src/index.ts` → `/api/paper/exit-monitor` → `runDuePaperAutomation`).
  // `vercel.json`의 cron에도, GitHub Actions cron에도 이 경로를 부르는 것이
  // 없다. 워커가 꺼져 있으면 봇을 켜 두어도 **한 건도 돌지 않는데**, 화면은
  // "반복 실행 중"까지만 말했다.
  //
  // **이 조회가 실패해도 503으로 만들지 않는다.** 나머지 화면은 그대로
  // 쓸모 있고, 못 읽은 사실은 판정기가 `RUNNER_UNKNOWN`으로 적는다.
  let beat: any = null, heartbeatReadFailed = false;
  try {
    const hb = await sb.from('worker_heartbeat')
      .select('worker_id,last_seen,status').order('last_seen',{ascending:false}).limit(1).maybeSingle();
    if (hb.error) heartbeatReadFailed = true; else beat = hb.data ?? null;
  } catch { heartbeatReadFailed = true; }
  // **`enabled === true`만 켜진 것이다.** 문자열 'false'는 truthy다.
  const enabledBotRows = bots.data.filter((b:any) => b.enabled === true);
  const intervals = enabledBotRows.map((b:any) => Number(b.interval_seconds))
    .filter((n:number) => Number.isFinite(n) && n > 0);
  const runner = paperRunnerStatus({
    nowMs: Date.now(),
    enabledBots: enabledBotRows.length,
    workerLastSeen: beat?.last_seen ?? null,
    heartbeatReadFailed,
    lastRunAt: runs.data[0]?.created_at ?? null,
    shortestIntervalSec: intervals.length ? Math.min(...intervals) : null,
  });
  const { id: _accountId,...accountView } = account.data ?? {};
  // 전략은 **판정하는 쪽과 같은 함수로** 읽는다. 화면이 따로 `config.signal`을
  // 해석하면 러너와 다른 답을 낼 수 있고, 그러면 "화면에는 돌파인데 추세
  // 추종이 도는" 상태가 된다.
  // ── 봇별 **실제 측정된** 성과 ──
  //
  // 지어내지 않는다. `paper_positions`에 실재하는 `realized_pnl`과
  // `margin`만 센다. 이 조회가 실패해도 503으로 만들지 않는다 — 나머지
  // 화면은 그대로 쓸모 있고, 못 읽었다는 사실은 `unreadable`로 간다.
  // **0으로 적지 않는다.**
  const botIds: string[] = bots.data.map((b:any) => String(b.bot_id));
  let perfRows: any[] | null = null, perfUnreadable = false;
  if (account.data && botIds.length > 0) {
    try {
      const pr = await sb.from('paper_positions')
        .select('strategy_id,status,realized_pnl,margin')
        .eq('user_id',uid).eq('paper_account_id',account.data.id)
        .in('strategy_id',botIds)
        .order('opened_at',{ascending:false}).limit(PERF_ROW_CAP);
      if (pr.error || !Array.isArray(pr.data)) perfUnreadable = true; else perfRows = pr.data;
    } catch { perfUnreadable = true; }
  } else if (!account.data) {
    // 계좌가 없으면 체결도 없다. **못 읽은 것이 아니라 없는 것**이다.
    perfRows = [];
  }
  const perf = summarizeBotPerf({ rows: perfRows, botIds, unreadable: perfUnreadable });
  const botView = bots.data.map((b:any) => {
    const { signal,bad } = readBotSignal(b.config);
    // 주기도 **판정하는 쪽과 같은 함수로** 읽는다. 화면이 따로 해석하면
    // "화면에는 1분봉인데 일봉이 도는" 상태가 된다.
    const tf = readBotTimeframe(b.config);
    // 배율도 **판정하는 쪽과 같은 함수로** 읽는다. 화면이 계정 설정값을
    // 그리면 "화면에는 5배인데 20배가 도는" 상태가 된다.
    const lev = readBotLeverage(b.config, defaultLeverage());
    const { config: _cfg,...rest } = b;
    return { ...rest,signal,signalLabel:ENTRY_SIGNAL_LABEL[signal],
      perf: perf[String(b.bot_id)] ?? null,
      timeframe:tf.timeframe,timeframeLabel:barIntervalLabel(tf.timeframe),
      leverage:lev.leverage,
      ...(bad ? { signalWarning:bad } : {}),
      ...(tf.bad ? { timeframeWarning:tf.bad } : {}),
      ...(lev.bad ? { leverageWarning:lev.bad } : {}) };
  });
  return json({ok:true,settings:settings.data,bots:botView,runs:runs.data,account:account.data ? accountView : null,positions:positions.data,runner});
}
export async function POST(req: NextRequest) {
  const { uid,sb } = await context(req);
  if (!uid) return json({ok:false,error:'auth_required'},401);
  if (!sb) return json({ok:false,error:'supabase_not_configured'},503);
  const input = parsePaperAutomationControl(await req.json().catch(()=>null));
  if (!input) return json({ok:false,error:'invalid_control'},400);
  // 전략을 안 적었으면 **이미 저장된 것을 지킨다.** RPC가 config를 통째로
  // 교체하므로(102번 `ON CONFLICT ... config=p_config`), 여기서 기본값을
  // 채우면 전략을 안 보내는 옛 화면이 켤 때마다 그 봇을 추세 추종으로
  // 되돌린다. 처음 켜는 봇일 때만 기본값이다.
  let signal = input.signal;
  if (signal == null) {
    const prev = await sb.from('paper_automation_settings').select('config')
      .eq('user_id',uid).eq('bot_id',input.botId).maybeSingle();
    // 못 읽었으면 **덮지 않는다** — 되돌릴 위험이 있으면 멈추는 쪽이 낫다.
    if (prev.error) return json({ok:false,error:'control_failed',
      message:'이 봇의 기존 전략을 확인하지 못해 설정을 바꾸지 않았습니다. 잠시 뒤 다시 시도하세요.'},503);
    signal = prev.data ? readBotSignal(prev.data.config).signal : DEFAULT_ENTRY_SIGNAL;
  }
  // 주기도 같다. `config`를 통째로 교체하는 `ON CONFLICT` 때문에, 주기를
  // 안 보내는 요청이 봇을 조용히 일봉으로 되돌리면 그 봇의 1분봉 기록과
  // 일봉 기록이 한 `strategy_id`에 섞인다.
  let timeframe = input.timeframe;
  if (timeframe == null) {
    const prev = await sb.from('paper_automation_settings').select('config')
      .eq('user_id',uid).eq('bot_id',input.botId).maybeSingle();
    if (prev.error) return json({ok:false,error:'control_failed',
      message:'이 봇의 기존 봉 주기를 확인하지 못해 설정을 바꾸지 않았습니다. 잠시 뒤 다시 시도하세요.'},503);
    timeframe = prev.data ? readBotTimeframe(prev.data.config).timeframe : DEFAULT_BAR_INTERVAL;
  }
  // 배율도 같다. config를 통째로 교체하는 `ON CONFLICT` 때문에, 배율을
  // 안 보내는 요청이 20배 봇을 조용히 계정 기본값으로 되돌리면 그 봇의
  // 20배 기록과 5배 기록이 한 `strategy_id`에 섞인다.
  let leverage = input.leverage;
  if (leverage == null) {
    const prev = await sb.from('paper_automation_settings').select('config')
      .eq('user_id',uid).eq('bot_id',input.botId).maybeSingle();
    if (prev.error) return json({ok:false,error:'control_failed',
      message:'이 봇의 기존 배율을 확인하지 못해 설정을 바꾸지 않았습니다. 잠시 뒤 다시 시도하세요.'},503);
    leverage = prev.data
      ? readBotLeverage(prev.data.config, defaultLeverage()).leverage
      : defaultLeverage();
  }
  const result = await sb.rpc('paper_auto_control',{ p_user_id:uid,p_bot_id:input.botId,p_enabled:input.enabled,
    p_symbol:input.symbol,p_interval:input.interval,
    p_config:{...readRunnerConfig(k=>process.env[k]),maxOpenPositions:1,signal,timeframe,leverage} });
  if (result.error) return json({ok:false,error:'control_failed',message:'설정을 저장하지 못했습니다. 기본 모의 계좌를 먼저 시작하고 다시 시도하세요.'},409);
  return json({ok:true,settings:result.data});
}
