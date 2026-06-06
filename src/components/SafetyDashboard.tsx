'use client';
import React, { useState, useEffect, useCallback } from 'react';

const T = {
  bg:'#060B14', card:'#0A1628', surf:'#0D1F3C', alt:'#0F2040',
  border:'#1A2D4A', border2:'#243A5E',
  txt:'#E2E8F0', sub:'#94A3B8', muted:'#475569',
  grn:'#10B981', red:'#EF4444', ylw:'#F59E0B',
  acl:'#60A5FA', acc:'#2563EB', acg:'#1E3A5F',
} as const;

// ── Risk Disclosure Modal ─────────────────────────────────────
export function RiskDisclosureModal({
  onAgree,
  onDecline,
}: {
  onAgree: () => void;
  onDecline: () => void;
}) {
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const items = [
    'automated_risk',
    'no_guarantee',
    'loss_possible',
    'withdrawal_disabled',
    'my_responsibility',
  ];
  const labels: Record<string, string> = {
    automated_risk:    '자동매매는 시스템 오류, API 장애, 시장 급변 등으로 예상치 못한 손실이 발생할 수 있습니다',
    no_guarantee:      'TRAIGO는 수익을 보장하지 않으며, AI/전략 추천은 참고 목적입니다',
    loss_possible:     '실거래 전환 후 발생하는 모든 손익은 본인 책임이며, TRAIGO는 배상 책임이 없습니다',
    withdrawal_disabled: 'API 키에 출금 권한을 부여하지 않았으며, 출금 권한 키는 시스템에서 거부됩니다',
    my_responsibility: '위 모든 내용을 충분히 이해하고 본인 판단으로 실거래를 활성화합니다',
  };

  const allChecked = items.every(i => checks[i]);

  return (
    <div style={{ position:'fixed', inset:0, zIndex:600, background:'rgba(0,0,0,.88)', display:'flex', alignItems:'center', justifyContent:'center', padding:16 }}>
      <div style={{ background:T.card, border:`1px solid ${T.red}40`, borderRadius:18, padding:20, maxWidth:440, width:'100%', maxHeight:'80vh', overflowY:'auto' }}>
        <div style={{ color:T.red, fontWeight:900, fontSize:16, marginBottom:4 }}>⚠️ 실거래 전환 위험고지</div>
        <div style={{ color:T.muted, fontSize:11, marginBottom:14 }}>아래 모든 항목에 동의해야 실거래가 활성화됩니다</div>

        <div style={{ background:'#EF444408', border:`1px solid ${T.red}25`, borderRadius:10, padding:'10px 14px', marginBottom:14 }}>
          <div style={{ color:T.red, fontSize:10, fontWeight:700, marginBottom:6 }}>🚨 이것은 실제 자산 거래입니다</div>
          <div style={{ color:'#FCA5A5', fontSize:10, lineHeight:1.7 }}>
            모의투자와 달리 실거래는 실제 금전 손실이 발생할 수 있습니다.<br/>
            레버리지 사용 시 원금 전액 손실(청산)도 발생할 수 있습니다.
          </div>
        </div>

        {(Array.isArray(items)?items:[]).map(item => (
          <div key={item}
            onClick={() => setChecks(p => ({...p, [item]: !p[item]}))}
            style={{
              display:'flex', gap:10, alignItems:'flex-start', padding:'10px 0',
              borderBottom:`1px solid ${T.border}`, cursor:'pointer',
            }}>
            <div style={{
              width:18, height:18, borderRadius:5, flexShrink:0, marginTop:1,
              background: checks[item] ? T.grn : 'transparent',
              border: `2px solid ${checks[item] ? T.grn : T.border}`,
              display:'flex', alignItems:'center', justifyContent:'center',
              fontSize:11, color:'#fff',
            }}>
              {checks[item] ? '✓' : ''}
            </div>
            <div style={{ color: checks[item] ? T.txt : T.sub, fontSize:11, lineHeight:1.5 }}>
              {labels[item]}
            </div>
          </div>
        ))}

        <div style={{ display:'flex', gap:8, marginTop:16 }}>
          <button onClick={onDecline}
            style={{ flex:1, padding:'11px', background:'transparent', border:`1px solid ${T.border}`, borderRadius:10, color:T.muted, fontWeight:700, fontSize:12, cursor:'pointer' }}>
            취소
          </button>
          <button onClick={allChecked ? onAgree : undefined}
            style={{
              flex:2, padding:'11px',
              background: allChecked ? T.red : T.alt,
              border: `1px solid ${allChecked ? T.red : T.border}`,
              borderRadius:10, color: allChecked ? '#fff' : T.muted,
              fontWeight:800, fontSize:13, cursor: allChecked ? 'pointer' : 'not-allowed',
              opacity: allChecked ? 1 : 0.6,
            }}>
            {allChecked ? '실거래 활성화' : `${items.filter(i=>!checks[i]).length}개 항목 동의 필요`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Pre-order Estimation Card ─────────────────────────────────
export function PreOrderEstimate({
  entryPrice, quantity, leverage, exchange, side, stopLoss, takeProfit,
}: {
  entryPrice: number; quantity: number; leverage: number;
  exchange: string; side: 'buy'|'sell'; stopLoss?: number; takeProfit?: number;
}) {
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const validate = useCallback(async () => {
    if (!entryPrice || !quantity) return;
    setLoading(true);
    try {
      const r = await fetch('/api/safety', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'validate-order', exchange, side,
          symbol: 'BTCUSDT', quantity, price: entryPrice,
          leverage, stopLoss, takeProfit, mode: 'paper',
        }),
      });
      setResult(await r.json());
    } catch { setResult(null); }
    finally { setLoading(false); }
  }, [entryPrice, quantity, leverage, exchange, side, stopLoss, takeProfit]);

  useEffect(() => { validate(); }, [validate]);

  if (loading) return (
    <div style={{ background:T.card, border:`1px solid ${T.border}`, borderRadius:12, padding:'12px 14px' }}>
      <div style={{ color:T.muted, fontSize:11 }}>예상 비용 계산 중…</div>
    </div>
  );

  if (!result) return null;

  const fmt = (v: number) => v >= 10000 ? '₩'+Math.round(v).toLocaleString() : '₩'+v.toFixed(0);

  return (
    <div style={{ background:T.card, border:`1px solid ${result.allowed ? T.acl+'40' : T.red+'40'}`, borderRadius:12, padding:'12px 14px' }}>
      <div style={{ display:'flex', justifyContent:'space-between', marginBottom:8 }}>
        <div style={{ color:T.txt, fontWeight:700, fontSize:12 }}>예상 비용 분석</div>
        <div style={{ background: result.allowed ? T.grn+'20' : T.red+'20', border:`1px solid ${result.allowed?T.grn:T.red}40`, borderRadius:6, padding:'2px 8px', color: result.allowed?T.grn:T.red, fontSize:10, fontWeight:700 }}>
          {result.allowed ? '✅ 진입 가능' : '❌ 차단됨'}
        </div>
      </div>

      <div className="mobile-1col" style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:6, marginBottom:8 }}>
        {[
          { label:'수수료 (예상)', value: fmt(result.estimatedFee||0), color:T.ylw },
          { label:'슬리피지', value: fmt(result.estimatedSlip||0), color:T.ylw },
          { label:'최대 손실', value: fmt(result.maxLoss||0), color:T.red },
        ].map(m => (
          <div key={m.label} style={{ background:T.alt, borderRadius:8, padding:'6px 8px', textAlign:'center' }}>
            <div style={{ color:T.muted, fontSize:8, marginBottom:2 }}>{m.label}</div>
            <div style={{ color:m.color, fontSize:11, fontWeight:700 }}>{m.value}</div>
          </div>
        ))}
      </div>

      {result.liquidationPx && (
        <div style={{ background:'#EF444410', border:`1px solid ${T.red}30`, borderRadius:8, padding:'6px 10px', marginBottom:6 }}>
          <div style={{ color:T.red, fontSize:10 }}>청산가: <strong>{fmt(result.liquidationPx)}</strong></div>
        </div>
      )}

      {result.blockers?.map((b: string, i: number) => (
        <div key={i} style={{ background:'#EF444408', border:`1px solid ${T.red}30`, borderRadius:7, padding:'5px 9px', marginBottom:4, color:T.red, fontSize:10 }}>🚫 {b}</div>
      ))}
      {result.warnings?.map((w: string, i: number) => (
        <div key={i} style={{ background:'#F59E0B08', border:`1px solid ${T.ylw}30`, borderRadius:7, padding:'5px 9px', marginBottom:4, color:T.ylw, fontSize:10 }}>{w}</div>
      ))}
    </div>
  );
}

