// Durable PAPER cycles. The existing worker's PAPER exit sweep supplies the wakeup.
// No browser timers, user tokens, exchange adapters, or TESTNET scheduler changes.
import { planEntry, planExits, DEFAULT_RUNNER, type OpenPaperPos } from './paperRunner';
import { buildPaperPlan } from './paperPlan';
import { dispatchPaperEntry } from './paperDispatch';
import { closePaperPosition } from './paperStore';
import { availableView } from './paperAvailable';
import { readPaperMarkPrice, paperPriceFailed } from './paperPriceSource';
import { collectPaperDailyLoss } from '../risk/dailyLossCheck';
import { collectRegime } from '../risk/regimeCheck';

export interface PaperAutomationResult { code: string; message: string; positionId?: string; }
export function parsePaperAutomationControl(body: unknown):
  { enabled: boolean; symbol: string; interval: number } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (b.action === 'stop') return { enabled: false, symbol: 'BTCUSDT', interval: 60 };
  if (b.action !== 'start' || !['BTCUSDT','ETHUSDT'].includes(String(b.symbol))
      || ![60,300,900].includes(b.interval as number)) return null;
  return { enabled: true, symbol: b.symbol as string, interval: b.interval as number };
}

const n = (v: unknown): number | null => v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
function openPosition(r: any): OpenPaperPos {
  return { id: r.id, symbol: r.symbol, side: r.side, fillPrice: Number(r.fill_price),
    quantity: Number(r.quantity), stopLoss: n(r.stop_loss), takeProfit: n(r.take_profit),
    liquidationPrice: n(r.liquidation_price), openedAt: new Date(r.opened_at).getTime() };
}

// Dependency seam for offline quote fixtures; production always uses the existing readers.
export const paperAutomationSources = {
  price: readPaperMarkPrice, regime: collectRegime, dailyLoss: collectPaperDailyLoss,
};

export async function evaluatePaperAutomation(sb: any, run: any,
  sources = paperAutomationSources): Promise<PaperAutomationResult> {
  if (run.entry_position_id) return { code: 'ENTERED', positionId: run.entry_position_id,
    message: '이전 회차의 영속 체결을 복구했습니다' };
  const cfg = { ...DEFAULT_RUNNER, ...run.config };
  const rows = async () => {
    const r = await sb.from('paper_positions').select('*').eq('user_id',run.user_id)
      .eq('paper_account_id',run.paper_account_id).eq('status','open');
    if (r.error || !Array.isArray(r.data)) throw new Error('열린 포지션 조회 실패');
    return r.data as any[];
  };
  let positions = await rows();
  // Time exits belong only to this runner and its explicit, persisted policy.
  // Global SL/TP/liquidation safety continues independently even after Stop.
  const own = positions.filter(p => p.strategy_id === 'paper-auto-v1' && p.market === 'USDM');
  const quotes = new Map<string, number>();
  for (const symbol of new Set<string>([run.symbol,...own.map(p => p.symbol)])) {
    const price = await sources.price('USDM', symbol);
    if (paperPriceFailed(price)) return { code: 'UNKNOWN_PRICE', message: price.reason };
    quotes.set(symbol,price.price);
  }
  for (const p of own) {
    const mark = quotes.get(p.symbol)!;
    for (const exit of planExits([openPosition(p)],mark,Date.now(),cfg)) {
      const result = await closePaperPosition(sb,p.id,mark,exit.exitReason as any);
      if (!result.ok && result.error !== '이미 청산된 포지션')
        return { code: 'EXIT_FAILED', message: String(result.error).slice(0,300) };
    }
  }
  // Re-read both after settlement. A previous account snapshot must not size the next entry.
  positions = await rows();
  const { data: account,error } = await sb.from('paper_accounts').select('balance,started_at,is_default')
    .eq('id',run.paper_account_id).eq('user_id',run.user_id).maybeSingle();
  if (error || !account?.started_at || !account.is_default)
    return { code: 'ACCOUNT_UNAVAILABLE', message: '시작한 기본 모의 계좌를 읽지 못했습니다' };
  const available = availableView(account.balance,positions);
  if (available.available == null) return { code: 'UNKNOWN_BALANCE', message: available.unknownReason! };
  const loss = await sources.dailyLoss({ sb,userId:run.user_id,paperAccountId:run.paper_account_id });
  if (loss.verdict.blockEntries) return { code: 'RISK_BLOCKED', message: loss.verdict.reason };
  const regime = await sources.regime({ symbol:run.symbol,side:'LONG' });
  const verdict = regime.verdict;
  const entry = planEntry({ symbol:run.symbol,regimeStatus:!verdict.regime?.dataOk ? 'unknown'
      : verdict.blockEntries ? 'blocked' : 'ok', regimeReason:verdict.reason,
    trend:verdict.regime?.trend ?? null,markPrice:quotes.get(run.symbol) ?? null,
    availableUsd:available.available,openCount:positions.length,cfg });
  if (entry.kind !== 'OPEN') return { code: 'WAIT', message: entry.reason };
  const plan = buildPaperPlan({ symbol:run.symbol,side:entry.side!,market:'USDM',
    quantity:entry.quantity!,leverage:cfg.leverage,markPrice:quotes.get(run.symbol)!,
    stopPrice:entry.stopPrice,takeProfit:entry.takeProfit,availableBalance:available.available });
  if (!plan.ok || !plan.plan) return { code: 'PLAN_BLOCKED', message: plan.reason };
  // The final ledger write is fenced inside PostgreSQL, in the SAME transaction as the fill.
  // Reuse dispatchPaperEntry -> openPaperPosition -> simulateFill, including fees/slippage.
  const fenced = { rpc: (name: string,args: any) => {
    if (name !== 'paper_open_position') throw new Error('Unexpected PAPER money RPC');
    return sb.rpc('paper_auto_open',{ p_run_id:run.id,p_token:run.lease_token,p_order:args });
  } };
  const fill = await dispatchPaperEntry(fenced,{ userId:run.user_id,mode:'PAPER',
    strategyId:'paper-auto-v1',signalId:`paper-auto:${run.id}`,plan:plan.plan,
    entryPrice:quotes.get(run.symbol)!,stopLoss:entry.stopPrice,takeProfit:entry.takeProfit,
    market:'USDM',marginMode:'ISOLATED' });
  return { code:fill.ok ? (fill.positionId ? 'ENTERED' : fill.code) : 'ENTRY_FAILED',
    message:fill.reason,...(fill.positionId ? { positionId:fill.positionId } : {}) };
}

/** At most one user per wakeup; expired leases recover the SAME durable signal. */
export async function runDuePaperAutomation(sb: any, sources = paperAutomationSources) {
  const claim = await sb.rpc('paper_auto_claim');
  if (claim.error || !Array.isArray(claim.data)) return { ok:false,code:'CLAIM_UNAVAILABLE' };
  if (!claim.data.length) return { ok:true,code:'NOT_DUE' };
  const run = claim.data[0];
  let result: PaperAutomationResult;
  try { result = await evaluatePaperAutomation(sb,run,sources); }
  catch { result = { code:'EVALUATION_FAILED',message:'평가 자료를 확인하지 못해 새 진입을 중단했습니다' }; }
  const finish = await sb.rpc('paper_auto_finish',{ p_run_id:run.id,p_token:run.lease_token,p_result:result });
  return { ok:!finish.error && finish.data === true,code:finish.error || finish.data !== true
    ? 'RECOVERY_PENDING' : result.code };
}
