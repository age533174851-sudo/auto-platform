'use client';
// src/components/news/ConsensusPanel.tsx
//
// 여러 AI의 의견을 나란히 보여준다.
//
// 이 화면의 값어치는 '갈렸다'에 있다
// ──────────────────────────────────
// 셋이 같은 말을 했다는 것보다, 둘이 정반대로 봤다는 사실이 더 쓸모 있다.
// 그래서 갈렸을 때 방향을 지어내지 않고 갈린 내역을 그대로 펼친다.
// 합의만 크게 쓰고 개별 의견을 접어 두면 이 기능을 쓸 이유가 없다.
//
// 부르기 전에는 아무것도 부르지 않는다
// ────────────────────────────────────
// 3개 공급자를 부르면 비용이 세 배다. 화면을 열 때 자동으로 돌리면
// 스크롤만 해도 요금이 나간다. 사용자가 누를 때만 부른다.
import React, { useCallback, useState } from 'react';
import { errorTextOf } from '@/lib/http/errorText';
import { T } from '@/lib/constants';
import { A } from '@/lib/theme/colors';
import { Users, AlertTriangle } from 'lucide-react';

interface Opinion {
  provider: string; direction: string; confidence: number; reasons: string[];
}
interface ConsensusData {
  consensus: {
    level: 'UNANIMOUS' | 'MAJORITY' | 'SPLIT' | 'INSUFFICIENT';
    direction: string | null;
    directionKo: string | null;
    confidence: number;
    summary: string;
    votes: Record<string, number>;
    responded: number;
  };
  opinions: Opinion[];
  sharedReasons: string[];
  uniqueReasons: { provider: string; reason: string }[];
  skipped: { provider: string; reason: string }[];
  note: string;
}

const TONE: Record<string, string> = {
  bullish: T.grn, bearish: T.red, neutral: T.sub, uncertain: T.ylw,
};
const KO: Record<string, string> = {
  bullish: '상승', bearish: '하락', neutral: '보합', uncertain: '판단 보류',
};
const LEVEL_KO: Record<string, string> = {
  UNANIMOUS: '만장일치', MAJORITY: '과반', SPLIT: '의견 갈림', INSUFFICIENT: '합의 불가',
};
const LEVEL_TONE: Record<string, string> = {
  UNANIMOUS: T.grn, MAJORITY: T.acl, SPLIT: T.ylw, INSUFFICIENT: T.muted,
};