// ── Safety Dashboard (main page) ──────────────────────────────
export default function SafetyDashboard() {
  const [status, setStatus] = useState<any>(null);
  const [auditLog, setAuditLog] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [killReason, setKillReason] = useState('');
  const [activatingKill, setActivatingKill] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const [s, a] = await Promise.all([
        fetch('/api/safety?action=status').then(r => r.json()),
        fetch('/api/safety?action=audit&limit=20').then(r => r.json()),
      ]);
      setStatus(s);
      setAuditLog(a.events || []);
    } catch {}
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  const handleKillSwitch = async (on: boolean) => {
    if (on && !killReason.trim()) { alert('정지 이유를 입력하세요'); return; }
    setActivatingKill(true);
    try {
      await fetch('/api/safety', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-secret': 'traigo-admin-dev' },
        body: JSON.stringify({ action: on ? 'kill-switch-on' : 'kill-switch-off', reason: killReason }),
      });
      setKillReason('');
      await loadStatus();
    } finally { setActivatingKill(false); }
  };

  if (loading) return (
    <div style={{ color:T.muted, textAlign:'center', padding:'40px 0' }}>안전 상태 로딩 중…</div>
  );

  const ks = status?.killSwitch;
  const dl = status?.dailyLossKRW || 0;
  const cl = status?.consecutiveLoss || 0;

  return (
    <div style={{ color:T.txt }}>
      {/* Header */}
      <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:14 }}>
        <div style={{ width:32, height:32, borderRadius:10, background:'linear-gradient(135deg,#EF4444,#7C3AED)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:16 }}>🛡️</div>
        <div>
          <div style={{ fontWeight:900, fontSize:15 }}>안전 제어판</div>
          <div style={{ color:T.muted, fontSize:10 }}>긴급 정지 · 손실 한도 · 감사 로그</div>
        </div>
        <button onClick={loadStatus} style={{ marginLeft:'auto', padding:'5px 12px', background:T.alt, border:`1px solid ${T.border}`, borderRadius:8, color:T.muted, fontSize:10, cursor:'pointer' }}>🔄</button>
      </div>

      {/* Kill switch */}
      <div style={{ background: ks?.active ? '#EF444415' : T.card, border:`2px solid ${ks?.active ? T.red : T.border}`, borderRadius:14, padding:'14px 16px', marginBottom:10 }}>
        <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8 }}>
          <div style={{ width:10, height:10, borderRadius:'50%', background: ks?.active ? T.red : T.grn, boxShadow: ks?.active ? `0 0 8px ${T.red}` : 'none' }}/>
          <div style={{ fontWeight:800, fontSize:13, color: ks?.active ? T.red : T.txt }}>
            {ks?.active ? '🚨 긴급 정지 활성화됨' : '자동매매 정상 운영 중'}
          </div>
        </div>
        {ks?.active && (
          <div style={{ background:'#EF444420', borderRadius:8, padding:'8px 10px', marginBottom:10, color:'#FCA5A5', fontSize:11 }}>
            이유: {ks.reason}<br/>
            활성화: {new Date(ks.activatedAt).toLocaleString('ko-KR')}
          </div>
        )}

        {!ks?.active ? (
          <div style={{ display:'flex', gap:8 }}>
            <input value={killReason} onChange={e => setKillReason(e.target.value)}
              placeholder="정지 이유 입력…"
              style={{ flex:1, background:T.bg, border:`1px solid ${T.border}`, borderRadius:8, padding:'8px 12px', color:T.txt, fontSize:12, outline:'none' }}/>
            <button onClick={() => handleKillSwitch(true)} disabled={activatingKill || !killReason.trim()}
              style={{ padding:'8px 16px', background:T.red+'20', border:`1px solid ${T.red}60`, borderRadius:8, color:T.red, fontWeight:700, fontSize:11, cursor:'pointer' }}>
              🛑 전체 정지
            </button>
          </div>
        ) : (
          <button onClick={() => handleKillSwitch(false)} disabled={activatingKill}
            style={{ width:'100%', padding:'10px', background:T.grn+'20', border:`1px solid ${T.grn}60`, borderRadius:10, color:T.grn, fontWeight:700, fontSize:12, cursor:'pointer' }}>
            ✅ 긴급 정지 해제
          </button>
        )}
      </div>

      {/* Risk metrics */}
      <div className="mobile-1col" style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginBottom:10 }}>
        <div style={{ background:T.card, border:`1px solid ${dl > 300000 ? T.red+'60' : T.border}`, borderRadius:12, padding:'12px' }}>
          <div style={{ color:T.muted, fontSize:9, marginBottom:4 }}>오늘 누적 손실</div>
          <div style={{ color: dl > 300000 ? T.red : dl > 100000 ? T.ylw : T.grn, fontWeight:800, fontSize:16 }}>
            ₩{dl.toLocaleString()}
          </div>
          <div style={{ marginTop:4, height:4, background:T.alt, borderRadius:2, overflow:'hidden' }}>
            <div style={{ height:'100%', width:`${Math.min(100, dl/500000*100)}%`, background: dl>300000?T.red:T.ylw, borderRadius:2, transition:'width .3s' }}/>
          </div>
          <div style={{ color:T.muted, fontSize:8, marginTop:2 }}>한도 ₩500,000</div>
        </div>
        <div style={{ background:T.card, border:`1px solid ${cl >= 2 ? T.ylw+'60' : T.border}`, borderRadius:12, padding:'12px' }}>
          <div style={{ color:T.muted, fontSize:9, marginBottom:4 }}>연속 손실 횟수</div>
          <div style={{ color: cl >= 3 ? T.red : cl >= 2 ? T.ylw : T.grn, fontWeight:800, fontSize:28 }}>
            {cl} <span style={{ fontSize:12, color:T.muted }}>/ 3</span>
          </div>
          <div style={{ color: cl >= 2 ? T.ylw : T.muted, fontSize:10, marginTop:4 }}>
            {cl >= 3 ? '🛑 쿨다운 중' : cl >= 2 ? '⚠️ 주의 필요' : '✅ 정상'}
          </div>
        </div>
      </div>

      {/* Audit log */}
      <div style={{ background:T.card, border:`1px solid ${T.border}`, borderRadius:14, overflow:'hidden', marginBottom:10 }}>
        <div style={{ padding:'10px 14px', borderBottom:`1px solid ${T.border}`, display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <div style={{ color:T.txt, fontWeight:700, fontSize:12 }}>감사 로그</div>
          <div style={{ color:T.muted, fontSize:9 }}>최근 {auditLog.length}건</div>
        </div>
        {auditLog.length === 0 ? (
          <div style={{ padding:'20px', textAlign:'center', color:T.muted, fontSize:11 }}>감사 기록 없음</div>
        ) : (Array.isArray(auditLog)?auditLog:[]).map((e, i) => (
          <div key={e.id} style={{ padding:'9px 14px', borderBottom: i < auditLog.length-1 ? `1px solid ${T.border}` : 'none', display:'flex', gap:8, alignItems:'flex-start' }}>
            <div style={{
              width:7, height:7, borderRadius:'50%', marginTop:4, flexShrink:0,
              background: e.result==='success' ? T.grn : e.result==='blocked' ? T.ylw : T.red,
            }}/>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                <div style={{ color:T.txt, fontSize:11, fontWeight:600 }}>{e.action}</div>
                <div style={{ color:T.muted, fontSize:9, flexShrink:0 }}>
                  {new Date(e.createdAt).toLocaleTimeString('ko-KR')}
                </div>
              </div>
              <div style={{ color:T.muted, fontSize:9 }}>
                {e.resource} · {e.result}
                {e.detail?.blocked ? ` · 차단됨` : ''}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Security info */}
      <div style={{ background:'#2563EB08', border:`1px solid ${T.acl}20`, borderRadius:12, padding:'12px 14px' }}>
        <div style={{ color:T.acl, fontWeight:700, fontSize:11, marginBottom:6 }}>🔐 보안 아키텍처</div>
        <div style={{ color:'#93C5FD', fontSize:10, lineHeight:1.7 }}>
          ✅ 웹훅 중복 방지 (24h 아이덴티컨시 키)<br/>
          ✅ 실거래 이중 확인 필수<br/>
          ✅ 출금 권한 키 자동 거부<br/>
          ✅ 일일 손실 한도 자동 정지<br/>
          ✅ 연속 손실 시 쿨다운<br/>
          ✅ 전체 긴급 정지 스위치<br/>
          ✅ 모든 작업 감사 로그 기록
        </div>
      </div>
    </div>
  );
}
