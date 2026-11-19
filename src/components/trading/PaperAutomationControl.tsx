'use client';
import React,{ useCallback,useEffect,useState } from 'react';
import { watchAuthToken } from '@/lib/auth/authToken';
import {
  refreshStart, refreshOk, refreshFailed, refreshCleared, type RefreshState,
} from '@/lib/ui/refreshState';
import { assess } from '@/lib/engine/dataQuality';
import type { PaperRunnerStatus } from '@/lib/engine/paperRunnerStatus';
import { ENTRY_SIGNAL_IDS, ENTRY_SIGNAL_LABEL, DEFAULT_ENTRY_SIGNAL, type EntrySignalId } from '@/lib/engine/entrySignals';
import { derivePaperBotId, DEFAULT_PAPER_BOT } from '@/lib/engine/paperAutomation';
import { BAR_INTERVALS, BAR_INTERVAL_LABEL, DEFAULT_BAR_INTERVAL, type BarInterval } from '@/lib/risk/bars';
import { nextRunText, parseAt } from '@/lib/ui/nextRunText';
import { perfView, type BotPerf } from '@/lib/engine/paperBotPerf';
import { BOT_LEVERAGE_CHOICES } from '@/lib/engine/paperAutomation';
import { envView } from '@/lib/ui/status';
import { F, SP, R, FS, FW, CONTROL, BORDER_W, buttonStyle } from '@/components/ui/tokens';
import { T } from '@/lib/constants';

interface Status {
  settings: { enabled: boolean; symbol: string; interval_seconds: number; next_run_at: string; config: Record<string,number> } | null;
  account: { balance: number; total_pnl: number; total_fees: number; started_at: string | null } | null;
  runs: { id: string; state: string; result: { code: string; message: string } | null; created_at: string; finished_at: string | null }[];
  positions: { id: string; strategy_id?: string | null; symbol: string; side: string; status: string; fill_price: number; exit_price: number | null; stop_loss: number; take_profit: number | null; liquidation_price: number | null; realized_pnl: number | null; exit_reason: string | null }[];
  /**
   * **누가 이 회차를 깨우고 있는가.** 서버가 판정해서 보낸다
   * (`src/lib/engine/paperRunnerStatus.ts`). 화면이 다시 판정하지 않는다 —
   * 두 벌이 되면 언젠가 서로 다른 답을 낸다.
   */
  runner?: PaperRunnerStatus | null;
  /** 봇 전부. 102번(다중 봇) 이후 계정 하나에 봇이 여럿일 수 있다. */
  bots?: { bot_id: string; enabled: boolean; symbol: string; interval_seconds: number;
    next_run_at: string | null; signal: string; signalLabel: string; signalWarning?: string;
    timeframe?: string; timeframeLabel?: string; timeframeWarning?: string;
    /** 이 봇이 거는 배율. 서버가 판정해서 보낸다 — 화면이 계정값을 그리지 않는다 */
    leverage?: number; leverageWarning?: string;
    /** 서버가 실제 체결에서 센 성과. **없으면 null이고 0이 아니다** */
    perf?: BotPerf | null }[];
}
const money = (v: unknown) => v == null || !Number.isFinite(Number(v)) ? '확인 불가' : Number(v).toLocaleString('en-US',{maximumFractionDigits:4});
const time = (v: string | null | undefined) => v ? new Date(v).toLocaleString('ko-KR') : '아직 없음';

