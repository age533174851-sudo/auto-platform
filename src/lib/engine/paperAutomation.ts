// Durable PAPER cycles. The existing worker's PAPER exit sweep supplies the wakeup.
// No browser timers, user tokens, exchange adapters, or TESTNET scheduler changes.
import { planEntry, planExits, DEFAULT_RUNNER, type OpenPaperPos } from './paperRunner';
import { buildPaperPlan } from './paperPlan';
import { dispatchPaperEntry } from './paperDispatch';
import { closePaperPosition } from './paperStore';
import { availableView } from './paperAvailable';
import { parseBarInterval, DEFAULT_BAR_INTERVAL, BAR_INTERVALS, type BarInterval } from '../risk/bars';
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

/**
 * 새 봇 이름을 **종목과 전략에서 만든다.**
 *
 * 같은 조합으로 다시 켜면 **같은 이름**이 나와야 한다. 켤 때마다 새 이름을
 * 지으면 같은 전략의 기록이 여러 `strategy_id`로 쪼개지고, 봇을 나눈 이유인
 * 비교가 그때 사라진다.
 *
 * 모양이 DB 제약(`PAPER_BOT_ID`)에 안 맞으면 **null이다.** 억지로 자르거나
 * 이름을 지어내지 않는다 — 못 만든 것을 만든 것처럼 넘기면 409가 난다.
 */
export function derivePaperBotId(
  symbol: unknown, signal: EntrySignalId, timeframe: BarInterval = DEFAULT_BAR_INTERVAL,
): string | null {
  const sym = String(symbol ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!sym) return null;
  // **주기도 이름에 들어간다.** 1분봉 돌파와 일봉 돌파는 다른 기계다 —
  // 한 이름을 쓰면 두 기록이 한 `strategy_id` 아래 섞이고, 비교가 그때
  // 망가진다.
  const tf = String(timeframe ?? '').trim().toLowerCase();
  if (!parseBarInterval(tf)) return null;
  const id = `${sym}-${tf}-${signal}`;
  return PAPER_BOT_ID.test(id) ? id : null;
}
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
/**
 * **"안 적었다"는 `null`·`undefined`·공백 문자열뿐이다.**
 *
 * `String([])`가 빈 문자열이라서, 느슨하게 보면 `signal: []`이 "안 적음"으로
 * 통과한다. `[]`는 미지정이 아니라 잘못된 값이고, 잘못된 값은 거절해야 한다.
 */
function fieldOmitted(raw: unknown): boolean {
  if (raw == null) return true;
  return typeof raw === 'string' && raw.trim() === '';
}

export function readBotSignal(config: unknown): { signal: EntrySignalId; bad: string | null } {
  const raw = config && typeof config === 'object' && !Array.isArray(config)
    ? (config as Record<string, unknown>).signal : undefined;
  // 안 적혀 있으면 지금까지 돌던 전략이다. 그래야 `paper-auto-v1`의 기록이
  // 이어진다.
  if (fieldOmitted(raw)) return { signal: DEFAULT_ENTRY_SIGNAL, bad: null };
  const got = parseEntrySignal(raw);
  // **적혀 있는데 모르는 값이면 기본값으로 돌리지 않는다.** 돌리면 오타 하나로
  // 추세 추종이 돌면서 그 봇의 성적표에 적히고, 그 전략을 평가할 방법이
  // 사라진다.
  return got
    ? { signal: got, bad: null }
    : { signal: DEFAULT_ENTRY_SIGNAL,
        bad: `알 수 없는 진입 전략입니다: ${String(raw).slice(0, 40)} (가능: ${ENTRY_SIGNAL_IDS.join(' · ')})` };
}

/**
 * 이 봇이 보는 **봉 주기**. 전략과 같은 규칙이다.
 *
 * 안 적혀 있으면 지금까지 돌던 일봉이다. **적혀 있는데 모르는 값이면
 * 기본값으로 돌리지 않는다** — 돌리면 사용자는 1분봉 봇을 켰다고 생각하는데
 * 일봉이 돌면서 그 봇의 성적표에 적힌다.
 */
