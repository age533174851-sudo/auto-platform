'use client';
// src/components/terminal/CreatorLedgerPanel.tsx
//
// **검수 → 장부 → 판정.** 세 단계를 한 화면에서 본다.
//
// 이 화면이 하지 않는 것
// ──────────────────────
// 주문 버튼이 없다. 판정이 '순방향 우위'로 나와도 그건 다음 단계
// (SHADOW_LIVE)로 갈 수 있다는 뜻이지 주문을 내도 된다는 뜻이 아니다.
//
// 왜 검수가 먼저인가
// ──────────────────
// 파서가 뽑은 것을 그대로 판정에 넣으면 재는 것이 그 사람의 성과가 아니라
// **우리 파서의 성과**가 된다. "여기서 롱도 가능하다"를 진입으로 읽은
// 신호가 섞이면 그 표는 아무것도 말하지 않는다.
//
// 그리고 발언 시각을 여기서 채운다. 감지 시각으로 대신 쓰면 지연이 0초가
// 되고, 그 신호는 성적이 가장 좋게 나오는 칸에 앉는다.
import React, { useCallback, useEffect, useState } from 'react';
import { errorTextOf } from '@/lib/http/errorText';
import { C, FS, NUM, chip, ghostBtn, input } from './theme';
import { useTerminal } from './TerminalContext';
import { BOOK_LABEL } from '@/lib/signals/creatorLedger';

const KINDS = [
  { v: 'EXPLICIT_ENTRY', t: '지금 진입했다' },
  { v: 'OPINION', t: '분석 의견' },
  { v: 'LONG_TERM', t: '장기 전망' },
  { v: 'RECAP', t: '과거 복기' },
  { v: 'QUESTION', t: '가정·질문 답변' },
  { v: 'AD', t: '광고·협찬' },
  { v: 'JOKE', t: '농담' },
];
const REGIMES = [
  { v: 'UNKNOWN', t: '모름' },
  { v: 'TREND_UP', t: '상승 추세' },
  { v: 'TREND_DOWN', t: '하락 추세' },
  { v: 'RANGE', t: '횡보' },
];