export function PaperAutomationControl() {
  const [auth,setAuth] = useState<string | null>(null);
  useEffect(()=>watchAuthToken(setAuth),[]);
  // **갱신이 실패했다고 방금까지 보던 값을 지우지 않는다.**
  //
  // 예전에는 15초 주기 조회가 한 번 실패하면 `setStatus(null)`로 잔고·체결
  // 이력·반복 상태를 전부 지우고 "상태 확인 전"을 띄웠다. 확인을 했고
  // 실패한 것인데 "확인 전"이라고 적은 것이고, 사용자는 자기 모의 계좌가
  // 비었거나 자동매매가 꺼진 것으로 읽을 수 있다 — 네트워크가 한 번 끊긴
  // 것인데. 지우는 쪽이 오히려 숨기는 것이다: 지우면 "지금 읽은 결과 비어
  // 있음"과 구별되지 않는다.
  const [refresh,setRefresh] = useState<RefreshState<Status>>(()=>refreshStart<Status>());
  const status = refresh.data;
  const error = refresh.error;
  /** 시작·정지 요청의 오류. 조회 실패와 섞지 않는다 */
  const [actionError,setActionError] = useState('');
  const [busy,setBusy] = useState(false);
  const [symbol,setSymbol] = useState('BTCUSDT');
  const [interval,setIntervalSeconds] = useState(60);
  /** 새 봇 입력. 위의 `symbol`·`interval`과 **따로** 둔다 — 같이 쓰면
   *  봇을 추가하는 순간 돌던 기본 봇의 설정이 바뀐다. */
  const [newSymbol,setNewSymbol] = useState('ETHUSDT');
  const [newSignal,setNewSignal] = useState<EntrySignalId>(DEFAULT_ENTRY_SIGNAL);
  const [newTimeframe,setNewTimeframe] = useState<BarInterval>(DEFAULT_BAR_INTERVAL);
  // 새 봇의 배율. **기본은 계정 기본값과 같은 5배** — 숫자를 여기서 올려 두지 않는다.
  const [newLeverage,setNewLeverage] = useState<number>(5);
  const [newInterval,setNewInterval] = useState(60);
  /** 어느 봇의 상세를 펼쳤는가. **기본은 접힘** — 한 줄이 열 줄이 되면 목록이 아니다 */
  const [detailOpen,setDetailOpen] = useState<string | null>(null);
  /**
   * 넓은 화면인가. **이것은 배치일 뿐 "모드"가 아니다** — 기기가
   * 초보자/전문가 모드를 정하지 않는다. 좁으면 쌓고 넓으면 한 줄로
   * 눕힌다. PC에서 모바일 카드를 그대로 늘리면 한 화면에 봇 네 개밖에
   * 안 들어간다(실측: 167px × 8 = 1538px).
   *
   * **기준선이 1100px인 이유.** 768·1024는 태블릿이고 태블릿은 손으로
   * 만진다 — 한 줄로 눕히면 버튼이 작아지고 전략 이름이 잘린다(실측에서
   * 768px에 말줄임 5건이 났다). 눕히는 것은 마우스가 있을 만한 폭부터다.
   */
  const [wide,setWide] = useState(false);
  useEffect(()=>{
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(min-width: 1100px)');
    const apply = () => setWide(mq.matches);
    apply();
    mq.addEventListener('change',apply);
    return ()=>mq.removeEventListener('change',apply);
  },[]);
  const load = useCallback(async (signal?: AbortSignal) => {
    // 로그아웃은 "정말 없음"이 맞다 — 여기서만 비운다.
    if (!auth) { setRefresh(refreshCleared<Status>()); return; }
    try {
      const res = await fetch('/api/paper/automation',{headers:{Authorization:auth},cache:'no-store',signal});
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.message || '서버 반복 상태를 확인하지 못했습니다');
      if (signal?.aborted) return;
      setRefresh(refreshOk(data as Status,Date.now()));
      if (data.settings) { setSymbol(data.settings.symbol); setIntervalSeconds(data.settings.interval_seconds); }
      window.dispatchEvent(new Event('paper-ledger-changed'));
    } catch (e) {
      // 값은 그대로 두고 실패를 기록한다. 낡았다는 사실은 아래 신선도 줄이 적는다.
      if (!signal?.aborted) setRefresh(prev=>refreshFailed(prev,e instanceof Error ? e.message : '상태 조회 실패'));
    }
  },[auth]);
  useEffect(()=>{
    const controller = new AbortController();
    void load(controller.signal);
    // Read-only refresh. Closing this page cannot stop or start a server cycle.
    const timer = window.setInterval(()=>void load(controller.signal),15000);
    return ()=>{ controller.abort(); window.clearInterval(timer); };
  },[load]);
  // 새 봇을 만들 때 고르는 값. 기본 봇의 종목/주기와 **따로** 둔다 —
  // 같은 입력을 공유하면 봇을 추가하는 순간 돌던 봇의 설정이 바뀐다.
  async function controlBot(
    action: 'start' | 'stop',
    bot: { botId: string; symbol: string; interval: number; signal?: EntrySignalId;
      timeframe?: BarInterval; leverage?: number },
  ) {
    if (!auth || busy) return;
    setBusy(true); setActionError('');
    try {
      const res = await fetch('/api/paper/automation',{method:'POST',
        headers:{Authorization:auth,'Content-Type':'application/json'},
        body:JSON.stringify({ action, botId:bot.botId, symbol:bot.symbol, interval:bot.interval,
          ...(bot.signal ? { signal:bot.signal } : {}),
          ...(bot.timeframe ? { timeframe:bot.timeframe } : {}),
          // **안 보내면 저장된 배율을 지킨다.** 0이나 기본값으로 채우지 않는다.
          ...(bot.leverage != null ? { leverage:bot.leverage } : {}) })});
      const data = await res.json().catch(()=>null);
      if (!res.ok || !data?.ok) throw new Error(data?.message || data?.error || `요청 실패 (${res.status})`);
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : '봇 요청 실패');
    } finally { setBusy(false); }
  }
  async function control(action: 'start' | 'stop') {
    if (!auth || busy) return;
    setBusy(true); setActionError('');
    try {
      const res = await fetch('/api/paper/automation',{method:'POST',headers:{Authorization:auth,'Content-Type':'application/json'},
        body:JSON.stringify({action,symbol,interval})});
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.message || '설정 저장 실패');
      await load();
    } catch(e) { setActionError(e instanceof Error ? e.message : '설정 저장 실패'); }
    finally { setBusy(false); }
  }
  const last = status?.runs[0];
  const lastDone = status?.runs.find(r=>r.state==='DONE');
  const enabled = status?.settings?.enabled === true;
  const bots = status?.bots ?? [];
  // **`enabled === true`만 켜진 것이다.** 문자열 'false'는 truthy다.
  const enabledBots = bots.filter(b => b.enabled === true).length;
  // 설정이 깨진 봇 — 켜져 있어도 **돌지 않거나 다른 전략으로 돈다**.
  // 머리글에서 세어 두면 목록을 끝까지 내리지 않아도 보인다.
  const warnBots = bots.filter(b => b.signalWarning != null || b.timeframeWarning != null || b.leverageWarning != null).length;
  // 새 봇 이름은 종목·전략에서 만든다. 같은 조합이면 같은 이름이라
  // 같은 봇의 기록이 쪼개지지 않는다. 못 만들면 null이다.
  const newBotId = derivePaperBotId(newSymbol, newSignal, newTimeframe);
  const newBotExists = newBotId != null && bots.some(b => b.bot_id === newBotId);
  // 주기 수신(15초)으로 본다. 모의 장부라도 **조회 자체는 서버에서 당겨오는
  // 값**이므로 POLLED가 맞다. 성공한 적이 없으면 수신 없음이다.
  const freshness = assess({ kind: refresh.okAt == null ? 'UNAVAILABLE' : 'POLLED',
    origin: '서버', label: '반복 상태', asOf: refresh.okAt, expectedIntervalMs: 15_000 }, Date.now());
  // 카드 전부가 **같은 시계**를 본다. 카드마다 Date.now()를 부르면
  // 같은 목록 안에서 한 줄은 '지금 차례', 다른 줄은 아직으로 갈릴 수 있다.
  const nowMs = Date.now();
  return <section data-testid="paper-automation" style={{padding:16,marginBottom:12,border:'1px solid var(--t-border)',borderRadius:12,display:'grid',gap:10}}>
    <strong>서버 PAPER 자동 반복 · 기본 모의 계좌</strong>
    <p style={{margin:0,fontSize:13}}>기존 추세 알고리즘으로 가상 체결합니다. 브라우저를 닫아도 서버가 반복합니다. 정지하면 새 진입을 멈추며 손절·익절·청산가 감시는 유지됩니다.</p>
    {!auth && <p>로그인하면 서버 반복을 설정할 수 있습니다.</p>}
    {error && <p role="alert">{error}</p>}
    {actionError && <p role="alert">{actionError}</p>}
    <div data-testid="paper-automation-status">{!status ? '상태 확인 전' : enabled ? '반복 실행 요청 켜짐' : '반복 실행 정지'}</div>
    {/* ── 켜진 것과 **도는 것**은 다르다 ──
        위 줄은 "요청"이다. 봇을 켜 두어도 깨우는 Fly 워커가 꺼져 있으면
        한 건도 돌지 않는다. 판정은 서버(`paperRunnerStatus`)가 하고
        여기서는 그 문장을 그대로 적는다. */}
    {status && (status.runner
      ? <div data-testid="paper-automation-runner" role={status.runner.running ? undefined : 'status'}>
          {status.runner.running ? '● ' : '▲ '}{status.runner.headline} — {status.runner.reason}
        </div>
      : <div data-testid="paper-automation-runner" role="status">
          ▲ 실행기 상태 모름 — 서버가 가동 여부를 알려주지 않았습니다
        </div>)}
    {/* 낡은 값을 **현재값처럼** 보여 주지 않는다. 판정과 나이 표기는
        `dataQuality.assess`가 한다 — 여기서 다시 만들면 두 벌이 된다. */}
    {status && freshness.freshness !== 'FRESH' && <p role="status" data-testid="paper-automation-freshness">
      아래 숫자는 {freshness.text} 값입니다 — 지금 갱신이 안 되고 있습니다
      {refresh.failures > 1 ? ` (연속 실패 ${refresh.failures}회)` : ''}
    </p>}
    <div style={{display:'flex',flexWrap:'wrap',gap:8}}>
      <select aria-label="서버 반복 종목" value={symbol} onChange={e=>setSymbol(e.target.value)} disabled={busy || enabled}>
        <option value="BTCUSDT">BTC / USDT</option><option value="ETHUSDT">ETH / USDT</option>
      </select>
      <select aria-label="서버 반복 간격" value={interval} onChange={e=>setIntervalSeconds(Number(e.target.value))} disabled={busy || enabled}>
        <option value={60}>1분</option><option value={300}>5분</option><option value={900}>15분</option>
      </select>
      <button type="button" disabled={!auth || !status || !status.account?.started_at || busy || enabled} onClick={()=>void control('start')}>서버 반복 시작</button>
      <button type="button" disabled={!auth || busy} onClick={()=>void control('stop')}>서버 반복 정지</button>
    </div>
    {status && !status.account?.started_at && <p>기본 모의 계좌를 먼저 시작하세요.</p>}
    {status?.settings && <div style={{fontSize:12}}>
      계정 기본 배율 {status.settings.config.leverage}배 · 거래 위험 {status.settings.config.riskPctPerTrade}% · 봇당 최대 동시 {status.settings.config.maxOpenPositions ?? 1}개 · 손절 {status.settings.config.stopPct}% · 익절 {status.settings.config.takeProfitPct}% · 최대 보유 {status.settings.config.maxHoldHours}시간
      <br/>다음 평가 예정: {enabled ? time(status.settings.next_run_at) : '정지'} · 최근 완료: {time(lastDone?.finished_at)}
    </div>}
    {/* 여기 있던 "최근 서버 평가 완료를 아직 확인하지 못했습니다"는 지웠다.
        같은 판단(회차가 밀렸는가)을 화면이 **화면의 간격 입력값**으로 다시
        했었다 — 실제 봇 주기가 아니라서 서버와 답이 갈릴 수 있었다. 지금은
        위 한 줄이 서버 판정으로 그 경우(OVERDUE·NEVER_RAN)를 덮는다. */}
    {/* ── 봇 목록 — 켜진 봇 하나하나가 자기 종목·전략으로 돈다 ── */}
    {status && <div data-testid="paper-bot-list" style={{display:'grid',gap:6,fontSize:12,
      border:'1px solid var(--t-border)',borderRadius:8,padding:8}}>
      <strong style={{fontSize:13}}>
        봇 {bots.length}개 · 켜짐 {enabledBots}개 · 정지 {bots.length - enabledBots}개
        {warnBots > 0 && <span style={{color:T.ylw}}> · 설정 오류 {warnBots}개</span>}
        {' '}· 동시 보유 최대 {Math.max(1,enabledBots)}개
      </strong>
      {/* 봇을 늘리면 노출이 그만큼 는다. 숨기지 않는다. */}
      {enabledBots > 1 && <p role="status" data-testid="paper-bot-exposure" style={{margin:0}}>
        켜 둔 봇이 {enabledBots}개라 같은 모의 계좌에서 동시에 {enabledBots}개까지 듭니다 —
        회차당 위험도 그만큼 커집니다.
      </p>}
      {bots.length === 0 && <span>아직 봇이 없습니다.</span>}
      {/* ── 봇 카드 ──
          예전에는 `flexWrap` 한 줄에 맨 `<span>` 넷을 흘려 놓았다. 360px
          에서 세 줄로 꺾이고, 전략 이름·종목·주기·전략유형·시각이 **전부
          같은 글자 크기와 색**이라 무엇을 먼저 봐야 하는지가 없었다.
          설계 시스템(`F`·`buttonStyle`)은 이미 있었는데 이 화면만 안 쓰고
          있었다 — CLAUDE.md가 적어 둔 "만들어 놓고 배선을 안 함"이다. */}
      {bots.map(b => {
        // **상태와 환경은 다른 축이다.** 켜짐/꺼짐은 "이 봇이 도는가"이고
        // 모의/테스트넷/실전은 "어느 돈으로 도는가"다. 사진에서는 오른쪽
        // 「정지」가 버튼인데 상태처럼 읽혔다 — 전부 켜져 있는 목록이었다.
        const warn = b.signalWarning ?? b.timeframeWarning ?? b.leverageWarning ?? null;
        const nv = nextRunText({
          // 꺼진 봇의 `next_run_at`도 서버는 계산해 둔다. 그 숫자를 그대로
          // 적으면 오지 않을 시각을 약속하는 것이다.
          blockedReason: b.enabled ? null : '예정 없음',
          blockedDetail: b.enabled ? null : '정지된 봇입니다 — 시작해야 다음 평가가 잡힙니다',
          atMs: parseAt(b.next_run_at), nowMs,
        });
        const pv = perfView(b.perf);
        const open = detailOpen === b.bot_id;
        const fills = (status?.positions ?? []).filter(x => x.strategy_id === b.bot_id);
        const pnlColor = !pv.measured ? T.muted
          : pv.sign === 'up' ? T.grn : pv.sign === 'down' ? T.red : T.txt;
        return <article key={b.bot_id} data-testid={`paper-bot-${b.bot_id}`}
          style={wide
            ? { display:'flex',alignItems:'center',gap:SP.md,padding:`${SP.sm}px ${SP.md}px`,
                borderRadius:R.md,background:T.bg,
                border:`1px solid ${warn ? T.ylw : T.border}`,flexWrap:'wrap' }
            : { display:'grid',gap:SP.xs,padding:SP.md,borderRadius:R.md,
                background:T.bg,border:`1px solid ${warn ? T.ylw : T.border}` }}>
          {/* ① 상태 · 환경 · 종목 — 한눈에 */}
          <div style={{display:'flex',alignItems:'center',gap:SP.xs,flexWrap:'wrap',
            ...(wide ? { flex:'0 0 auto' } : {})}}>
            <span data-testid={`paper-bot-state-${b.bot_id}`}
              style={{...F.btnSm,padding:'2px 7px',borderRadius:R.pill,whiteSpace:'nowrap',
                color: warn ? T.ylw : b.enabled ? T.grn : T.muted,
                background: warn ? `${T.ylw}1A` : b.enabled ? `${T.grn}1A` : 'transparent',
                border:`1px solid ${warn ? T.ylw : b.enabled ? T.grn : T.border}`}}>
              {warn ? '⚠ 설정 오류' : b.enabled ? '● 실행 중' : '■ 정지됨'}
            </span>
            {/* 환경 배지는 **테두리 모양**으로 구분한다. 상태 배지와 같은
                모양이면 두 축이 한 종류로 읽힌다. */}
            <span data-testid={`paper-bot-env-${b.bot_id}`} title={envView('MOCK').meaning}
              style={{...F.btnSm,padding:'2px 7px',borderRadius:R.sm,whiteSpace:'nowrap',
                color:T.sub,border:`1px dashed ${T.border}`}}>
              {envView('MOCK').label}
            </span>
            {!wide && <span style={{...F.numS,marginLeft:'auto',whiteSpace:'nowrap'}}>{b.symbol}</span>}
          </div>
          {/* ② 전략 이름 — 한 줄로 자르고 전체는 title로. 320px에서 긴
              이름이 카드를 세 줄로 밀던 자리다. */}
          <div title={b.bot_id} style={{...F.body,fontWeight:FW.bold,
            overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',
            ...(wide ? { flex:'0 1 190px',minWidth:0 } : {})}}>
            {b.bot_id}{b.bot_id === DEFAULT_PAPER_BOT ? ' (기본)' : ''}
          </div>
          {/* ③ 보조 계층 — 이름보다 작고 흐리게. 사진에서는 같은 크기였다 */}
          <div style={{...F.muted,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',
            ...(wide ? { flex:'1 1 220px',minWidth:0 } : {})}}>
            {wide ? `${b.symbol} · ` : ''}{b.timeframeLabel ?? '주기 미확인'} · {b.signalLabel}
            {b.leverage != null && ` · ${b.leverage}배`}
          </div>
          {warn && <div role="alert" style={{...F.caption,color:T.ylw}}>⚠ {warn}</div>}
          {/* ④ 값 두 칸 — 라벨과 값을 분리한다 */}
          {/* ④ 값 — 라벨과 값을 한 줄에 붙이고 두 쌍을 양끝으로 민다.
              라벨을 값 위에 쌓으면 줄이 둘이 되고, 카드 여덟 개에서 그
              한 줄이 128px가 된다. 좁아지면 `flexWrap`으로 **접히지,
              잘리지 않는다** — 실측에서 320px의 이 칸은 105px였고 긴
              문장이 말줄임으로 뜻을 잃었다. */}
          <div style={{display:'flex',flexWrap:'wrap',gap:`2px ${SP.sm}px`,
            justifyContent:'space-between',marginTop:wide ? 0 : 2,
            ...(wide ? { flex:'0 0 auto',minWidth:0,justifyContent:'flex-start',gap:SP.md } : {})}}>
            <span style={{...F.muted,minWidth:0}}>
              다음 평가{' '}
              <span data-testid={`paper-bot-next-${b.bot_id}`} title={nv.detail}
                style={{color: nv.blocked ? T.muted : nv.overdue ? T.ylw : T.txt,
                  fontWeight: nv.overdue ? FW.heavy : FW.medium}}>
                {nv.text}
              </span>
            </span>
            {/* **수익금과 수익률은 다른 값이다.** 없으면 비운다 —
                `?? 0`으로 채우지 않는다. */}
            <span style={{...F.muted,minWidth:0}}>
              손익{' '}
              <span data-testid={`paper-bot-pnl-${b.bot_id}`} title={pv.note ?? pv.detailTitle}
                style={{color:pnlColor,fontWeight:pv.measured ? FW.heavy : FW.normal}}>
                {pv.amount}
              </span>
              {pv.rate && <span style={{color:pnlColor,marginLeft:4}}>({pv.rate})</span>}
              {/* **접힌 카드에서도 보여야 한다.** 단서가 `title`에만 있으면
                  휴대폰에서는 없는 것과 같다 — 터치에 hover가 없다. 전체
                  문구는 아래 상세에 그대로 있고, 여기엔 짧은 표식만 둔다
                  (줄을 늘리지 않으려고 같은 줄에 붙인다). */}
              {pv.mark && <span data-testid={`paper-bot-pnl-mark-${b.bot_id}`}
                title={pv.note ?? undefined}
                style={{marginLeft:4,padding:'0 4px',borderRadius:R.sm,
                  border:`${BORDER_W}px dashed ${T.border}`,color:T.muted,
                  fontSize:FS.micro,fontWeight:FW.medium,whiteSpace:'nowrap'}}>
                {pv.mark}
              </span>}
            </span>
          </div>
          {/* ⑤ 조작 — 44px 터치. 실제로 서버를 부르는 것만 둔다 */}
          <div style={{display:'flex',gap:SP.sm,marginTop:wide ? 0 : 2,
            ...(wide ? { flex:'0 0 auto' } : {})}}>
            <button type="button" disabled={!auth || busy}
              aria-label={`${b.bot_id} ${b.enabled ? '정지' : '시작'}`}
              style={{...buttonStyle(b.enabled ? 'danger' : 'primary','md'),
                ...(wide ? { minWidth:64 } : { flex:1 }),
                opacity:(!auth || busy) ? 0.5 : 1}}
              onClick={()=>void controlBot(b.enabled ? 'stop' : 'start',
                { botId:b.bot_id, symbol:b.symbol, interval:b.interval_seconds })}>
              {busy ? '처리 중…' : b.enabled ? '정지' : '시작'}
            </button>
            <button type="button" aria-expanded={open}
              aria-label={`${b.bot_id} 상세 ${open ? '접기' : '펼치기'}`}
              data-testid={`paper-bot-detail-${b.bot_id}`}
              style={{...buttonStyle('ghost','md'),
                ...(wide ? { minWidth:56 } : { flex:1 })}}
              onClick={()=>setDetailOpen(open ? null : b.bot_id)}>
              {open ? '접기' : '상세'}
            </button>
          </div>
          {/* ⑥ 상세 — 접었을 때는 그리지 않는다. 사진의 목록이 길었던
              이유가 매 줄이 제 설명을 다 펼치고 있던 것이다. */}
          {open && <div style={{display:'grid',gap:SP.xs,paddingTop:SP.sm,
            borderTop:`1px solid ${T.border}`,...(wide ? { flexBasis:'100%' } : {})}}>
            <div style={F.muted}>평가 주기 {b.interval_seconds}초 · 전략 {b.signal}</div>
            <div style={F.muted}>다음 평가 — {nv.detail}</div>
            {pv.note && <div style={F.muted}>성과 — {pv.note}</div>}
            <div style={F.muted}>
              최근 체결 {fills.length}건
              {fills.length === 0 && ' — 최근 10건 안에 이 봇의 체결이 없습니다'}
            </div>
            {fills.map(f => <div key={f.id} style={{...F.caption,display:'flex',
              gap:SP.sm,justifyContent:'space-between'}}>
              <span>{f.side} · {f.status}</span>
              <span style={{color:f.realized_pnl == null ? T.muted
                : Number(f.realized_pnl) >= 0 ? T.grn : T.red}}>
                {f.realized_pnl == null ? '손익 미기록' : money(f.realized_pnl)}
              </span>
            </div>)}
          </div>}
        </article>;
      })}
      {/* 새 봇 — 종목과 전략을 고르면 이름이 정해진다 */}
      <div data-testid="paper-bot-add" style={{display:'flex',flexWrap:'wrap',gap:6,alignItems:'center'}}>
        <select aria-label="새 봇 종목" value={newSymbol} onChange={e=>setNewSymbol(e.target.value)} disabled={busy}>
          <option value="BTCUSDT">BTC / USDT</option>
          <option value="ETHUSDT">ETH / USDT</option>
          <option value="SOLUSDT">SOL / USDT</option>
        </select>
        <select aria-label="새 봇 전략" value={newSignal} disabled={busy}
          onChange={e=>setNewSignal(e.target.value as EntrySignalId)}>
          {ENTRY_SIGNAL_IDS.map(id=><option key={id} value={id}>{ENTRY_SIGNAL_LABEL[id]}</option>)}
        </select>
        <select aria-label="새 봇 봉 주기" value={newTimeframe} disabled={busy}
          onChange={e=>setNewTimeframe(e.target.value as BarInterval)}>
          {BAR_INTERVALS.map(tf=><option key={tf} value={tf}>{BAR_INTERVAL_LABEL[tf]}</option>)}
        </select>
        <select aria-label="새 봇 배율" data-testid="paper-bot-new-leverage"
          value={newLeverage} disabled={busy}
          onChange={e=>setNewLeverage(Number(e.target.value))}>
          {BOT_LEVERAGE_CHOICES.map(x=><option key={x} value={x}>{x}배</option>)}
        </select>
        <select aria-label="새 봇 간격" value={newInterval} disabled={busy}
          onChange={e=>setNewInterval(Number(e.target.value))}>
          <option value={60}>1분</option><option value={300}>5분</option><option value={900}>15분</option>
        </select>
        <button type="button" data-testid="paper-bot-add-cta"
          disabled={!auth || busy || !status.account?.started_at || newBotId == null || newBotExists}
          onClick={()=>void controlBot('start',
            { botId:newBotId!, symbol:newSymbol, interval:newInterval, signal:newSignal,
              timeframe:newTimeframe, leverage:newLeverage })}>
          봇 추가 시작
        </button>
        {newBotId == null && <span role="alert">이 조합으로는 봇 이름을 만들 수 없습니다</span>}
        {newBotExists && <span>이미 있는 봇입니다 — 위 목록에서 시작하세요</span>}
      </div>
    </div>}
    {status?.account && <div>잔고 {money(status.account.balance)} USDT · 실현 손익 {money(status.account.total_pnl)} USDT · 수수료 {money(status.account.total_fees)} USDT</div>}
    {last && <p style={{margin:0}}>최근 평가: {last.result?.message || (last.state==='CLAIMED' ? '서버 평가 중 또는 복구 대기' : '실행 취소됨')}</p>}
    <ul aria-label="서버 반복 평가 이력">{status?.runs.slice(0,5).map(r=><li key={r.id}>{time(r.created_at)} · {r.result?.message || (r.state==='CLAIMED' ? '평가 중 또는 복구 대기' : '실행 취소됨')}</li>)}</ul>
    <ul aria-label="자동 모의 체결 이력">{status?.positions.map(p=><li key={p.id}>
      {p.symbol} {p.side} · {p.status==='open' ? '보유 중' : `청산 ${p.exit_reason || ''}`} · 가상 체결가 {money(p.fill_price)}
      {' · '}손절 {money(p.stop_loss)} · 익절 {money(p.take_profit)} · 청산가 {money(p.liquidation_price)}
      {p.status==='closed' && <> · 청산 체결가 {money(p.exit_price)} · 실현 손익 {money(p.realized_pnl)} USDT</>}
    </li>)}</ul>
  </section>;
}
