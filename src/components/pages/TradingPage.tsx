'use client';
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { placeOrder, toTVSymbol, type OrderRequest } from '@/lib/api/client';
import { paperBuy, getOpenPositions, checkPaperExits, loadPaperBalance, closePaperPosition, reversePaperPosition, canOpenNewPosition } from '@/lib/autotrade/store';
import { T, CURRENCIES, LANGS, I18N, WORLD_MARKETS, MOCK_NEWS, ECON_EVENTS } from '@/lib/constants';
import { cvt, fmt, fmtPct, clamp, tr, gS, sS, uid } from '@/lib/utils';
import { ASSETS, TYPE_LABEL, TYPE_COLOR, simulatePriceUpdate } from '@/data/assets';
import type { Asset } from '@/types';
import { Card, Dot, Spark, Pill, Bdg, Toggle, AreaChart, WorldClock, Heatmap,
         TradingChart, Logo, getBgColor, resolveLogoUrl, getKrName, cleanName, resolveTVSym,
         DonutChart, MiniBar, GlobalSearch, getLeverageRec,
         LiquidationCalc, PositionSizer, RiskDashboard, InlineTVChart, ChartContainer } from './SharedUI';


function TradingPage({prices,currency,activeAsset,onOpenPnL}:{prices:Asset[];currency:string;activeAsset?:any;onOpenPnL?:(a:any)=>void}) {
  const [isMock,setIsMock]=useState(true);
  const [tradeMode,setTradeMode]=useState<'mock'|'testnet'|'live'>('mock');
  const [hasExchange,setHasExchange]=useState(false);
  const [connections,setConnections]=useState<any[]>([]);
  const [connId,setConnId]=useState('');
  const [slEditAsset,setSlEditAsset]=useState('');
  const [quickActions,setQuickActions]=useState<string[]>(()=>{
    try { const r=localStorage.getItem('tg_quick_actions'); return r?JSON.parse(r):['close_all','close_50','close_25','add','reverse','tpsl']; }
    catch { return ['close_all','close_50','close_25','add','reverse','tpsl']; }
  });
  const [slEditVal,setSlEditVal]=useState('');
  const [tpEditVal,setTpEditVal]=useState('');
  const [tpslTab,setTpslTab]=useState<'entire'|'partial'|'trailing'>('entire');
  const [tpRoi,setTpRoi]=useState('');
  const [slRoi,setSlRoi]=useState('');
  const [tpslRatio,setTpslRatio]=useState(100);
  const [trailPct,setTrailPct]=useState('');
  const authHeaderRef=useRef<string>('');
  // 거래소 연결 여부 확인 (testnet/live 가능 여부)
  useEffect(()=>{
    let cancelled=false;
    (async()=>{
      try {
        let auth='';
        try { const { getSupabaseClient } = await import('@/lib/supabase/client'); const sbc=getSupabaseClient();
          if(sbc){ const {data}=await sbc.auth.getSession(); if(data?.session?.access_token) auth=`Bearer ${data.session.access_token}`; } } catch {}
        authHeaderRef.current=auth;
        const r=await fetch('/api/exchange?action=list',{headers:auth?{Authorization:auth}:{}});
        const d=await r.json();
        if(!cancelled){
          const conns = Array.isArray(d.connections) ? d.connections : [];
          const usable = conns.filter((c:any)=>!c.has_withdrawal);
          setConnections(usable); setHasExchange(usable.length>0);
          if(usable[0]) setConnId(usable[0].id);
        }
      } catch {}
    })();
    return ()=>{cancelled=true;};
  },[]);
  // tradeMode와 isMock 동기화
  useEffect(()=>{ setIsMock(tradeMode==='mock'); },[tradeMode]);
  const resolveAsset = (): Asset => {
    if(activeAsset){const {_ts,...clean}=activeAsset;return clean as Asset;}
    try{const s=sessionStorage.getItem('tg_sel_asset');if(s)return JSON.parse(s) as Asset;}catch{}
    return prices[0] || ASSETS[0];
  };
  const [sel,setSel]=useState<Asset>(resolveAsset);
  const [side,setSide]=useState('매수');
  const sideRef=useRef('매수');
  const [amount,setAmount]=useState('');
  const [leverage,setLeverage]=useState(()=>{ try { const v=+(localStorage.getItem('tg_last_leverage')||'1'); return v>=1&&v<=125?v:1; } catch { return 1; } });
  useEffect(()=>{ try { localStorage.setItem('tg_last_leverage',String(leverage)); } catch {} }, [leverage]);
  const [marginMode,setMarginMode]=useState<'cross'|'isolated'>('isolated');
  const [orderType,setOrderType]=useState('market');
  const [showOrderbook,setShowOrderbook]=useState(true);
  const [showLevSheet,setShowLevSheet]=useState(false);
  const [limitPrice,setLimitPrice]=useState('');
  const [status,setStatus]=useState<string|null>(null);
  const [search,setSearch]=useState('');
  const [showConfirm,setShowConfirm]=useState(false);
  useEffect(()=>{if(activeAsset){const {_ts,...clean}=activeAsset;setSel(clean as Asset);}},[activeAsset]);
  const [orders,setOrders]=useState<Order[]>([]);
  const [showOrders,setShowOrders]=useState(false);
  const [riskProfile,setRiskProfile]=useState<'conservative'|'balanced'|'aggressive'>('balanced');

    const [tab,setTab]=useState<'trade'|'chart'|'ai'|'tech'|'news'|'sizing'|'risk'>('chart');
  const [chartInterval,setChartInterval]=useState('60');
  const [tp,setTp]=useState('');
  const [sl,setSl]=useState('');
  const [showChart,setShowChart]=useState(false);

  const filtered=useMemo(()=>{
    if(!search)return prices;
    const q=search.toLowerCase();
    return prices.filter(a=>a.nameKr.includes(search)||a.name.toLowerCase().includes(q)||a.id.toLowerCase().includes(q));
  },[prices,search]);

  const qMap:Record<string,string>={'10만':'100000','50만':'500000','100만':'1000000','500만':'5000000','전액':'10000000'};
  const fee=Math.round((+amount||0)*0.0005);
  const slippage=Math.round((+amount||0)*0.0001);
  const fundingFee=Math.round((+amount||0)*leverage*0.0001);
  const levRec=getLeverageRec(sel,riskProfile);

  // 실제 보유 포지션 (paper store 기반)
  const [positions, setPositions] = useState<Array<{ asset: string; qty: number; avgPrice: number; side?: 'long'|'short'; slPrice?: number; tpPrice?: number }>>([]);
  const refreshPositions = useCallback(() => {
    try { setPositions(getOpenPositions()); } catch { setPositions([]); }
  }, []);
  useEffect(() => { refreshPositions(); }, [refreshPositions]);

  // ── Binance 실제 포지션 동기화 + Ghost Sync (testnet/live) ──────
  const [realPos, setRealPos] = useState<any[]>([]);       // 거래소 실제 (source of truth)
  const [ghostPos, setGhostPos] = useState<any[]>([]);     // 직전엔 있었는데 사라진 포지션 (사용자 확인 후 정리)
  const [realFunding, setRealFunding] = useState<{ total:number; bySymbol:Record<string,number>; items:any[] }|null>(null);
  const [realTestnet, setRealTestnet] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string|null>(null);
  const [syncedAt, setSyncedAt] = useState<number|null>(null);
  const [syncStatus, setSyncStatus] = useState<'idle'|'syncing'|'synced'|'mismatch'|'error'|'disconnected'>('idle');
  const [mismatchActive, setMismatchActive] = useState(false);   // 불일치 시 신규주문/Reverse/TPSL 차단 (Close는 허용)
  const [tradingBlocked, setTradingBlocked] = useState(false);   // 5회 연속 실패 → 신규 진입 차단
  const [syncLog, setSyncLog] = useState<Array<{ t:number; mode:string; ex:string; symbol:string; status:string; detail:string; action:string }>>([]);
  const [pollSec, setPollSec] = useState<number>(()=>{ try { const v=+(localStorage.getItem('tg_poll_sec')||'15'); return [5,15,30,60].includes(v)?v:15; } catch { return 15; } });
  useEffect(()=>{ try { localStorage.setItem('tg_poll_sec', String(pollSec)); } catch {} }, [pollSec]);
  const errCountRef = useRef(0);
  const prevPosRef = useRef<any[]|null>(null);   // TRAIGO가 알고있던 직전 포지션 (Ghost 비교 기준)
  const pushLog = useCallback((status:string, symbol:string, detail:string, action:string)=>{
    setSyncLog(l=>[{ t:Date.now(), mode: tradeMode, ex:'binance', symbol, status, detail, action }, ...l].slice(0,50));
  }, [tradeMode]);
  // 텔레그램 알림 (서버에서 throttle/로그) — 실패해도 무시
  const tgAlert = useCallback(async (payload:any)=>{
    try {
      const auth = authHeaderRef.current;
      await fetch('/api/alert/telegram', { method:'POST', headers:{'Content-Type':'application/json',...(auth?{Authorization:auth}:{})}, body: JSON.stringify(payload), signal: AbortSignal.timeout(4000) });
    } catch {}
  }, []);

  const syncBinancePositions = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent;
    if (!connId) { if(!silent) setSyncMsg('연결된 Binance 거래소가 없습니다. 먼저 API 키를 연결하세요.'); setSyncStatus('disconnected'); return; }
    if (!silent) setSyncing(true);
    setSyncStatus('syncing');
    try {
      const auth = authHeaderRef.current;
      const r = await fetch(`/api/binance/futures/account?connectionId=${encodeURIComponent(connId)}`, {
        headers: auth ? { Authorization: auth } : {},
        signal: AbortSignal.timeout(3000),   // 3초 타임아웃
      });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || d.positionMsg || ('HTTP '+r.status));

      const live = (Array.isArray(d.positions) ? d.positions : []).filter((p:any)=>Math.abs(p.amount||0)>0);

      // ── Ghost Sync diff (직전 스냅샷 vs 신규) ──
      const prev = prevPosRef.current;
      let mismatch = false;
      if (prev) {
        const nextSyms = new Set(live.map((p:any)=>p.symbol));
        const prevSyms = new Set(prev.map((p:any)=>p.symbol));
        // A. 직전엔 있었는데 거래소에 없음 → ghost (자동삭제 금지)
        const vanished = prev.filter((p:any)=>!nextSyms.has(p.symbol)).map((p:any)=>({ ...p, _ghost:true }));
        if (vanished.length) { setGhostPos(g=>{ const have=new Set(g.map((x:any)=>x.symbol)); return [...g, ...vanished.filter((v:any)=>!have.has(v.symbol))]; }); vanished.forEach((v:any)=>pushLog('ghost', v.symbol, 'TRAIGO에 있었으나 거래소 미존재', '사용자 확인 대기')); mismatch=true; }
        // B/C. 신규 발견 또는 수량/방향 불일치
        for (const p of live) {
          const old = prev.find((x:any)=>x.symbol===p.symbol);
          if (!old) { p._discovered=true; pushLog('discovered', p.symbol, '미등록 실포지션 발견', '실포지션 카드 편입'); mismatch=true; }
          else {
            const os=(old.amount||0)<0?'S':'L', ns=(p.amount||0)<0?'S':'L';
            if (os!==ns) { p._mismatch='방향'; pushLog('mismatch', p.symbol, `방향 불일치 (${os}→${ns})`, '거래소 우선'); mismatch=true; }
            else if (Math.abs((old.amount||0)-(p.amount||0)) > Math.abs(p.amount||0)*0.005+1e-9) { p._mismatch='수량'; pushLog('mismatch', p.symbol, '수량 불일치', '거래소 우선'); mismatch=true; }
          }
        }
        // 거래소에 다시 나타난 심볼은 ghost에서 제거
        setGhostPos(g=>g.filter((x:any)=>!nextSyms.has(x.symbol)));
      }
      prevPosRef.current = live;

      setRealPos(live);
      setRealFunding(d.funding || null);
      setRealTestnet(!!d.testnet);
      setSyncedAt(Date.now());
      errCountRef.current = 0;
      setTradingBlocked(false);
      setMismatchActive(mismatch);
      setSyncStatus(mismatch ? 'mismatch' : 'synced');
      if (mismatch) tgAlert({ level:'warning', eventType:'ghost_sync', exchange:'Binance', mode: d.testnet?'TESTNET':'LIVE', title:'Ghost Sync 불일치 감지', message:'화면과 거래소 포지션이 불일치합니다. 거래소 우선 적용됨.' });
      if (!silent) setSyncMsg(`동기화 완료 · ${d.testnet?'테스트넷':'라이브'} · 포지션 ${live.length}개${mismatch?' · ⚠️ 불일치 감지':''}`);
    } catch (e:any) {
      errCountRef.current += 1;
      const n = errCountRef.current;
      setSyncStatus('error');
      pushLog('error', '-', e?.message || '네트워크/타임아웃', `연속 실패 ${n}회`);
      if (n === 3) tgAlert({ level:'warning', eventType:'api_fail', exchange:'Binance', mode: realTestnet?'TESTNET':'LIVE', title:'API 연결 3회 연속 실패', message:'자동 동기화가 중지되었습니다. 거래소 상태를 확인하세요.' });
      if (n >= 5) setTradingBlocked(true);
      if (!silent || n >= 2) setSyncMsg(`동기화 오류 (${n}회 연속): ${e?.message || '타임아웃'}${n>=3?' · 자동 폴링 중지됨':''}${n>=5?' · 신규 진입 차단':''}`);
    } finally { if (!silent) setSyncing(false); }
  }, [connId, pushLog, tgAlert, realTestnet]);

  const dismissGhost = useCallback((symbol:string)=>{
    setGhostPos(g=>g.filter((x:any)=>x.symbol!==symbol));
    pushLog('resolved', symbol, 'ghost 포지션 정리', '사용자 삭제');
  }, [pushLog]);

  // toast: 아래 Kill Switch/큐 핸들러들이 의존성으로 참조 → 먼저 선언 (TDZ 방지)
  const [toast, setToast] = useState<{ msg:string; ok:boolean }|null>(null);
  const showToast = useCallback((msg:string, ok:boolean)=>{ setToast({ msg, ok }); setTimeout(()=>setToast(null), 3800); }, []);

  // ── Daily MDD Kill Switch ──────────────────────────────────────
  const [ksStatus, setKsStatus] = useState<any|null>(null);
  const [ksBusy, setKsBusy] = useState(false);
  const [ksReleaseText, setKsReleaseText] = useState('');
  const [showKsPanel, setShowKsPanel] = useState(false);
  const fetchKsStatus = useCallback(async ()=>{
    if (!connId) return;
    try {
      const auth = authHeaderRef.current;
      const r = await fetch(`/api/risk/kill-switch/status?connectionId=${encodeURIComponent(connId)}`, { headers: auth?{Authorization:auth}:{}, signal: AbortSignal.timeout(4000) });
      const d = await r.json();
      if (r.ok && !d.error) setKsStatus(d);
      else if (d.noTable || d.error==='table_missing') setKsStatus({ noTable:true });
    } catch { /* 조용히 */ }
  }, [connId]);
  const ksUpdate = useCallback(async (patch:any)=>{
    if (!connId) return; setKsBusy(true);
    try {
      const auth = authHeaderRef.current;
      const r = await fetch('/api/risk/kill-switch/update', { method:'POST', headers:{'Content-Type':'application/json',...(auth?{Authorization:auth}:{})}, body: JSON.stringify({ connectionId: connId, ...patch }) });
      const d = await r.json();
      if (!r.ok || d.error) showToast(`설정 실패: ${d.message||d.error}`, false);
      else { showToast('리스크 설정 저장됨', true); fetchKsStatus(); }
    } catch(e:any){ showToast(`오류: ${e?.message}`, false); } finally { setKsBusy(false); }
  }, [connId, showToast, fetchKsStatus]);
  const ksReset = useCallback(async ()=>{
    if (!connId) return;
    if (ksStatus?.active && ksReleaseText.trim()!=='해제합니다') { showToast('해제하려면 "해제합니다"를 정확히 입력하세요', false); return; }
    setKsBusy(true);
    try {
      const auth = authHeaderRef.current;
      const r = await fetch('/api/risk/kill-switch/reset', { method:'POST', headers:{'Content-Type':'application/json',...(auth?{Authorization:auth}:{})}, body: JSON.stringify({ connectionId: connId }) });
      const d = await r.json();
      if (!r.ok || d.error) showToast(`리셋 실패: ${d.message||d.error}`, false);
      else { showToast('킬스위치 리셋 — 새 기준 설정됨', true); setKsReleaseText(''); fetchKsStatus(); }
    } catch(e:any){ showToast(`오류: ${e?.message}`, false); } finally { setKsBusy(false); }
  }, [connId, ksStatus, ksReleaseText, showToast, fetchKsStatus]);
  const ksTrigger = useCallback(async ()=>{
    if (!connId) return; setKsBusy(true);
    try {
      const auth = authHeaderRef.current;
      const r = await fetch('/api/risk/kill-switch/trigger', { method:'POST', headers:{'Content-Type':'application/json',...(auth?{Authorization:auth}:{})}, body: JSON.stringify({ connectionId: connId, reason:'수동 발동' }) });
      const d = await r.json();
      if (!r.ok || d.error) showToast(`발동 실패: ${d.message||d.error}`, false);
      else { showToast('🛑 킬스위치 수동 발동됨', true); fetchKsStatus(); }
    } catch(e:any){ showToast(`오류: ${e?.message}`, false); } finally { setKsBusy(false); }
  }, [connId, showToast, fetchKsStatus]);
  // 폴링과 함께 킬스위치 상태 갱신
  useEffect(()=>{
    if ((tradeMode==='testnet'||tradeMode==='live') && connId) fetchKsStatus();
  }, [tradeMode, connId, syncedAt, fetchKsStatus]);
  // Railway Worker heartbeat 상태
  const [workerStatus, setWorkerStatus] = useState<any|null>(null);
  useEffect(()=>{
    if (!(tradeMode==='testnet'||tradeMode==='live')) return;
    let cancelled=false;
    const fetchWorker=async()=>{
      try { const auth=authHeaderRef.current; const r=await fetch('/api/worker/status',{headers:auth?{Authorization:auth}:{},signal:AbortSignal.timeout(4000)}); const d=await r.json(); if(!cancelled) setWorkerStatus(d); } catch {}
    };
    fetchWorker(); const t=setInterval(fetchWorker, 20000);
    return ()=>{ cancelled=true; clearInterval(t); };
  }, [tradeMode]);
  const [tgBusy, setTgBusy] = useState(false);
  const [redisOk, setRedisOk] = useState<boolean|null>(null);
  const ksTestTelegram = useCallback(async (channel:'money'|'system', test:'basic'|'throttle'|'escalation'='basic')=>{
    setTgBusy(true);
    try {
      const auth = authHeaderRef.current;
      const r = await fetch('/api/telegram/test', { method:'POST', headers:{'Content-Type':'application/json',...(auth?{Authorization:auth}:{})}, body: JSON.stringify({ channel, severity: channel==='money'?'critical':'warning', test }) });
      const d = await r.json();
      if (typeof d.redis==='boolean') setRedisOk(d.redis);
      if (d.ok) showToast(`${channel==='money'?'Money':'System'} Bot ${test==='basic'?'테스트':test} 발송 — 폰 확인 (Redis ${d.redis?'연결':'미연결'})`, true);
      else showToast(`발송 실패: ${d.message||d.error||'설정 확인'}`, false);
    } catch(e:any){ showToast(`오류: ${e?.message}`, false); } finally { setTgBusy(false); }
  }, [showToast]);

  // ── Auto Position Polling (TESTNET/LIVE 전용) ──────────────────
  useEffect(()=>{
    const active = (tradeMode==='testnet'||tradeMode==='live') && !!connId;
    if (!active) { setSyncStatus(s=>connId?s:'disconnected'); return; }
    let timer:any = null;
    const tick = ()=>{
      if (document.visibilityState !== 'visible') return;       // 백그라운드면 중지
      if (errCountRef.current >= 3) { if(timer){clearInterval(timer);timer=null;} return; }  // 3회 연속 실패 시 중지
      syncBinancePositions({ silent:true });
    };
    syncBinancePositions({ silent:true });                       // 진입 즉시 1회
    timer = setInterval(tick, pollSec*1000);
    const onVis = ()=>{ if (document.visibilityState==='visible') { errCountRef.current=0; syncBinancePositions({ silent:true }); } };  // 복귀 시 즉시
    document.addEventListener('visibilitychange', onVis);
    return ()=>{ if(timer)clearInterval(timer); document.removeEventListener('visibilitychange', onVis); };
  }, [tradeMode, connId, pollSec, syncBinancePositions]);

  // ── 실포지션 종료 (reduce-only) ────────────────────────────────
  const [closeBusy, setCloseBusy] = useState<string|null>(null);      // `${symbol}:${percent}`
  const [closeConfirm, setCloseConfirm] = useState<{ p:any; percent:number }|null>(null);
  // 큐 작업 상태 폴링 (요청접수→처리중→성공/실패)
  const pollJob = useCallback(async (jobId:string, label:string):Promise<boolean>=>{
    const auth = authHeaderRef.current;
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      await new Promise(r=>setTimeout(r, 1500));
      try {
        const r = await fetch(`/api/jobs/${jobId}`, { headers: auth?{Authorization:auth}:{}, signal: AbortSignal.timeout(4000) });
        const d = await r.json();
        if (d.status==='COMPLETED') { showToast(`${label} 성공`, true); return true; }
        if (d.status==='FAILED' || d.status==='CANCELLED') { showToast(`${label} 실패: ${d.error||'-'}`, false); return false; }
      } catch {}
    }
    showToast(`${label} 처리 지연 — 거래소/Worker 상태 확인`, false);
    return false;
  }, [showToast]);
  const execCloseReal = useCallback(async (p:any, percent:number)=>{
    const positionSide = (p.side==='SHORT' || (p.amount||0)<0) ? 'SHORT' : 'LONG';
    const key = `${p.symbol}:${percent}`;
    setCloseBusy(key);
    try {
      const auth = authHeaderRef.current;
      const r = await fetch('/api/binance/futures/close-position', {
        method: 'POST',
        headers: { 'Content-Type':'application/json', ...(auth?{ Authorization: auth }:{}) },
        body: JSON.stringify({ connectionId: connId, symbol: p.symbol, positionSide, quantity: Math.abs(p.amount||0), percent }),
      });
      const d = await r.json();
      if (!r.ok || d.error) { showToast(`종료 요청 실패: ${d.message || d.error || ('HTTP '+r.status)}`, false); }
      else if (d.queued && d.jobId) {
        showToast(`${p.symbol} ${percent}% 종료 요청 접수됨 — 처리 중`, true);
        const okJob = await pollJob(d.jobId, `${p.symbol} ${percent}% 종료`);
        if (okJob) await syncBinancePositions();
      }
    } catch (e:any) { showToast(`종료 오류: ${e?.message || '네트워크'}`, false); }
    finally { setCloseBusy(null); }
  }, [connId, syncBinancePositions, showToast, pollJob]);
  const closeReal = useCallback((p:any, percent:number)=>{
    if (!realTestnet) setCloseConfirm({ p, percent });   // LIVE → 확인 모달 필수
    else execCloseReal(p, percent);                       // TESTNET → 즉시 실행
  }, [realTestnet, execCloseReal]);

  // ── 실포지션 TP/SL 편집 ────────────────────────────────────────
  const [tpslModal, setTpslModal] = useState<any|null>(null);   // 대상 포지션
  const [tpslBusy, setTpslBusy] = useState(false);
  const [tpInput, setTpInput] = useState('');
  const [slInput, setSlInput] = useState('');
  const [tpslMode, setTpslMode] = useState<'pct'|'price'>('pct');
  const [tpslConfirm, setTpslConfirm] = useState<{ p:any; tpPrice:number|null; slPrice:number|null }|null>(null);
  const openTpsl = useCallback((p:any)=>{
    setTpslMode('pct'); setTpInput(''); setSlInput(''); setTpslModal(p);
  }, []);
  const calcTpSl = useCallback((p:any, tpVal:string, slVal:string, mode:'pct'|'price')=>{
    const entry = p.entryPrice || 0;
    const isLong = !(p.side==='SHORT' || (p.amount||0)<0);
    let tpPrice:number|null = null, slPrice:number|null = null;
    if (tpVal!=='' && !isNaN(+tpVal)) tpPrice = mode==='price' ? +tpVal : (isLong ? entry*(1+(+tpVal)/100) : entry*(1-(+tpVal)/100));
    if (slVal!=='' && !isNaN(+slVal)) slPrice = mode==='price' ? +slVal : (isLong ? entry*(1-(+slVal)/100) : entry*(1+(+slVal)/100));
    return { tpPrice, slPrice };
  }, []);
  const submitTpsl = useCallback(async (p:any, tpPrice:number|null, slPrice:number|null)=>{
    setTpslBusy(true);
    try {
      const positionSide = (p.side==='SHORT' || (p.amount||0)<0) ? 'SHORT' : 'LONG';
      const auth = authHeaderRef.current;
      const r = await fetch('/api/binance/futures/tpsl', {
        method:'POST', headers:{ 'Content-Type':'application/json', ...(auth?{ Authorization:auth }:{}) },
        body: JSON.stringify({ connectionId: connId, symbol: p.symbol, positionSide, tpPrice, slPrice }),
      });
      const d = await r.json();
      if (!r.ok || d.error) { showToast(`TP/SL 요청 실패: ${d.message || d.error || ('HTTP '+r.status)}`, false); }
      else if (d.queued && d.jobId) {
        showToast(`${p.symbol} TP/SL 요청 접수됨 — 처리 중`, true);
        setTpslModal(null);
        const okJob = await pollJob(d.jobId, `${p.symbol} TP/SL`);
        if (okJob) await syncBinancePositions();
      }
    } catch (e:any) { showToast(`TP/SL 오류: ${e?.message || '네트워크'}`, false); }
    finally { setTpslBusy(false); }
  }, [connId, syncBinancePositions, showToast, pollJob]);
  const onTpslSubmit = useCallback((p:any)=>{
    if (mismatchActive) { showToast('⚠️ 포지션 불일치 감지 — 동기화 전까지 TP/SL 수정이 차단됩니다', false); return; }
    if (tradingBlocked) { showToast('⚠️ 동기화 연속 실패 — 거래가 차단된 상태입니다', false); return; }
    const { tpPrice, slPrice } = calcTpSl(p, tpInput, slInput, tpslMode);
    if (tpPrice==null && slPrice==null) { showToast('TP 또는 SL 중 하나는 입력하세요', false); return; }
    if (!realTestnet) setTpslConfirm({ p, tpPrice, slPrice });   // LIVE → 확인 모달
    else submitTpsl(p, tpPrice, slPrice);                         // TESTNET → 즉시
  }, [tpInput, slInput, tpslMode, calcTpSl, realTestnet, submitTpsl, showToast, mismatchActive, tradingBlocked]);

  // ── 펀딩 카운트다운 1초 틱 (실포지션 있을 때만) ───────────────────
  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(()=>{
    if (realPos.length===0) return;
    const t = setInterval(()=>setNowTick(Date.now()), 1000);
    return ()=>clearInterval(t);
  }, [realPos.length]);
  const fmtCountdown = useCallback((ms:number)=>{
    if (!(ms>0)) return '00:00:00';
    const s=Math.floor(ms/1000), h=Math.floor(s/3600), m=Math.floor((s%3600)/60), ss=s%60;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;
  }, []);

  // 포지션 종료 — paper 정리 + testnet/live면 거래소 청산
  const closePosition = async (p: any, cur: number, ratio: number) => {
    // testnet/live: 거래소에 reduce-only 반대주문
    if ((tradeMode === 'testnet' || tradeMode === 'live') && connId) {
      try {
        const tradeSymbol = p.asset.toUpperCase().replace(/USDT$/,'') + 'USDT';
        const closeQty = Number((p.qty * ratio).toFixed(3));
        const r = await fetch('/api/binance/futures/order', {
          method:'POST',
          headers:{'Content-Type':'application/json',...(authHeaderRef.current?{Authorization:authHeaderRef.current}:{})},
          body: JSON.stringify({
            connectionId: connId, symbol: tradeSymbol,
            side: p.side==='short'?'BUY':'SELL',   // 청산은 반대방향
            type:'MARKET', quantity: closeQty, leverage, reduceOnly: true,
            confirmToken:'LIVE_ORDER_CONFIRMED',
          }),
        });
        const d = await r.json();
        if (!r.ok || d.error) { alert(`거래소 청산 실패:\n${d.message||d.error}`); return; }
        alert(`거래소 청산 주문 전송됨 (${Math.round(ratio*100)}%)\n주문번호: ${d.orderId||'-'}`);
      } catch (e:any) { alert(`청산 오류: ${e?.message||''}`); return; }
    }
    closePaperPosition(p.asset, cur, ratio);
    refreshPositions();
  };

  const confirmOrder = async (sideArg?: string) => {
    const side = sideArg || sideRef.current || '매수';
    setShowConfirm(false);
    // EMERGENCY_STOP: 킬스위치 발동 중이면 신규 진입 차단 (Close/TP-SL은 별도 허용)
    if (ksStatus?.active && (tradeMode==='testnet'||tradeMode==='live')) {
      showToast('🛑 킬스위치 발동 중 — 신규 진입이 차단되었습니다', false);
      setStatus(null); return;
    }
    setStatus('loading');
    const orderAmt = amount ? +amount : 100_000;

    // ── 테스트넷/실전: 실제 거래소 선물 주문 ──
    if (tradeMode === 'testnet' || tradeMode === 'live') {
      if (!connId) { setStatus('error' as any); setTimeout(()=>setStatus(null),3000); return; }
      try {
        const tradeSymbol = (sel.sym || sel.id).toUpperCase().replace(/USDT$/,'') + 'USDT';
        const krwPx = sel.p || 0;                    // 화면 표시가 (KRW)
        const usdtPx = krwPx / 1375;                 // USDT 환산 가격
        let usdtNotional = orderAmt / 1375;          // 주문 명목가치 (USDT)
        // 바이낸스 최소 명목가치 20 USDT — 미달 시 안내
        if (usdtNotional < 20) {
          alert(`주문 금액이 너무 작습니다.\n\n바이낸스 최소 주문: 약 20 USDT (≈ 27,500원)\n현재: ${Math.round(usdtNotional)} USDT (₩${fmt(orderAmt)})\n\n금액을 3만원 이상으로 늘려주세요.`);
          setStatus(null); return;
        }
        const qty = usdtPx > 0 ? usdtNotional / usdtPx : 0;
        const r = await fetch('/api/binance/futures/order', {
          method:'POST',
          headers:{'Content-Type':'application/json',...(authHeaderRef.current?{Authorization:authHeaderRef.current}:{})},
          body: JSON.stringify({
            connectionId: connId,
            symbol: tradeSymbol,
            side: side==='매수'?'BUY':'SELL',
            type:'MARKET',
            quantity: Number(qty.toFixed(3)),
            leverage,
            stopLossPct: sl && krwPx ? Math.abs(((+sl-krwPx)/krwPx)*100) : undefined,
            takeProfitPct: tp && krwPx ? Math.abs(((+tp-krwPx)/krwPx)*100) : undefined,
            confirmToken:'LIVE_ORDER_CONFIRMED',
          }),
        });
        const d = await r.json();
        if (!r.ok || d.error) {
          const errMsg = d.message || d.error || '주문 실패';
          setOrders(prev=>[{ id:uid(), assetId:sel.id, nameKr:sel.nameKr, sym:sel.sym, side:side==='매수'?'buy':'sell',
            price:krwPx, amount:orderAmt, leverage, fee:0, slippage:0, status:'failed', pnl:0, pnlPct:0,
            openedAt:new Date().toISOString(), note:errMsg, emotion:'😟' } as Order, ...prev]);
          alert(`${tradeMode==='testnet'?'테스트넷':'실전'} 주문 요청 실패:\n\n${errMsg}`);
          setStatus('error' as any); setTimeout(()=>setStatus(null),4000); return;
        }
        // 요청 접수됨 → Worker 처리 대기 (job 폴링)
        if (d.queued && d.jobId) {
          showToast(`${tradeSymbol} ${side} 요청 접수됨 — Worker 처리 중`, true);
          setStatus('done'); setTimeout(()=>setStatus(null),2000);
          const okJob = await pollJob(d.jobId, `${tradeSymbol} ${side} 주문`);
          if (okJob) {
            try {
              paperBuy(sel.id, krwPx, orderAmt, {
                stopLossPct: sl && krwPx ? Math.abs(((+sl-krwPx)/krwPx)*100) : undefined,
                takeProfitPct: tp && krwPx ? Math.abs(((+tp-krwPx)/krwPx)*100) : undefined,
                stratId: tradeMode, side: side === '매수' ? 'long' : 'short',
              });
              refreshPositions();
            } catch {}
            setOrders(prev=>[{ id:d.jobId||uid(), assetId:sel.id, nameKr:sel.nameKr, sym:sel.sym, side:side==='매수'?'buy':'sell',
              price:krwPx, amount:orderAmt, leverage, fee:0, slippage:0, status:'filled', pnl:0, pnlPct:0,
              openedAt:new Date().toISOString(), note:`${tradeMode==='testnet'?'테스트넷':'실전'} 주문 (job ${String(d.jobId).slice(0,8)})`, emotion:'😊' } as Order, ...prev]);
            await syncBinancePositions();
          }
        }
        return;
      } catch (e:any) {
        alert(`주문 오류: ${e?.message||'네트워크 오류'}`);
        setStatus('error' as any); setTimeout(()=>setStatus(null),3000); return;
      }
    }

    // ── 모의(mock): 앱 내부 가상 포지션 ──
    try {
      const r = await placeOrder({
        assetId:  sel.id,
        nameKr:   sel.nameKr,
        symbol:   sel.sym || sel.id,
        side:     side === '매수' ? 'buy' : 'sell',
        amount:   orderAmt,
        leverage,
        price:    sel.p || 0,
        mode:     'paper',
      });
      const newOrder: Order = {
        id:       r.data?.orderId || uid(),
        assetId:  sel.id, nameKr: sel.nameKr, sym: sel.sym,
        side:     side === '매수' ? 'buy' : 'sell',
        price:    r.data?.filledPrice || sel.p,
        amount:   orderAmt, leverage,
        fee:      r.data?.fee || orderAmt * 0.001,
        slippage: 0,
        status:   r.status === 'error' ? 'failed' : 'filled',
        pnl:      r.data?.pnl || 0,
        pnlPct:   0,
        openedAt: new Date().toISOString(),
        note: '', emotion: '😊',
      };
      setOrders(prev => [newOrder, ...prev]);

      // 실제 포지션 생성 (mock 모드 — 매수/매도 모두)
      if (tradeMode === 'mock' && r.status !== 'error') {
        try {
          const riskCheck = canOpenNewPosition();
          if (!riskCheck.allowed) {
            setOrders(prev => prev.map((o, i) => i === 0 ? { ...o, note: `진입 차단: ${riskCheck.reason}`, status: 'failed' } : o));
            alert(`신규 진입 차단\n\n${riskCheck.reason}\n\n(설정 → 리스크 한도에서 조정 가능)`);
            setStatus(null);
            return;
          }
          const px = r.data?.filledPrice || sel.p || 0;
          paperBuy(sel.id, px, orderAmt, {
            stopLossPct: sl ? Math.abs(((+sl - px) / px) * 100) : undefined,
            takeProfitPct: tp ? Math.abs(((+tp - px) / px) * 100) : undefined,
            stratId: 'manual',
            side: side === '매수' ? 'long' : 'short',
          });
          refreshPositions();
          alert(`모의 ${side} 체결!\n${sel.nameKr} ${leverage}x\n금액: ₩${fmt(orderAmt)}\n\n아래 '현재 포지션'에서 확인하세요.`);
        } catch {}
      }

      setStatus(r.status === 'error' ? 'error' as any : 'done');
    } catch {
      setStatus('error' as any);
    }
    setTimeout(() => setStatus(null), 3000);
  };

  return (
    <div>
      {/* Mock/Live toggle */}
      <div style={{display:'flex',gap:8,marginBottom:12}}>
        {([['mock','모의'],['testnet','테스트넷'],['live','실전']] as [typeof tradeMode,string][]).map(([m,l])=>{
          const locked = (m==='testnet'||m==='live') && !hasExchange;
          const active = tradeMode===m;
          const c = m==='mock'?T.acl:m==='testnet'?T.ylw:T.red;
          return (
            <button key={m} onClick={()=>{ if(locked){ alert('거래소 연결 후 사용 가능합니다 (더보기 → 거래소연결)'); return; } setTradeMode(m); }}
              style={{flex:1,padding:'10px 6px',background:active?c+'20':'transparent',color:active?c:locked?T.muted:T.sub,border:`1px solid ${active?c:T.border}`,borderRadius:12,fontWeight:700,fontSize:11,cursor:'pointer',opacity:locked?0.5:1,position:'relative'}}>
              {l}{locked&&' 🔒'}
            </button>
          );
        })}
      </div>
      {tradeMode==='mock'&&<div style={{background:T.prp+'15',border:`1px solid ${T.prp}30`,borderRadius:10,padding:'8px 12px',marginBottom:12}}><div style={{color:T.prp,fontWeight:700,fontSize:11}}>모의매매 — 앱 내부 가상 포지션 · 실제 돈 사용 안됨</div></div>}
      {tradeMode==='testnet'&&<div style={{background:T.ylw+'15',border:`1px solid ${T.ylw}30`,borderRadius:10,padding:'8px 12px',marginBottom:12}}><div style={{color:T.ylw,fontWeight:700,fontSize:11}}>테스트넷 — 거래소 테스트 서버에 실제 주문 (가짜 자금)</div></div>}
      {tradeMode==='live'&&<div style={{background:T.red+'15',border:`1px solid ${T.red}40`,borderRadius:10,padding:'8px 12px',marginBottom:12}}><div style={{color:T.red,fontWeight:800,fontSize:11}}>⚠️ 실전 — 실제 자금으로 주문이 실행됩니다</div></div>}

      {(tradeMode==='testnet'||tradeMode==='live')&&connections.length>0&&(
        <div style={{marginBottom:12}}>
          <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:6}}>거래소 연결 선택</div>
          <select value={connId} onChange={e=>setConnId(e.target.value)}
            style={{width:'100%',background:T.alt,border:`1px solid ${T.border}`,borderRadius:10,padding:'11px 12px',color:T.txt,fontSize:12,outline:'none'}}>
            {connections.map((c:any)=>(
              <option key={c.id} value={c.id}>{c.label||c.exchange_id} {c.is_testnet?'(테스트넷)':'(실전)'}</option>
            ))}
          </select>
        </div>
      )}

      {/* Sub tabs */}
      <div style={{display:'flex',gap:4,marginBottom:12,overflowX:'auto'}}>
        {(['trade','chart','ai','tech','news','sizing','risk'] as const).map(t=>(
          <button key={t} onClick={()=>setTab(t)}
            style={{flexShrink:0,padding:'8px 10px',minHeight:38,background:tab===t?T.acg:'transparent',color:tab===t?T.acl:T.muted,border:`1px solid ${tab===t?T.acl:T.border}`,borderRadius:10,fontSize:11,fontWeight:700,cursor:'pointer',whiteSpace:'nowrap'}}>
            {t==='trade'?'매매':t==='chart'?'차트':t==='ai'?'AI':t==='tech'?'기술':t==='news'?'뉴스':t==='sizing'?'사이징':'리스크'}
          </button>
        ))}
      </div>

      {tab==='chart'&&(
        <Card style={{padding:0,overflow:'hidden',marginBottom:12}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'10px 14px',borderBottom:`1px solid ${T.border}`}}>
            <div>
              <span style={{color:T.txt,fontWeight:700,fontSize:13}}>{sel.nameKr}</span>
              <span style={{color:T.muted,fontSize:10,marginLeft:8}}>{sel.sym||sel.id}</span>
            </div>
            <div style={{display:'flex',gap:4}}>
              {['1','5','15','60','240','D'].map(iv=>(
                <button key={iv} onClick={()=>setChartInterval(iv)}
                  style={{padding:'2px 6px',background:chartInterval===iv?T.acg:'transparent',color:chartInterval===iv?T.acl:T.muted,border:`1px solid ${chartInterval===iv?T.acl:'transparent'}`,borderRadius:5,fontSize:9,fontWeight:700,cursor:'pointer'}}>
                  {iv==='60'?'1H':iv==='240'?'4H':iv==='D'?'1D':iv+'m'}
                </button>
              ))}
            </div>
          </div>
          <ChartContainer
            storageKey="tg_chart_height_trading"
            defaultLevel="normal"
            title={`${sel.sym || sel.id} · ${sel.nameKr || ''}`}>
            <InlineTVChart symbol={toTVSymbol(sel.sym||sel.id)} interval={chartInterval}/>
          </ChartContainer>
          <div style={{padding:'8px 14px',borderTop:`1px solid ${T.border}`,display:'flex',flexDirection:'column',gap:8}}>
            <div style={{display:'flex',gap:8}}>
              <button type="button" onClick={()=>{setSide('매수');setTab('trade');}} style={{flex:1,padding:'10px',background:T.grn,color:'#fff',border:'none',borderRadius:10,fontWeight:800,fontSize:13,cursor:'pointer',minHeight:40}}>
                매수
              </button>
              <button type="button" onClick={()=>{setSide('매도');setTab('trade');}} style={{flex:1,padding:'10px',background:T.red,color:'#fff',border:'none',borderRadius:10,fontWeight:800,fontSize:13,cursor:'pointer',minHeight:40}}>
                매도
              </button>
            </div>
            <button type="button" onClick={()=>onOpenPnL?.(sel)} disabled={!onOpenPnL} style={{padding:'9px',background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:10,fontWeight:700,fontSize:12,cursor:onOpenPnL?'pointer':'not-allowed',minHeight:38,opacity:onOpenPnL?1:0.5}}>
              수익 계산기로 이동
            </button>
          </div>
        </Card>
      )}

      {tab==='sizing'&&(
        <Card style={{padding:'14px 16px',marginBottom:12}}>
          <PositionSizer balance={50000000} currency={currency}/>
        </Card>
      )}

      {tab==='risk'&&(
        <Card style={{padding:'14px 16px',marginBottom:12}}>
          <RiskDashboard positions={positions.map(p=>({assetId:p.asset,nameKr:p.asset,entryPrice:p.avgPrice,qty:p.qty,leverage:1,side:'long'}))} prices={prices}/>
        </Card>
      )}

      {tab==='ai' && <AIAnalysisTab asset={sel} onTradeBuy={() => { setSide('매수'); setTab('trade'); }} onTradeSell={() => { setSide('매도'); setTab('trade'); }} />}
      {tab==='tech' && <TechAnalysisTab asset={sel}/>}
      {tab==='news' && <NewsTab asset={sel}/>}

      {tab==='trade'&&(
        <>
          {/* Asset selector */}
          <Card style={{padding:12,marginBottom:12}}>
            <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="종목 검색…"
              style={{width:'100%',background:T.alt,border:`1px solid ${T.border}`,borderRadius:8,padding:'7px 10px',color:T.txt,fontSize:12,outline:'none',marginBottom:8}}/>
            <div style={{display:'flex',gap:5,flexWrap:'wrap',maxHeight:80,overflowY:'auto'}}>
              {filtered.slice(0,24).map(a=>(
                <button key={a.id} onClick={()=>{setSel(a);setSearch('');}} style={{background:sel.id===a.id?a.clr+'20':'transparent',color:sel.id===a.id?a.clr:T.muted,border:`1px solid ${sel.id===a.id?a.clr:T.border}`,borderRadius:8,padding:'3px 8px',fontSize:11,fontWeight:700,cursor:'pointer',display:'flex',alignItems:'center',gap:4}}>
                  <Logo id={a.id} size={14} clr={a.clr}/>{a.id}
                </button>
              ))}
            </div>
          </Card>

          {/* Price + Chart */}
          <Card style={{padding:'14px 14px 10px',marginBottom:12}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
              <div>
                <div style={{color:T.muted,fontSize:10}}>{sel.nameKr}</div>
                <div style={{color:T.txt,fontSize:22,fontWeight:900,fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums',letterSpacing:-1}}>{cvt(sel.p,currency)}</div>
                <span style={{color:sel.c>=0?T.grn:T.red,fontWeight:800,fontSize:13}}>{sel.c>=0?'▲':'▼'} {Math.abs(sel.c).toFixed(2)}%</span>
              </div>
              <div style={{display:'flex',flexDirection:'column',alignItems:'flex-end',gap:5}}>
                <Logo id={sel.id} size={38} clr={sel.clr}/>
                <button onClick={()=>setShowChart(v=>!v)} style={{display:'flex',alignItems:'center',gap:4,background:showChart?T.acc:T.alt,color:showChart?'#fff':T.acl,border:`1px solid ${showChart?T.acc:T.acl}40`,borderRadius:8,padding:'5px 11px',fontSize:11,fontWeight:800,cursor:'pointer'}}>
                  <BarChart3 size={13}/>{showChart?'차트 숨기기':'차트 보기'}
                </button>
              </div>
            </div>
            {showChart&&<div style={{marginTop:10,borderTop:`1px solid ${T.border}`,paddingTop:10}}><TradingChart asset={sel}/></div>}
          </Card>

          {/* AI Leverage Recommendation */}
          <Card style={{padding:'12px 14px',marginBottom:12,border:`1px solid ${levRec.color}30`}}>
            <div style={{color:T.txt,fontWeight:700,fontSize:12,marginBottom:8}}>AI 레버리지 추천</div>
            <div style={{display:'flex',gap:8,marginBottom:10}}>
              {(['conservative','balanced','aggressive'] as const).map(p=>(
                <button key={p} onClick={()=>setRiskProfile(p)} style={{flex:1,padding:'6px 4px',background:riskProfile===p?T.acg:'transparent',color:riskProfile===p?T.acl:T.muted,border:`1px solid ${riskProfile===p?T.acl:T.border}`,borderRadius:8,fontSize:10,fontWeight:700,cursor:'pointer'}}>
                  {p==='conservative'?'보수형':p==='balanced'?'균형형':'공격형'}
                </button>
              ))}
            </div>
            <div style={{background:levRec.color+'12',border:`1px solid ${levRec.color}30`,borderRadius:10,padding:'10px 12px'}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
                <div>
                  <div style={{color:levRec.color,fontWeight:900,fontSize:18,fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums'}}>{levRec.rec}x 권장</div>
                  <div style={{color:T.muted,fontSize:10,marginTop:1}}>변동성 {Math.abs(sel.c).toFixed(1)}% · {sel.nameKr}</div>
                </div>
                <div style={{textAlign:'center'}}>
                  <div style={{color:levRec.color,fontWeight:800,fontSize:11}}>{levRec.level}</div>
                  <div style={{color:T.muted,fontSize:9}}>안전도 {levRec.score}/100</div>
                </div>
              </div>
              {/* 현재 선택 표시 */}
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6,padding:'5px 0',borderTop:`1px solid ${levRec.color}20`}}>
                <span style={{color:T.muted,fontSize:10}}>선택한 레버리지</span>
                <span style={{color:leverage>10?T.red:leverage>5?T.ylw:T.grn,fontWeight:900,fontSize:14,fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums'}}>{leverage}x</span>
              </div>
              <div style={{display:'flex',gap:6}}>
                {[1,3,5,10,20].map(v=>{
                  const active = v===leverage;
                  const isRec = v===levRec.rec;
                  return (
                    <button key={v} onClick={()=>setLeverage(v)} style={{flex:1,padding:'7px 4px',position:'relative',
                      background:active?levRec.color+'30':'transparent',
                      color:active?levRec.color:T.muted,
                      border:`1px solid ${active?levRec.color:T.border}`,
                      borderRadius:6,fontSize:11,fontWeight:active?800:700,cursor:'pointer'}}>
                      {v}x
                      {isRec && <span style={{position:'absolute',top:-6,right:-2,fontSize:7,background:levRec.color,color:'#fff',padding:'1px 4px',borderRadius:4,fontWeight:800}}>추천</span>}
                    </button>
                  );
                })}
              </div>
            </div>
            <div style={{marginTop:8,color:T.muted,fontSize:10,lineHeight:1.6}}>
              {Math.abs(sel.c)>5?`현재 ${sel.nameKr} 변동성이 높습니다. 낮은 레버리지를 권장합니다.`:Math.abs(sel.c)>3?`${sel.nameKr} 보통 변동성. 중간 레버리지가 적합합니다.`:`${sel.nameKr} 안정적 상태. 전략에 맞는 레버리지를 선택하세요.`}
            </div>
          </Card>

          {/* Order form */}
          <Card style={{padding:12,marginBottom:12}}>
              <div>

            {/* 한 줄: 마진모드 + 레버리지 (바이낸스처럼 압축) */}
            <div style={{display:'flex',gap:6,marginBottom:8}}>
              {(['cross','isolated'] as const).map(m=>(
                <button key={m} onClick={()=>setMarginMode(m)} style={{flex:1,background:marginMode===m?T.acg:T.alt,color:marginMode===m?T.acl:T.muted,border:`1px solid ${marginMode===m?T.acl:T.border}`,borderRadius:7,padding:'8px',fontSize:11,fontWeight:700,cursor:'pointer'}}>{m==='cross'?'교차':'격리'}</button>
              ))}
              <button onClick={()=>setShowLevSheet(true)}
                style={{flex:1,background:T.alt,color:leverage>20?T.red:leverage>5?T.ylw:T.grn,border:`1px solid ${T.border}`,borderRadius:7,padding:'8px',fontSize:12,fontWeight:800,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',gap:4}}>
                {leverage}x <span style={{fontSize:8,color:T.muted}}>▼</span>
              </button>
            </div>

            {/* 레버리지 조절 바텀시트 (바이낸스 스타일) */}
            {showLevSheet&&(
              <div onClick={()=>setShowLevSheet(false)} style={{position:'fixed',inset:0,zIndex:3000,background:'rgba(0,0,0,.6)',display:'flex',alignItems:'flex-end',justifyContent:'center'}}>
                <div onClick={e=>e.stopPropagation()} style={{width:'100%',maxWidth:480,background:T.surf,borderRadius:'20px 20px 0 0',padding:'20px 18px calc(20px + env(safe-area-inset-bottom,0px))',border:`1px solid ${T.border2}`}}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4}}>
                    <span style={{color:T.txt,fontWeight:900,fontSize:18}}>레버리지 조절</span>
                    <button onClick={()=>setShowLevSheet(false)} style={{background:'none',border:'none',color:T.muted,fontSize:22,cursor:'pointer',lineHeight:1}}>✕</button>
                  </div>
                  <div style={{color:T.muted,fontSize:12,marginBottom:18}}>{sel.nameKr} · {marginMode==='cross'?'교차':'격리'}</div>

                  {/* - 숫자 + */}
                  <div style={{display:'flex',alignItems:'center',background:T.alt,borderRadius:12,padding:'4px',marginBottom:18}}>
                    <button onClick={()=>setLeverage(Math.max(1,leverage-1))} style={{width:48,height:48,background:T.card,border:`1px solid ${T.border}`,borderRadius:10,color:T.txt,fontSize:24,fontWeight:700,cursor:'pointer'}}>−</button>
                    <div style={{flex:1,display:'flex',alignItems:'center',justifyContent:'center',gap:2}}>
                      <input type="number" inputMode="numeric" value={leverage}
                        onChange={e=>{ const v=parseInt(e.target.value.replace(/[^0-9]/g,'')); if(!isNaN(v)) setLeverage(Math.max(1,Math.min(125,v))); else setLeverage(1); }}
                        style={{width:80,textAlign:'center',background:'transparent',border:'none',outline:'none',color:leverage>20?T.red:leverage>5?T.ylw:T.grn,fontSize:28,fontWeight:900,fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums'}}/>
                      <span style={{color:leverage>20?T.red:leverage>5?T.ylw:T.grn,fontSize:18,fontWeight:900}}>x</span>
                    </div>
                    <button onClick={()=>setLeverage(Math.min(125,leverage+1))} style={{width:48,height:48,background:T.card,border:`1px solid ${T.border}`,borderRadius:10,color:T.txt,fontSize:24,fontWeight:700,cursor:'pointer'}}>+</button>
                  </div>

                  {/* 슬라이더 */}
                  <input type="range" min={1} max={125} value={leverage} onChange={e=>setLeverage(+e.target.value)}
                    style={{width:'100%',accentColor:leverage>20?T.red:leverage>5?T.ylw:T.grn,marginBottom:6}}/>
                  {/* 마커 */}
                  <div style={{display:'flex',justifyContent:'space-between',marginBottom:18}}>
                    {[1,25,50,75,100,125].map(v=>(
                      <button key={v} onClick={()=>setLeverage(v)} style={{background:'none',border:'none',color:leverage===v?T.acl:T.muted,fontSize:11,fontWeight:leverage===v?800:600,cursor:'pointer',padding:0}}>{v}x</button>
                    ))}
                  </div>

                  {/* 빠른 선택 */}
                  <div style={{display:'flex',gap:6,marginBottom:16,flexWrap:'wrap'}}>
                    {[1,3,5,10,20,50,75,100,125].map(v=>(
                      <button key={v} onClick={()=>setLeverage(v)} style={{flex:'1 0 auto',minWidth:52,padding:'9px 4px',background:leverage===v?T.acc:T.alt,color:leverage===v?'#fff':T.sub,border:`1px solid ${leverage===v?T.acc:T.border}`,borderRadius:8,fontSize:12,fontWeight:700,cursor:'pointer'}}>{v}x</button>
                    ))}
                  </div>

                  {leverage>10&&(
                    <div style={{color:T.ylw,fontSize:11,lineHeight:1.5,marginBottom:16}}>
                      ⚠️ 10배 이상 레버리지는 작은 가격 변동에도 청산될 수 있습니다. 주의하세요.
                    </div>
                  )}

                  <button onClick={()=>setShowLevSheet(false)} style={{width:'100%',padding:'15px',background:T.acc,color:'#fff',border:'none',borderRadius:12,fontWeight:900,fontSize:15,cursor:'pointer'}}>
                    확인 ({leverage}x)
                  </button>
                </div>
              </div>
            )}

            {/* 한 줄: 주문타입 + 가격(지정가일때) */}
            <div style={{display:'flex',gap:6,marginBottom:8}}>
              {([['market','시장가'],['limit','지정가'],['conditional','조건부']] as [string,string][]).map(([v,l])=>(
                <button key={v} onClick={()=>setOrderType(v)} style={{flex:1,padding:'8px 4px',background:orderType===v?T.acg:T.alt,color:orderType===v?T.acl:T.muted,border:`1px solid ${orderType===v?T.acl:T.border}`,borderRadius:7,fontSize:11,fontWeight:700,cursor:'pointer'}}>{l}</button>
              ))}
            </div>
            {(orderType==='limit'||orderType==='conditional')&&(
              <div style={{display:'flex',gap:6,marginBottom:8}}>
                <input type="number" inputMode="decimal" value={limitPrice} onChange={e=>setLimitPrice(e.target.value)} placeholder={`${orderType==='conditional'?'트리거가':'지정가'}`}
                  style={{flex:1,background:T.alt,border:`1px solid ${T.border}`,borderRadius:7,padding:'9px 11px',color:T.txt,fontSize:13,fontWeight:700,outline:'none'}}/>
                <button onClick={()=>setLimitPrice(String(Math.round(sel.p)))} style={{padding:'0 14px',background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:7,fontSize:11,fontWeight:800,cursor:'pointer'}}>BBO</button>
              </div>
            )}

            {/* 금액 입력 + 빠른선택 (한 줄에) */}
            <input type="number" inputMode="numeric" value={amount} onChange={e=>setAmount(e.target.value)} placeholder="주문 금액 (₩)"
              style={{width:'100%',background:T.alt,border:`1px solid ${T.border2}`,borderRadius:8,padding:'11px 12px',color:T.txt,fontSize:15,fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums',fontWeight:700,outline:'none',marginBottom:6}}/>
            {/* 실시간 환산: USDT + 수량 + 명목가치 */}
            {amount&&+amount>0&&(()=>{
              const krwPx = sel.p || 0;
              const usdt = +amount / 1375;
              const qty = krwPx>0 ? (+amount/krwPx) : 0;
              const notional = usdt * leverage;
              const symbol = (sel.sym||sel.id).toUpperCase().replace(/USDT$/,'');
              return (
                <div style={{display:'flex',justifyContent:'space-between',gap:8,background:T.bg,borderRadius:7,padding:'8px 11px',marginBottom:6,fontSize:11,fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums'}}>
                  <div><span style={{color:T.muted}}>≈ </span><span style={{color:T.txt,fontWeight:700}}>{usdt.toFixed(1)} USDT</span></div>
                  <div><span style={{color:T.muted}}>수량 </span><span style={{color:T.acl,fontWeight:700}}>{qty.toFixed(qty<1?5:3)} {symbol}</span></div>
                  <div><span style={{color:T.muted}}>명목 </span><span style={{color:notional<20?T.red:T.grn,fontWeight:700}}>{notional.toFixed(0)} USDT</span></div>
                </div>
              );
            })()}
            <div style={{display:'flex',gap:4,marginBottom:8}}>
              {[25,50,75,100].map(pct=>(
                <button key={pct} onClick={()=>{ try { const b=loadPaperBalance(); setAmount(String(Math.round((b.krw||10000000)*pct/100))); } catch {} }}
                  style={{flex:1,background:T.alt,color:T.acl,border:`1px solid ${T.border}`,borderRadius:6,padding:'5px 2px',fontSize:10,fontWeight:700,cursor:'pointer'}}>{pct}%</button>
              ))}
            </div>

            {/* TP/SL 한 줄 */}
            <div style={{display:'flex',gap:6,marginBottom:8}}>
              <input type="number" value={tp} onChange={e=>setTp(e.target.value)} placeholder="익절가(TP)"
                style={{flex:1,background:T.alt,border:`1px solid ${T.grn}30`,borderRadius:7,padding:'9px',color:T.txt,fontSize:12,outline:'none'}}/>
              <input type="number" value={sl} onChange={e=>setSl(e.target.value)} placeholder="손절가(SL)"
                style={{flex:1,background:T.alt,border:`1px solid ${T.red}30`,borderRadius:7,padding:'9px',color:T.txt,fontSize:12,outline:'none'}}/>
            </div>

            {/* 요약 한 줄 (금액 있을때만, 컴팩트) */}
            {amount&&(
              <div style={{display:'flex',justifyContent:'space-between',background:T.alt,borderRadius:7,padding:'7px 11px',marginBottom:8,fontSize:10}}>
                <span style={{color:T.muted}}>명목 ₩{fmt(+amount*leverage)} · 수수료 ₩{fmt(fee)}</span>
                <span style={{color:T.red,fontWeight:700}}>청산 -{(100/leverage*0.9).toFixed(1)}%</span>
              </div>
            )}
            {leverage>20&&<div style={{color:T.red,fontSize:10,fontWeight:700,marginBottom:8,textAlign:'center'}}>⚠️ {leverage}x 고위험 — 작은 변동에도 청산 가능</div>}

            {/* 실행 버튼 — Buy(Long) / Sell(Short) 2개 (바이낸스) */}
            <div style={{display:'flex',gap:8}}>
              <button onClick={()=>{if(!amount)setAmount('100000');setSide('매수');setTimeout(()=>setShowConfirm(true),0);}} disabled={status==='loading'}
                style={{flex:1,padding:'15px',background:T.grn,color:'#fff',border:'none',borderRadius:10,fontWeight:900,fontSize:15,cursor:'pointer'}}>
                매수 / 롱
              </button>
              <button onClick={()=>{if(!amount)setAmount('100000');setSide('매도');setTimeout(()=>setShowConfirm(true),0);}} disabled={status==='loading'}
                style={{flex:1,padding:'15px',background:T.red,color:'#fff',border:'none',borderRadius:10,fontWeight:900,fontSize:15,cursor:'pointer'}}>
                매도 / 숏
              </button>
            </div>
            {status==='loading'&&<div style={{color:T.acl,fontSize:11,textAlign:'center',marginTop:6}}>처리 중…</div>}
            {status==='done'&&<div style={{color:T.grn,fontSize:11,textAlign:'center',marginTop:6}}>✅ 완료!</div>}
            <div style={{color:T.muted,fontSize:9,textAlign:'center',marginTop:5}}>{tradeMode==='mock'?'모의':tradeMode==='testnet'?'테스트넷':'실전'} · 금액 미입력 시 기본 10만원</div>
              </div>

              {/* 오더북 (호가창) — 주문폼 아래 */}
              <div style={{marginTop:12}}>
                {(()=>{
                  const px = sel.p || 0;
                  const tick = px > 1000 ? Math.round(px*0.0001) : Math.max(px*0.0001, 0.0001);
                  const asks = Array.from({length:5},(_,i)=>({ p: px+tick*(5-i), amt: (Math.random()*80+10) }));
                  const bids = Array.from({length:5},(_,i)=>({ p: px-tick*(i+1), amt: (Math.random()*80+10) }));
                  const maxAmt = Math.max(...asks.map(a=>a.amt),...bids.map(b=>b.amt));
                  const Row = ({p,amt,buy}:{p:number;amt:number;buy:boolean})=>(
                    <div onClick={()=>{ setOrderType('limit'); setLimitPrice(String(Math.round(p))); }}
                      style={{position:'relative',display:'flex',justifyContent:'space-between',padding:'2px 6px',fontSize:10,fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums',cursor:'pointer',overflow:'hidden',lineHeight:1.5}}>
                      <div style={{position:'absolute',top:0,bottom:0,right:0,width:`${amt/maxAmt*100}%`,background:buy?T.grn+'18':T.red+'18'}}/>
                      <span style={{color:buy?T.grn:T.red,zIndex:1}}>{fmt(Math.round(p))}</span>
                      <span style={{color:T.sub,zIndex:1,fontSize:9}}>{amt.toFixed(1)}</span>
                    </div>
                  );
                  return (
                    <div style={{background:T.bg,borderRadius:8,padding:'4px 0',border:`1px solid ${T.border}`}}>
                      <div style={{display:'flex',justifyContent:'space-between',padding:'2px 6px 4px',fontSize:8,color:T.muted,borderBottom:`1px solid ${T.border}`}}>
                        <span>가격</span><span>수량</span>
                      </div>
                      {asks.map((a,i)=><Row key={'a'+i} p={a.p} amt={a.amt} buy={false}/>)}
                      <div style={{padding:'4px 6px',textAlign:'center',borderTop:`1px solid ${T.border}`,borderBottom:`1px solid ${T.border}`,margin:'1px 0'}}>
                        <div style={{color:sel.c>=0?T.grn:T.red,fontWeight:900,fontSize:13,fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums'}}>{fmt(Math.round(px))}</div>
                        <div style={{color:T.muted,fontSize:8}}>{sel.c>=0?'▲':'▼'}{Math.abs(sel.c).toFixed(2)}%</div>
                      </div>
                      {bids.map((b,i)=><Row key={'b'+i} p={b.p} amt={b.amt} buy={true}/>)}
                    </div>
                  );
                })()}
              </div>
          </Card>

          {/* Binance 실제 포지션 (TESTNET/LIVE) — 동기화 */}
          {hasExchange && (
            <Card style={{padding:'14px 16px',marginBottom:12,borderLeft:`3px solid ${T.ylw}`}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10,gap:8,flexWrap:'wrap'}}>
                <div style={{color:T.txt,fontWeight:800,fontSize:13,display:'flex',alignItems:'center',gap:6,flexWrap:'wrap'}}>
                  Binance 실제 포지션
                  {realPos.length>0&&<span style={{background:(realTestnet?T.ylw:T.red)+'20',color:realTestnet?T.ylw:T.red,fontSize:9,fontWeight:800,padding:'1px 7px',borderRadius:5}}>{realTestnet?'TESTNET':'LIVE'} {realPos.length}</span>}
                  {(()=>{ const m:Record<string,[string,string]>={ idle:['대기',T.muted], syncing:['동기화 중',T.ylw], synced:['동기화됨',T.grn], mismatch:['불일치 감지',T.red], error:['API 오류',T.red], disconnected:['연결 끊김',T.muted] }; const [lb,c]=m[syncStatus]||m.idle; return <span style={{background:c+'20',color:c,fontSize:9,fontWeight:800,padding:'1px 7px',borderRadius:5,display:'inline-flex',alignItems:'center',gap:3}}>{syncStatus==='synced'?'●':syncStatus==='syncing'?'◐':'○'} {lb}</span>; })()}
                </div>
                <button onClick={()=>syncBinancePositions()} disabled={syncing}
                  style={{padding:'6px 12px',background:syncing?T.alt:T.acg,color:syncing?T.muted:T.acl,border:`1px solid ${T.acl}40`,borderRadius:8,fontSize:11,fontWeight:700,cursor:syncing?'default':'pointer'}}>
                  {syncing?'동기화 중…':'⟳ 수동 동기화'}
                </button>
              </div>
              {/* 자동 폴링 간격 선택 (testnet/live에서 작동) */}
              <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:8,fontSize:10,color:T.muted,flexWrap:'wrap'}}>
                <span>자동 동기화</span>
                {[5,15,30,60].map(s=>(
                  <button key={s} onClick={()=>setPollSec(s)}
                    style={{padding:'3px 9px',background:pollSec===s?T.acg:'transparent',color:pollSec===s?T.acl:T.muted,border:`1px solid ${pollSec===s?T.acl:T.border}`,borderRadius:6,fontSize:10,fontWeight:700,cursor:'pointer'}}>{s}초</button>
                ))}
                {(tradeMode==='mock')&&<span style={{color:T.muted,fontSize:9}}>· 실거래(테넷/실전) 모드에서 작동</span>}
              </div>

              {/* Daily MDD Kill Switch — 배지 + 패널 */}
              {(tradeMode==='testnet'||tradeMode==='live')&&(
                <div style={{marginBottom:8}}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:8}}>
                    {(()=>{ const lv=ksStatus?.noTable?'na':(ksStatus?.level||'ok'); const m:Record<string,[string,string]>={ ok:['🛡 Risk OK',T.grn], warning:['⚠️ Warning',T.ylw], active:['🛑 Kill Switch Active',T.red], na:['리스크 미설정',T.muted] }; const [lb,c]=m[lv]||m.ok; return <span style={{background:c+'18',color:c,fontSize:10,fontWeight:800,padding:'3px 9px',borderRadius:6}}>{lb}</span>; })()}
                    <div style={{display:'flex',alignItems:'center',gap:6}}>
                      {workerStatus&&(()=>{ const m:Record<string,string>={ running:T.grn, degraded:T.ylw, stopped:T.red, absent:T.muted, error:T.muted }; const c=m[workerStatus.status]||T.muted; return <span style={{background:c+'18',color:c,fontSize:9,fontWeight:700,padding:'2px 7px',borderRadius:5}} title={workerStatus.task||''}>Worker {workerStatus.label||workerStatus.status}</span>; })()}
                      <button onClick={()=>setShowKsPanel(v=>!v)} style={{background:'none',border:`1px solid ${T.border}`,borderRadius:6,color:T.sub,fontSize:10,fontWeight:700,padding:'3px 9px',cursor:'pointer'}}>{showKsPanel?'리스크 닫기':'리스크 관리'}</button>
                    </div>
                  </div>

                  {showKsPanel&&(
                    <div style={{background:T.bg,border:`1px solid ${T.border}`,borderRadius:10,padding:'12px',marginTop:8}}>
                      {/* 알림 (듀얼봇 + Redis 상태) */}
                      <div style={{marginBottom:10}}>
                        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
                          <span style={{fontSize:10,color:T.muted,fontWeight:700}}>Telegram 알림</span>
                          {redisOk!=null&&<span style={{fontSize:9,fontWeight:700,color:redisOk?T.grn:T.ylw,background:(redisOk?T.grn:T.ylw)+'18',padding:'1px 7px',borderRadius:5}}>Redis {redisOk?'연결됨':'미연결(fail-open)'}</span>}
                        </div>
                        <div style={{display:'flex',gap:6}}>
                          <button onClick={()=>ksTestTelegram('money')} disabled={tgBusy}
                            style={{flex:1,padding:'8px',background:T.prp+'18',color:T.prp,border:`1px solid ${T.prp}40`,borderRadius:7,fontSize:10,fontWeight:700,cursor:tgBusy?'default':'pointer'}}>📨 Money Bot</button>
                          <button onClick={()=>ksTestTelegram('system')} disabled={tgBusy}
                            style={{flex:1,padding:'8px',background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:7,fontSize:10,fontWeight:700,cursor:tgBusy?'default':'pointer'}}>🛠 System Bot</button>
                        </div>
                        <div style={{display:'flex',gap:6,marginTop:6}}>
                          <button onClick={()=>ksTestTelegram('money','throttle')} disabled={tgBusy}
                            style={{flex:1,padding:'6px',background:'transparent',color:T.muted,border:`1px solid ${T.border}`,borderRadius:6,fontSize:9,fontWeight:700,cursor:'pointer'}}>throttle 테스트</button>
                          <button onClick={()=>ksTestTelegram('system','escalation')} disabled={tgBusy}
                            style={{flex:1,padding:'6px',background:'transparent',color:T.muted,border:`1px solid ${T.border}`,borderRadius:6,fontSize:9,fontWeight:700,cursor:'pointer'}}>escalation 테스트</button>
                        </div>
                      </div>
                      {ksStatus?.noTable?(
                        <div style={{color:T.ylw,fontSize:11,lineHeight:1.6}}>kill_switch_state 테이블이 없어 작동하지 않습니다. 아래 SQL을 Supabase에서 실행한 뒤 새로고침하세요. (상세는 개발자 안내 참고)</div>
                      ):ksStatus?(
                        <>
                          {ksStatus.triggerReason&&<div style={{background:T.red+'15',border:`1px solid ${T.red}40`,borderRadius:8,padding:'8px',marginBottom:10,color:T.red,fontSize:10,fontWeight:700}}>발동 원인: {ksStatus.triggerReason}</div>}
                          {/* C/D 자동 실행 결과 */}
                          {ksStatus.exec&&(ksStatus.exec.cancel||ksStatus.exec.close)&&(
                            <div style={{background:T.alt,borderRadius:8,padding:'8px',marginBottom:10,fontSize:10}}>
                              {ksStatus.exec.cancel&&<div style={{color:ksStatus.exec.cancel.success?T.grn:T.red,fontWeight:700}}>주문 취소: {ksStatus.exec.cancel.success?`완료 (${ksStatus.exec.cancel.count||0}심볼)`:'일부 실패 — 거래소 직접 확인'}</div>}
                              {ksStatus.exec.close&&<div style={{color:ksStatus.exec.close.success?T.grn:T.red,fontWeight:700,marginTop:3}}>포지션 종료: {ksStatus.exec.close.success?`완료 (재시도 ${ksStatus.exec.close.retries}회)`:`${ksStatus.exec.close.remaining}개 잔존 — 거래소 직접 확인 필요`}</div>}
                            </div>
                          )}
                          {/* Reconciliation 잔여 경고 */}
                          {ksStatus.recon&&!ksStatus.recon.clean&&(
                            <div style={{background:T.red+'20',border:`1px solid ${T.red}60`,borderRadius:8,padding:'8px',marginBottom:10}}>
                              <div style={{color:T.red,fontSize:10,fontWeight:800}}>⚠️ 거래소 직접 확인 필요</div>
                              <div style={{color:T.sub,fontSize:9,marginTop:2}}>재확인 결과 포지션 {ksStatus.recon.positions}개 · 미체결 {ksStatus.recon.orders}개 잔존. 거래소 앱에서 직접 확인하세요.</div>
                            </div>
                          )}
                          <div style={{fontSize:10,color:T.muted,marginBottom:8}}>현재 Equity <b style={{color:T.txt}}>{(ksStatus.equity||0).toFixed(2)} USDT</b></div>
                          {([['일일',ksStatus.daily,ksStatus.config.dailyLimitPct,'dailyLimitPct'],['주간',ksStatus.weekly,ksStatus.config.weeklyLimitPct,'weeklyLimitPct'],['월간',ksStatus.monthly,ksStatus.config.monthlyLimitPct,'monthlyLimitPct']] as any[]).map(([lab,d,lim]:any,i:number)=>{
                            const ddv=d.drawdownPct||0; const pctOfLim=Math.min(100,Math.max(0,(-ddv/lim)*100));
                            return (
                              <div key={i} style={{marginBottom:8}}>
                                <div style={{display:'flex',justifyContent:'space-between',fontSize:10,marginBottom:3}}>
                                  <span style={{color:T.muted}}>{lab} 손실</span>
                                  <span style={{color:ddv<=-lim?T.red:ddv<=-lim*0.8?T.ylw:T.sub,fontWeight:700,fontFamily:'Inter,monospace'}}>{ddv.toFixed(2)}% / 한도 -{lim}% · 남은 {d.remainingPct.toFixed(1)}%</span>
                                </div>
                                <div style={{height:5,background:T.alt,borderRadius:3,overflow:'hidden'}}><div style={{height:'100%',width:`${pctOfLim}%`,background:pctOfLim>=100?T.red:pctOfLim>=80?T.ylw:T.grn}}/></div>
                              </div>
                            );
                          })}
                          {/* 한도 입력 */}
                          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:6,marginTop:10}}>
                            {([['일일','dailyLimitPct',ksStatus.config.dailyLimitPct],['주간','weeklyLimitPct',ksStatus.config.weeklyLimitPct],['월간','monthlyLimitPct',ksStatus.config.monthlyLimitPct]] as any[]).map(([lab,key,val]:any)=>(
                              <div key={key}>
                                <div style={{fontSize:9,color:T.muted,marginBottom:3}}>{lab} 한도%</div>
                                <input defaultValue={val} inputMode="decimal" onBlur={e=>{ const v=+e.target.value; if(v>0&&v!==val) ksUpdate({[key]:v}); }}
                                  style={{width:'100%',background:T.alt,border:`1px solid ${T.border}`,borderRadius:6,padding:'7px',color:T.txt,fontSize:12,outline:'none'}}/>
                              </div>
                            ))}
                          </div>
                          {/* 조치 모드 */}
                          <div style={{fontSize:9,color:T.muted,margin:'10px 0 4px'}}>발동 시 조치 (A신규차단 B봇정지 C주문취소 D포지션종료)</div>
                          <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
                            {(['A','B','C','D'] as const).map(a=>{ const on=(ksStatus.config.actionMode||'').includes(a); return (
                              <button key={a} onClick={()=>{ const cur=ksStatus.config.actionMode||''; const next=on?cur.replace(a,''):cur+a; ksUpdate({actionMode: next||'A'}); }}
                                style={{flex:1,minWidth:36,padding:'7px',background:on?T.acg:'transparent',color:on?T.acl:T.muted,border:`1px solid ${on?T.acl:T.border}`,borderRadius:6,fontSize:11,fontWeight:700,cursor:'pointer'}}>{a}{a==='D'?'⚠️':''}</button>
                            );})}
                          </div>
                          {/* 액션 */}
                          <div style={{display:'flex',gap:6,marginTop:12}}>
                            <button onClick={()=>ksUpdate({enabled:!ksStatus.config.enabled})} disabled={ksBusy}
                              style={{flex:1,padding:'9px',background:ksStatus.config.enabled?T.grn+'18':T.alt,color:ksStatus.config.enabled?T.grn:T.muted,border:`1px solid ${ksStatus.config.enabled?T.grn+'40':T.border}`,borderRadius:7,fontSize:10,fontWeight:700,cursor:'pointer'}}>{ksStatus.config.enabled?'ON':'OFF'}</button>
                            <button onClick={ksTrigger} disabled={ksBusy||ksStatus.active}
                              style={{flex:1,padding:'9px',background:T.red+'15',color:T.red,border:`1px solid ${T.red}40`,borderRadius:7,fontSize:10,fontWeight:700,cursor:ksStatus.active?'default':'pointer',opacity:ksStatus.active?0.5:1}}>수동 발동</button>
                            <button onClick={ksReset} disabled={ksBusy}
                              style={{flex:1,padding:'9px',background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:7,fontSize:10,fontWeight:700,cursor:'pointer'}}>기준 리셋</button>
                          </div>
                          {/* 강제 해제 (active 시 "해제합니다" 입력) */}
                          {ksStatus.active&&(
                            <div style={{marginTop:10}}>
                              <div style={{fontSize:9,color:T.red,marginBottom:4}}>발동 상태입니다. 해제하려면 "해제합니다" 입력 후 기준 리셋</div>
                              <input value={ksReleaseText} onChange={e=>setKsReleaseText(e.target.value)} placeholder='해제합니다'
                                style={{width:'100%',background:T.alt,border:`1px solid ${T.red}40`,borderRadius:6,padding:'8px',color:T.txt,fontSize:12,outline:'none'}}/>
                            </div>
                          )}
                        </>
                      ):(
                        <div style={{color:T.muted,fontSize:11,textAlign:'center',padding:'8px 0'}}>리스크 상태 불러오는 중…</div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* 불일치 / 거래차단 경고 배너 */}
              {mismatchActive&&(
                <div style={{background:T.red+'15',border:`1px solid ${T.red}40`,borderRadius:8,padding:'8px 11px',marginBottom:8}}>
                  <div style={{color:T.red,fontSize:11,fontWeight:800}}>⚠️ 포지션 불일치 감지 — 거래소 데이터 우선 적용</div>
                  <div style={{color:T.sub,fontSize:9,marginTop:2}}>신규 주문·Reverse·TP/SL 수정 차단됨 (Close는 허용). 동기화로 일치되면 자동 해제.</div>
                </div>
              )}
              {tradingBlocked&&(
                <div style={{background:T.red+'20',border:`1px solid ${T.red}60`,borderRadius:8,padding:'8px 11px',marginBottom:8}}>
                  <div style={{color:T.red,fontSize:11,fontWeight:800}}>🛑 동기화 5회 연속 실패 — 신규 진입 차단</div>
                  <div style={{color:T.sub,fontSize:9,marginTop:2}}>수동 동기화 성공 시 해제됩니다.</div>
                </div>
              )}
              {syncMsg&&<div style={{color:(syncMsg.includes('실패')||syncMsg.includes('오류')||syncMsg.includes('불일치'))?T.red:T.muted,fontSize:10,marginBottom:8}}>{syncMsg}</div>}
              {realFunding&&(
                <div style={{display:'flex',justifyContent:'space-between',fontSize:10,color:T.muted,padding:'6px 0',borderBottom:`1px solid ${T.border}`,marginBottom:8}}>
                  <span>누적 펀딩비 (최근 200건)</span>
                  <span style={{color:realFunding.total>=0?T.grn:T.red,fontWeight:700,fontFamily:'Inter,monospace'}}>{realFunding.total>=0?'+':''}{realFunding.total.toFixed(4)} USDT {realFunding.total>=0?'(수령)':'(지불)'}</span>
                </div>
              )}
              {/* Ghost 포지션 — 거래소 미존재 (사용자 확인 후 정리) */}
              {ghostPos.map((g,i)=>(
                <div key={'ghost'+i} style={{background:T.red+'10',border:`1px dashed ${T.red}50`,borderRadius:10,padding:'10px 12px',marginBottom:8}}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:8}}>
                    <div>
                      <span style={{background:T.red+'20',color:T.red,fontSize:9,fontWeight:800,padding:'1px 7px',borderRadius:5}}>{g.symbol} 거래소 미존재</span>
                      <div style={{color:T.muted,fontSize:9,marginTop:4}}>TRAIGO에는 있었으나 거래소에서 사라짐 (청산/외부종료 가능). 자동 삭제하지 않음.</div>
                    </div>
                    <button onClick={()=>dismissGhost(g.symbol)}
                      style={{padding:'7px 12px',background:T.alt,color:T.sub,border:`1px solid ${T.border}`,borderRadius:7,fontSize:10,fontWeight:700,cursor:'pointer',whiteSpace:'nowrap'}}>정리</button>
                  </div>
                </div>
              ))}
              {realPos.length===0&&ghostPos.length===0?(
                <div style={{color:T.muted,fontSize:11,textAlign:'center',padding:'12px 0'}}>{syncedAt?'열린 포지션이 없습니다':'동기화 버튼을 눌러 거래소 포지션을 불러오세요'}</div>
              ):realPos.map((p,i)=>{
                const isShort=p.side==='SHORT'||(p.amount||0)<0;
                const fundSym=realFunding?.bySymbol?.[p.symbol];
                return (
                  <div key={i} style={{background:T.alt,borderRadius:10,padding:'11px 13px',marginBottom:i<realPos.length-1?8:0}}>
                    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
                      <span style={{display:'flex',alignItems:'center',gap:5,flexWrap:'wrap'}}>
                        <span style={{background:(isShort?T.red:T.grn)+'20',color:isShort?T.red:T.grn,fontSize:10,fontWeight:800,padding:'2px 8px',borderRadius:5}}>{p.symbol} {isShort?'SHORT':'LONG'} {p.leverage}x</span>
                        {p._discovered&&<span style={{background:T.ylw+'20',color:T.ylw,fontSize:8,fontWeight:800,padding:'1px 6px',borderRadius:4}}>미등록 발견</span>}
                        {p._mismatch&&<span style={{background:T.red+'20',color:T.red,fontSize:8,fontWeight:800,padding:'1px 6px',borderRadius:4}}>{p._mismatch} 불일치</span>}
                      </span>
                      <span style={{color:(p.unrealizedPnl||0)>=0?T.grn:T.red,fontSize:13,fontWeight:900,fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums'}}>{(p.unrealizedPnl||0)>=0?'+':''}{(p.unrealizedPnl||0).toFixed(2)} USDT</span>
                    </div>
                    <div style={{display:'flex',gap:12,flexWrap:'wrap',fontSize:9,color:T.muted,fontFamily:'Inter,monospace',marginBottom:6}}>
                      <span>진입 {p.entryPrice}</span><span>마크 {p.markPrice}</span><span>수량 {Math.abs(p.amount||0)}</span>
                    </div>
                    <div style={{display:'flex',justifyContent:'space-between',fontSize:11,padding:'3px 0'}}>
                      <span style={{color:T.muted}}>청산가 <span style={{color:p.liqSource==='exchange'?T.grn:T.ylw,fontSize:8,fontWeight:700,marginLeft:4,background:(p.liqSource==='exchange'?T.grn:T.ylw)+'18',padding:'1px 5px',borderRadius:4}}>{p.liqSource==='exchange'?'거래소 실제값':'추정'}</span></span>
                      <span style={{color:T.ylw,fontWeight:700,fontFamily:'Inter,monospace'}}>{p.liquidationPrice}</span>
                    </div>
                    {p.mmr!=null&&(
                      <div style={{display:'flex',justifyContent:'space-between',fontSize:11,padding:'3px 0'}}>
                        <span style={{color:T.muted}}>MMR <span style={{color:p.bracketSource==='exchange'?T.grn:T.ylw,fontSize:8,fontWeight:700,marginLeft:4,background:(p.bracketSource==='exchange'?T.grn:T.ylw)+'18',padding:'1px 5px',borderRadius:4}}>{p.bracketSource==='exchange'?'거래소 브래킷':'추정'}</span></span>
                        <span style={{color:T.txt,fontWeight:700,fontFamily:'Inter,monospace'}}>{(p.mmr*100).toFixed(2)}% · 공제 {p.maintAmount}</span>
                      </div>
                    )}
                    {fundSym!=null&&(
                      <div style={{display:'flex',justifyContent:'space-between',fontSize:11,padding:'3px 0'}}>
                        <span style={{color:T.muted}}>펀딩비 ({p.symbol})</span>
                        <span style={{color:fundSym>=0?T.grn:T.red,fontWeight:700,fontFamily:'Inter,monospace'}}>{fundSym>=0?'+':''}{fundSym.toFixed(4)} USDT</span>
                      </div>
                    )}
                    {/* 펀딩 예측 — 다음 펀딩시간 + 예상 펀딩비 */}
                    <div style={{marginTop:6,paddingTop:6,borderTop:`1px solid ${T.border}`}}>
                      {p.nextFundingTime?(
                        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,fontSize:10}}>
                          <div>
                            <div style={{color:T.muted,marginBottom:2}}>다음 펀딩</div>
                            <div style={{color:T.txt,fontWeight:700,fontFamily:'Inter,monospace'}}>{fmtCountdown(p.nextFundingTime-nowTick)} 남음</div>
                          </div>
                          <div>
                            <div style={{color:T.muted,marginBottom:2}}>예상 펀딩비</div>
                            <div style={{fontWeight:700,fontFamily:'Inter,monospace',color:p.fundingSide==='receive'?T.grn:p.fundingSide==='pay'?T.red:T.muted}}>
                              {p.estimatedNextFundingFee!=null?`${p.estimatedNextFundingFee>=0?'+':''}${p.estimatedNextFundingFee.toFixed(4)} ${p.fundingSide==='receive'?'수령':p.fundingSide==='pay'?'지불':'중립'}`:'-'}
                            </div>
                          </div>
                          <div style={{gridColumn:'1 / -1',display:'flex',justifyContent:'space-between',color:T.muted,marginTop:2}}>
                            <span>Funding Rate</span>
                            <span style={{fontFamily:'Inter,monospace',color:T.txt,fontWeight:700}}>{((p.lastFundingRate||0)*100).toFixed(4)}%</span>
                          </div>
                        </div>
                      ):(
                        <div style={{color:T.muted,fontSize:10}}>펀딩 데이터 없음</div>
                      )}
                    </div>
                    {/* 현재 TP/SL 상태 */}
                    {(p.tpPrice||p.slPrice)&&(
                      <div style={{display:'flex',gap:14,fontSize:10,marginTop:4,paddingTop:6,borderTop:`1px solid ${T.border}`,fontFamily:'Inter,monospace'}}>
                        <span style={{color:p.tpPrice?T.grn:T.muted}}>TP {p.tpPrice?p.tpPrice:'미설정'}</span>
                        <span style={{color:p.slPrice?T.red:T.muted}}>SL {p.slPrice?p.slPrice:'미설정'}</span>
                      </div>
                    )}
                    {/* 액션 버튼 — reduce-only 종료 + TP/SL */}
                    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:6,marginTop:8}}>
                      <button onClick={()=>closeReal(p,100)} disabled={!!closeBusy}
                        style={{padding:'9px',background:T.red+'18',color:T.red,border:`1px solid ${T.red}40`,borderRadius:7,fontSize:10,fontWeight:700,cursor:closeBusy?'default':'pointer',opacity:closeBusy&&closeBusy!==`${p.symbol}:100`?0.5:1}}>
                        {closeBusy===`${p.symbol}:100`?'종료 중…':'전량 종료'}</button>
                      <button onClick={()=>closeReal(p,50)} disabled={!!closeBusy}
                        style={{padding:'9px',background:T.ylw+'15',color:T.ylw,border:`1px solid ${T.ylw}40`,borderRadius:7,fontSize:10,fontWeight:700,cursor:closeBusy?'default':'pointer',opacity:closeBusy&&closeBusy!==`${p.symbol}:50`?0.5:1}}>
                        {closeBusy===`${p.symbol}:50`?'종료 중…':'50% 종료'}</button>
                      <button onClick={()=>openTpsl(p)} disabled={!!closeBusy}
                        style={{padding:'9px',background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:7,fontSize:10,fontWeight:700,cursor:'pointer'}}>
                        TP/SL</button>
                    </div>
                  </div>
                );
              })}
            </Card>
          )}

          {/* 토스트 (성공/실패) */}
          {toast&&(
            <div style={{position:'fixed',left:'50%',bottom:24,transform:'translateX(-50%)',zIndex:9999,maxWidth:'90%',
              background:toast.ok?T.grn:T.red,color:'#fff',padding:'11px 18px',borderRadius:10,fontSize:12,fontWeight:700,
              boxShadow:'0 6px 24px rgba(0,0,0,0.4)'}}>
              {toast.ok?'✓ ':'✕ '}{toast.msg}
            </div>
          )}

          {/* LIVE 종료 확인 모달 */}
          {closeConfirm&&(
            <div onClick={()=>setCloseConfirm(null)} style={{position:'fixed',inset:0,zIndex:9998,background:'rgba(0,0,0,0.6)',display:'flex',alignItems:'center',justifyContent:'center',padding:20}}>
              <div onClick={e=>e.stopPropagation()} style={{background:T.card,border:`1px solid ${T.red}50`,borderRadius:16,padding:20,maxWidth:340,width:'100%'}}>
                <div style={{color:T.red,fontSize:15,fontWeight:900,marginBottom:10}}>⚠️ 실계좌 포지션 종료</div>
                <div style={{color:T.sub,fontSize:12,lineHeight:1.6,marginBottom:6}}>실계좌 포지션을 시장가로 종료합니다. 계속할까요?</div>
                <div style={{color:T.muted,fontSize:11,marginBottom:16}}>{closeConfirm.p.symbol} · {(closeConfirm.p.side==='SHORT'||(closeConfirm.p.amount||0)<0)?'SHORT':'LONG'} · {closeConfirm.percent}% (reduce-only 시장가)</div>
                <button onClick={()=>{ const c=closeConfirm; setCloseConfirm(null); execCloseReal(c.p,c.percent); }}
                  style={{width:'100%',padding:'12px',background:T.red,color:'#fff',border:'none',borderRadius:12,fontWeight:800,cursor:'pointer',marginBottom:8}}>시장가로 종료</button>
                <button onClick={()=>setCloseConfirm(null)}
                  style={{width:'100%',padding:'12px',background:T.muted+'20',color:T.muted,border:`1px solid ${T.border}`,borderRadius:12,fontWeight:700,cursor:'pointer'}}>취소</button>
              </div>
            </div>
          )}

          {/* TP/SL 편집 바텀시트 */}
          {tpslModal&&(()=>{
            const p=tpslModal;
            const isLong=!(p.side==='SHORT'||(p.amount||0)<0);
            const cur=p.markPrice||p.entryPrice;
            const preview=calcTpSl(p,tpInput,slInput,tpslMode);
            return (
              <div onClick={()=>setTpslModal(null)} style={{position:'fixed',inset:0,zIndex:9998,background:'rgba(0,0,0,0.6)',display:'flex',alignItems:'flex-end',justifyContent:'center'}}>
                <div onClick={e=>e.stopPropagation()} style={{background:T.card,borderTop:`1px solid ${T.border}`,borderTopLeftRadius:18,borderTopRightRadius:18,padding:'18px 18px 28px',width:'100%',maxWidth:480,maxHeight:'85vh',overflowY:'auto'}}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
                    <span style={{background:(isLong?T.grn:T.red)+'20',color:isLong?T.grn:T.red,fontSize:11,fontWeight:800,padding:'2px 9px',borderRadius:6}}>{p.symbol} {isLong?'LONG':'SHORT'} {p.leverage}x</span>
                    <button onClick={()=>setTpslModal(null)} style={{background:'none',border:'none',color:T.muted,fontSize:20,cursor:'pointer',lineHeight:1}}>✕</button>
                  </div>
                  <div style={{display:'flex',gap:16,fontSize:11,color:T.muted,marginBottom:6,fontFamily:'Inter,monospace'}}>
                    <span>진입 {p.entryPrice}</span><span>현재 {cur}</span>
                  </div>
                  <div style={{fontSize:10,color:T.muted,marginBottom:14}}>현재 설정 — TP {p.tpPrice||'없음'} · SL {p.slPrice||'없음'}</div>
                  <div style={{display:'flex',gap:8,marginBottom:12}}>
                    {(['pct','price'] as const).map(m=>(
                      <button key={m} onClick={()=>setTpslMode(m)} style={{flex:1,padding:'8px',background:tpslMode===m?T.acg:'transparent',color:tpslMode===m?T.acl:T.muted,border:`1px solid ${tpslMode===m?T.acl:T.border}`,borderRadius:8,fontSize:11,fontWeight:700,cursor:'pointer'}}>{m==='pct'?'퍼센트 (%)':'가격 직접'}</button>
                    ))}
                  </div>
                  <div style={{marginBottom:12}}>
                    <div style={{color:T.grn,fontSize:11,fontWeight:700,marginBottom:6}}>익절 (TP){tpslMode==='pct'?' +%':' 가격'}</div>
                    <input value={tpInput} onChange={e=>setTpInput(e.target.value.replace(/[^0-9.]/g,''))} inputMode="decimal" placeholder={tpslMode==='pct'?'예: 5 (+5%)':'예: 95000'}
                      style={{width:'100%',background:T.alt,border:`1px solid ${T.grn}40`,borderRadius:8,padding:'12px',color:T.txt,fontSize:14,outline:'none'}}/>
                    {tpslMode==='pct'&&<div style={{display:'flex',gap:6,marginTop:6}}>{['3','5','10'].map(v=>(
                      <button key={v} onClick={()=>setTpInput(v)} style={{flex:1,padding:'6px',background:T.grn+'15',color:T.grn,border:`1px solid ${T.grn}30`,borderRadius:6,fontSize:10,fontWeight:700,cursor:'pointer'}}>+{v}%</button>
                    ))}</div>}
                    {preview.tpPrice!=null&&<div style={{fontSize:10,color:T.muted,marginTop:5,fontFamily:'Inter,monospace'}}>→ TP 가격 ≈ {Math.round(preview.tpPrice*100)/100}</div>}
                  </div>
                  <div style={{marginBottom:16}}>
                    <div style={{color:T.red,fontSize:11,fontWeight:700,marginBottom:6}}>손절 (SL){tpslMode==='pct'?' -%':' 가격'}</div>
                    <input value={slInput} onChange={e=>setSlInput(e.target.value.replace(/[^0-9.]/g,''))} inputMode="decimal" placeholder={tpslMode==='pct'?'예: 2 (-2%)':'예: 88000'}
                      style={{width:'100%',background:T.alt,border:`1px solid ${T.red}40`,borderRadius:8,padding:'12px',color:T.txt,fontSize:14,outline:'none'}}/>
                    {tpslMode==='pct'&&<div style={{display:'flex',gap:6,marginTop:6}}>{['1','2','5'].map(v=>(
                      <button key={v} onClick={()=>setSlInput(v)} style={{flex:1,padding:'6px',background:T.red+'15',color:T.red,border:`1px solid ${T.red}30`,borderRadius:6,fontSize:10,fontWeight:700,cursor:'pointer'}}>-{v}%</button>
                    ))}</div>}
                    {preview.slPrice!=null&&<div style={{fontSize:10,color:T.muted,marginTop:5,fontFamily:'Inter,monospace'}}>→ SL 가격 ≈ {Math.round(preview.slPrice*100)/100}</div>}
                  </div>
                  <button onClick={()=>onTpslSubmit(p)} disabled={tpslBusy}
                    style={{width:'100%',padding:'13px',background:tpslBusy?T.alt:T.acl,color:tpslBusy?T.muted:'#fff',border:'none',borderRadius:12,fontWeight:800,fontSize:14,cursor:tpslBusy?'default':'pointer'}}>
                    {tpslBusy?'등록 중…':'TP/SL 등록'}</button>
                  <div style={{fontSize:9,color:T.muted,marginTop:8,textAlign:'center'}}>기존 TP/SL 주문은 취소 후 새로 등록됩니다 (replace · MARK_PRICE 기준)</div>
                </div>
              </div>
            );
          })()}

          {/* LIVE TP/SL 확인 모달 */}
          {tpslConfirm&&(
            <div onClick={()=>setTpslConfirm(null)} style={{position:'fixed',inset:0,zIndex:9999,background:'rgba(0,0,0,0.6)',display:'flex',alignItems:'center',justifyContent:'center',padding:20}}>
              <div onClick={e=>e.stopPropagation()} style={{background:T.card,border:`1px solid ${T.acl}50`,borderRadius:16,padding:20,maxWidth:340,width:'100%'}}>
                <div style={{color:T.acl,fontSize:15,fontWeight:900,marginBottom:10}}>실계좌 TP/SL 등록</div>
                <div style={{color:T.sub,fontSize:12,lineHeight:1.6,marginBottom:6}}>실계좌 TP/SL 주문을 등록합니다. 계속할까요?</div>
                <div style={{color:T.muted,fontSize:11,marginBottom:16,fontFamily:'Inter,monospace'}}>
                  {tpslConfirm.p.symbol}
                  {tpslConfirm.tpPrice!=null?` · TP ${Math.round(tpslConfirm.tpPrice*100)/100}`:''}
                  {tpslConfirm.slPrice!=null?` · SL ${Math.round(tpslConfirm.slPrice*100)/100}`:''}
                </div>
                <button onClick={()=>{ const c=tpslConfirm; setTpslConfirm(null); submitTpsl(c.p,c.tpPrice,c.slPrice); }}
                  style={{width:'100%',padding:'12px',background:T.acl,color:'#fff',border:'none',borderRadius:12,fontWeight:800,cursor:'pointer',marginBottom:8}}>등록</button>
                <button onClick={()=>setTpslConfirm(null)}
                  style={{width:'100%',padding:'12px',background:T.muted+'20',color:T.muted,border:`1px solid ${T.border}`,borderRadius:12,fontWeight:700,cursor:'pointer'}}>취소</button>
              </div>
            </div>
          )}

          {/* 모의 포지션 (paper store) */}
          {positions.length>0&&(
            <Card style={{padding:'14px 16px',marginBottom:12,borderLeft:`3px solid ${T.prp}`}}>
              <div style={{color:T.txt,fontWeight:800,fontSize:13,marginBottom:10,display:'flex',alignItems:'center',gap:6}}>모의 포지션 ({positions.length})<span style={{background:T.prp+'20',color:T.prp,fontSize:9,fontWeight:800,padding:'1px 7px',borderRadius:5}}>MOCK</span></div>
              {positions.map((p,i)=>{
                const cur = prices.find(a=>a.id===p.asset)?.p || p.avgPrice;
                const isShort = p.side === 'short';
                const pnl = (cur - p.avgPrice) * p.qty * (isShort ? -1 : 1);
                const pnlPct = p.avgPrice>0 ? ((cur-p.avgPrice)/p.avgPrice)*100*(isShort?-1:1) : 0;
                return (
                  <div key={i} style={{background:T.alt,borderRadius:10,padding:'11px 13px',marginBottom:i<positions.length-1?8:0}}>
                    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
                      <span style={{background:(isShort?T.red:T.grn)+'20',color:isShort?T.red:T.grn,fontSize:10,fontWeight:800,padding:'2px 8px',borderRadius:5}}>{p.asset} {isShort?'SHORT':'LONG'}</span>
                      <span style={{color:pnl>=0?T.grn:T.red,fontSize:13,fontWeight:900,fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums'}}>{pnl>=0?'+':''}{fmt(Math.round(pnl))}원 ({fmtPct(pnlPct)})</span>
                    </div>
                    <div style={{display:'flex',gap:12,flexWrap:'wrap',fontSize:9,color:T.muted,fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums',marginBottom:8}}>
                      <span>진입 ₩{fmt(Math.round(p.avgPrice))}</span>
                      <span>현재 ₩{fmt(Math.round(cur))}</span>
                      <span>수량 {p.qty.toFixed(4)}</span>
                      {p.slPrice&&<span style={{color:T.red}}>SL ₩{fmt(Math.round(p.slPrice))}</span>}
                      {p.tpPrice&&<span style={{color:T.grn}}>TP ₩{fmt(Math.round(p.tpPrice))}</span>}
                    </div>
                    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6}}>
                      {quickActions.includes('close_all')&&<button onClick={()=>closePosition(p,cur,1)}
                        style={{padding:'9px',background:T.red+'18',color:T.red,border:`1px solid ${T.red}40`,borderRadius:7,fontSize:10,fontWeight:700,cursor:'pointer'}}>전량 종료</button>}
                      {quickActions.includes('close_50')&&<button onClick={()=>closePosition(p,cur,0.5)}
                        style={{padding:'9px',background:T.ylw+'15',color:T.ylw,border:`1px solid ${T.ylw}40`,borderRadius:7,fontSize:10,fontWeight:700,cursor:'pointer'}}>50% 종료</button>}
                      {quickActions.includes('close_25')&&<button onClick={()=>closePosition(p,cur,0.25)}
                        style={{padding:'9px',background:T.alt,color:T.sub,border:`1px solid ${T.border}`,borderRadius:7,fontSize:10,fontWeight:700,cursor:'pointer'}}>25% 종료</button>}
                      {quickActions.includes('add')&&<button onClick={()=>{
                        const addAmt = amount ? +amount : 100000;
                        const rc = canOpenNewPosition();
                        if(!rc.allowed){ alert(`추가 진입 차단: ${rc.reason}`); return; }
                        paperBuy(p.asset, cur, addAmt, { stratId:'manual', side: p.side==='short'?'short':'long' });
                        refreshPositions();
                        alert(`추가 진입 완료!\n${p.asset} ${p.side==='short'?'숏':'롱'}\n+₩${fmt(addAmt)} (평단가 재계산됨)`);
                      }} style={{padding:'9px',background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:7,fontSize:10,fontWeight:700,cursor:'pointer'}}>추가 진입</button>}
                    </div>
                    {(quickActions.includes('reverse')||quickActions.includes('tpsl'))&&<div style={{display:'flex',gap:6,marginTop:6}}>
                      {quickActions.includes('reverse')&&<button onClick={async()=>{
                        // testnet/live: 거래소에 청산(reduce-only) + 반대방향 신규 주문
                        if((tradeMode==='testnet'||tradeMode==='live')&&connId){
                          try {
                            const tradeSymbol = p.asset.toUpperCase().replace(/USDT$/,'')+'USDT';
                            const qty = Number(p.qty.toFixed(3));
                            const isShort = p.side==='short';
                            // 1) 기존 청산 (반대방향 reduce-only)
                            await fetch('/api/binance/futures/order',{method:'POST',headers:{'Content-Type':'application/json',...(authHeaderRef.current?{Authorization:authHeaderRef.current}:{})},
                              body:JSON.stringify({connectionId:connId,symbol:tradeSymbol,side:isShort?'BUY':'SELL',type:'MARKET',quantity:qty,leverage,reduceOnly:true,confirmToken:'LIVE_ORDER_CONFIRMED'})});
                            // 2) 반대방향 신규 진입
                            const r2 = await fetch('/api/binance/futures/order',{method:'POST',headers:{'Content-Type':'application/json',...(authHeaderRef.current?{Authorization:authHeaderRef.current}:{})},
                              body:JSON.stringify({connectionId:connId,symbol:tradeSymbol,side:isShort?'BUY':'SELL',type:'MARKET',quantity:qty,leverage,confirmToken:'LIVE_ORDER_CONFIRMED'})});
                            const d2=await r2.json();
                            if(!r2.ok||d2.error){ alert(`거래소 리버스 실패:\n${d2.message||d2.error}`); return; }
                          } catch(e:any){ alert(`거래소 리버스 오류: ${e?.message||''}`); return; }
                        }
                        const res = reversePaperPosition(p.asset, cur);
                        refreshPositions();
                        if(res.ok){
                          alert(`리버스 완료!\n실현손익 ${Math.round(res.pnl).toLocaleString('ko-KR')}원\n→ ${res.newSide==='long'?'롱':'숏'} 포지션으로 전환`);
                        } else { alert('리버스 실패: 포지션 없음'); }
                      }} style={{flex:1,padding:'9px',background:T.prp+'18',color:T.prp,border:`1px solid ${T.prp}40`,borderRadius:7,fontSize:10,fontWeight:700,cursor:'pointer'}}>리버스</button>}
                      {quickActions.includes('tpsl')&&<button onClick={()=>{ setSlEditAsset(p.asset); setSlEditVal(p.slPrice?String(Math.round(p.slPrice)):''); setTpEditVal(p.tpPrice?String(Math.round(p.tpPrice)):''); }}
                        style={{flex:1,padding:'9px',background:T.alt,color:T.acl,border:`1px solid ${T.border}`,borderRadius:7,fontSize:10,fontWeight:700,cursor:'pointer'}}>TP/SL 편집</button>}
                    </div>}
                    {slEditAsset===p.asset&&(()=>{
                      const isShort=p.side==='short';
                      const lev=leverage||5;
                      // 가격↔ROI 변환 (ROI = 가격변동% × 레버리지)
                      const priceToRoi=(price:number)=>{ const chg=((price-p.avgPrice)/p.avgPrice)*100*(isShort?-1:1); return chg*lev; };
                      const roiToPrice=(roi:number)=>{ const chg=roi/lev; return p.avgPrice*(1+(chg/100)*(isShort?-1:1)); };
                      const tpPrice=tpEditVal?+tpEditVal:(tpRoi?roiToPrice(+tpRoi):0);
                      const slPrice=slEditVal?+slEditVal:(slRoi?roiToPrice(-Math.abs(+slRoi)):0);
                      return (
                      <div style={{marginTop:8,padding:'14px',background:T.bg,borderRadius:10,border:`1px solid ${T.border}`}}>
                        {/* 탭 */}
                        <div style={{display:'flex',gap:14,marginBottom:12,borderBottom:`1px solid ${T.border}`,paddingBottom:8}}>
                          {([['entire','전체'],['partial','부분'],['trailing','트레일링']] as [any,string][]).map(([v,l])=>(
                            <button key={v} onClick={()=>setTpslTab(v)} style={{background:'none',border:'none',color:tpslTab===v?T.txt:T.muted,fontSize:12,fontWeight:tpslTab===v?800:600,cursor:'pointer',padding:0,borderBottom:tpslTab===v?`2px solid ${T.acl}`:'none',paddingBottom:4}}>{l}</button>
                          ))}
                        </div>
                        {/* 정보 */}
                        <div style={{marginBottom:12}}>
                          {[['현재가',cur],['진입가',p.avgPrice],['청산가', isShort? p.avgPrice*(1+(0.9/lev)) : p.avgPrice*(1-(0.9/lev)) ]].map(([l,v]:any,i)=>(
                            <div key={i} style={{display:'flex',justifyContent:'space-between',padding:'3px 0',fontSize:11}}>
                              <span style={{color:T.muted}}>{l}{l==='청산가'&&<span style={{color:T.ylw,fontSize:8,fontWeight:700,marginLeft:5,background:T.ylw+'18',padding:'1px 5px',borderRadius:4}}>추정</span>}</span>
                              <span style={{color:l==='청산가'?T.ylw:T.txt,fontWeight:700,fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums'}}>₩{fmt(Math.round(v))}</span>
                            </div>
                          ))}
                          <div style={{fontSize:9,color:T.muted,marginTop:4,lineHeight:1.4}}>청산가는 근사식 추정값입니다. 실거래(테스트넷/실전)는 거래소 계단식 유지증거금(MMR)을 적용한 정확값이 사용됩니다.</div>
                        </div>

                        {tpslTab==='trailing'?(
                          <div style={{marginBottom:12}}>
                            <div style={{color:T.acl,fontSize:10,fontWeight:700,marginBottom:4}}>트레일링 스탑 (고점 대비 하락 %)</div>
                            <input value={trailPct} onChange={e=>setTrailPct(e.target.value.replace(/[^0-9.]/g,''))} placeholder="예: 5 (고점 -5% 도달 시 청산)" inputMode="decimal"
                              style={{width:'100%',background:T.alt,border:`1px solid ${T.prp}40`,borderRadius:8,padding:'11px',color:T.txt,fontSize:13,outline:'none'}}/>
                            <div style={{color:T.muted,fontSize:9,marginTop:6,lineHeight:1.4}}>가격이 오를수록 청산선도 따라 올라갑니다. 고점에서 설정%만큼 떨어지면 자동 청산.</div>
                          </div>
                        ):(
                          <>
                            {/* TP */}
                            <div style={{marginBottom:10}}>
                              <div style={{color:T.grn,fontSize:10,fontWeight:700,marginBottom:4}}>익절 (TP)</div>
                              <div style={{display:'flex',gap:6}}>
                                <div style={{flex:1,minWidth:0,display:'flex',alignItems:'center',background:T.alt,border:`1px solid ${T.grn}40`,borderRadius:7,padding:'0 10px'}}>
                                  <input value={tpEditVal} onChange={e=>{setTpEditVal(e.target.value.replace(/[^0-9.]/g,''));setTpRoi('');}} placeholder="목표 가격" inputMode="decimal"
                                    style={{flex:1,minWidth:0,width:'100%',background:'transparent',border:'none',outline:'none',color:T.txt,fontSize:12,padding:'9px 0'}}/>
                                  <span style={{color:T.muted,fontSize:10}}>₩</span>
                                </div>
                                <div style={{flex:1,minWidth:0,display:'flex',alignItems:'center',background:T.alt,border:`1px solid ${T.grn}40`,borderRadius:7,padding:'0 10px'}}>
                                  <input value={tpRoi} onChange={e=>{setTpRoi(e.target.value.replace(/[^0-9.]/g,''));setTpEditVal('');}} placeholder="수익률 ROI" inputMode="decimal"
                                    style={{flex:1,minWidth:0,width:'100%',background:'transparent',border:'none',outline:'none',color:T.txt,fontSize:12,padding:'9px 0'}}/>
                                  <span style={{color:T.muted,fontSize:10}}>%</span>
                                </div>
                              </div>
                              {(tpPrice>0)&&<div style={{color:T.muted,fontSize:9,marginTop:4,fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums'}}>→ 익절가 ₩{fmt(Math.round(tpPrice))} (ROI {priceToRoi(tpPrice).toFixed(1)}%)</div>}
                            </div>
                            {/* SL */}
                            <div style={{marginBottom:12}}>
                              <div style={{color:T.red,fontSize:10,fontWeight:700,marginBottom:4}}>손절 (SL)</div>
                              <div style={{display:'flex',gap:6}}>
                                <div style={{flex:1,minWidth:0,display:'flex',alignItems:'center',background:T.alt,border:`1px solid ${T.red}40`,borderRadius:7,padding:'0 10px'}}>
                                  <input value={slEditVal} onChange={e=>{setSlEditVal(e.target.value.replace(/[^0-9.]/g,''));setSlRoi('');}} placeholder="손절 가격" inputMode="decimal"
                                    style={{flex:1,minWidth:0,width:'100%',background:'transparent',border:'none',outline:'none',color:T.txt,fontSize:12,padding:'9px 0'}}/>
                                  <span style={{color:T.muted,fontSize:10}}>₩</span>
                                </div>
                                <div style={{flex:1,minWidth:0,display:'flex',alignItems:'center',background:T.alt,border:`1px solid ${T.red}40`,borderRadius:7,padding:'0 10px'}}>
                                  <input value={slRoi} onChange={e=>{setSlRoi(e.target.value.replace(/[^0-9.]/g,''));setSlEditVal('');}} placeholder="손실률" inputMode="decimal"
                                    style={{flex:1,minWidth:0,width:'100%',background:'transparent',border:'none',outline:'none',color:T.txt,fontSize:12,padding:'9px 0'}}/>
                                  <span style={{color:T.muted,fontSize:10}}>%</span>
                                </div>
                              </div>
                              {(slPrice>0)&&<div style={{color:T.muted,fontSize:9,marginTop:4,fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums'}}>→ 손절가 ₩{fmt(Math.round(slPrice))} (ROI {priceToRoi(slPrice).toFixed(1)}%)</div>}
                            </div>
                            {tpslTab==='partial'&&(
                              <div style={{marginBottom:12}}>
                                <div style={{color:T.muted,fontSize:10,marginBottom:6}}>청산 비율: {tpslRatio}%</div>
                                <div style={{display:'flex',gap:5}}>
                                  {[25,50,75,100].map(r=>(
                                    <button key={r} onClick={()=>setTpslRatio(r)} style={{flex:1,padding:'6px',background:tpslRatio===r?T.acg:T.alt,color:tpslRatio===r?T.acl:T.muted,border:`1px solid ${tpslRatio===r?T.acl:T.border}`,borderRadius:6,fontSize:10,fontWeight:700,cursor:'pointer'}}>{r}%</button>
                                  ))}
                                </div>
                              </div>
                            )}
                          </>
                        )}

                        <div style={{display:'flex',gap:6}}>
                          <button onClick={()=>{
                            try { const b=loadPaperBalance(); if(b.positions[p.asset]){
                              if(tpslTab==='trailing'){
                                b.positions[p.asset]={...b.positions[p.asset], slPrice: trailPct? cur*(1-(+trailPct)/100):undefined};
                              } else {
                                b.positions[p.asset]={...b.positions[p.asset], tpPrice:tpPrice>0?tpPrice:undefined, slPrice:slPrice>0?slPrice:undefined};
                              }
                              try{localStorage.setItem('tg_paper_balance_v1',JSON.stringify(b));}catch{} } refreshPositions(); } catch {}
                            setSlEditAsset('');setTpEditVal('');setSlEditVal('');setTpRoi('');setSlRoi('');setTrailPct('');
                            alert('TP/SL 설정 완료');
                          }} style={{flex:1,padding:'12px',background:T.acc,color:'#fff',border:'none',borderRadius:8,fontSize:13,fontWeight:800,cursor:'pointer'}}>확인</button>
                          <button onClick={()=>{setSlEditAsset('');setTpEditVal('');setSlEditVal('');setTpRoi('');setSlRoi('');setTrailPct('');}} style={{flex:1,padding:'12px',background:T.alt,color:T.muted,border:`1px solid ${T.border}`,borderRadius:8,fontSize:13,fontWeight:700,cursor:'pointer'}}>취소</button>
                        </div>
                      </div>
                      );
                    })()}
                  </div>
                );
              })}
            </Card>
          )}

          {/* Order history */}
          {orders.length>0&&(
            <Card style={{padding:'14px 16px'}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
                <div style={{color:T.txt,fontWeight:700,fontSize:13}}>매매 기록 ({orders.length}건)</div>
                <button onClick={()=>setShowOrders(v=>!v)} style={{background:'transparent',color:T.muted,border:`1px solid ${T.border}`,borderRadius:8,padding:'3px 8px',fontSize:11,cursor:'pointer'}}>{showOrders?'접기':'펼치기'}</button>
              </div>
              {showOrders&&orders.slice(0,5).map((o,i)=>(
                <div key={o.id} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'8px 0',borderBottom:i<Math.min(4,orders.length-1)?`1px solid ${T.border}`:'none'}}>
                  <div>
                    <div style={{color:T.txt,fontSize:12,fontWeight:600}}>{o.nameKr} {o.side==='buy'?'매수':'매도'} {o.leverage}x</div>
                    <div style={{color:T.muted,fontSize:10}}>{new Date(o.openedAt).toLocaleString('ko-KR')}</div>
                  </div>
                  <div style={{textAlign:'right'}}>
                    <div style={{color:o.pnl>=0?T.grn:T.red,fontSize:11,fontWeight:700}}>{o.pnl>=0?'+':''}{fmt(o.pnl)}원</div>
                    <div style={{color:T.muted,fontSize:10}}>₩{fmt(o.amount)}</div>
                  </div>
                </div>
              ))}
            </Card>
          )}
        </>
      )}

      {/* Confirm modal */}
      {showConfirm&&(
        <>
          <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.75)',zIndex:200,touchAction:'none'}} onClick={()=>setShowConfirm(false)}/>
          <div style={{position:'fixed',inset:'auto 0 0',zIndex:201,background:T.surf,borderRadius:'20px 20px 0 0',padding:'24px 20px calc(40px + env(safe-area-inset-bottom, 0px))',maxWidth:480,margin:'0 auto',border:`1px solid ${T.border}`}} onClick={e=>e.stopPropagation()}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
              <span style={{color:T.txt,fontWeight:900,fontSize:18}}>주문 확인</span>
              <button onClick={()=>setShowConfirm(false)} style={{background:'none',border:'none',color:T.muted,fontSize:22,cursor:'pointer',lineHeight:1}}>✕</button>
            </div>
            <div style={{color:T.txt,fontWeight:700,fontSize:14,marginBottom:14}}>
              {sel.nameKr} · {marginMode==='cross'?'교차':'격리'} · {leverage}x · <span style={{color:side==='매수'?T.grn:T.red}}>{side==='매수'?'매수/롱':'매도/숏'}</span>
            </div>
            {(()=>{
              const krwPx=sel.p||0; const usdtPx=krwPx/1375;
              const notional=(+amount/1375); const qty=krwPx>0?(+amount/krwPx):0;
              const margin=notional; const liqPct=100/leverage*0.9;
              const liqPrice=side==='매수'?krwPx*(1-liqPct/100):krwPx*(1+liqPct/100);
              const symbol=(sel.sym||sel.id).toUpperCase().replace(/USDT$/,'');
              return [
                {l:'가격',v:'시장가 (Best Price)'},
                {l:'수량',v:`${qty.toFixed(qty<1?5:3)} ${symbol}`},
                {l:'주문 금액',v:`₩${fmt(+amount)} (${notional.toFixed(0)} USDT)`},
                {l:'증거금',v:`${margin.toFixed(1)} USDT`},
                {l:'예상 청산가',v:`₩${fmt(Math.round(liqPrice))}`,c:T.ylw},
                {l:'레버리지',v:`${leverage}x`},
              ].map((r:any,i)=>(
                <div key={i} style={{display:'flex',justifyContent:'space-between',padding:'10px 0',borderBottom:`1px solid ${T.border}`}}>
                  <span style={{color:T.muted,fontSize:13}}>{r.l}</span>
                  <span style={{color:r.c||T.txt,fontWeight:700,fontSize:13}}>{r.v}</span>
                </div>
              ));
            })()}
            <div style={{marginTop:12,color:T.muted,fontSize:11,lineHeight:1.5}}>
              {tradeMode==='mock'?'모의매매 — 실제 자금이 사용되지 않습니다.':tradeMode==='testnet'?'테스트넷 — 거래소 테스트 서버에 실제 주문이 전송됩니다.':'⚠️ 실전 — 실제 자금으로 주문이 실행됩니다.'}
            </div>
            {leverage>10&&<div style={{marginTop:8,background:T.red+'15',border:`1px solid ${T.red}30`,borderRadius:8,padding:'8px 12px',color:T.red,fontSize:11}}>⚠️ {leverage}배는 원금 손실 위험이 매우 높습니다</div>}
            <div style={{display:'flex',gap:10,marginTop:16}}>
              <button onClick={()=>setShowConfirm(false)} style={{flex:1,padding:'14px',background:'transparent',color:T.muted,border:`1px solid ${T.border}`,borderRadius:12,fontWeight:700,cursor:'pointer'}}>취소</button>
              <button onClick={()=>confirmOrder(sideRef.current)} style={{flex:2,padding:'15px',minHeight:48,background:side==='매수'?T.grn:T.red,color:'#fff',border:'none',borderRadius:12,fontWeight:800,fontSize:15,cursor:'pointer'}}>
                {side==='매수'?'매수 확인':'매도 확인'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
/* ── AutoPage (모듈형 자동매매 엔진) ── */

/* ─── Types ─── */
type StratType='ema_cross'|'rsi_reversal'|'macd_trend'|'breakout'|'scalping'|'swing'|'dca'|'buy_dip'|'funding_rate'|'ai_strategy';
type StratStatus='running'|'paused'|'stopped'|'error';
type SignalState='waiting'|'confirmed'|'rejected'|'executed'|'expired';
type ExecMode='paper'|'simulated'|'testnet'|'real';
type OrderStatus='pending'|'processing'|'completed'|'failed'|'canceled';

interface Strategy {
  id:string; name:string; type:StratType; status:StratStatus;
  asset:string; assetNameKr:string; timeframe:string;
  leverage:number; maxLeverage:number; riskLevel:'low'|'medium'|'high';
  tp:number; sl:number; enabled:boolean;
  winRate:number; totalPnl:number; trades:number;
  maxDailyLoss:number; maxPositionSize:number; cooldownMin:number;
  params:Record<string,number|string|boolean>; description:string;
}

interface Signal {
  id:string; stratId:string; stratName:string; asset:string;
  type:'buy'|'sell'; price:number; state:SignalState;
  confidence:number; source:'indicator'|'webhook'|'ai'|'manual';
  createdAt:string; note:string;
}

interface BotRun {
  id:string; stratId:string; stratName:string; asset:string;
  side:'long'|'short'; entryPrice:number; exitPrice?:number;
  qty:number; pnl:number; pnlPct:number; status:OrderStatus;
  execMode:ExecMode; openedAt:string; closedAt?:string;
}

interface RiskEvent {
  id:string; type:'daily_loss'|'drawdown'|'leverage'|'consecutive_loss'|'emergency';
  message:string; severity:'info'|'warning'|'critical'; timestamp:string;
}

/* ─── Strategy definitions ─── */


// ═════════════════════════════════════════════════════════════
// 새 탭 컴포넌트들 (AI / 기술 / 뉴스)
// ═════════════════════════════════════════════════════════════
import { Sparkles, TrendingUp, TrendingDown, Activity, AlertCircle,
         Newspaper, Gauge, ChevronRight, BarChart3 } from 'lucide-react';

// ─── 1) AI 분석 탭 ────────────────────────────────────────────
interface AnalysisResp {
  asset: string;
  snapshot: any;
  diagnosis: {
    trend: 'bullish'|'bearish'|'neutral';
    momentum: 'strong'|'moderate'|'weak';
    volatility: 'high'|'medium'|'low';
    signals: string[];
    buySignals: number;
    sellSignals: number;
    score: number;
  };
  aiComment: string;
  aiSource: string;
}

function getAssetMarket(a: any): string {
  const t = a?.t || a?.type || '';
  if (t === 'crypto' || t === 'futures') return 'crypto';
  if (t === 'krstock')                    return 'stock';
  if (t === 'stock' || t === 'etf')       return 'stock';
  return 'crypto';
}

function AIAnalysisTab({ asset, onTradeBuy, onTradeSell }: {
  asset: any; onTradeBuy: () => void; onTradeSell: () => void;
}) {
  const [data, setData] = useState<AnalysisResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch('/api/asset-analysis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          asset:     asset?.sym || asset?.id,
          market:    getAssetMarket(asset),
          timeframe: '1h',
        }),
        signal: AbortSignal.timeout(25000),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        setError(d.message || `status_${r.status}`);
        setLoading(false);
        return;
      }
      const d = await r.json();
      setData(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'unknown');
    } finally {
      setLoading(false);
    }
  }, [asset?.sym, asset?.id]);

  useEffect(() => { load(); }, [load]);

  const trendColor = data?.diagnosis.trend === 'bullish' ? T.grn
                  : data?.diagnosis.trend === 'bearish' ? T.red
                  : T.muted;

  if (loading) {
    return (
      <Card style={{padding:'16px',marginBottom:12}}>
        <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:12}}>
          <Sparkles size={14} strokeWidth={2.2} color={T.acl}/>
          <span style={{color:T.acl,fontSize:13,fontWeight:700}}>AI 분석 중...</span>
        </div>
        {['가격 데이터 불러오는 중','지표 계산 중 (RSI·MACD·EMA)','AI 진단 생성 중'].map((s,i)=>(
          <div key={i} style={{display:'flex',alignItems:'center',gap:8,marginBottom:8}}>
            <div style={{width:6,height:6,borderRadius:'50%',background:T.acl,opacity:1-i*0.25,animation:'pulse 1.2s infinite'}}/>
            <span style={{color:T.muted,fontSize:11}}>{s}</span>
          </div>
        ))}
        <div style={{background:T.alt,height:60,borderRadius:8,marginTop:6,opacity:0.4}}/>
      </Card>
    );
  }

  if (error || !data) {
    // 원인별 안내
    const isUnsupported = /지원|symbol|not.*found|404|unsupported/i.test(error || '');
    const isTimeout = /timeout|시간|abort/i.test(error || '');
    const isData = /가격|price|데이터|data|fetch/i.test(error || '');
    return (
      <Card style={{padding:'18px 16px',marginBottom:12}}>
        <div style={{display:'flex',alignItems:'center',gap:7,marginBottom:10}}>
          <Sparkles size={15} strokeWidth={2.2} color={T.ylw}/>
          <span style={{color:T.txt,fontWeight:800,fontSize:13}}>AI 분석을 불러올 수 없습니다</span>
        </div>
        <div style={{background:T.alt,borderRadius:10,padding:'11px 13px',marginBottom:12}}>
          <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:6}}>가능한 원인</div>
          {[
            { hit: isData, t: '가격 데이터 응답 실패 (거래소 일시 오류)' },
            { hit: isUnsupported, t: '지원하지 않는 종목 (Binance USDT 페어만 분석 가능)' },
            { hit: isTimeout, t: '응답 시간 초과 (네트워크 지연)' },
            { hit: !isData && !isUnsupported && !isTimeout, t: error || '알 수 없는 오류' },
          ].filter(x=>x.hit).map((x,i)=>(
            <div key={i} style={{color:T.sub,fontSize:11,lineHeight:1.6,display:'flex',gap:6}}>
              <span style={{color:T.red}}>•</span> {x.t}
            </div>
          ))}
        </div>
        <div style={{display:'flex',gap:8}}>
          <button onClick={load} style={{flex:1,background:T.acc,color:'#fff',border:'none',borderRadius:9,padding:'11px',fontSize:12,fontWeight:700,cursor:'pointer'}}>다시 시도</button>
          <button onClick={onTradeBuy} style={{flex:1,background:T.alt,color:T.sub,border:`1px solid ${T.border}`,borderRadius:9,padding:'11px',fontSize:12,fontWeight:700,cursor:'pointer'}}>매매 화면으로</button>
        </div>
        <div style={{marginTop:10,color:T.muted,fontSize:10,lineHeight:1.5}}>
          AI 분석은 주요 암호화폐(BTC·ETH 등 Binance USDT 페어)를 지원합니다. 주식·기타 종목은 차트·기술 분석 탭을 이용하세요.
        </div>
      </Card>
    );
  }

  const d = data.diagnosis;
  return (
    <div style={{marginBottom:12}}>
      {/* AI 코멘트 카드 */}
      <Card style={{padding:'14px 16px',marginBottom:10,borderLeft:`3px solid ${trendColor}`}}>
        <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:8}}>
          <Sparkles size={14} strokeWidth={2.2} color={T.prp}/>
          <span style={{color:T.txt,fontWeight:800,fontSize:13}}>AI 종합 분석</span>
          <span style={{marginLeft:'auto',padding:'2px 7px',background:trendColor+'22',color:trendColor,fontSize:9,fontWeight:800,borderRadius:4}}>
            {d.trend === 'bullish' ? '강세' : d.trend === 'bearish' ? '약세' : '중립'} · 모멘텀 {d.momentum === 'strong' ? '강함' : d.momentum === 'moderate' ? '보통' : '약함'}
          </span>
        </div>
        <div style={{color:T.txt,fontSize:12,lineHeight:1.7,marginBottom:8}}>{data.aiComment}</div>
        <div style={{display:'flex',gap:5,fontSize:9,color:T.muted}}>
          <span>소스: {data.aiSource === 'openai' ? 'OpenAI' : '내장 분석'}</span>
          <span>·</span>
          <span>매수 {d.buySignals} / 매도 {d.sellSignals}</span>
          <span>·</span>
          <span>변동성 {d.volatility === 'high' ? '높음' : d.volatility === 'medium' ? '보통' : '낮음'}</span>
        </div>
      </Card>

      {/* 점수 게이지 */}
      <Card style={{padding:'12px 14px',marginBottom:10}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',marginBottom:5}}>
          <span style={{color:T.muted,fontSize:10,fontWeight:700,display:'inline-flex',alignItems:'center',gap:4}}>
            <Gauge size={10} strokeWidth={2.4}/>매수·매도 점수
          </span>
          <span style={{color:trendColor,fontWeight:900,fontSize:14}}>
            {d.score >= 0 ? '+' : ''}{d.score}
          </span>
        </div>
        <div style={{height:8,background:T.alt,borderRadius:4,overflow:'hidden',position:'relative'}}>
          {/* 중앙선 */}
          <div style={{position:'absolute',top:0,bottom:0,left:'50%',width:1,background:T.muted,zIndex:1}}/>
          {/* 막대 */}
          <div style={{
            position:'absolute',
            top:0, bottom:0,
            left: d.score >= 0 ? '50%' : `${50 + d.score/2}%`,
            width: `${Math.abs(d.score) / 2}%`,
            background: trendColor,
            transition: 'width 300ms',
          }}/>
        </div>
        <div style={{display:'flex',justifyContent:'space-between',marginTop:4,fontSize:9,color:T.muted}}>
          <span>-100 매도</span>
          <span>0 중립</span>
          <span>+100 매수</span>
        </div>
      </Card>

      {/* 시그널 리스트 */}
      <Card style={{padding:'12px 14px',marginBottom:10}}>
        <div style={{color:T.txt,fontWeight:800,fontSize:12,marginBottom:8}}>주요 시그널</div>
        {d.signals.length === 0 ? (
          <div style={{color:T.muted,fontSize:11}}>특별한 시그널이 감지되지 않습니다</div>
        ) : (
          d.signals.map((s, i) => (
            <div key={i} style={{
              display:'flex',alignItems:'flex-start',gap:6,
              padding:'7px 10px',background:T.alt,borderRadius:6,marginBottom:5,
              borderLeft: `2px solid ${
                s.includes('매수') || s.includes('정배열') || s.includes('상승') ? T.grn :
                s.includes('매도') || s.includes('역배열') || s.includes('하락') ? T.red :
                T.acl
              }`,
            }}>
              <span style={{color:T.sub,fontSize:11,lineHeight:1.5}}>{s}</span>
            </div>
          ))
        )}
      </Card>

      {/* 매매 버튼 */}
      <div style={{display:'flex',gap:8}}>
        <button type="button" onClick={onTradeBuy}
          style={{flex:1,padding:'12px',background:T.grn,color:'#fff',border:'none',borderRadius:10,fontWeight:800,fontSize:13,cursor:'pointer',minHeight:46,display:'flex',alignItems:'center',justifyContent:'center',gap:5}}>
          <TrendingUp size={14} strokeWidth={2.4}/>매수
        </button>
        <button type="button" onClick={onTradeSell}
          style={{flex:1,padding:'12px',background:T.red,color:'#fff',border:'none',borderRadius:10,fontWeight:800,fontSize:13,cursor:'pointer',minHeight:46,display:'flex',alignItems:'center',justifyContent:'center',gap:5}}>
          <TrendingDown size={14} strokeWidth={2.4}/>매도
        </button>
      </div>
    </div>
  );
}

// ─── 2) 기술 분석 탭 ─────────────────────────────────────────
function TechAnalysisTab({ asset }: { asset: any }) {
  const [data, setData] = useState<AnalysisResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tf, setTf] = useState<'15m'|'1h'|'4h'|'1d'>('1h');

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch('/api/asset-analysis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          asset:     asset?.sym || asset?.id,
          market:    getAssetMarket(asset),
          timeframe: tf,
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        setError(d.message || `status_${r.status}`);
        setLoading(false);
        return;
      }
      setData(await r.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'unknown');
    } finally {
      setLoading(false);
    }
  }, [asset?.sym, asset?.id, tf]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <Card style={{padding:'16px',marginBottom:12}}>
        <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:10}}>
          <Activity size={14} strokeWidth={2.2} color={T.muted}/>
          <span style={{color:T.muted,fontSize:13,fontWeight:700}}>지표 계산 중...</span>
        </div>
        <div style={{background:T.alt,height:200,borderRadius:8,opacity:0.5}}/>
      </Card>
    );
  }

  if (error || !data) {
    return (
      <Card style={{padding:'16px',marginBottom:12}}>
        <div style={{color:T.red,fontSize:12}}>{error}</div>
      </Card>
    );
  }

  const snap = data.snapshot;

  return (
    <div style={{marginBottom:12}}>
      {/* 시간 단위 선택 */}
      <div style={{display:'flex',gap:5,marginBottom:10}}>
        {(['15m','1h','4h','1d'] as const).map(t => (
          <button key={t} onClick={()=>setTf(t)}
            style={{flex:1,padding:'6px',minHeight:34,background:tf===t?T.acg:T.alt,color:tf===t?T.acl:T.muted,border:`1px solid ${tf===t?T.acl:T.border}`,borderRadius:8,fontSize:11,fontWeight:700,cursor:'pointer'}}>
            {t}
          </button>
        ))}
      </div>

      {/* RSI */}
      <Card style={{padding:'12px 14px',marginBottom:8}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',marginBottom:6}}>
          <span style={{color:T.muted,fontSize:11,fontWeight:700}}>RSI (14)</span>
          <span style={{color:
            (snap.rsi ?? 50) > 70 ? T.red :
            (snap.rsi ?? 50) < 30 ? T.grn :
            T.txt,
            fontWeight:900,fontSize:16,fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums'}}>
            {snap.rsi != null ? snap.rsi.toFixed(1) : '—'}
          </span>
        </div>
        <div style={{height:6,background:T.alt,borderRadius:3,overflow:'hidden',position:'relative'}}>
          <div style={{position:'absolute',top:0,bottom:0,left:'30%',width:1,background:T.grn+'80',zIndex:1}}/>
          <div style={{position:'absolute',top:0,bottom:0,left:'70%',width:1,background:T.red+'80',zIndex:1}}/>
          {snap.rsi != null && (
            <div style={{height:'100%',width:`${snap.rsi}%`,background:
              snap.rsi > 70 ? T.red :
              snap.rsi < 30 ? T.grn :
              T.acl,
              transition:'width 300ms'}}/>
          )}
        </div>
        <div style={{display:'flex',justifyContent:'space-between',marginTop:3,fontSize:9,color:T.muted}}>
          <span>0</span><span>30 과매도</span><span>70 과매수</span><span>100</span>
        </div>
      </Card>

      {/* EMA 배열 */}
      <Card style={{padding:'12px 14px',marginBottom:8}}>
        <div style={{color:T.muted,fontSize:11,fontWeight:700,marginBottom:8}}>EMA 배열</div>
        <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:5,marginBottom:8}}>
          {[
            { name:'EMA20',  val:snap.ema20,  c:'#60A5FA' },
            { name:'EMA60',  val:snap.ema60,  c:'#F59E0B' },
            { name:'EMA120', val:snap.ema120, c:'#A78BFA' },
          ].map(e => (
            <div key={e.name} style={{background:T.alt,padding:'7px 9px',borderRadius:6,borderTop:`2px solid ${e.c}`}}>
              <div style={{color:e.c,fontSize:9,fontWeight:700}}>{e.name}</div>
              <div style={{color:T.txt,fontSize:11,fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums',fontWeight:700}}>
                {e.val != null ? e.val.toFixed(2) : '—'}
              </div>
            </div>
          ))}
        </div>
        {snap.ema20 != null && snap.ema60 != null && snap.ema120 != null && (
          <div style={{padding:'7px 10px',background:T.bg,borderRadius:6,fontSize:11,
            color: snap.ema20 > snap.ema60 && snap.ema60 > snap.ema120 ? T.grn :
                   snap.ema20 < snap.ema60 && snap.ema60 < snap.ema120 ? T.red :
                   T.ylw,
            fontWeight:700}}>
            {snap.ema20 > snap.ema60 && snap.ema60 > snap.ema120 ? '✓ 정배열 (강한 상승 추세)' :
             snap.ema20 < snap.ema60 && snap.ema60 < snap.ema120 ? '✗ 역배열 (강한 하락 추세)' :
             '⚠ 혼조 (방향성 불확실)'}
          </div>
        )}
      </Card>

      {/* 가격 / 변동 / 거래량 */}
      <Card style={{padding:'12px 14px',marginBottom:8}}>
        <div style={{color:T.muted,fontSize:11,fontWeight:700,marginBottom:8}}>가격 데이터</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6}}>
          <div style={{background:T.alt,padding:'7px 10px',borderRadius:6}}>
            <div style={{color:T.muted,fontSize:9}}>현재가</div>
            <div style={{color:T.txt,fontSize:13,fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums',fontWeight:800}}>
              {snap.currentPrice != null ? snap.currentPrice.toFixed(snap.currentPrice > 100 ? 2 : 6) : '—'}
            </div>
          </div>
          <div style={{background:T.alt,padding:'7px 10px',borderRadius:6}}>
            <div style={{color:T.muted,fontSize:9}}>최근 1봉 변동</div>
            <div style={{color:(snap.priceChange ?? 0) >= 0 ? T.grn : T.red,fontSize:13,fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums',fontWeight:800}}>
              {snap.priceChange != null ? `${snap.priceChange >= 0 ? '+' : ''}${snap.priceChange.toFixed(2)}%` : '—'}
            </div>
          </div>
          <div style={{background:T.alt,padding:'7px 10px',borderRadius:6}}>
            <div style={{color:T.muted,fontSize:9}}>현재 거래량</div>
            <div style={{color:T.txt,fontSize:13,fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums',fontWeight:700}}>
              {snap.volume != null ? snap.volume.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—'}
            </div>
          </div>
          <div style={{background:T.alt,padding:'7px 10px',borderRadius:6}}>
            <div style={{color:T.muted,fontSize:9}}>평균 대비</div>
            <div style={{color:T.txt,fontSize:13,fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums',fontWeight:700}}>
              {snap.volume != null && snap.volumeAvg != null ?
                `${(snap.volume / snap.volumeAvg).toFixed(2)}배` : '—'}
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

// ─── 3) 뉴스 탭 ──────────────────────────────────────────────
function NewsTab({ asset }: { asset: any }) {
  // 자산 관련 뉴스 필터링 (MOCK_NEWS에서)
  const filtered = (MOCK_NEWS || []).filter(n => {
    const sym = (asset?.sym || asset?.id || '').toLowerCase();
    const krName = (asset?.nameKr || '').toLowerCase();
    const title = (n.title || '').toLowerCase();
    const summary = ((n as any).summary || '').toLowerCase();
    return title.includes(sym) || (krName && title.includes(krName)) ||
           summary.includes(sym) || (krName && summary.includes(krName));
  });
  const display = filtered.length > 0 ? filtered : (MOCK_NEWS || []).slice(0, 5);

  return (
    <div style={{marginBottom:12}}>
      <Card style={{padding:'12px 14px',marginBottom:10}}>
        <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:5}}>
          <Newspaper size={13} strokeWidth={2.2} color={T.acl}/>
          <span style={{color:T.txt,fontWeight:800,fontSize:12}}>
            {filtered.length > 0
              ? `${asset?.nameKr || asset?.sym || asset?.id} 관련 뉴스 ${filtered.length}건`
              : '관련 뉴스를 찾지 못해 전체 뉴스 표시'}
          </span>
        </div>
        <div style={{color:T.muted,fontSize:10}}>
          뉴스 영향 분석은 더보기 → 자동 → 시장 브리핑에서 사용 가능
        </div>
      </Card>

      {display.map(n => (
        <Card key={n.id} style={{padding:'11px 14px',marginBottom:6}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:8,marginBottom:4}}>
            <div style={{color:T.txt,fontWeight:700,fontSize:12,lineHeight:1.4,flex:1}}>{n.title}</div>
            {(n as any).sentiment && (
              <span style={{flexShrink:0,padding:'1px 6px',
                background: (n as any).sentiment === 'bullish' ? T.grn+'22' :
                            (n as any).sentiment === 'bearish' ? T.red+'22' :
                            T.ylw+'22',
                color: (n as any).sentiment === 'bullish' ? T.grn :
                       (n as any).sentiment === 'bearish' ? T.red :
                       T.ylw,
                fontSize:9,fontWeight:800,borderRadius:4}}>
                {(n as any).sentiment === 'bullish' ? '강세' :
                 (n as any).sentiment === 'bearish' ? '약세' : '중립'}
              </span>
            )}
          </div>
          <div style={{display:'flex',gap:6,marginTop:3,fontSize:10,color:T.muted}}>
            <span>{n.source}</span>
            <span>·</span>
            <span>{n.time}</span>
          </div>
        </Card>
      ))}
    </div>
  );
}


export default TradingPage;
