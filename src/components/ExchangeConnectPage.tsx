'use client';
import { A } from '@/lib/theme/colors';
import React, { useState, useEffect, useCallback } from 'react';
import { confirmDialog } from '@/lib/confirm/dialog';
import { EXCHANGE_META } from '@/lib/exchanges/types';
import type { ExchangeId, ConnectedExchange } from '@/lib/exchanges/types';

// ── Theme ─────────────────────────────────────────────────────
// 팔레트는 공용 하나만 쓴다. 복사본을 두면 테마를 바꿨을 때
// 이 화면만 옛 색으로 남고, 그 차이를 아무도 눈치채지 못한다.
import { T } from '@/lib/constants';

// ── Exchange order & display ──────────────────────────────────
const EXCHANGES: ExchangeId[] = ['binance','bybit','okx','gate','upbit','bithumb'];

/**
 * 테스트넷 호스트가 **서버 쪽에 실제로 구현된** 거래소.
 *
 * 목록에 없는 거래소는 토글을 아예 보여주지 않는다 — 고를 수 있는데 서버가
 * 실계좌로 물어보면, 화면에는 '테스트넷'이라고 적힌 채 실계좌가 조회된다.
 * 그건 이 저장소에서 이미 한 번 낸 사고다(Gate `BASE` 하드코딩).
 *
 * 여기 추가하기 전에 `lib/exchanges/<거래소>`가 testnet 인자를 받아 호스트를
 * 바꾸는지 먼저 확인할 것. Bybit·OKX는 아직 아니다.
 */
const HAS_TESTNET: ExchangeId[] = ['binance', 'gate'];

// ── Loading skeleton ──────────────────────────────────────────
function Skeleton({ w='100%', h=14 }: { w?: string|number; h?: number }) {
  return <div style={{ width:w, height:h, borderRadius:6, background:'linear-gradient(90deg,var(--t-border) 25%,var(--t-border2) 50%,var(--t-border) 75%)', backgroundSize:'200% 100%', animation:'shimmer 1.2s infinite' }}/>;
}

// ── Card ──────────────────────────────────────────────────────
function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div style={{ background:T.card, border:`1px solid ${T.border}`, borderRadius:14, padding:'14px 16px', ...style }}>{children}</div>;
}

