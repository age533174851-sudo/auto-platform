import { NextRequest,NextResponse } from 'next/server';
import { getSupabaseAdmin,resolveUserId } from '@/lib/supabase/admin';
import { parsePaperAutomationControl } from '@/lib/engine/paperAutomation';
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
  const [settings,runs,account] = await Promise.all([
    sb.from('paper_automation_settings').select('enabled,symbol,interval_seconds,config,next_run_at,updated_at').eq('user_id',uid).maybeSingle(),
    sb.from('paper_automation_runs').select('id,state,result,entry_position_id,created_at,finished_at').eq('user_id',uid).order('created_at',{ascending:false}).limit(20),
    sb.from('paper_accounts').select('id,balance,total_pnl,total_fees,started_at').eq('user_id',uid).eq('is_default',true).maybeSingle(),
  ]);
  if (settings.error || runs.error || account.error || !Array.isArray(runs.data))
    return json({ok:false,error:'automation_unreadable',message:'서버 반복 상태를 확인하지 못했습니다'},503);
  const positions = account.data ? await sb.from('paper_positions')
    .select('id,symbol,side,status,fill_price,exit_price,stop_loss,take_profit,liquidation_price,quantity,realized_pnl,exit_reason,opened_at,closed_at')
    .eq('user_id',uid).eq('paper_account_id',account.data.id).eq('strategy_id','paper-auto-v1')
    .order('opened_at',{ascending:false}).limit(10) : { data:[],error:null };
  if (positions.error) return json({ok:false,error:'positions_unreadable',message:'모의 체결 이력을 읽지 못했습니다'},503);
  const { id: _accountId,...accountView } = account.data ?? {};
  return json({ok:true,settings:settings.data,runs:runs.data,account:account.data ? accountView : null,positions:positions.data});
}
export async function POST(req: NextRequest) {
  const { uid,sb } = await context(req);
  if (!uid) return json({ok:false,error:'auth_required'},401);
  if (!sb) return json({ok:false,error:'supabase_not_configured'},503);
  const input = parsePaperAutomationControl(await req.json().catch(()=>null));
  if (!input) return json({ok:false,error:'invalid_control'},400);
  const result = await sb.rpc('paper_auto_control',{ p_user_id:uid,p_enabled:input.enabled,
    p_symbol:input.symbol,p_interval:input.interval,p_config:{...readRunnerConfig(k=>process.env[k]),maxOpenPositions:1} });
  if (result.error) return json({ok:false,error:'control_failed',message:'설정을 저장하지 못했습니다. 기본 모의 계좌를 먼저 시작하고 다시 시도하세요.'},409);
  return json({ok:true,settings:result.data});
}
