'use client';
// src/components/pages/AiUsagePage.tsx
//
// AI·데이터 관리센터 — 공급자 상태 · 응답시간 · 오류 · 예상 비용.
//
// 이 화면이 조심하는 것
// ─────────────────────
// 숫자가 있으면 사람은 그걸 사실로 읽는다. 여기 있는 금액은 공시가로
// 계산한 **추정치**이고, 단가표에 없는 모델은 아예 빠져 있다. 그래서
// 총액에 '이상'을 붙이고 무엇이 빠졌는지 같이 적는다. 정확한 척하는
// 숫자 하나가 안 보여주는 것보다 나쁘다.
import React, { useCallback, useEffect, useState } from 'react';
import { errorTextOf } from '@/lib/http/errorText';
import { T } from '@/lib/constants';
import { A } from '@/lib/theme/colors';
import { Cpu, RefreshCw, AlertTriangle, Clock, DollarSign } from 'lucide-react';

interface ProviderStat {
  id: string; label: string; configured: boolean;
  calls: number; ok: number; failed: number;
  successRate: number | null;
  latencyMedianMs: number | null;
  cost: { label: string; usd: number | null; isPartial: boolean; unpricedCalls: number; untokenedCalls: number };
  recentErrors: { at: string; text: string }[];
}

interface UsageData {
  ok: boolean;
  days: number;
  providers: ProviderStat[];
  total: { calls: number; failed: number; cost: { label: string; isPartial: boolean } };
  defaultProvider: string | null;
  fallbacks: string[];
  pricingAsOf: string;
  pricingNote: string;
  logWarning: string | null;
}

const card = (extra: React.CSSProperties = {}): React.CSSProperties => ({
  background: T.card, border: `1px solid ${T.border}`, borderRadius: 14,
  padding: '14px 16px', ...extra,
});

