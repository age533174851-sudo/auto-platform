'use client';
import React, { useState, useEffect, useCallback } from 'react';
import { EXCHANGE_META } from '@/lib/exchanges/types';
import type { ExchangeId, ConnectedExchange } from '@/lib/exchanges/types';

// ── Theme ─────────────────────────────────────────────────────
const T = {
  bg:'#060B14', card:'#0A1628', surf:'#0D1F3C', alt:'#0F2040',
  border:'#1A2D4A', border2:'#243A5E',
  txt:'#E2E8F0', sub:'#94A3B8', muted:'#475569',
  grn:'#10B981', red:'#EF4444', ylw:'#F59E0B',
  acl:'#60A5FA', acc:'#2563EB', acg:'#1E3A5F', prp:'#7C3AED',
} as const;

// ── Exchange order & display ──────────────────────────────────
const EXCHANGES: ExchangeId[] = ['binance','bybit','okx','gate','upbit','bithumb'];

// ── Loading skeleton ──────────────────────────────────────────
function Skeleton({ w='100%', h=14 }: { w?: string|number; h?: number }) {
  return <div style={{ width:w, height:h, borderRadius:6, background:'linear-gradient(90deg,#1A2D4A 25%,#243A5E 50%,#1A2D4A 75%)', backgroundSize:'200% 100%', animation:'shimmer 1.2s infinite' }}/>;
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
  const [testing,      setTesting]      = useState(false);
  const [testMsg,      setTestMsg]      = useState('');

  // ── Load connections ────────────────────────────────────────
  const loadConnections = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/exchange?action=list');
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
      const r = await fetch('/api/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'connect', exchange: selExchange,
          apiKey: apiKey.trim(), apiSecret: apiSecret.trim(),
          passphrase: passphrase.trim() || undefined,
          nickname: nickname.trim() || meta.nameKr,
          isTestnet: selExchange === 'binance' ? isTestnet : false,
        }),
      });
      const d = await r.json();
      if (!r.ok || d.error) {
        setConnectErr(d.error || '연결 실패');
      } else {
        setConnectOk(true);
        setApiKey(''); setApiSecret(''); setPassphrase(''); setNickname('');
        await loadConnections();
        setTimeout(() => setView('list'), 1500);
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
      const r = await fetch('/api/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'test', connectionId: conn.id }),
      });
      const d = await r.json();
      setTestMsg(d.success ? `✅ ${d.message} (${d.latencyMs}ms)` : `❌ ${d.message}`);
      await loadConnections();
    } catch { setTestMsg('❌ 테스트 실패'); }
    finally { setTesting(false); }
  };

  // ── Load balances ───────────────────────────────────────────
  const loadBalances = async (conn: ConnectedExchange) => {
    setBalLoading(true); setBalances([]);
    try {
      const r = await fetch(`/api/exchange?action=balances&id=${conn.id}`);
      const d = await r.json();
      setBalances(d.balances || []);
    } catch { setBalances([]); }
    finally { setBalLoading(false); }
  };

  // ── Delete ──────────────────────────────────────────────────
  const handleDelete = async (id: string) => {
    if (!confirm('이 거래소 연결을 삭제하시겠습니까?\n저장된 API 키는 즉시 삭제됩니다.')) return;
    try {
      await fetch('/api/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', connectionId: id }),
      });
      await loadConnections();
      if (selConn?.id === id) setView('list');
    } catch {}
  };

  // ── Toggle auto trading ──────────────────────────────────────
  const handleToggleAuto = async (conn: ConnectedExchange) => {
    try {
      await fetch('/api/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'toggle-auto', connectionId: conn.id, enabled: !conn.autoTradingEnabled }),
      });
      await loadConnections();
    } catch {}
  };

  const meta = EXCHANGE_META[selExchange];
  const connectedIds = new Set(connections.map(c => c.exchange));

  // ════════════════════════════════════════════════════════════
  // VIEW: LIST
  // ════════════════════════════════════════════════════════════
  if (view === 'list') return (
    <div>
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
      <div style={{ background:'#F59E0B0F', border:`1px solid ${T.ylw}30`, borderRadius:12, padding:'10px 14px', marginBottom:14 }}>
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
                    </div>
                    <div style={{ color:T.muted, fontSize:10 }}>{conn.apiKeyMasked} · {ex.name}</div>
                    <div style={{ display:'flex', gap:4, marginTop:4, flexWrap:'wrap' }}>
                      {conn.permissions.read     && <span style={{ background:T.grn+'20', color:T.grn,   fontSize:8, padding:'1px 5px', borderRadius:4 }}>조회</span>}
                      {conn.permissions.trading  && <span style={{ background:T.ylw+'20', color:T.ylw,   fontSize:8, padding:'1px 5px', borderRadius:4 }}>거래</span>}
                      {conn.permissions.withdrawal && <span style={{ background:T.red+'20', color:T.red, fontSize:8, padding:'1px 5px', borderRadius:4 }}>⚠️ 출금</span>}
                    </div>
                  </div>
                  <div style={{ display:'flex', flexDirection:'column', gap:5, alignItems:'flex-end' }}>
                    <button onClick={() => { setSelConn(conn); setView('detail'); loadBalances(conn); setTestMsg(''); }}
                      style={{ padding:'5px 10px', background:T.alt, border:`1px solid ${T.border}`, borderRadius:8, color:T.sub, fontSize:10, fontWeight:700, cursor:'pointer' }}>
                      상세
                    </button>
                    <button onClick={() => handleDelete(conn.id)}
                      style={{ padding:'4px 10px', background:'transparent', border:`1px solid ${T.red}30`, borderRadius:8, color:T.red, fontSize:10, cursor:'pointer' }}>
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
                        width:36, height:20, borderRadius:10, cursor:'pointer', position:'relative', flexShrink:0,
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
              style={{ color:T.acl, fontSize:10 }}>📖 API 키 발급 가이드 →</a>
          </div>
        </div>

        {/* Security reminder */}
        <div style={{ background:'#EF444410', border:`1px solid ${T.red}30`, borderRadius:10, padding:'10px 14px', marginBottom:14 }}>
          <div style={{ color:T.red, fontSize:10, fontWeight:700, marginBottom:3 }}>⚠️ 반드시 확인하세요</div>
          <div style={{ color:'#FCA5A5', fontSize:10, lineHeight:1.6 }}>
            ✗ <strong>출금(Withdrawal) 권한은 절대 부여하지 마세요</strong><br/>
            ✓ 읽기(Read) 권한만, 또는 읽기+거래(Trade) 권한만 부여<br/>
            ⚠ Vercel은 고정 IP가 아닐 수 있어 IP 제한 시 차단될 수 있습니다. 실전 운영 시 고정 IP 서버/VPS 사용 권장.
          </div>
        </div>

        {/* Inputs */}
        <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
          {/* 테스트넷/실전 토글 (binance만) */}
          {selExchange === 'binance' && (
            <div>
              <div style={{ color:T.sub, fontSize:11, marginBottom:4 }}>연결 환경</div>
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
                {isTestnet
                  ? '테스트넷(데모): demo-fapi.binance.com · developers.binance.com 데모 모드에서 발급한 키를 사용하세요. 실제 돈이 들지 않습니다.'
                  : '⚠️ 실전: fapi.binance.com 실계정 키. 실제 자금이 사용됩니다.'}
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
              style={{ width:'100%', background:T.bg, border:`1px solid ${T.border}`, borderRadius:10, padding:'10px 14px', color:T.txt, fontSize:12, outline:'none', fontFamily:'monospace', boxSizing:'border-box' }}/>
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
              style={{ width:'100%', background:T.bg, border:`1px solid ${T.border}`, borderRadius:10, padding:'10px 14px', color:T.txt, fontSize:12, outline:'none', fontFamily:'monospace', boxSizing:'border-box' }}/>
            <div style={{ color:T.muted, fontSize:9, marginTop:3 }}>🔐 입력 즉시 AES-256 암호화 · 화면에 절대 저장 안됨</div>
          </div>
          {meta.hasPassphrase && (
            <div>
              <div style={{ color:T.sub, fontSize:11, marginBottom:4 }}>Passphrase <span style={{ color:T.red }}>*</span></div>
              <input value={passphrase} onChange={e => setPassphrase(e.target.value)}
                type="password" placeholder="Passphrase를 입력하세요"
                style={{ width:'100%', background:T.bg, border:`1px solid ${T.border}`, borderRadius:10, padding:'10px 14px', color:T.txt, fontSize:12, outline:'none', fontFamily:'monospace', boxSizing:'border-box' }}/>
            </div>
          )}
        </div>

        {/* Error / success */}
        {connectErr && (
          <div style={{ marginTop:12, background:'#EF444415', border:`1px solid ${T.red}40`, borderRadius:10, padding:'10px 14px', color:T.red, fontSize:11, lineHeight:1.5, whiteSpace:'pre-wrap' }}>{connectErr}</div>
        )}
        {connectOk && (
          <div style={{ marginTop:12, background:'#10B98115', border:`1px solid ${T.grn}40`, borderRadius:10, padding:'10px 14px', color:T.grn, fontSize:12, fontWeight:700 }}>
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
                <div style={{ fontSize:14 }}>{k==='read'?'👁':k==='trading'?'⚡':'⚠️'}</div>
                <div style={{ color: selConn.permissions[k] ? c : T.muted, fontSize:9, fontWeight:700 }}>{l}</div>
                <div style={{ color: selConn.permissions[k] ? c : T.muted, fontSize:8 }}>{selConn.permissions[k]?'허용':'없음'}</div>
              </div>
            ))}
          </div>

          {/* Test connection */}
          <button onClick={() => handleTest(selConn)} disabled={testing}
            style={{ width:'100%', padding:'10px', background:T.alt, border:`1px solid ${T.acl}40`, borderRadius:10, color:T.acl, fontWeight:700, fontSize:12, cursor: testing ? 'not-allowed' : 'pointer' }}>
            {testing ? '테스트 중…' : '연결 테스트'}
          </button>
          {testMsg && (
            <div style={{ marginTop:8, padding:'8px 12px', background: testMsg.startsWith('✅') ? T.grn+'10' : T.red+'10', borderRadius:8, color: testMsg.startsWith('✅') ? T.grn : T.red, fontSize:11 }}>
              {testMsg}
            </div>
          )}

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
            style={{ width:'100%', marginTop:8, padding:'10px', background:T.prp+'15', border:`1px solid ${T.prp}40`, borderRadius:10, color:T.prp, fontWeight:700, fontSize:12, cursor: diagRunning?'not-allowed':'pointer' }}>
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
                background: diag.verdict==='ready'?T.grn+'12':diag.verdict==='partial'?T.ylw+'12':T.red+'12',
                color: diag.verdict==='ready'?T.grn:diag.verdict==='partial'?T.ylw:T.red }}>
                {diag.verdict==='ready' ? '✅ 모든 항목 통과 — 시스템 정상. 소액 실전 테스트 가능' :
                 diag.verdict==='partial' ? '⚠️ 일부 실패 — 실패 항목 확인 후 재시도' :
                 '❌ 다수 실패 — API 키/권한/연결 점검 필요'}
              </div>
            </div>
          )}
          {diag?.error && (
            <div style={{ marginTop:8, padding:'8px 12px', background:T.red+'10', borderRadius:8, color:T.red, fontSize:11 }}>진단 실패: {diag.error}</div>
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
          ) : balances.length === 0 ? (
            <div style={{ textAlign:'center', padding:'20px 0', color:T.muted, fontSize:12 }}>
              잔고 없음 또는 조회 실패
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
                    <div style={{ color:T.txt, fontSize:12, fontFamily:'monospace' }}>{b.total.toFixed(b.total > 1000 ? 0 : b.total > 1 ? 2 : 6)}</div>
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
              <div onClick={() => handleToggleAuto(selConn).then(() => {
                setSelConn(prev => prev ? {...prev, autoTradingEnabled: !prev.autoTradingEnabled} : prev);
              })} style={{
                width:40, height:22, borderRadius:11, cursor:'pointer', position:'relative',
                background: selConn.autoTradingEnabled ? T.grn : T.alt,
                border: `1px solid ${selConn.autoTradingEnabled ? T.grn : T.border}`,
                transition:'background .2s',
              }}>
                <div style={{ position:'absolute', top:3, left: selConn.autoTradingEnabled ? 20 : 3, width:14, height:14, borderRadius:'50%', background:'#fff', transition:'left .2s' }}/>
              </div>
            </div>
          </div>
          {selConn.autoTradingEnabled && (
            <div style={{ marginTop:8, background:'#F59E0B10', border:`1px solid ${T.ylw}30`, borderRadius:8, padding:'7px 10px', color:T.ylw, fontSize:10 }}>
              ⚠️ 자동매매 활성화됨 · 실주문 기능은 별도 안전장치 승인 후 활성화됩니다
            </div>
          )}
        </Card>

        {/* Delete */}
        <div style={{ background:'#EF444408', border:`1px solid ${T.red}20`, borderRadius:12, padding:'12px 14px' }}>
          <div style={{ color:T.red, fontWeight:700, fontSize:11, marginBottom:6 }}>⛔ 위험 구역</div>
          <div style={{ color:'#FCA5A5', fontSize:10, marginBottom:10 }}>연결을 삭제하면 저장된 API 키가 즉시 삭제됩니다</div>
          <button onClick={() => handleDelete(selConn.id)}
            style={{ width:'100%', padding:'10px', background:'transparent', border:`1px solid ${T.red}50`, borderRadius:10, color:T.red, fontWeight:700, fontSize:12, cursor:'pointer' }}>
            🗑️ 이 거래소 연결 삭제
          </button>
        </div>
      </div>
    );
  }

  return null;
}
