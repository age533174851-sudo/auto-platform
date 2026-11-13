'use client';
import React,{ useCallback,useEffect,useState } from 'react';
import { watchAuthToken } from '@/lib/auth/authToken';

interface Status {
  settings: { enabled: boolean; symbol: string; interval_seconds: number; next_run_at: string; config: Record<string,number> } | null;
  account: { balance: number; total_pnl: number; total_fees: number; started_at: string | null } | null;
  runs: { id: string; state: string; result: { code: string; message: string } | null; created_at: string; finished_at: string | null }[];
  positions: { id: string; symbol: string; side: string; status: string; fill_price: number; exit_price: number | null; stop_loss: number; take_profit: number | null; liquidation_price: number | null; realized_pnl: number | null; exit_reason: string | null }[];
}
const money = (v: unknown) => v == null || !Number.isFinite(Number(v)) ? '확인 불가' : Number(v).toLocaleString('en-US',{maximumFractionDigits:4});
const time = (v: string | null | undefined) => v ? new Date(v).toLocaleString('ko-KR') : '아직 없음';

export function PaperAutomationControl() {
  const [auth,setAuth] = useState<string | null>(null);
  useEffect(()=>watchAuthToken(setAuth),[]);
  const [status,setStatus] = useState<Status | null>(null);
  const [error,setError] = useState('');
  const [busy,setBusy] = useState(false);
  const [symbol,setSymbol] = useState('BTCUSDT');
  const [interval,setIntervalSeconds] = useState(60);
  const load = useCallback(async (signal?: AbortSignal) => {
    if (!auth) { setStatus(null); return; }
    try {
      const res = await fetch('/api/paper/automation',{headers:{Authorization:auth},cache:'no-store',signal});
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.message || '서버 반복 상태를 확인하지 못했습니다');
      if (signal?.aborted) return;
      setStatus(data); setError('');
      if (data.settings) { setSymbol(data.settings.symbol); setIntervalSeconds(data.settings.interval_seconds); }
      window.dispatchEvent(new Event('paper-ledger-changed'));
    } catch (e) { if (!signal?.aborted) { setStatus(null); setError(e instanceof Error ? e.message : '상태 조회 실패'); } }
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
    setBusy(true); setError('');
    try {
      const res = await fetch('/api/paper/automation',{method:'POST',headers:{Authorization:auth,'Content-Type':'application/json'},
        body:JSON.stringify({action,symbol,interval})});
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.message || '설정 저장 실패');
      await load();
    } catch(e) { setError(e instanceof Error ? e.message : '설정 저장 실패'); }
    finally { setBusy(false); }
  }
  const last = status?.runs[0];
  const lastDone = status?.runs.find(r=>r.state==='DONE');
  const enabled = status?.settings?.enabled === true;
  return <section data-testid="paper-automation" style={{padding:16,marginBottom:12,border:'1px solid var(--t-border)',borderRadius:12,display:'grid',gap:10}}>
    <strong>서버 PAPER 자동 반복 · 기본 모의 계좌</strong>
    <p style={{margin:0,fontSize:13}}>기존 추세 알고리즘으로 가상 체결합니다. 브라우저를 닫아도 서버가 반복합니다. 정지하면 새 진입을 멈추며 손절·익절·청산가 감시는 유지됩니다.</p>
    {!auth && <p>로그인하면 서버 반복을 설정할 수 있습니다.</p>}
    {error && <p role="alert">{error}</p>}
    <div data-testid="paper-automation-status">{!status ? '상태 확인 전' : enabled ? '반복 실행 요청 켜짐' : '반복 실행 정지'}</div>
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
    {enabled && (!lastDone || Date.now()-new Date(lastDone.finished_at!).getTime()>Math.max(180000,interval*2000)) && <p role="status">최근 서버 평가 완료를 아직 확인하지 못했습니다.</p>}
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