export default function AiUsagePage() {
  const [d, setD] = useState<UsageData | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [denied, setDenied] = useState(false);
  const [days, setDays] = useState(1);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      let auth = '';
      try {
        const { getSupabaseClient } = await import('@/lib/supabase/client');
        const sbc = getSupabaseClient();
        if (sbc) {
          const { data } = await sbc.auth.getSession();
          if (data?.session?.access_token) auth = `Bearer ${data.session.access_token}`;
        }
      } catch {}
      const r = await fetch(`/api/ai/usage?days=${days}`, {
        headers: auth ? { Authorization: auth } : {},
      });
      const j = await r.json();
      if (r.status === 403) {
        // 권한 없음을 '조회 실패'로 뭉개지 않는다. 사용자가 뭘 해야
        // 하는지가 완전히 다르다 — 다시 시도할 일이 아니라 계정 문제다.
        setDenied(true); setErr(''); setD(null); return;
      }
      if (!r.ok || !j?.ok) { setErr(errorTextOf(j, `조회 실패 (${r.status})`)); setD(null); return; }
      setDenied(false);
      setErr(''); setD(j);
    } catch (e: any) { setErr(`조회 실패: ${e?.message || e}`); }
    finally { setBusy(false); }
  }, [days]);

  useEffect(() => { load(); }, [load]);

  if (denied) {
    return (
      <div style={card({ textAlign: 'center', padding: '40px 24px' })}>
        <Cpu size={26} color={T.muted}/>
        <div style={{ color: T.txt, fontSize: 15, fontWeight: 700, margin: '12px 0 6px' }}>
          관리자 전용 화면입니다
        </div>
        <div style={{ color: T.muted, fontSize: 12, lineHeight: 1.6 }}>
          여기에는 전체 사용자의 AI 호출량과 비용이 나옵니다.
          권한이 필요하면 계정 관리자에게 문의하세요.
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{
          width: 38, height: 38, borderRadius: 11, background: A(T.prp, '20'),
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}><Cpu size={19} color={T.prp}/></span>
        <div style={{ flex: 1 }}>
          <div style={{ color: T.txt, fontSize: 17, fontWeight: 800 }}>AI 관리센터</div>
          <div style={{ color: T.muted, fontSize: 11 }}>공급자 상태 · 응답시간 · 예상 비용</div>
        </div>
        <button onClick={load} disabled={busy} style={{
          background: T.alt, border: `1px solid ${T.border}`, borderRadius: 10,
          width: 36, height: 36, cursor: 'pointer', color: T.sub,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}><RefreshCw size={16} style={busy ? { animation: 'spin 1s linear infinite' } : undefined}/></button>
      </div>

      <div style={{ display: 'flex', gap: 6 }}>
        {[1, 7, 30].map(n => (
          <button key={n} onClick={() => setDays(n)} style={{
            flex: 1, padding: '8px', borderRadius: 9, cursor: 'pointer',
            background: days === n ? A(T.acl, '20') : T.alt,
            color: days === n ? T.acl : T.sub,
            border: `1px solid ${days === n ? T.acl : T.border}`,
            fontSize: 12, fontWeight: 700,
          }}>{n === 1 ? '오늘' : `${n}일`}</button>
        ))}
      </div>

      {err && (
        <div style={card({ background: A(T.red, '12'), borderColor: A(T.red, '35'), color: T.red, fontSize: 12, lineHeight: 1.55 })}>
          {err}
        </div>
      )}

      {/* 기록 자체가 없는 것과 호출이 없는 것을 구분해 준다 */}
      {d?.logWarning && (
        <div style={card({ background: A(T.ylw, '12'), borderColor: A(T.ylw, '35'), color: T.ylw, fontSize: 11, lineHeight: 1.6, display: 'flex', gap: 8 })}>
          <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }}/>
          <span>{d.logWarning}</span>
        </div>
      )}

      {d && (
        <>
          <div style={card()}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
              <DollarSign size={15} color={T.grn}/>
              <span style={{ color: T.txt, fontSize: 22, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>
                {d.total.cost.label}
              </span>
              <span style={{ color: T.muted, fontSize: 11 }}>
                호출 {d.total.calls}건{d.total.failed > 0 ? ` · 실패 ${d.total.failed}` : ''}
              </span>
            </div>
            {/* 추정이라는 것과 언제 기준인지를 금액 바로 아래에 둔다 */}
            <div style={{ color: T.muted, fontSize: 10, lineHeight: 1.6 }}>
              {d.pricingNote} 단가 기준 {d.pricingAsOf}.
              {d.total.cost.isPartial && ' 단가나 토큰 수를 모르는 호출이 있어 실제 금액은 이보다 큽니다.'}
            </div>
          </div>

          {d.providers.map(p => (
            <div key={p.id} style={card({
              borderLeft: `3px solid ${p.configured ? (p.failed > 0 ? T.ylw : T.grn) : T.border}`,
            })}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <span style={{ color: T.txt, fontSize: 14, fontWeight: 800 }}>{p.label}</span>
                <span style={{
                  padding: '2px 8px', borderRadius: 5, fontSize: 10, fontWeight: 700,
                  background: p.configured ? A(T.grn, '18') : T.alt,
                  color: p.configured ? T.grn : T.muted,
                }}>{p.configured ? '키 있음' : '키 없음'}</span>
                {d.defaultProvider === p.id && (
                  <span style={{
                    padding: '2px 8px', borderRadius: 5, fontSize: 10, fontWeight: 700,
                    background: A(T.acl, '18'), color: T.acl,
                  }}>기본</span>
                )}
              </div>

              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <Stat k="호출" v={String(p.calls)}/>
                {/* 호출이 0건인데 성공률 100%로 적으면 '완벽 동작'으로 읽힌다 */}
                <Stat k="성공률" v={p.successRate == null ? '—' : `${p.successRate}%`}
                      tone={p.successRate != null && p.successRate < 90 ? T.ylw : undefined}/>
                <Stat k="응답(중앙값)"
                      v={p.latencyMedianMs == null ? '—' : `${p.latencyMedianMs}ms`}
                      icon={<Clock size={11} color={T.muted}/>}/>
                <Stat k="예상 비용" v={p.cost.label}/>
              </div>

              {(p.cost.unpricedCalls > 0 || p.cost.untokenedCalls > 0) && (
                <div style={{ color: T.muted, fontSize: 10, marginTop: 8, lineHeight: 1.55 }}>
                  금액에서 빠짐 — 단가 미등록 {p.cost.unpricedCalls}건 · 토큰 수 없음 {p.cost.untokenedCalls}건
                </div>
              )}

              {p.recentErrors.length > 0 && (
                <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {p.recentErrors.map((e, i) => (
                    <div key={i} style={{
                      padding: '7px 9px', borderRadius: 7, background: A(T.red, '10'),
                      color: T.red, fontSize: 10, lineHeight: 1.5,
                    }}>{e.text || '사유 없음'}</div>
                  ))}
                </div>
              )}
            </div>
          ))}

          {d.fallbacks.length > 0 && (
            <div style={card({ padding: '11px 14px' })}>
              <div style={{ color: T.muted, fontSize: 10, marginBottom: 4 }}>장애 시 전환 순서</div>
              <div style={{ color: T.sub, fontSize: 12, fontWeight: 600 }}>
                {d.fallbacks.join(' → ')}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ k, v, tone, icon }: { k: string; v: string; tone?: string; icon?: React.ReactNode }) {
  return (
    <div style={{ minWidth: 72 }}>
      <div style={{ color: T.muted, fontSize: 10, marginBottom: 3, display: 'flex', alignItems: 'center', gap: 3 }}>
        {icon}{k}
      </div>
      <div style={{ color: tone ?? T.txt, fontSize: 14, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{v}</div>
    </div>
  );
}
