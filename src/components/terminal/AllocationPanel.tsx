'use client';
// src/components/terminal/AllocationPanel.tsx
//
// 자금 배분표 — **읽기만 한다.**
//
// `/api/portfolio/allocation`이 계산한 것을 그대로 보여준다. 여기서 다시
// 계산하지 않는다. 화면이 자기 계산을 갖는 순간 서버와 다른 숫자를 말하기
// 시작하고, 사용자는 어느 쪽이 맞는지 알 방법이 없다.
//
// 이 화면이 반드시 보여야 하는 것
// ───────────────────────────────
//   · **왜** 그 전략이 자리를 못 받았는가 (표본 부족 / 성적 미달 / 자리 없음)
//   · 표본 부족과 성적 미달을 **다르게** 표시한다 — 하나는 더 돌려야 하고
//     하나는 꺼야 한다
//   · 배분 가능액을 다 안 쓰면 그 사실
//
// 잘된 것만 크게 보여주면 "왜 아무것도 안 도는지" 알 수 없는 화면이 된다.
import React, { useCallback, useEffect, useState } from 'react';
import { C, FS, NUM, ghostBtn, fmtPrice } from './theme';
import { useTerminal } from './TerminalContext';

const STATUS_TONE: Record<string, string> = {
  ok: C.up, insufficient: C.dim, disabled: C.down, unknown: C.warn,
};
const STATUS_LABEL: Record<string, string> = {
  ok: '활성 가능', insufficient: '표본 부족', disabled: '기준 미달', unknown: '판정 불가',
};