export function CreatorLedgerPanel() {
  const { auth } = useTerminal();
  const [signals, setSignals] = useState<any[] | null>(null);
  const [ledger, setLedger] = useState<any>(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [dims, setDims] = useState('creator');
  // 검수 중인 신호마다 채워 넣는 값
  const [edit, setEdit] = useState<Record<string, { saidAt: string; kind: string; regime: string }>>({});

  const load = useCallback(async () => {
    if (!auth) return;
    try {
      const [a, b] = await Promise.all([
        fetch('/api/signals', { headers: { Authorization: auth } }).then(r => r.json()),
        fetch(`/api/signals/ledger?dims=${encodeURIComponent(dims)}`, { headers: { Authorization: auth } })
          .then(r => r.json()),
      ]);
      setSignals(Array.isArray(a?.signals) ? a.signals : []);
      setLedger(b);
    } catch (e: any) {
      setMsg({ ok: false, text: `읽지 못했습니다: ${e?.message || e}` });
    }
  }, [auth, dims]);

  useEffect(() => { load(); }, [load]);

  const review = async (id: string, status: 'approved' | 'rejected') => {
    const e = edit[id] || { saidAt: '', kind: '', regime: '' };
    setBusy(id); setMsg(null);
    try {
      const r = await fetch('/api/signals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({
          action: 'review', signalId: id, status,
          // 빈 값은 **안 보낸다.** 보내면 서버가 지금 시각으로 채우려 하고,
          // 그건 지연을 0초로 만든다.
          saidAt: e.saidAt ? new Date(e.saidAt).toISOString() : undefined,
          utteranceKind: e.kind || undefined,
          regime: e.regime || undefined,
        }),
      });
      const j = await r.json();
      if (r.ok && j?.ok) { setMsg({ ok: true, text: status === 'approved' ? '승인했습니다' : '거부했습니다' }); load(); }
      else setMsg({ ok: false, text: [errorTextOf(j), j?.hint].filter(Boolean).join(' — ') });
    } catch (e: any) {
      setMsg({ ok: false, text: `실패: ${e?.message || e}` });
    } finally { setBusy(''); }
  };

  const compute = async () => {
    setBusy('COMPUTE'); setMsg(null);
    try {
      const r = await fetch('/api/signals/ledger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({}),
      });
      const j = await r.json();
      if (r.ok && j?.ok) {
        // **못 만든 것도 말한다.** 계산 3건만 적으면 나머지 40건이 왜
        // 빠졌는지 아무도 모르고, 그러면 검수해야 할 것이 쌓여 있는데도
        // 화면은 조용하다.
        const parts = [`장부 ${j.computed}건 계산`];
        if (j.skippedIntake > 0) parts.push(`반입에서 ${j.skippedIntake}건 제외`);
        if (j.failures?.length) parts.push(`계산 실패 ${j.failures.length}건`);
        setMsg({ ok: true, text: parts.join(' · ') });
        load();
      } else setMsg({ ok: false, text: errorTextOf(j, '계산 실패') });
    } catch (e: any) {
      setMsg({ ok: false, text: `실패: ${e?.message || e}` });
    } finally { setBusy(''); }
  };

  const pending = (signals || []).filter(s => (s.review_status ?? 'pending') === 'pending');
  const segments: any[] = ledger?.segments || [];

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ background: C.raised, borderRadius: 9, padding: '10px 12px',
                    color: C.faint, fontSize: FS.micro, lineHeight: 1.6 }}>
        신호 하나마다 장부를 <b style={{ color: C.dim }}>세 권</b> 만듭니다 —
        말한 대로 / 반대로 / 거래 안 함. 셋에 <b style={{ color: C.dim }}>완전히 같은 조건</b>
        (같은 지연·수수료·미끄러짐·손절)이 들어갑니다. 주문 버튼은 없습니다.
      </div>

      {msg && (
        <div style={{ padding: '9px 12px', borderRadius: 8, fontSize: FS.micro, lineHeight: 1.55,
                      background: msg.ok ? C.upBg : C.warnBg, color: msg.ok ? C.up : C.warn }}>
          {msg.text}
        </div>
      )}

      {/* ── 검수 대기 ── */}
      <div>
        <div style={{ color: C.dim, fontSize: FS.micro, fontWeight: 700, marginBottom: 6 }}>
          검수 대기 <span style={{ ...NUM, color: C.accent }}>{pending.length}</span>
        </div>
        <div style={{ color: C.faint, fontSize: FS.micro, marginBottom: 8, lineHeight: 1.55 }}>
          검수 전 신호를 판정에 넣으면 재는 것이 그 사람의 성과가 아니라 <b>우리 추출기의 성과</b>가 됩니다.
        </div>
        {pending.length === 0 && (
          <div style={{ color: C.faint, fontSize: FS.micro, padding: '10px 0' }}>대기 중인 신호가 없습니다</div>
        )}
        {pending.slice(0, 20).map(s => {
          const e = edit[s.id] || { saidAt: '', kind: '', regime: '' };
          const set = (k: string, v: string) =>
            setEdit(prev => ({ ...prev, [s.id]: { ...e, [k]: v } }));
          return (
            <div key={s.id} style={{ background: C.raised, borderRadius: 10, padding: '11px 13px',
                                     marginBottom: 8, overflowWrap: 'anywhere' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <b style={{ color: C.text }}>{s.trader || '—'}</b>
                <span style={{ color: C.dim }}>{s.symbol}</span>
                <span style={chip(s.side === 'LONG' ? C.up : C.down,
                                  s.side === 'LONG' ? C.upBg : C.downBg)}>{s.side || '방향 없음'}</span>
                <span style={chip(C.dim)}>{s.action}</span>
              </div>
              <div style={{ color: C.faint, fontSize: FS.micro, marginTop: 6, lineHeight: 1.5 }}>
                {s.evidence}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 9 }}>
                <label style={{ color: C.faint, fontSize: FS.micro }}>
                  발언 시각 — <b style={{ color: C.warn }}>없으면 승인할 수 없습니다</b>
                  {s.said_at && <span style={{ color: C.up }}> (기록됨)</span>}
                </label>
                <input type="datetime-local" value={e.saidAt}
                  onChange={ev => set('saidAt', ev.target.value)}
                  style={{ ...input, minHeight: 38 }}/>
                <div style={{ color: C.faint, fontSize: FS.micro, lineHeight: 1.45 }}>
                  감지 {s.detected_at ? new Date(s.detected_at).toLocaleString('ko-KR') : '—'} ·
                  둘의 차이가 지연이고, 지연이 성과를 가장 크게 가릅니다.
                </div>

                <div style={{ display: 'flex', gap: 6 }}>
                  <select value={e.kind} onChange={ev => set('kind', ev.target.value)}
                          style={{ ...input, flex: 1, minHeight: 38 }}>
                    <option value="">발언 종류 ({s.utterance_kind || '미정'})</option>
                    {KINDS.map(k => <option key={k.v} value={k.v}>{k.t}</option>)}
                  </select>
                  <select value={e.regime} onChange={ev => set('regime', ev.target.value)}
                          style={{ ...input, flex: 1, minHeight: 38 }}>
                    <option value="">국면 ({s.regime || 'UNKNOWN'})</option>
                    {REGIMES.map(k => <option key={k.v} value={k.v}>{k.t}</option>)}
                  </select>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button onClick={() => review(s.id, 'approved')} disabled={busy === s.id}
                        style={{ ...ghostBtn(), flex: 1, minHeight: 42, color: C.up,
                                 borderColor: `${C.up}55`, cursor: 'pointer' }}>
                  {busy === s.id ? '…' : '승인'}
                </button>
                <button onClick={() => review(s.id, 'rejected')} disabled={busy === s.id}
                        style={{ ...ghostBtn(), flex: 1, minHeight: 42, color: C.down,
                                 borderColor: `${C.down}55`, cursor: 'pointer' }}>
                  거부
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── 장부 계산 ── */}
      <div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={compute} disabled={busy === 'COMPUTE'}
                  style={{ ...ghostBtn(), minHeight: 40, color: C.accent, cursor: 'pointer' }}>
            {busy === 'COMPUTE' ? '계산 중…' : '장부 계산'}
          </button>
          <select value={dims} onChange={e => setDims(e.target.value)}
                  style={{ ...input, minHeight: 40, flex: 1, minWidth: 140 }}>
            <option value="creator">사람별</option>
            <option value="creator,symbol">사람 × 종목</option>
            <option value="creator,direction">사람 × 방향</option>
            <option value="creator,symbol,direction">사람 × 종목 × 방향</option>
            <option value="creator,latency">사람 × 지연</option>
            <option value="creator,regime">사람 × 국면</option>
          </select>
        </div>
        <div style={{ color: C.faint, fontSize: FS.micro, marginTop: 6, lineHeight: 1.55 }}>
          계산은 캔들 보관 기간 안에 해야 합니다 — 지금 안 하면 그 신호의 성적은 다시 계산할 수 없습니다.
        </div>
      </div>

      {/* ── 판정 ── */}
      <div>
        <div style={{ color: C.dim, fontSize: FS.micro, fontWeight: 700, marginBottom: 4 }}>
          판정 <span style={{ ...NUM, color: C.accent }}>{segments.length}</span>
          {ledger?.total != null && (
            <span style={{ color: C.faint, fontWeight: 400 }}> · 장부 {ledger.total}건</span>
          )}
        </div>
        {/* **비교한 개수를 적는다.** 이게 클수록 통과 문턱이 높아졌다는
            사실이 보여야, "왜 +0.3R인데 통과가 아니냐"에 답이 있다. */}
        {segments.length > 1 && (
          <div style={{ color: C.faint, fontSize: FS.micro, marginBottom: 8, lineHeight: 1.55 }}>
            세그먼트를 <b style={{ color: C.dim }}>{segments.length}개</b> 비교했습니다 —
            여럿을 뒤져 가장 좋은 것을 고르면 우연히 좋은 것이 나오므로, 그만큼 문턱이 올라갑니다.
          </div>
        )}
        {segments.length === 0 && (
          <div style={{ color: C.faint, fontSize: FS.micro, padding: '10px 0' }}>
            장부가 없습니다 — 신호를 승인하고 [장부 계산]을 누르세요.
          </div>
        )}
        {segments.map((sj: any) => {
          const best = sj.best as 'FOLLOW' | 'INVERSE' | 'IGNORE';
          const tone = best === 'IGNORE' ? C.faint
            : sj.survivesMultipleComparison ? C.up : C.warn;
          const sc = sj.scored?.[best] || {};
          return (
            <div key={sj.key} style={{ background: C.raised, borderRadius: 10, padding: '11px 13px',
                                       marginBottom: 8, borderLeft: `2px solid ${tone}`,
                                       overflowWrap: 'anywhere' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <b style={{ color: C.text }}>{sj.key}</b>
                <span style={chip(tone, best === 'IGNORE' ? undefined : `${tone}22`)}>
                  {BOOK_LABEL[best]}
                </span>
                <span style={{ ...NUM, color: C.faint, fontSize: FS.micro }}>n={sj.n}</span>
              </div>

              <div style={{ display: 'flex', gap: 12, marginTop: 8, flexWrap: 'wrap' }}>
                {(['FOLLOW', 'INVERSE', 'IGNORE'] as const).map(b => {
                  const s = sj.scored?.[b];
                  const e = s?.expectancyR;
                  return (
                    <div key={b} style={{ minWidth: 92 }}>
                      <div style={{ color: C.faint, fontSize: FS.micro }}>{BOOK_LABEL[b].split(' ')[0]}</div>
                      <div style={{ ...NUM, fontSize: FS.small, fontWeight: 700,
                                    color: e == null ? C.faint : e > 0 ? C.up : e < 0 ? C.down : C.dim }}>
                        {e == null ? '—' : `${e >= 0 ? '+' : ''}${Number(e).toFixed(3)}R`}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div style={{ color: C.dim, fontSize: FS.micro, marginTop: 8, lineHeight: 1.55 }}>
                {sj.note}
              </div>
              <div style={{ color: C.faint, fontSize: FS.micro, marginTop: 4, lineHeight: 1.5 }}>
                {sj.judgement?.reason}
              </div>
              <div style={{ marginTop: 7 }}>
                <span style={sj.promote?.ok ? chip(C.up, C.upBg) : chip(C.faint)}>
                  {sj.promote?.ok ? '다음 단계 가능' : '연결 불가'}
                </span>
                <span style={{ color: C.faint, fontSize: FS.micro, marginLeft: 7 }}>
                  {sj.promote?.reason}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {ledger?.note && (
        <div style={{ color: C.faint, fontSize: FS.micro, lineHeight: 1.6 }}>{ledger.note}</div>
      )}
    </div>
  );
}
