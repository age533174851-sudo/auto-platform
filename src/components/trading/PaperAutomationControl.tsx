'use client';
import React,{ useCallback,useEffect,useState } from 'react';
import { watchAuthToken } from '@/lib/auth/authToken';
import {
  refreshStart, refreshOk, refreshFailed, refreshCleared, type RefreshState,
} from '@/lib/ui/refreshState';
import { assess } from '@/lib/engine/dataQuality';
import type { PaperRunnerStatus } from '@/lib/engine/paperRunnerStatus';

interface Status {
  settings: { enabled: boolean; symbol: string; interval_seconds: number; next_run_at: string; config: Record<string,number> } | null;
  account: { balance: number; total_pnl: number; total_fees: number; started_at: string | null } | null;
  runs: { id: string; state: string; result: { code: string; message: string } | null; created_at: string; finished_at: string | null }[];
  positions: { id: string; symbol: string; side: string; status: string; fill_price: number; exit_price: number | null; stop_loss: number; take_profit: number | null; liquidation_price: number | null; realized_pnl: number | null; exit_reason: string | null }[];
  /**
   * **누가 이 회차를 깨우고 있는가.** 서버가 판정해서 보낸다
   * (`src/lib/engine/paperRunnerStatus.ts`). 화면이 다시 판정하지 않는다 —
   * 두 벌이 되면 언젠가 서로 다른 답을 낸다.
   */
  runner?: PaperRunnerStatus | null;
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
  // 주기 수신(15초)으로 본다. 모의 장부라도 **조회 자체는 서버에서 당겨오는
  // 값**이므로 POLLED가 맞다. 성공한 적이 없으면 수신 없음이다.
  const freshness = assess({ kind: refresh.okAt == null ? 'UNAVAILABLE' : 'POLLED',
    origin: '서버', label: '반복 상태', asOf: refresh.okAt, expectedIntervalMs: 15_000 }, Date.now());
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
      배율 {status.settings.config.leverage}배 · 거래 위험 {status.settings.config.riskPctPerTrade}% · 최대 동시 1개 · 손절 {status.settings.config.stopPct}% · 익절 {status.settings.config.takeProfitPct}% · 최대 보유 {status.settings.config.maxHoldHours}시간
      <br/>다음 평가 예정: {enabled ? time(status.settings.next_run_at) : '정지'} · 최근 완료: {time(lastDone?.finished_at)}
    </div>}
    {/* 여기 있던 "최근 서버 평가 완료를 아직 확인하지 못했습니다"는 지웠다.
        같은 판단(회차가 밀렸는가)을 화면이 **화면의 간격 입력값**으로 다시
        했었다 — 실제 봇 주기가 아니라서 서버와 답이 갈릴 수 있었다. 지금은
        위 한 줄이 서버 판정으로 그 경우(OVERDUE·NEVER_RAN)를 덮는다. */}
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