export function AllocationPanel() {
  const { auth } = useTerminal();
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!auth) { setErr('로그인이 필요합니다'); return; }
    setBusy(true);
    try {
      const r = await fetch('/api/portfolio/allocation', { headers: { Authorization: auth } });
      const j = await r.json();
      if (!r.ok || !j?.ok) {
        // 조회 실패를 '배분 없음'으로 그리지 않는다. 빈 표와 못 읽은 표는
        // 완전히 다른 상태인데 화면에서는 둘 다 비어 보인다.
        setData(null);
        setErr(j?.message || j?.error || `조회 실패 (${r.status})`);
        return;
      }
      setErr('');
      setData(j);
    } catch (e: any) {
      setData(null);
      setErr(`배분표를 읽지 못했습니다 (${e?.message || e})`);
    } finally { setBusy(false); }
  }, [auth]);

  useEffect(() => { load(); }, [load]);

  if (err) {
    return (
      <div style={{ padding: 14 }}>
        <div style={{
          padding: '10px 12px', borderRadius: 8,
          background: C.warnBg, color: C.warn, fontSize: FS.small, lineHeight: 1.55,
        }}>{err}</div>
        <button onClick={load} style={{ ...ghostBtn(), marginTop: 10, minHeight: 30 }}>
          다시 시도
        </button>
      </div>
    );
  }

  if (!data) {
    return <div style={{ padding: 20, textAlign: 'center', color: C.faint, fontSize: FS.small }}>
      {busy ? '계산 중…' : '—'}
    </div>;
  }

  const plan = data.plan ?? {};
  const tier = plan.tier ?? {};
  const slots: any[] = Array.isArray(plan.slots) ? plan.slots : [];
  const benched: any[] = Array.isArray(plan.benched) ? plan.benched : [];
  const scores: any[] = Array.isArray(data.scores) ? data.scores : [];

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* 지금 어떤 운영 방식인가 */}
      <div style={{
        background: C.raised, borderRadius: 9, padding: '11px 13px',
        border: `1px solid ${tier.id === 'unknown' ? `${C.warn}55` : C.hair}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
          <span style={{ color: C.text, fontSize: FS.body, fontWeight: 800 }}>
            {tier.label ?? '—'}
          </span>
          <span style={{ ...NUM, color: C.dim, fontSize: FS.small }}>
            {plan.equityUsd == null ? '자산 확인 불가' : `${fmtPrice(plan.equityUsd)} USDT`}
          </span>
        </div>
        <div style={{ color: C.faint, fontSize: FS.micro, marginTop: 5, lineHeight: 1.55 }}>
          {plan.summary}
        </div>
        {tier.note && (
          <div style={{ color: C.faint, fontSize: FS.micro, marginTop: 4, lineHeight: 1.5 }}>
            {tier.note}
          </div>
        )}

        {/* **집중과 과대 포지션은 다르다** — 이 두 줄이 그 구분이다.
            비중이 커져도 거래당 위험은 안 커진다는 것을 화면에 적는다. */}
        <div style={{
          display: 'flex', gap: 14, marginTop: 9, paddingTop: 9,
          borderTop: `1px solid ${C.hair}`, ...NUM, fontSize: FS.micro,
        }}>
          <span style={{ color: C.faint }}>
            거래당 위험 <b style={{ color: C.text }}>{plan.riskPerTradePct}%</b>
          </span>
          <span style={{ color: C.faint }}>
            동시 위험 상한 <b style={{ color: C.text }}>{plan.maxConcurrentRiskPct}%</b>
          </span>
          <span style={{ color: C.faint }}>
            현금 유보 <b style={{ color: C.text }}>{tier.reservePct}%</b>
          </span>
        </div>
      </div>

      {/* 알아야 할 것. 접지 않는다 — 여기 적히는 것이 대부분 "왜 안 도는가"다 */}
      {Array.isArray(plan.notes) && plan.notes.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {plan.notes.map((n: string, i: number) => (
            <div key={i} style={{
              padding: '8px 10px', borderRadius: 7,
              background: C.warnBg, color: C.warn, fontSize: FS.micro, lineHeight: 1.55,
            }}>{n}</div>
          ))}
        </div>
      )}
      {Array.isArray(data.warnings) && data.warnings.map((w: string, i: number) => (
        <div key={`w${i}`} style={{
          padding: '8px 10px', borderRadius: 7,
          background: C.warnBg, color: C.warn, fontSize: FS.micro, lineHeight: 1.55,
        }}>{w}</div>
      ))}

      {/* 배분 */}
      <Section title={`배분 (${slots.length}/${tier.maxActive ?? 0})`}>
        {slots.length === 0
          ? <Empty t="자금을 받는 전략이 없습니다"/>
          : slots.map((s: any) => (
            <div key={s.id} style={{ padding: '9px 0', borderBottom: `1px solid ${C.hair}` }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ color: C.text, fontSize: FS.small, fontWeight: 700 }}>{s.label}</span>
                <span style={{ ...NUM, color: C.text, fontSize: FS.small, fontWeight: 700 }}>
                  {s.usd == null ? '—' : `${fmtPrice(s.usd)} USDT`}
                </span>
              </div>
              {/* 비중 막대. 숫자만 있으면 서로 얼마나 다른지 안 읽힌다 */}
              <div style={{
                height: 4, borderRadius: 2, background: C.hair, marginTop: 6, overflow: 'hidden',
              }}>
                <div style={{
                  width: `${Math.min(100, (Number(s.weight) || 0) * 100)}%`,
                  height: '100%', background: C.accent,
                }}/>
              </div>
              <div style={{ color: C.faint, fontSize: FS.micro, marginTop: 5 }}>
                {Math.round((Number(s.weight) || 0) * 100)}% · {s.reason}
              </div>
            </div>
          ))}
      </Section>

      {/* 대기 — **왜** 못 들어갔는지가 이 화면의 핵심이다 */}
      {benched.length > 0 && (
        <Section title={`대기 (${benched.length})`}>
          {benched.map((b: any) => {
            const sc = scores.find((x: any) => x.id === b.id);
            const st = sc?.status ?? 'unknown';
            return (
              <div key={b.id} style={{ padding: '8px 0', borderBottom: `1px solid ${C.hair}` }}>
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ color: C.dim, fontSize: FS.small, fontWeight: 600 }}>{b.label}</span>
                  {/* 표본 부족과 기준 미달을 **다른 색**으로. 하나는 더 돌려야
                      하고 하나는 꺼야 하는데, 같아 보이면 구분이 사라진다. */}
                  <span style={{
                    fontSize: FS.micro, fontWeight: 700, color: STATUS_TONE[st] ?? C.dim,
                    whiteSpace: 'nowrap',
                  }}>
                    {STATUS_LABEL[st] ?? st}
                    {b.score != null && <span style={{ ...NUM, marginLeft: 5 }}>{b.score}점</span>}
                  </span>
                </div>
                <div style={{ color: C.faint, fontSize: FS.micro, marginTop: 4, lineHeight: 1.5 }}>
                  {b.reason}
                </div>
              </div>
            );
          })}
        </Section>
      )}

      {/* 점수 상세 — 무엇이 점수를 깎았는지 */}
      {scores.length > 0 && (
        <Section title="점수 상세">
          {scores.map((s: any) => (
            <div key={s.id} style={{ padding: '8px 0', borderBottom: `1px solid ${C.hair}` }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
                <span style={{ color: C.dim, fontSize: FS.micro, fontWeight: 700 }}>{s.label}</span>
                <span style={{ ...NUM, fontSize: FS.micro, color: STATUS_TONE[s.status] ?? C.dim }}>
                  {s.score == null ? STATUS_LABEL[s.status] : `${s.score}점`}
                </span>
              </div>
              {Array.isArray(s.parts) && s.parts.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 5 }}>
                  {s.parts.map((p: any, i: number) => (
                    <span key={i} style={{ ...NUM, fontSize: FS.micro, color: C.faint }}>
                      {p.k} <b style={{ color: p.pts == null ? C.warn : C.dim }}>{p.v}</b>
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </Section>
      )}

      <div style={{ color: C.faint, fontSize: FS.micro, lineHeight: 1.6 }}>
        {data.sourceNote}<br/>
        최근 {data.lookbackDays}일 · 청산된 거래 {data.tradeCount}건 기준.
        <b> 이 표는 계산만 합니다 — 실제 주문 크기에 아직 물려 있지 않습니다.</b>
      </div>

      <button onClick={load} disabled={busy}
        style={{ ...ghostBtn(), minHeight: 32, opacity: busy ? 0.5 : 1 }}>
        {busy ? '계산 중…' : '다시 계산'}
      </button>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ color: C.faint, fontSize: FS.micro, fontWeight: 700, marginBottom: 2 }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function Empty({ t }: { t: string }) {
  return <div style={{ padding: '14px 0', color: C.faint, fontSize: FS.micro }}>{t}</div>;
}