// ── Main Component ────────────────────────────────────────────
export default function ExchangeConnectPage() {
  const [view, setView] = useState<'list'|'connect'|'detail'>('list');
  const [connections, setConnections] = useState<ConnectedExchange[]>([]);
  const [loading, setLoading] = useState(true);
  const [selExchange, setSelExchange] = useState<ExchangeId>('binance');
  const [selConn, setSelConn] = useState<ConnectedExchange|null>(null);

  // Connect form
  const [apiKey,     setApiKey]     = useState('');
  const [apiSecret,  setApiSecret]  = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [nickname,   setNickname]   = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [isTestnet,  setIsTestnet]  = useState(true);   // 기본 테스트넷 (안전)
  const [connecting, setConnecting] = useState(false);
  const [connectErr, setConnectErr] = useState('');
  const [connectOk,  setConnectOk]  = useState(false);

  // Detail
  const [balances,     setBalances]     = useState<any[]>([]);
  const [diag,         setDiag]         = useState<any>(null);
  const [diagRunning,  setDiagRunning]  = useState(false);
  const [balLoading,   setBalLoading]   = useState(false);
  const [balErr,       setBalErr]       = useState('');
  const [toggleBusy,   setToggleBusy]   = useState<string|null>(null);   // 토글 중인 connectionId
  const [toast,        setToast]        = useState<{ msg:string; ok:boolean }|null>(null);
  const showToast = useCallback((msg:string, ok:boolean)=>{ setToast({ msg, ok }); setTimeout(()=>setToast(null), 4200); }, []);
  const toastEl = toast ? (
    <div style={{ position:'fixed', left:'50%', bottom:88, transform:'translateX(-50%)', zIndex:9999, maxWidth:'90vw',
      background: toast.ok ? '#0F766E' : '#B91C1C', color:'#fff', padding:'11px 16px', borderRadius:10,
      fontSize:12, fontWeight:600, lineHeight:1.5, boxShadow:'0 8px 24px rgba(0,0,0,.35)', whiteSpace:'pre-line', textAlign:'center' }}>
      {toast.msg}
    </div>
  ) : null;
  const [testing,      setTesting]      = useState(false);
  const [testMsg,      setTestMsg]      = useState('');
  // 거래소 키에 IP 제한을 걸었을 때 허용 목록에 넣어야 하는 것은
  // **이 서버**의 IP다. 지금까지 "이 서버 IP를 확인하세요"라고만 적고
  // 그 값을 알려주지 않았다 — 확인할 방법이 없는 안내였다.
  const [srvIp,        setSrvIp]        = useState<any>(null);
  const [ipBusy,       setIpBusy]       = useState(false);

  // ── Load connections ────────────────────────────────────────
  const loadConnections = useCallback(async () => {
    setLoading(true);
    try {
      let auth = '';
      try {
        const { getSupabaseClient } = await import('@/lib/supabase/client');
        const sbc = getSupabaseClient();
        if (sbc) { const { data } = await sbc.auth.getSession(); if (data?.session?.access_token) auth = `Bearer ${data.session.access_token}`; }
      } catch {}
      const r = await fetch('/api/exchange?action=list', { headers: auth ? { Authorization: auth } : {} });
      const d = await r.json();
      setConnections(Array.isArray(d.connections) ? d.connections : []);
    } catch {
      setConnections([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadConnections(); }, [loadConnections]);

  // ── Connect handler ─────────────────────────────────────────
  const getAuthHeader = async (): Promise<string> => {
    try {
      const { getSupabaseClient } = await import('@/lib/supabase/client');
      const sbc = getSupabaseClient();
      if (sbc) { const { data } = await sbc.auth.getSession(); if (data?.session?.access_token) return `Bearer ${data.session.access_token}`; }
    } catch {}
    return '';
  };

  const loadServerIp = async () => {
    setIpBusy(true);
    try {
      const auth = await getAuthHeader();
      const r = await fetch('/api/diagnostics/ip', { headers: auth ? { Authorization: auth } : {} });
      const d = await r.json();
      // 실패를 빈 값으로 두지 않는다 — 빈 칸은 '아직 안 눌렀다'로 읽힌다
      setSrvIp(r.ok && d?.ok ? d : { error: d?.message || d?.error || `확인 실패 (${r.status})` });
    } catch (e: any) {
      setSrvIp({ error: `확인 실패 (${e?.message || e})` });
    } finally { setIpBusy(false); }
  };

  const handleConnect = async () => {
    if (!apiKey.trim() || !apiSecret.trim()) {
      setConnectErr('API Key와 Secret Key를 입력해주세요');
      return;
    }
    const meta = EXCHANGE_META[selExchange];
    if (meta.hasPassphrase && !passphrase.trim()) {
      setConnectErr('Passphrase를 입력해주세요');
      return;
    }

    setConnecting(true);
    setConnectErr('');
    setConnectOk(false);

    try {
      const auth = await getAuthHeader();
      if (!auth) {
        setConnectErr('먼저 TRAIGO 앱에 로그인해주세요 (더보기 → 로그인). 거래소 연결은 계정에 안전하게 저장됩니다.');
        setConnecting(false);
        return;
      }
      const r = await fetch('/api/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({
          action: 'connect', exchange: selExchange,
          apiKey: apiKey.trim(), apiSecret: apiSecret.trim(),
          passphrase: passphrase.trim() || undefined,
          nickname: nickname.trim() || meta.nameKr,
          // 테스트넷을 고를 수 있는 거래소면 고른 값을 그대로 보낸다.
          // 예전에는 `binance ? isTestnet : false`였다 — Gate 테스트넷 키를
          // 등록할 방법이 아예 없었고, 화면은 그 사실을 말하지도 않았다.
          isTestnet: HAS_TESTNET.includes(selExchange) ? isTestnet : false,
        }),
      });
      const d = await r.json();
      if (!r.ok || d.error) {
        setConnectErr(d.error || '연결 실패');
      } else {
        setConnectOk(true);
        // 고른 환경과 실제 키가 달랐으면 **그 사실을 말한다.** 조용히 바꾸면
        // 사용자가 '실전'이라고 믿는 연결이 테스트넷이 되고, 그 반대도 된다.
        if (d?.detected?.switched && d.detected.message) {
          showToast(d.detected.message, true);
          setIsTestnet(!!d.detected.isTestnet);
        }
        setApiKey(''); setApiSecret(''); setPassphrase(''); setNickname('');
        await loadConnections();
        setTimeout(() => setView('list'), d?.detected?.switched ? 3200 : 1500);
      }
    } catch (e: any) {
      setConnectErr(e.message || '네트워크 오류');
    } finally {
      setConnecting(false);
    }
  };

  // ── Test handler ────────────────────────────────────────────
  const handleTest = async (conn: ConnectedExchange) => {
    setTesting(true); setTestMsg('');
    try {
      const _auth = await getAuthHeader();
      const r = await fetch('/api/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(_auth?{Authorization:_auth}:{}) },
        body: JSON.stringify({ action: 'test', connectionId: conn.id }),
      });
      const d = await r.json();
      const text = String(d.message ?? '');
      setTestMsg(d.success ? `✅ ${text} (${d.latencyMs}ms)` : `❌ ${text}`);
      // 실패 이유에 IP가 걸려 있으면 **묻기 전에** 서버 IP를 띄운다.
      //
      // 아래 '확인' 버튼을 눌러야만 보이는 값은, 그걸 눌러야 한다는 걸
      // 아는 사람에게만 보이는 값이다. 정작 이 오류를 처음 보는 사람은
      // 무엇을 허용 목록에 넣어야 하는지 모른 채로 화면을 닫는다.
      if (!d.success && /\bip\b|아이피/i.test(text)) loadServerIp();
      await loadConnections();
    } catch { setTestMsg('❌ 테스트 실패'); }
    finally { setTesting(false); }
  };

  // ── 테스트넷 여부 바꾸기 ─────────────────────────────────────
  //
  // 실전으로 등록해 놓고 실제로는 테스트넷 키인 경우가 흔하다. 지금까지는
  // 지우고 다시 만드는 수밖에 없었는데, 그러면 키를 다시 붙여넣어야 하고
  // 그 과정에서 실전 키를 잘못 넣을 위험이 새로 생긴다.
  const [envBusy, setEnvBusy] = useState(false);
  const switchEnv = async (conn: ConnectedExchange, next: boolean) => {
    const going = next ? '테스트넷' : '실전';
    const lines = [
      `이 연결을 ${going}으로 바꿉니다.`,
      '',
      next
        ? '가짜 돈으로 도는 계좌를 보게 됩니다.'
        : '⚠️ 이제부터 이 연결의 주문은 실제 자금을 씁니다.',
      '',
      '자동매매는 꺼집니다 — 어느 계좌를 향하는지가 바뀌었으므로,',
      '연결 테스트로 확인한 뒤 직접 다시 켜세요.',
    ];
    if (!(await confirmDialog(lines.join('\n'), { danger: !next }))) return;
    setEnvBusy(true);
    try {
      const _a = await getAuthHeader();
      const r = await fetch('/api/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(_a?{Authorization:_a}:{}) },
        body: JSON.stringify({ action: 'set-testnet', connectionId: conn.id, isTestnet: next }),
      });
      const d = await r.json();
      // 실패 사유를 그대로 보여준다. '변경 실패'만 적으면 무엇이 문제인지
      // 알 수 없고, 반쯤 바뀌었는지도 알 수 없다.
      showToast(
        d?.success ? (d.message || '바꿨습니다')
                   : [d?.error, d?.message].filter(Boolean).join('\n') || `변경 실패 (${r.status})`,
        !!d?.success);
      if (d?.success) {
        await loadConnections();
        setSelConn(prev => prev ? ({ ...prev, isTestnet: next, autoTradingEnabled: false } as any) : prev);
        setTestMsg(''); setBalances([]); setBalErr('');
      }
    } catch (e: any) {
      showToast(`변경 실패 (${e?.message || e})`, false);
    } finally { setEnvBusy(false); }
  };

  // ── Load balances ───────────────────────────────────────────
  const loadBalances = async (conn: ConnectedExchange) => {
    setBalLoading(true); setBalances([]); setBalErr('');
    try {
      // **인증 헤더가 빠져 있었다.** 이 화면의 다른 요청은 전부 붙이는데
      // 이것만 없어서 서버가 사용자를 못 알아보고 404를 돌려줬다 —
      // 그래서 잔고 조회는 **한 번도 성공한 적이 없다.** 화면에는
      // "잔고 없음 또는 조회 실패"만 떴다.
      const _a = await getAuthHeader();
      const r = await fetch(`/api/exchange?action=balances&id=${conn.id}`,
        { headers: _a ? { Authorization: _a } : undefined });
      const d = await r.json();
      // 실패 사유를 버리지 않는다. '잔고가 0'과 '못 읽었다'는 완전히 다른
      // 상태인데 화면에서는 둘 다 비어 보인다.
      if (!r.ok || d?.error) { setBalances([]); setBalErr(d?.error || `조회 실패 (${r.status})`); return; }
      setBalances(d.balances || []);
    } catch (e: any) {
      setBalances([]); setBalErr(`잔고를 읽지 못했습니다 (${e?.message || e})`);
    }
    finally { setBalLoading(false); }
  };

  // ── Delete ──────────────────────────────────────────────────
  const handleDelete = async (id: string) => {
    if (!(await confirmDialog('이 거래소 연결을 삭제하시겠습니까?\n저장된 API 키는 즉시 삭제됩니다.', { danger: true }))) return;
    try {
      const _a = await getAuthHeader();
      await fetch('/api/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(_a?{Authorization:_a}:{}) },
        body: JSON.stringify({ action: 'delete', connectionId: id }),
      });
      await loadConnections();
      if (selConn?.id === id) setView('list');
    } catch {}
  };

  // ── Toggle auto trading ──────────────────────────────────────
  const handleToggleAuto = async (conn: ConnectedExchange) => {
    if (toggleBusy) return;                       // 중복 클릭 방지
    const turningOn = !conn.autoTradingEnabled;
    setToggleBusy(conn.id);
    try {
      const _a = await getAuthHeader();
      const r = await fetch('/api/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(_a?{Authorization:_a}:{}) },
        body: JSON.stringify({ action: 'toggle-auto', connectionId: conn.id, enabled: turningOn }),
        signal: AbortSignal.timeout(8000),
      });
      let d: any = {};
      try { d = await r.json(); } catch {}
      if (!r.ok || d.error) {
        // 서버가 막은 실제 이유를 그대로 노출 (거래권한 없음 / 연결없음 / DB오류 등)
        const reason = d.error || (r.status === 403 ? 'API 키에 거래 권한이 없습니다' : r.status === 401 ? '로그인이 필요합니다' : r.status >= 500 ? '서버 오류 (Supabase 연결 확인)' : `요청 실패 (HTTP ${r.status})`);
        showToast(`자동매매 ${turningOn?'ON':'OFF'} 실패: ${reason}`, false);
        return;
      }
      await loadConnections();
      setSelConn(prev => prev && prev.id === conn.id ? { ...prev, autoTradingEnabled: turningOn } : prev);
      showToast(`자동매매 ${turningOn?'ON 활성화됨':'OFF'}`, true);
    } catch (e: any) {
      const msg = e?.name === 'TimeoutError' ? '응답 시간 초과 — 서버/Supabase 상태를 확인하세요' : (e?.message || '네트워크 오류');
      showToast(`자동매매 전환 실패: ${msg}`, false);
    } finally {
      setToggleBusy(null);
    }
  };

  const meta = EXCHANGE_META[selExchange];
  const connectedIds = new Set(connections.map(c => c.exchange));

  // ════════════════════════════════════════════════════════════
  // VIEW: LIST
  // ════════════════════════════════════════════════════════════
  if (view === 'list') return (
    <div>
      {toastEl}
      {/* Header */}
      <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:16 }}>
        <div style={{ width:32, height:32, borderRadius:10, background:'linear-gradient(135deg,#2563EB,#7C3AED)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:16 }}>🔗</div>
        <div>
          <div style={{ fontWeight:900, fontSize:15, color:T.txt }}>거래소 API 연결</div>
          <div style={{ color:T.muted, fontSize:10 }}>실시간 잔고 조회 · 자동매매 준비</div>
        </div>
        <button onClick={() => { setView('connect'); setConnectErr(''); setConnectOk(false); }}
          style={{ marginLeft:'auto', padding:'7px 14px', background:'linear-gradient(135deg,#2563EB,#7C3AED)', color:'#fff', border:'none', borderRadius:10, fontWeight:700, fontSize:12, cursor:'pointer' }}>
          + 거래소 연결
        </button>
      </div>

      {/* Security banner */}
      <div style={{ background:'#F59E0B0F', border:`1px solid ${A(T.ylw,'30')}`, borderRadius:12, padding:'10px 14px', marginBottom:14 }}>
        <div style={{ color:T.ylw, fontWeight:700, fontSize:11, marginBottom:4 }}>🔐 보안 안내</div>
        <div style={{ color:'#B45309', fontSize:10, lineHeight:1.6 }}>
          • API Secret은 <strong>AES-256-GCM 암호화</strong> 후 서버에만 저장 · 절대 클라이언트로 반환하지 않습니다<br/>
          • <strong>출금 권한이 있는 API 키는 등록이 거부</strong>됩니다<br/>
          • 조회 전용 또는 거래 전용 권한만 허용합니다
        </div>
      </div>

      {/* Exchange cards grid */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(2,1fr)', gap:8, marginBottom:14 }}>
        {EXCHANGES.map(exId => {
          const ex      = EXCHANGE_META[exId];
          const myConns = connections.filter(c => c.exchange === exId);
          const isConn  = myConns.length > 0;
          return (
            <div key={exId}
              onClick={() => { setSelExchange(exId); setView('connect'); setConnectErr(''); setConnectOk(false); }}
              style={{
                background: isConn ? ex.color+'0D' : T.card,
                border: `1px solid ${isConn ? ex.color+'50' : T.border}`,
                borderRadius: 12, padding:'12px 14px', cursor:'pointer',
                position:'relative',
              }}>
              <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:6 }}>
                <span style={{ fontSize:22 }}>{ex.logo}</span>
                <div>
                  <div style={{ color:T.txt, fontWeight:800, fontSize:12 }}>{ex.name}</div>
                  <div style={{ color:T.muted, fontSize:9 }}>{ex.type === 'korean' ? '🇰🇷 원화' : '🌏 달러'}</div>
                </div>
              </div>
              <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                <div style={{ width:7, height:7, borderRadius:'50%', background: isConn ? T.grn : T.muted, flexShrink:0 }}/>
                <div style={{ color: isConn ? T.grn : T.muted, fontSize:10, fontWeight:700 }}>
                  {isConn ? `연결됨 (${myConns.length})` : '미연결'}
                </div>
              </div>
              {ex.hasPassphrase && <div style={{ position:'absolute', top:8, right:8, background:'#7C3AED20', border:'1px solid #7C3AED40', borderRadius:6, padding:'1px 5px', fontSize:8, color:'#A78BFA' }}>PW</div>}
            </div>
          );
        })}
      </div>

      {/* Connected accounts list */}
      {loading ? (
        <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
          {[0,1].map(i => <Card key={i}><Skeleton h={60}/></Card>)}
        </div>
      ) : connections.length === 0 ? (
        <Card style={{ textAlign:'center', padding:'32px 16px' }}>
          <div style={{ fontSize:32, marginBottom:8 }}>🔌</div>
          <div style={{ color:T.muted, fontSize:13 }}>연결된 거래소가 없습니다</div>
          <div style={{ color:T.muted, fontSize:11, marginTop:4 }}>거래소 카드를 눌러 API 키를 연결하세요</div>
        </Card>
      ) : (
        <div>
          <div style={{ color:T.muted, fontSize:11, fontWeight:700, marginBottom:8, paddingLeft:2 }}>연결된 계정</div>
          {connections.map(conn => {
            const ex = EXCHANGE_META[conn.exchange];
            return (
              <Card key={conn.id} style={{ marginBottom:8 }}>
                <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                  <span style={{ fontSize:22, flexShrink:0 }}>{ex.logo}</span>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:2 }}>
                      <div style={{ color:T.txt, fontWeight:800, fontSize:13 }}>{conn.nickname}</div>
                      <div style={{ width:6, height:6, borderRadius:'50%', background: conn.status==='active' ? T.grn : T.red, flexShrink:0 }}/>
                      {(()=>{ const mode = conn.isTestnet ? 'TESTNET' : (conn.isPaper ? 'MOCK' : 'LIVE'); const c = mode==='LIVE'?T.grn:mode==='TESTNET'?T.ylw:T.prp; return <span style={{ background:c+'20', color:c, fontSize:8, fontWeight:800, padding:'1px 6px', borderRadius:5, letterSpacing:0.3 }}>{mode}</span>; })()}
                    </div>
                    <div style={{ color:T.muted, fontSize:10 }}>{conn.apiKeyMasked} · {ex.name}</div>
                    <div style={{ display:'flex', gap:4, marginTop:4, flexWrap:'wrap' }}>
                      {conn.permissions.read     && <span style={{ background:A(T.grn,'20'), color:T.grn,   fontSize:8, padding:'1px 5px', borderRadius:4 }}>조회</span>}
                      {conn.permissions.trading  && <span style={{ background:A(T.ylw,'20'), color:T.ylw,   fontSize:8, padding:'1px 5px', borderRadius:4 }}>거래</span>}
                      {conn.permissions.withdrawal && <span style={{ background:A(T.red,'20'), color:T.red, fontSize:8, padding:'1px 5px', borderRadius:4 }}>⚠️ 출금</span>}
                    </div>
                  </div>
                  <div style={{ display:'flex', flexDirection:'column', gap:5, alignItems:'flex-end' }}>
                    <button onClick={() => { setSelConn(conn); setView('detail'); loadBalances(conn); setTestMsg(''); }}
                      style={{ padding:'5px 10px', background:T.alt, border:`1px solid ${T.border}`, borderRadius:8, color:T.sub, fontSize:10, fontWeight:700, cursor:'pointer' }}>
                      상세
                    </button>
                    <button onClick={() => handleDelete(conn.id)}
                      style={{ padding:'4px 10px', background:'transparent', border:`1px solid ${A(T.red,'30')}`, borderRadius:8, color:T.red, fontSize:10, cursor:'pointer' }}>
                      삭제
                    </button>
                  </div>
                </div>
                {/* Auto trading toggle */}
                <div style={{ marginTop:10, paddingTop:10, borderTop:`1px solid ${T.border}`, display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                  <div style={{ color:T.muted, fontSize:10 }}>자동매매</div>
                  <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                    <div style={{ color: conn.autoTradingEnabled ? T.grn : T.muted, fontSize:10, fontWeight:700 }}>
                      {conn.autoTradingEnabled ? 'ON' : 'OFF'}
                    </div>
                    <div onClick={() => handleToggleAuto(conn)}
                      style={{
                        width:36, height:20, borderRadius:10, cursor: toggleBusy===conn.id?'wait':'pointer', position:'relative', flexShrink:0,
                        opacity: toggleBusy===conn.id ? 0.5 : 1,
                        background: conn.autoTradingEnabled ? T.grn : T.alt,
                        border: `1px solid ${conn.autoTradingEnabled ? T.grn : T.border}`,
                        transition:'background .2s',
                      }}>
                      <div style={{
                        position:'absolute', top:2, left: conn.autoTradingEnabled ? 18 : 2,
                        width:14, height:14, borderRadius:'50%', background:'#fff', transition:'left .2s',
                      }}/>
                    </div>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );

  // ════════════════════════════════════════════════════════════
  // VIEW: CONNECT FORM
  // ════════════════════════════════════════════════════════════
  if (view === 'connect') return (
    <div>
      <button onClick={() => setView('list')}
        style={{ background:'transparent', border:`1px solid ${T.border}`, borderRadius:8, color:T.muted, padding:'5px 12px', fontSize:12, cursor:'pointer', marginBottom:14 }}>
        ← 목록으로
      </button>

      {/* Exchange selector */}
      <div style={{ display:'flex', gap:6, overflowX:'auto', paddingBottom:4, marginBottom:14 }}>
        {EXCHANGES.map(exId => {
          const ex = EXCHANGE_META[exId];
          const active = selExchange === exId;
          return (
            <button key={exId}
              onClick={() => { setSelExchange(exId); setConnectErr(''); setConnectOk(false); }}
              style={{
                flexShrink:0, display:'flex', alignItems:'center', gap:5, padding:'6px 12px',
                background: active ? ex.color+'20' : 'transparent',
                border: `1px solid ${active ? ex.color : T.border}`,
                borderRadius:10, cursor:'pointer', whiteSpace:'nowrap',
              }}>
              <span>{ex.logo}</span>
              <span style={{ color: active ? ex.color : T.muted, fontSize:11, fontWeight:700 }}>{ex.name}</span>
            </button>
          );
        })}
      </div>

      {/* Form card */}
      <Card>
        <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:14 }}>
          <span style={{ fontSize:28 }}>{meta.logo}</span>
          <div>
            <div style={{ color:T.txt, fontWeight:900, fontSize:15 }}>{meta.nameKr} 연결</div>
            <a href={meta.apiGuideUrl} target="_blank" rel="noopener noreferrer"
              style={{ color:T.acl, fontSize:10 }}>API 키 발급 가이드 →</a>
          </div>
        </div>

        {/* Security reminder */}
        <div style={{ background:'#EF444410', border:`1px solid ${A(T.red,'30')}`, borderRadius:10, padding:'10px 14px', marginBottom:14 }}>
          <div style={{ color:T.red, fontSize:10, fontWeight:700, marginBottom:3 }}>⚠️ 반드시 확인하세요</div>
          <div style={{ color:'#FCA5A5', fontSize:10, lineHeight:1.6 }}>
            ✗ <strong>출금(Withdrawal) 권한은 절대 부여하지 마세요</strong><br/>
            ✓ 읽기(Read) 권한만, 또는 읽기+거래(Trade) 권한만 부여<br/>
            ⚠ Vercel은 고정 IP가 아닐 수 있어 IP 제한 시 차단될 수 있습니다. 실전 운영 시 고정 IP 서버/VPS 사용 권장.
          </div>
        </div>

        {/* Inputs */}
        <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
          {/* 테스트넷/실전 토글.
              **바이낸스 전용이 아니다.** Gate도 테스트넷 호스트가 따로 있고
              (api-testnet.gateapi.io) 서버는 그것을 지원하는데, 여기서 고를 수
              없어서 Gate 테스트넷 키를 등록할 방법이 없었다. 등록해 봐야
              실계좌에 물어보고 401이 뜨는데, 화면에는 그 이유가 안 적혔다. */}
          {HAS_TESTNET.includes(selExchange) && (
            <div>
              <div style={{ color:T.sub, fontSize:11, marginBottom:4 }}>
                연결 환경 <span style={{ color:T.muted, fontSize:9, fontWeight:600 }}>
                  — 틀려도 됩니다. 키가 반대쪽이면 알아서 찾아 그대로 알려드립니다
                </span>
              </div>
              <div style={{ display:'flex', gap:6 }}>
                {([
                  { id: true,  label: '테스트넷', desc: '가짜 돈 · 안전', color: T.grn },
                  { id: false, label: '실전',     desc: '실제 자금',     color: T.red },
                ]).map(opt => {
                  const active = isTestnet === opt.id;
                  return (
                    <button key={String(opt.id)} type="button"
                      onClick={() => setIsTestnet(opt.id)}
                      style={{ flex:1, padding:'11px', minHeight:50,
                        background: active ? opt.color+'22' : T.bg,
                        color:      active ? opt.color : T.muted,
                        border:    `1px solid ${active ? opt.color : T.border}`,
                        borderRadius:10, fontWeight:800, fontSize:12, cursor:'pointer',
                        display:'flex', flexDirection:'column', alignItems:'center', gap:2 }}>
                      <span>{opt.label}</span>
                      <span style={{ fontSize:9, fontWeight:600, opacity:0.8 }}>{opt.desc}</span>
                    </button>
                  );
                })}
              </div>
              <div style={{ color:T.muted, fontSize:9, marginTop:4, lineHeight:1.5 }}>
                {/* 어느 호스트에 물어볼지를 적는다. 실패했을 때 오류 메시지가
                    같은 호스트를 말하므로, 둘을 맞춰 보면 원인이 바로 보인다. */}
                {selExchange === 'gate'
                  ? (isTestnet
                      ? '테스트넷: api-testnet.gateapi.io. Gate 테스트넷 키는 실전 키와 별도로 발급받아야 합니다. 실제 돈이 들지 않습니다.'
                      : '⚠️ 실전: api.gateio.ws 실계정 키. 실제 자금이 사용됩니다.')
                  : (isTestnet
                      ? '테스트넷은 두 개입니다 — 현물: testnet.binance.vision · 선물: demo-fapi.binance.com(developers.binance.com 데모 모드). 키도 각각 따로 발급됩니다. 저장할 때 어느 쪽이 인증됐는지 알려드립니다. 실제 돈이 들지 않습니다.'
                      : '⚠️ 실전: api.binance.com(현물) · fapi.binance.com(선물) 실계정 키. 실제 자금이 사용됩니다.')}
              </div>
            </div>
          )}

          <div>
            <div style={{ color:T.sub, fontSize:11, marginBottom:4 }}>별칭 (선택)</div>
            <input value={nickname} onChange={e => setNickname(e.target.value)}
              placeholder={`${meta.nameKr} 계정`}
              style={{ width:'100%', background:T.bg, border:`1px solid ${T.border}`, borderRadius:10, padding:'10px 14px', color:T.txt, fontSize:13, outline:'none', boxSizing:'border-box' }}/>
          </div>
          <div>
            <div style={{ color:T.sub, fontSize:11, marginBottom:4 }}>API Key <span style={{ color:T.red }}>*</span></div>
            <input value={apiKey} onChange={e => setApiKey(e.target.value)}
              placeholder="API 키를 입력하세요"
              style={{ width:'100%', background:T.bg, border:`1px solid ${T.border}`, borderRadius:10, padding:'10px 14px', color:T.txt, fontSize:12, outline:'none', fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums', boxSizing:'border-box' }}/>
          </div>
          <div>
            <div style={{ color:T.sub, fontSize:11, marginBottom:4, display:'flex', justifyContent:'space-between' }}>
              <span>Secret Key <span style={{ color:T.red }}>*</span></span>
              <button onClick={() => setShowSecret(s => !s)}
                style={{ background:'none', border:'none', color:T.muted, fontSize:10, cursor:'pointer' }}>
                {showSecret ? '🙈 숨기기' : '👁 보기'}
              </button>
            </div>
            <input value={apiSecret} onChange={e => setApiSecret(e.target.value)}
              type={showSecret ? 'text' : 'password'}
              placeholder="Secret Key를 입력하세요"
              style={{ width:'100%', background:T.bg, border:`1px solid ${T.border}`, borderRadius:10, padding:'10px 14px', color:T.txt, fontSize:12, outline:'none', fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums', boxSizing:'border-box' }}/>
            <div style={{ color:T.muted, fontSize:9, marginTop:3 }}>🔐 입력 즉시 AES-256 암호화 · 화면에 절대 저장 안됨</div>
          </div>
          {meta.hasPassphrase && (
            <div>
              <div style={{ color:T.sub, fontSize:11, marginBottom:4 }}>Passphrase <span style={{ color:T.red }}>*</span></div>
              <input value={passphrase} onChange={e => setPassphrase(e.target.value)}
                type="password" placeholder="Passphrase를 입력하세요"
                style={{ width:'100%', background:T.bg, border:`1px solid ${T.border}`, borderRadius:10, padding:'10px 14px', color:T.txt, fontSize:12, outline:'none', fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums', boxSizing:'border-box' }}/>
            </div>
          )}
        </div>

        {/* Error / success */}
        {connectErr && (
          <div style={{ marginTop:12, background:'#EF444415', border:`1px solid ${A(T.red,'40')}`, borderRadius:10, padding:'10px 14px', color:T.red, fontSize:11, lineHeight:1.5, whiteSpace:'pre-wrap' }}>{connectErr}</div>
        )}
        {connectOk && (
          <div style={{ marginTop:12, background:'#10B98115', border:`1px solid ${A(T.grn,'40')}`, borderRadius:10, padding:'10px 14px', color:T.grn, fontSize:12, fontWeight:700 }}>
            ✅ 연결 성공! 목록으로 이동합니다…
          </div>
        )}

        {/* Submit */}
        <button onClick={handleConnect} disabled={connecting}
          style={{
            marginTop:14, width:'100%', padding:'13px',
            background: connecting ? T.alt : 'linear-gradient(135deg,#2563EB,#7C3AED)',
            color: connecting ? T.muted : '#fff',
            border:'none', borderRadius:12, fontWeight:800, fontSize:14, cursor: connecting ? 'not-allowed' : 'pointer',
          }}>
          {connecting ? '연결 테스트 중…' : `${meta.logo} ${meta.nameKr} 연결하기`}
        </button>

        <div style={{ marginTop:10, color:T.muted, fontSize:9, textAlign:'center', lineHeight:1.5 }}>
          연결 클릭 시 API 키 유효성을 서버에서 검증합니다<br/>
          Secret Key는 클라이언트에 절대 저장되지 않습니다
        </div>
      </Card>
    </div>
  );

  // ════════════════════════════════════════════════════════════
  // VIEW: DETAIL
  // ════════════════════════════════════════════════════════════
  if (view === 'detail' && selConn) {
    const ex = EXCHANGE_META[selConn.exchange];
    return (
      <div>
        {toastEl}
        <button onClick={() => setView('list')}
          style={{ background:'transparent', border:`1px solid ${T.border}`, borderRadius:8, color:T.muted, padding:'5px 12px', fontSize:12, cursor:'pointer', marginBottom:14 }}>
          ← 목록으로
        </button>

        {/* Connection info */}
        <Card style={{ marginBottom:10 }}>
          <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:10 }}>
            <span style={{ fontSize:28 }}>{ex.logo}</span>
            <div style={{ flex:1 }}>
              <div style={{ color:T.txt, fontWeight:900, fontSize:15 }}>{selConn.nickname}</div>
              <div style={{ color:T.muted, fontSize:10 }}>{ex.name} · {selConn.apiKeyMasked}</div>
            </div>
            <div style={{ display:'flex', alignItems:'center', gap:5 }}>
              <div style={{ width:8, height:8, borderRadius:'50%', background: selConn.status==='active' ? T.grn : T.red }}/>
              <div style={{ color: selConn.status==='active' ? T.grn : T.red, fontSize:11, fontWeight:700 }}>
                {selConn.status === 'active' ? '연결됨' : '오류'}
              </div>
            </div>
          </div>

          {/* Permissions */}
          <div style={{ display:'flex', gap:6, marginBottom:10 }}>
            {([['read','조회','#10B981'],['trading','거래','#F59E0B'],['withdrawal','출금','#EF4444']] as const).map(([k,l,c])=>(
              <div key={k} style={{
                flex:1, textAlign:'center', padding:'6px',
                background: selConn.permissions[k] ? c+'15' : T.alt,
                border: `1px solid ${selConn.permissions[k] ? c+'50' : T.border}`,
                borderRadius:8,
              }}>
                <div style={{ fontSize:14 }}>{k==='read'?'👁':k==='trading'?'':'⚠️'}</div>
                <div style={{ color: selConn.permissions[k] ? c : T.muted, fontSize:9, fontWeight:700 }}>{l}</div>
                <div style={{ color: selConn.permissions[k] ? c : T.muted, fontSize:8 }}>{selConn.permissions[k]?'허용':'없음'}</div>
              </div>
            ))}
          </div>

          {/* 연결 환경 바꾸기.
              연결 테스트가 어느 호스트에 물어보는지를 정하는 값이라,
              테스트 버튼 바로 위에 둔다 — 실패했을 때 다음에 눌러야 할 것이
              바로 위에 있어야 한다. */}
          {HAS_TESTNET.includes(selConn.exchange as ExchangeId) && (
            <div style={{ marginBottom:10 }}>
              <div style={{ color:T.muted, fontSize:10, fontWeight:700, marginBottom:4 }}>
                연결 환경 — 지금 <b style={{ color: selConn.isTestnet ? T.grn : T.red }}>
                  {selConn.isTestnet ? '테스트넷' : '실전'}
                </b>
              </div>
              <button onClick={() => switchEnv(selConn, !selConn.isTestnet)} disabled={envBusy}
                style={{ width:'100%', padding:'9px', background:T.alt,
                  border:`1px solid ${A(selConn.isTestnet ? T.red : T.grn,'40')}`, borderRadius:10,
                  color: selConn.isTestnet ? T.red : T.grn, fontWeight:700, fontSize:11,
                  cursor: envBusy ? 'not-allowed' : 'pointer' }}>
                {envBusy ? '바꾸는 중…' : selConn.isTestnet ? '실전으로 바꾸기' : '테스트넷으로 바꾸기'}
              </button>
              <div style={{ color:T.muted, fontSize:9, marginTop:4, lineHeight:1.5 }}>
                연결 테스트는 실패하는데 테스트넷 진단은 통과한다면, 이 연결이
                실전으로 등록됐지만 키는 테스트넷 키라는 뜻입니다.
              </div>
            </div>
          )}

          {/* Test connection */}
          <button onClick={() => handleTest(selConn)} disabled={testing}
            style={{ width:'100%', padding:'10px', background:T.alt, border:`1px solid ${A(T.acl,'40')}`, borderRadius:10, color:T.acl, fontWeight:700, fontSize:12, cursor: testing ? 'not-allowed' : 'pointer' }}>
            {testing ? '테스트 중…' : '연결 테스트'}
          </button>
          {testMsg && (
            <div style={{ marginTop:8, padding:'8px 12px', background: testMsg.startsWith('✅') ? A(T.grn,'10') : A(T.red,'10'), borderRadius:8, color: testMsg.startsWith('✅') ? T.grn : T.red, fontSize:11 }}>
              {testMsg}
            </div>
          )}

          {/* 이 서버의 IP.
              401·IP 제한 오류의 원인 중 하나가 이것인데, 지금까지 화면이
              "이 서버 IP를 허용 목록에 넣으세요"라고만 하고 그 값은 안
              알려줬다. 여기서 직접 보여준다. */}
          <div style={{ marginTop:10, padding:'10px 12px', background:T.alt, border:`1px solid ${T.border}`, borderRadius:10 }}>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:8 }}>
              <span style={{ color:T.sub, fontSize:11, fontWeight:700 }}>거래소에 보이는 서버 IP</span>
              <button onClick={loadServerIp} disabled={ipBusy} style={{
                padding:'5px 10px', minHeight:0, background:'transparent',
                border:`1px solid ${T.border}`, borderRadius:8,
                color:T.acl, fontSize:10, fontWeight:700, cursor: ipBusy ? 'default' : 'pointer',
              }} className="switch">{ipBusy ? '확인 중…' : '확인'}</button>
            </div>
            {srvIp?.ip && (
              <>
                <div style={{ marginTop:6, color:T.txt, fontSize:14, fontWeight:800, fontVariantNumeric:'tabular-nums', wordBreak:'break-all' }}>
                  {srvIp.ip}
                </div>
                {/* 고정이라고 말하지 않는다. 이 값 하나만 허용 목록에 넣으면
                    지금은 되고 나중에 조용히 막힌다. */}
                <div style={{ marginTop:5, color:T.ylw, fontSize:10, lineHeight:1.55 }}>
                  {srvIp.note}
                </div>
              </>
            )}
            {srvIp?.error && (
              <div style={{ marginTop:6, color:T.red, fontSize:10, lineHeight:1.55 }}>{srvIp.error}</div>
            )}
            {!srvIp && (
              <div style={{ marginTop:5, color:T.muted, fontSize:10, lineHeight:1.55 }}>
                키에 IP 제한을 걸었다면 이 IP를 거래소 허용 목록에 넣어야 합니다.
                내 폰·PC의 IP가 아니라 <b>주문을 보내는 서버</b>의 IP입니다.
              </div>
            )}
          </div>

          {/* 테스트넷 진단 (선물 시스템 검증) */}
          <button onClick={async () => {
            setDiagRunning(true); setDiag(null);
            try {
              let auth = '';
              try {
                const { getSupabaseClient } = await import('@/lib/supabase/client');
                const sbc = getSupabaseClient();
                if (sbc) { const { data } = await sbc.auth.getSession(); if (data?.session?.access_token) auth = `Bearer ${data.session.access_token}`; }
              } catch {}
              const r = await fetch('/api/binance/futures/diagnose', {
                method: 'POST', headers: { 'Content-Type':'application/json', ...(auth?{Authorization:auth}:{}) },
                body: JSON.stringify({ connectionId: selConn.id }),
              });
              const d = await r.json();
              setDiag(d);
            } catch (e:any) { setDiag({ error: e?.message || '진단 실패' }); }
            finally { setDiagRunning(false); }
          }} disabled={diagRunning}
            style={{ width:'100%', marginTop:8, padding:'10px', background:A(T.prp,'15'), border:`1px solid ${A(T.prp,'40')}`, borderRadius:10, color:T.prp, fontWeight:700, fontSize:12, cursor: diagRunning?'not-allowed':'pointer' }}>
            {diagRunning ? '진단 중…' : '테스트넷 진단 (시스템 검증)'}
          </button>
          {diag && !diag.error && (
            <div style={{ marginTop:8, background:T.alt, borderRadius:10, padding:'10px 12px' }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
                <span style={{ color:T.txt, fontWeight:700, fontSize:11 }}>
                  {diag.testnet ? '테스트넷' : '⚠️ 실계좌'} 진단
                </span>
                <span style={{ fontWeight:900, fontSize:13, color: diag.successRate===100?T.grn:diag.successRate>=60?T.ylw:T.red }}>
                  {diag.passed}/{diag.total} · {diag.successRate}%
                </span>
              </div>
              {(diag.checks||[]).map((c:any,i:number)=>(
                <div key={i} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'5px 0', borderBottom:i<diag.checks.length-1?`1px solid ${T.border}`:'none' }}>
                  <span style={{ color: c.ok?T.txt:T.red, fontSize:11 }}>{c.ok?'✅':'❌'} {c.name}</span>
                  <span style={{ color:T.muted, fontSize:9, textAlign:'right', maxWidth:140, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{c.detail} · {c.ms}ms</span>
                </div>
              ))}
              <div style={{ marginTop:8, padding:'7px 10px', borderRadius:7, fontSize:10, lineHeight:1.4,
                background: diag.verdict==='ready'?A(T.grn,'12'):diag.verdict==='partial'?A(T.ylw,'12'):A(T.red,'12'),
                color: diag.verdict==='ready'?T.grn:diag.verdict==='partial'?T.ylw:T.red }}>
                {diag.verdict==='ready' ? '✅ 모든 항목 통과 — 시스템 정상. 소액 실전 테스트 가능' :
                 diag.verdict==='partial' ? '⚠️ 일부 실패 — 실패 항목 확인 후 재시도' :
                 '❌ 다수 실패 — API 키/권한/연결 점검 필요'}
              </div>
            </div>
          )}
          {diag?.error && (
            <div style={{ marginTop:8, padding:'8px 12px', background:A(T.red,'10'), borderRadius:8, color:T.red, fontSize:11 }}>진단 실패: {diag.error}</div>
          )}
        </Card>

        {/* Balances */}
        <Card style={{ marginBottom:10 }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:10 }}>
            <div style={{ color:T.txt, fontWeight:700, fontSize:13 }}>보유 자산</div>
            <button onClick={() => loadBalances(selConn)} disabled={balLoading}
              style={{ padding:'4px 10px', background:T.alt, border:`1px solid ${T.border}`, borderRadius:7, color:T.muted, fontSize:10, cursor:'pointer' }}>
              {balLoading ? '새로고침 중…' : '새로고침'}
            </button>
          </div>

          {balLoading ? (
            <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
              {[0,1,2].map(i=><Skeleton key={i} h={32}/>)}
            </div>
          ) : balErr ? (
            <div style={{ padding:'10px 12px', borderRadius:9, background:A(T.ylw,'12'),
                          color:T.ylw, fontSize:11, lineHeight:1.6 }}>
              {balErr}
            </div>
          ) : balances.length === 0 ? (
            <div style={{ textAlign:'center', padding:'20px 0', color:T.muted, fontSize:12 }}>
              잔고가 없습니다 (0개 자산)
            </div>
          ) : (
            <div>
              {balances.map((b, i) => (
                <div key={i} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'8px 0', borderBottom: i < balances.length-1 ? `1px solid ${T.border}` : 'none' }}>
                  <div>
                    <div style={{ color:T.txt, fontWeight:700, fontSize:12 }}>{b.currency}</div>
                    {b.locked > 0 && <div style={{ color:T.muted, fontSize:9 }}>잠금 {b.locked.toFixed(6)}</div>}
                  </div>
                  <div style={{ textAlign:'right' }}>
                    <div style={{ color:T.txt, fontSize:12, fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums' }}>{b.total.toFixed(b.total > 1000 ? 0 : b.total > 1 ? 2 : 6)}</div>
                    {b.valueKRW && b.valueKRW > 0 && <div style={{ color:T.muted, fontSize:9 }}>≈ ₩{Math.round(b.valueKRW).toLocaleString('ko-KR')}</div>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Auto trading & danger zone */}
        <Card style={{ marginBottom:10 }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
            <div>
              <div style={{ color:T.txt, fontWeight:700, fontSize:12 }}>자동매매</div>
              <div style={{ color:T.muted, fontSize:10 }}>이 계정을 자동매매에 사용</div>
            </div>
            <div style={{ display:'flex', alignItems:'center', gap:8 }}>
              <span style={{ color: selConn.autoTradingEnabled ? T.grn : T.muted, fontSize:11, fontWeight:700 }}>
                {selConn.autoTradingEnabled ? 'ON' : 'OFF'}
              </span>
              <div onClick={() => handleToggleAuto(selConn)} style={{
                width:40, height:22, borderRadius:11, cursor: toggleBusy===selConn.id?'wait':'pointer', position:'relative',
                opacity: toggleBusy===selConn.id ? 0.5 : 1,
                background: selConn.autoTradingEnabled ? T.grn : T.alt,
                border: `1px solid ${selConn.autoTradingEnabled ? T.grn : T.border}`,
                transition:'background .2s',
              }}>
                <div style={{ position:'absolute', top:3, left: selConn.autoTradingEnabled ? 20 : 3, width:14, height:14, borderRadius:'50%', background:'#fff', transition:'left .2s' }}/>
              </div>
            </div>
          </div>
          {selConn.autoTradingEnabled && (
            <div style={{ marginTop:8, background:'#F59E0B10', border:`1px solid ${A(T.ylw,'30')}`, borderRadius:8, padding:'7px 10px', color:T.ylw, fontSize:10 }}>
              ⚠️ 자동매매 활성화됨 · 실주문 기능은 별도 안전장치 승인 후 활성화됩니다
            </div>
          )}
        </Card>

        {/* Delete */}
        <div style={{ background:'#EF444408', border:`1px solid ${A(T.red,'20')}`, borderRadius:12, padding:'12px 14px' }}>
          <div style={{ color:T.red, fontWeight:700, fontSize:11, marginBottom:6 }}>⛔ 위험 구역</div>
          <div style={{ color:'#FCA5A5', fontSize:10, marginBottom:10 }}>연결을 삭제하면 저장된 API 키가 즉시 삭제됩니다</div>
          <button onClick={() => handleDelete(selConn.id)}
            style={{ width:'100%', padding:'10px', background:'transparent', border:`1px solid ${A(T.red,'50')}`, borderRadius:10, color:T.red, fontWeight:700, fontSize:12, cursor:'pointer' }}>
            🗑️ 이 거래소 연결 삭제
          </button>
        </div>
      </div>
    );
  }

  return null;
}