export function ConsensusPanel({ article }: {
  article: { title: string; body?: string; url: string; publishedAt: string; source?: string };
}) {
  const [d, setD] = useState<ConsensusData | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const run = useCallback(async () => {
    setBusy(true); setErr('');
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
      const r = await fetch('/api/ai/consensus', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
        body: JSON.stringify({ article }),
      });
      const j = await r.json();
      if (!r.ok || !j?.ok) { setErr(errorTextOf(j, `실패 (${r.status})`)); return; }
      setD(j);
    } catch (e: any) { setErr(`요청 실패: ${e?.message || e}`); }
    finally { setBusy(false); }
  }, [article]);

  if (!d) {
    return (
      <div style={{ marginTop: 14 }}>
        <button onClick={run} disabled={busy} style={{
          width: '100%', minHeight: 42, borderRadius: 11, cursor: busy ? 'default' : 'pointer',
          background: A(T.prp, '18'), color: T.prp, border: `1px solid ${A(T.prp, '40')}`,
          fontSize: 13, fontWeight: 700,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
        }}>
          <Users size={16}/> {busy ? '여러 AI에게 물어보는 중…' : 'AI별 의견 비교'}
        </button>
        {/* 비용이 든다는 사실을 누르기 전에 알린다 */}
        <div style={{ color: T.muted, fontSize: 10, marginTop: 6, lineHeight: 1.55, textAlign: 'center' }}>
          여러 AI를 각각 호출합니다. 의견이 갈리면 방향을 내지 않습니다.
        </div>
        {err && (
          <div style={{
            marginTop: 8, padding: '9px 11px', borderRadius: 9,
            background: A(T.red, '12'), color: T.red, fontSize: 11, lineHeight: 1.55,
          }}>{err}</div>
        )}
      </div>
    );
  }

  const c = d.consensus;
  const levelTone = LEVEL_TONE[c.level] ?? T.sub;
  const split = c.level === 'SPLIT' || c.level === 'INSUFFICIENT';

  return (
    <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* 합의 결과. 갈렸으면 방향 자리에 방향을 넣지 않는다 */}
      <div style={{
        padding: '12px 14px', borderRadius: 12,
        background: A(levelTone, '12'), border: `1px solid ${A(levelTone, '35')}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6, flexWrap: 'wrap' }}>
          <span style={{
            padding: '2px 9px', borderRadius: 6, fontSize: 10, fontWeight: 800,
            background: A(levelTone, '22'), color: levelTone,
          }}>{LEVEL_KO[c.level] ?? c.level}</span>

          {c.directionKo && (
            <span style={{
              fontSize: 16, fontWeight: 800,
              color: TONE[String(c.direction)] ?? T.txt,
            }}>{c.directionKo}</span>
          )}
          {!split && (
            <span style={{ color: T.muted, fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>
              신뢰도 {c.confidence}%
            </span>
          )}
          <span style={{ color: T.muted, fontSize: 10 }}>· AI {c.responded}개 응답</span>
        </div>
        <div style={{ color: T.sub, fontSize: 11, lineHeight: 1.6 }}>{c.summary}</div>
      </div>

      {/* AI별 의견 — 접지 않는다. 갈린 지점이 이 화면의 값어치다 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {d.opinions.map(o => (
          <div key={o.provider} style={{
            padding: '9px 11px', borderRadius: 10,
            background: T.card, border: `1px solid ${T.border}`,
            borderLeft: `3px solid ${TONE[o.direction] ?? T.sub}`,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <span style={{ color: T.txt, fontSize: 12, fontWeight: 700 }}>{o.provider}</span>
              <span style={{ color: TONE[o.direction] ?? T.sub, fontSize: 11, fontWeight: 800 }}>
                {KO[o.direction] ?? o.direction}
              </span>
              <span style={{ color: T.muted, fontSize: 10, fontVariantNumeric: 'tabular-nums' }}>
                {o.confidence}%
              </span>
            </div>
            {o.reasons.length > 0 && (
              <ul style={{ margin: 0, paddingLeft: 15, color: T.sub, fontSize: 10.5, lineHeight: 1.6 }}>
                {o.reasons.slice(0, 3).map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            )}
          </div>
        ))}
      </div>

      {d.sharedReasons.length > 0 && (
        <div style={{ padding: '10px 12px', borderRadius: 10, background: T.alt }}>
          <div style={{ color: T.muted, fontSize: 10, marginBottom: 4 }}>공통 근거</div>
          <ul style={{ margin: 0, paddingLeft: 15, color: T.sub, fontSize: 11, lineHeight: 1.6 }}>
            {d.sharedReasons.slice(0, 4).map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </div>
      )}

      {/* 한 모델만 든 근거. 버리지 않는다 — 남들이 놓친 것일 수 있다 */}
      {d.uniqueReasons.length > 0 && (
        <div style={{ padding: '10px 12px', borderRadius: 10, background: T.alt }}>
          <div style={{ color: T.muted, fontSize: 10, marginBottom: 4 }}>한 AI만 지적한 것</div>
          <ul style={{ margin: 0, paddingLeft: 15, color: T.sub, fontSize: 11, lineHeight: 1.6 }}>
            {d.uniqueReasons.slice(0, 4).map((u, i) => (
              <li key={i}><span style={{ color: T.muted }}>{u.provider}:</span> {u.reason}</li>
            ))}
          </ul>
        </div>
      )}

      {/* 빠진 공급자를 숨기지 않는다. 둘이 답했는데 셋인 줄 알면
          합의의 무게를 잘못 읽는다 */}
      {d.skipped.length > 0 && (
        <div style={{
          padding: '9px 11px', borderRadius: 10,
          background: A(T.ylw, '10'), color: T.ylw, fontSize: 10, lineHeight: 1.6,
          display: 'flex', gap: 7, alignItems: 'flex-start',
        }}>
          <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 1 }}/>
          <span>
            응답하지 않은 AI: {d.skipped.map(s => `${s.provider}(${s.reason.slice(0, 40)})`).join(' · ')}
          </span>
        </div>
      )}

      <div style={{ color: T.muted, fontSize: 9.5, lineHeight: 1.6 }}>{d.note}</div>
    </div>
  );
}