export function readBotTimeframe(config: unknown): { timeframe: BarInterval; bad: string | null } {
  const raw = config && typeof config === 'object' && !Array.isArray(config)
    ? (config as Record<string, unknown>).timeframe : undefined;
  if (fieldOmitted(raw)) return { timeframe: DEFAULT_BAR_INTERVAL, bad: null };
  const got = parseBarInterval(raw);
  return got
    ? { timeframe: got, bad: null }
    : { timeframe: DEFAULT_BAR_INTERVAL,
        bad: `알 수 없는 봉 주기입니다: ${String(raw).slice(0, 40)} (가능: ${BAR_INTERVALS.join(' · ')})` };
}

/**
 * 봇이 걸 **배율**. 거래소 선물 한도에 맞춰 1~125배를 받는다.
 *
 * 전에는 배율이 계정 설정 하나였다 — `readRunnerConfig(env)`가 읽는
 * `PAPER_LEVERAGE` 한 값을 모든 봇이 같이 썼다. 그래서 "보수적인 봇과
 * 공격적인 봇을 나란히 돌려 비교한다"가 되지 않았다.
 *
 * **적혀 있는데 범위를 벗어나면 조용히 깎지 않는다.** 깎으면 사용자는
 * 50배 봇을 켰다고 생각하는데 5배가 돌면서 그 봇의 성적표에 적힌다 —
 * 전략과 봉 주기에서 이미 같은 판단을 했다. 부르는 쪽이 `bad`를 보고
 * 멈춘다.
 */
/**
 * 화면이 고를 수 있는 배율 단계. **범위(1~125)와 따로 적지 않는다** —
 * 여기 없는 값도 `parseBotLeverage`가 받으므로(옛 봇·직접 호출), 이 목록은
 * 고르기 편한 단계일 뿐 울타리가 아니다.
 */
export const BOT_LEVERAGE_CHOICES = [1, 2, 3, 5, 10, 20, 50, 75, 100, 125] as const;

export const BOT_LEVERAGE_MIN = 1;
export const BOT_LEVERAGE_MAX = 125;

export function readBotLeverage(config: unknown, fallback: number):
  { leverage: number; bad: string | null } {
  const raw = config && typeof config === 'object' && !Array.isArray(config)
    ? (config as Record<string, unknown>).leverage : undefined;
  if (fieldOmitted(raw)) return { leverage: fallback, bad: null };
  const got = parseBotLeverage(raw);
  return got != null
    ? { leverage: got, bad: null }
    : { leverage: fallback,
        bad: `배율은 ${BOT_LEVERAGE_MIN}~${BOT_LEVERAGE_MAX} 사이의 정수여야 합니다: ${String(raw).slice(0, 40)}` };
}

/** 받아들일 수 있는 배율이면 그 수, 아니면 `null`. **깎아서 돌려주지 않는다.** */
export function parseBotLeverage(raw: unknown): number | null {
  if (typeof raw === 'boolean') return null;
  const v = Number(raw);
  if (!Number.isFinite(v) || !Number.isInteger(v)) return null;
  if (v < BOT_LEVERAGE_MIN || v > BOT_LEVERAGE_MAX) return null;
  return v;
}

