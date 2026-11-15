import { NextRequest,NextResponse } from 'next/server';
import { getSupabaseAdmin,resolveUserId } from '@/lib/supabase/admin';
import { parsePaperAutomationControl,readBotSignal,DEFAULT_PAPER_BOT } from '@/lib/engine/paperAutomation';
import { ENTRY_SIGNAL_LABEL } from '@/lib/engine/entrySignals';
import { readRunnerConfig } from '@/lib/engine/paperRunner';

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
  if (settings.error || runs.error || account.error || !Array.isArray(runs.data))
    return json({ok:false,error:'automation_unreadable',message:'서버 반복 상태를 확인하지 못했습니다'},503);
  const positions = account.data ? await sb.from('paper_positions')
    .select('id,symbol,side,status,fill_price,exit_price,stop_loss,take_profit,liquidation_price,quantity,realized_pnl,exit_reason,opened_at,closed_at')
    // **봇 전부의 체결을 읽는다.** 예전에는 `paper-auto-v1`만 봤다 — 그대로
    // 두면 새 봇이 낸 거래가 화면에도 점수판에도 안 잡힌다.
    .eq('user_id',uid).eq('paper_account_id',account.data.id)
    .in('strategy_id',(bots.data ?? []).map((b:any)=>String(b.bot_id)).concat(DEFAULT_PAPER_BOT))
    .order('opened_at',{ascending:false}).limit(10) : { data:[],error:null };
  if (positions.error) return json({ok:false,error:'positions_unreadable',message:'모의 체결 이력을 읽지 못했습니다'},503);
  const { id: _accountId,...accountView } = account.data ?? {};
  // 전략은 **판정하는 쪽과 같은 함수로** 읽는다. 화면이 따로 `config.signal`을
  // 해석하면 러너와 다른 답을 낼 수 있고, 그러면 "화면에는 돌파인데 추세
  // 추종이 도는" 상태가 된다.
  const botView = (bots.data ?? []).map((b:any) => {
    const { signal,bad } = readBotSignal(b.config);
    const { config: _cfg,...rest } = b;
    return { ...rest,signal,signalLabel:ENTRY_SIGNAL_LABEL[signal],
      ...(bad ? { signalWarning:bad } : {}) };
  });
  return json({ok:true,settings:settings.data,bots:bots.data ? botView : null,runs:runs.data,account:account.data ? accountView : null,positions:positions.data});
}
export async function POST(req: NextRequest) {
  const { uid,sb } = await context(req);
  if (!uid) return json({ok:false,error:'auth_required'},401);
  if (!sb) return json({ok:false,error:'supabase_not_configured'},503);
  const input = parsePaperAutomationControl(await req.json().catch(()=>null));
  if (!input) return json({ok:false,error:'invalid_control'},400);
  const result = await sb.rpc('paper_auto_control',{ p_user_id:uid,p_bot_id:input.botId,p_enabled:input.enabled,
    p_symbol:input.symbol,p_interval:input.interval,
    p_config:{...readRunnerConfig(k=>process.env[k]),maxOpenPositions:1,signal:input.signal} });
  if (result.error) return json({ok:false,error:'control_failed',message:'설정을 저장하지 못했습니다. 기본 모의 계좌를 먼저 시작하고 다시 시도하세요.'},409);
  return json({ok:true,settings:result.data});
}
