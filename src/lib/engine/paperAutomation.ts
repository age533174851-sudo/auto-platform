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
import {
  parseEntrySignal, DEFAULT_ENTRY_SIGNAL, ENTRY_SIGNAL_IDS,
  type EntrySignalId,
} from './entrySignals';

export interface PaperAutomationResult { code: string; message: string; positionId?: string; }
/**
 * 봇 이름. **DB가 받는 모양과 같아야 한다** — 102번의
 * `paper_automation_settings_bot_id_shape`가 같은 정규식으로 막는다.
 * 여기서 먼저 걸러야 사용자가 409 대신 400을 받는다.
 */
export const PAPER_BOT_ID = /^[a-z0-9][a-z0-9-]{1,62}$/;
/** 안 적으면 이 봇. 099 시절부터 돌던 그 봇이다 */
export const DEFAULT_PAPER_BOT = 'paper-auto-v1';

/**
 * 봇이 쓸 진입 전략을 `config.signal`에 넣는다.
 *
 * **새 컬럼을 만들지 않는다.** `paper_automation_settings.config`는 099부터
 * 있고 `paper_auto_control`이 그대로 저장하며 러너가 `run.config`로 읽는다.
 * 컬럼·CHECK·RPC 시그니처를 새로 만들면 그 셋이 서로 어긋날 수 있는 자리가
 * 세 개 생긴다 — 이미 끝까지 흐르는 통로가 있으면 그것을 쓴다.
 */
export function readBotSignal(config: unknown): { signal: EntrySignalId; bad: string | null } {
  const raw = config && typeof config === 'object' && !Array.isArray(config)
    ? (config as Record<string, unknown>).signal : undefined;
  // 안 적혀 있으면 지금까지 돌던 전략이다. 그래야 `paper-auto-v1`의 기록이
  // 이어진다.
  if (raw == null || String(raw).trim() === '') return { signal: DEFAULT_ENTRY_SIGNAL, bad: null };
  const got = parseEntrySignal(raw);
  // **적혀 있는데 모르는 값이면 기본값으로 돌리지 않는다.** 돌리면 오타 하나로
  // 추세 추종이 돌면서 그 봇의 성적표에 적히고, 그 전략을 평가할 방법이
  // 사라진다.
  return got
    ? { signal: got, bad: null }
    : { signal: DEFAULT_ENTRY_SIGNAL,
        bad: `알 수 없는 진입 전략입니다: ${String(raw).slice(0, 40)} (가능: ${ENTRY_SIGNAL_IDS.join(' · ')})` };
}

export function parsePaperAutomationControl(body: unknown):
  { enabled: boolean; symbol: string; interval: number; botId: string; signal: EntrySignalId } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  // **안 적으면 옛 봇이다.** 이 줄이 없으면 예전 화면이 보내던 요청이
  // 새 봇을 만들어 버리고, 돌던 봇은 멈춘 것처럼 보인다.
  const botId = b.botId == null || b.botId === '' ? DEFAULT_PAPER_BOT : String(b.botId);
  if (!PAPER_BOT_ID.test(botId)) return null;
  if (b.action === 'stop') return { enabled: false, symbol: 'BTCUSDT', interval: 60, botId, signal: DEFAULT_ENTRY_SIGNAL };
  if (b.action !== 'start' || !['BTCUSDT','ETHUSDT'].includes(String(b.symbol))
      || ![60,300,900].includes(b.interval as number)) return null;
  // 모르는 전략 이름은 **400으로 거절한다.** 조용히 기본값으로 켜 주면
  // 사용자는 역추세 봇을 켰다고 생각하는데 추세 추종이 돈다.
  const signal = b.signal == null || b.signal === '' ? DEFAULT_ENTRY_SIGNAL : parseEntrySignal(b.signal);
  if (!signal) return null;
  return { enabled: true, symbol: b.symbol as string, interval: b.interval as number, botId, signal };
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
  // `signal`은 설정값이 아니라 **전략 선택**이다. RunnerConfig에 섞어 넣으면
  // `readRunnerConfig`가 모르는 키를 들고 다니게 된다.
  const { signal: _signalKey, ...runCfg } = (run.config ?? {}) as Record<string, unknown>;
  const cfg = { ...DEFAULT_RUNNER, ...runCfg };
  const bot = readBotSignal(run.config);
  // 적혀 있는데 모르는 전략이면 **진입하지 않는다.** 이 회차를 기본 전략으로
  // 돌려 버리면 그 체결이 이 봇의 기록이 된다.
  if (bot.bad) return { code: 'SIGNAL_UNKNOWN', message: bot.bad };
  const rows = async () => {
    const r = await sb.from('paper_positions').select('*').eq('user_id',run.user_id)
      .eq('paper_account_id',run.paper_account_id).eq('status','open');
    if (r.error || !Array.isArray(r.data)) throw new Error('열린 포지션 조회 실패');
    return r.data as any[];
  };
  let positions = await rows();
  // Time exits belong only to this runner and its explicit, persisted policy.
  // Global SL/TP/liquidation safety continues independently even after Stop.
  // **이 봇의 포지션만 본다.** `paper_auto_open`이 `strategy_id`에 봇 이름을
  // 적으므로(102번), 'paper-auto-v1'로 묶어 두면 새 봇의 포지션은 시간 청산을
  // 영원히 못 받는다 — 손절·익절은 전역 경로가 보지만 보유시간은 이 러너만 본다.
  const own = positions.filter(p => p.strategy_id === run.bot_id && p.market === 'USDM');
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
    trend:verdict.regime?.trend ?? null,
    // 국면이 이미 계산해 둔 관측값(종가·EMA·ATR·박스·돌파선)을 그대로 넘긴다.
    // 이것이 없으면 역추세·돌파는 방향을 내지 않는다 — 없는 값을 0으로 바꿔
    // 계산하는 대신 쉰다.
    view:verdict.regime?.dataOk ? (verdict.regime?.view ?? null) : null,
    signal:bot.signal,
    markPrice:quotes.get(run.symbol) ?? null,
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
    // SQL(`paper_auto_open`)이 `s.bot_id`를 strategy_id로 적으므로 이 값은
    // 쓰이지 않지만, 두 자리가 다른 이름을 들고 있으면 읽는 사람이 어느 쪽이
    // 진짜인지 모른다.
    strategyId:String(run.bot_id ?? DEFAULT_PAPER_BOT),signalId:`paper-auto:${run.id}`,plan:plan.plan,
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