export function parsePaperAutomationControl(body: unknown):
  { enabled: boolean; symbol: string; interval: number; botId: string;
    /**
     * **`null`은 "안 적었다"는 뜻이고 "추세 추종"이 아니다.**
     *
     * `paper_auto_control`의 `ON CONFLICT`는 `config=p_config`로 config를
     * **통째로 교체**한다. 그래서 여기서 null을 기본값으로 채우면, 전략을
     * 안 보내는 옛 화면이 봇을 다시 켤 때마다 그 봇이 조용히 추세 추종으로
     * 바뀐다 — 이름은 그대로인 채 한 `strategy_id` 아래 두 전략의 기록이
     * 섞이고, 이 기능이 존재하는 이유인 비교가 그때 망가진다.
     *
     * 그래서 "안 적었다"를 그대로 올려 보내고, 저장하는 쪽이 **이미 저장된
     * 전략을 지킨다.**
     */
    signal: EntrySignalId | null;
    /** 봉 주기. **`null`은 "안 적었다"** — 저장된 값을 지키게 한다 */
    timeframe: BarInterval | null;
    /** 배율. **`null`은 "안 적었다"** — 저장된 값을 지키게 한다 */
    leverage: number | null } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  // **안 적으면 옛 봇이다.** 이 줄이 없으면 예전 화면이 보내던 요청이
  // 새 봇을 만들어 버리고, 돌던 봇은 멈춘 것처럼 보인다.
  const botId = b.botId == null || b.botId === '' ? DEFAULT_PAPER_BOT : String(b.botId);
  if (!PAPER_BOT_ID.test(botId)) return null;
  // 끄는 데는 전략이 필요하지 않다. null은 "안 적었다"다.
  if (b.action === 'stop') return { enabled: false, symbol: 'BTCUSDT', interval: 60, botId, signal: null, timeframe: null, leverage: null };
  // **화면이 고를 수 있는 종목과 같아야 한다.** #658에서 화면 드롭다운에
  // SOLUSDT를 넣었는데 이 목록에 없어서 400으로 거절됐다 — 고를 수 있는데
  // 눌리지 않는 자리였다.
  if (b.action !== 'start' || !['BTCUSDT','ETHUSDT','SOLUSDT'].includes(String(b.symbol))
      || ![60,300,900].includes(b.interval as number)) return null;
  // 모르는 전략 이름은 **400으로 거절한다.** 조용히 기본값으로 켜 주면
  // 사용자는 역추세 봇을 켰다고 생각하는데 추세 추종이 돈다.
  const omitted = fieldOmitted(b.signal);
  const signal = omitted ? null : parseEntrySignal(b.signal);
  if (!omitted && !signal) return null;
  // 주기도 같다 — 모르는 값은 조용히 일봉으로 바꾸지 않고 400으로 거절한다.
  const tfOmitted = fieldOmitted(b.timeframe);
  const timeframe = tfOmitted ? null : parseBarInterval(b.timeframe);
  if (!tfOmitted && !timeframe) return null;
  // 배율도 같다 — 범위를 벗어난 값은 조용히 깎지 않고 400으로 거절한다.
  const levOmitted = fieldOmitted(b.leverage);
  const leverage = levOmitted ? null : parseBotLeverage(b.leverage);
  if (!levOmitted && leverage == null) return null;
  return { enabled: true, symbol: b.symbol as string, interval: b.interval as number, botId, signal, timeframe, leverage };
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
  // 주기도 모르면 멈춘다 — 모르는 주기로 "일단 일봉" 돌리지 않는다.
  const tf = readBotTimeframe(run.config);
  if (tf.bad) return { code: 'TIMEFRAME_UNKNOWN', message: tf.bad };
  // 배율도 모르면 멈춘다. `runCfg`가 config를 통째로 펼치므로 검증하지
  // 않으면 이상한 값이 그대로 `cfg.leverage`가 되어 체결에 적힌다.
  const lev = readBotLeverage(run.config, DEFAULT_RUNNER.leverage);
  if (lev.bad) return { code: 'LEVERAGE_UNKNOWN', message: lev.bad };
  cfg.leverage = lev.leverage;
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
    // 봉 전체도 그대로 넘긴다. 오더블록·FVG·유동성 사냥·거래량 확인 돌파는
    // 고가·저가·거래량이 있어야 표현된다 — 없으면 그 전략들은 쉰다.
    bars:verdict.regime?.dataOk ? (regime.bars ?? null) : null,
    signal:bot.signal,
    markPrice:quotes.get(run.symbol) ?? null,
    // **이 봇이 들고 있는 것만 센다.** 계좌 전체 한도는 `paper_auto_open`
    // (104번)이 "켜 둔 봇 수"로 지킨다. 여기서 계좌 전체를 세면 BTC 봇이
    // 들고 있는 동안 ETH 봇이 영원히 못 들어간다 — 봇을 여러 개 만든 뜻이
    // 사라진다. 두 관문은 **다른 것**을 막는다:
    //   여기   전략 하나가 동시에 둘을 들지 않는다 (성적표 비교 가능성)
    //   104    계좌 전체 자리 수 (노출 상한)
    availableUsd:available.available,
    openCount:positions.filter(p => p.strategy_id === run.bot_id && p.market === 'USDM').length,
    cfg });
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
