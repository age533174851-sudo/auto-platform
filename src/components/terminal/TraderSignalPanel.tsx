'use client';
// src/components/terminal/TraderSignalPanel.tsx
//
// **방송자 인텔리전스.**
//
// 이 화면이 하지 않는 것
// ──────────────────────
// 주문 버튼이 없다. 여기서 나오는 것은 전부 **다른 사람이 무엇을 했는지에
// 대한 추측**이고, 추측 위에 주문을 얹으면 그 추측이 틀렸을 때 돈이 나간다.
//
// 이 화면이 하는 것
// ─────────────────
//   1. 누가 무엇을 말했는지 기록
//   2. 그 사람이 실제로 잘하는지 성적으로 검증
//   3. 여럿의 의견이 어디로 쏠려 있는지 (신호가 아니라 상태로)
//
// 2번이 이 화면의 목적이다. 방송을 보는 사람은 기억으로 판단하는데,
// 기억은 크게 맞힌 것만 남기고 조용히 틀린 것은 지운다.
import React, { useCallback, useEffect, useState } from 'react';
import { C, FS, NUM, ghostBtn, primaryBtn, input } from './theme';
import { useTerminal } from './TerminalContext';
import { CONFIDENCE_LABEL, ACTION_LABEL } from '@/lib/signals/positionParse';
import { TIER_LABEL } from '@/lib/signals/traderScore';
import { consensusHeadline } from '@/lib/signals/consensus';

const TIER_TONE: Record<string, string> = {
  watch: C.faint, notify: C.warn, paper: C.accent, semi_auto: C.up,
};
const CONF_TONE: Record<string, string> = {
  confirmed: C.up, likely: C.accent, uncertain: C.faint,
};

export function TraderSignalPanel() {
  const { auth } = useTerminal();
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const [newName, setNewName] = useState('');
  const [pickChannel, setPickChannel] = useState('');
  const [text, setText] = useState('');
  const [sawScreen, setSawScreen] = useState(false);
  const [preview, setPreview] = useState<any>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!auth) { setErr('로그인이 필요합니다'); return; }
    setBusy(true);
    try {
      const r = await fetch('/api/signals', { headers: { Authorization: auth } });
      const j = await r.json();
      if (!r.ok || !j?.ok) {
        setData(null);
        setErr([j?.message || j?.error || `조회 실패 (${r.status})`, j?.hint].filter(Boolean).join(' — '));
        return;
      }
      setErr(''); setData(j);
      if (!pickChannel && j.channels?.[0]) setPickChannel(j.channels[0].id);
    } catch (e: any) {
      setData(null);
      setErr(`읽지 못했습니다 (${e?.message || e})`);
    } finally { setBusy(false); }
  }, [auth, pickChannel]);

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [auth]);

  const post = async (payload: any) => {
    const r = await fetch('/api/signals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: JSON.stringify(payload),
    });
    return { r, j: await r.json() };
  };

  // 넣기 전에 무엇으로 읽히는지 본다. 저장하면 지울 수 없다.
  const doPreview = async (t: string) => {
    setText(t);
    if (!t.trim() || !auth) { setPreview(null); return; }
    try {
      const { j } = await post({ action: 'preview', text: t });
      setPreview(j?.parsed ?? null);
    } catch { setPreview(null); }
  };

  const addChannel = async () => {
    if (!newName.trim()) return;
    setBusy(true); setMsg(null);
    const { r, j } = await post({ action: 'add_channel', name: newName.trim() });
    setBusy(false);
    if (r.ok && j?.ok) { setNewName(''); load(); }
    else setMsg({ ok: false, text: [j?.message || j?.error, j?.hint].filter(Boolean).join(' — ') });
  };

  const addSignal = async () => {
    if (!pickChannel || !text.trim()) return;
    setBusy(true); setMsg(null);
    const { r, j } = await post({
      action: 'add_signal', channelId: pickChannel, text,
      // 화면을 봤다고 체크했을 때만 true. 안 봤으면 **false가 아니라
      // 넘기지 않는다** — false는 "확인해 봤는데 아니었다"는 뜻이다.
      screenMatches: sawScreen ? true : undefined,
    });
    setBusy(false);
    if (r.ok && j?.ok) { setText(''); setPreview(null); setSawScreen(false); load(); setMsg({ ok: true, text: '기록했습니다' }); }
    else setMsg({ ok: false, text: [j?.message || j?.error, j?.hint].filter(Boolean).join(' — ') });
  };

  if (err) {
    return (
      <div style={{ padding: 14 }}>
        <div style={{ padding: '10px 12px', borderRadius: 8, background: C.warnBg, color: C.warn,
                      fontSize: FS.small, lineHeight: 1.55 }}>{err}</div>
        <button onClick={load} style={{ ...ghostBtn(), marginTop: 10, minHeight: 32 }}>다시 시도</button>
      </div>
    );
  }
  if (!data) return <div style={{ padding: 20, textAlign: 'center', color: C.faint, fontSize: FS.small }}>
    {busy ? '읽는 중…' : '—'}
  </div>;

  const traders: any[] = data.traders || [];
  const consensus: any[] = (data.consensus || []).filter((c: any) => c.counted > 0);
  const signals: any[] = data.signals || [];

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 14 }}>

      {/* 이 화면이 무엇인지 먼저 */}
      <div style={{ background: C.raised, borderRadius: 9, padding: '10px 12px',
                    color: C.faint, fontSize: FS.micro, lineHeight: 1.6 }}>
        <b style={{ color: C.dim }}>공개 방송·공개 게시물에서 본 발언만</b> 넣으세요.
        여기 나오는 것은 전부 <b style={{ color: C.dim }}>추측</b>이고, 주문 버튼은 없습니다 —
        따라 사기 전에 그 사람이 실제로 잘하는지 먼저 세는 화면입니다.
      </div>

      {/* 쏠림 */}
      {consensus.length > 0 && (
        <div>
          <div style={{ color: C.faint, fontSize: FS.micro, fontWeight: 700, marginBottom: 6 }}>
            지금 어디로 쏠려 있나
          </div>
          {consensus.map((c: any) => (
            <div key={c.symbol} style={{ padding: '8px 0', borderBottom: `1px solid ${C.hair}` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                <span style={{ color: C.text, fontSize: FS.small, fontWeight: 700 }}>{c.symbol}</span>
                <span style={{
                  fontSize: FS.micro, fontWeight: 800,
                  color: c.crowded ? C.warn : c.side === 'LONG' ? C.up : c.side === 'SHORT' ? C.down : C.dim,
                }}>{consensusHeadline(c)}</span>
              </div>
              <div style={{ color: C.faint, fontSize: FS.micro, marginTop: 3, lineHeight: 1.5 }}>{c.note}</div>
            </div>
          ))}
        </div>
      )}

      {/* 방송자 성적 */}
      <div>
        <div style={{ color: C.faint, fontSize: FS.micro, fontWeight: 700, marginBottom: 6 }}>
          방송자 ({traders.length})
        </div>
        {traders.length === 0 && (
          <div style={{ color: C.faint, fontSize: FS.micro, lineHeight: 1.6 }}>
            아직 없습니다. 아래에서 추가하세요.
          </div>
        )}
        {traders.map((t: any) => {
          const st = t.stats;
          return (
            <div key={t.channel.id} style={{ padding: '10px 0', borderBottom: `1px solid ${C.hair}` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                <span style={{ color: C.text, fontSize: FS.small, fontWeight: 700 }}>{t.channel.name}</span>
                <span style={{ fontSize: FS.micro, fontWeight: 800, color: TIER_TONE[t.tier] ?? C.dim }}>
                  {TIER_LABEL[t.tier]?.text ?? t.tier}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 12, marginTop: 5, ...NUM, fontSize: FS.micro, flexWrap: 'wrap' }}>
                {/* **표본이 적으면 승률 자리에 '—'가 뜬다.** 3전 2승을
                    67%로 적으면 사람은 그 숫자를 믿는다. */}
                <span style={{ color: C.faint }}>승률 <b style={{ color: C.dim }}>
                  {st.winRate == null ? '—' : `${st.winRate}%`}</b></span>
                <span style={{ color: C.faint }}>손익비 <b style={{ color: C.dim }}>
                  {st.profitFactor == null ? '—' : st.profitFactor}</b></span>
                <span style={{ color: C.faint }}>누적 <b style={{ color: st.totalPct >= 0 ? C.up : C.down }}>
                  {st.totalPct >= 0 ? '+' : ''}{st.totalPct}%</b></span>
                <span style={{ color: C.faint }}>낙폭 <b style={{ color: C.dim }}>{st.maxDrawdownPct}%</b></span>
              </div>
              <div style={{ color: C.faint, fontSize: FS.micro, marginTop: 4, lineHeight: 1.5 }}>{st.note}</div>
              <div style={{ color: TIER_TONE[t.tier] ?? C.dim, fontSize: FS.micro, marginTop: 3, lineHeight: 1.5 }}>
                {t.tierReason}
              </div>
              <button onClick={async () => {
                setBusy(true);
                await post({ action: 'remove_channel', id: t.channel.id });
                setBusy(false); load();
              }} style={{ ...ghostBtn(), marginTop: 7, minHeight: 28, fontSize: FS.micro }}>삭제</button>
            </div>
          );
        })}
      </div>

      {/* 채널 추가 */}
      <div style={{ display: 'flex', gap: 6 }}>
        <input value={newName} onChange={e => setNewName(e.target.value)}
          placeholder="방송자 이름"
          style={{ ...input, flex: 1, padding: '9px 11px', fontSize: FS.small }}/>
        <button onClick={addChannel} disabled={busy || !newName.trim()}
          style={{ ...ghostBtn(), minHeight: 38, opacity: (busy || !newName.trim()) ? 0.5 : 1 }}>추가</button>
      </div>

      {/* 발언 넣기 */}
      {traders.length > 0 && (
        <div style={{ background: C.raised, borderRadius: 9, padding: 12,
                      display: 'flex', flexDirection: 'column', gap: 9 }}>
          <div style={{ color: C.text, fontSize: FS.body, fontWeight: 800 }}>발언 기록</div>

          <select value={pickChannel} onChange={e => setPickChannel(e.target.value)}
            style={{ ...input, padding: '9px 11px', fontSize: FS.small }}>
            {traders.map((t: any) => <option key={t.channel.id} value={t.channel.id}>{t.channel.name}</option>)}
          </select>

          <textarea value={text} onChange={e => doPreview(e.target.value)}
            placeholder="예: 비트 여기서 롱 잡았습니다. 118,400에 10배로"
            rows={3}
            style={{ ...input, padding: '9px 11px', fontSize: FS.small, resize: 'vertical' }}/>

          {/* 넣기 전에 무엇으로 읽히는지 보여준다 */}
          {text.trim() && (
            <div style={{
              padding: '9px 11px', borderRadius: 8,
              background: C.panel, border: `1px solid ${preview ? C.hair : `${C.warn}55`}`,
              fontSize: FS.micro, lineHeight: 1.6,
            }}>
              {!preview ? (
                <span style={{ color: C.warn }}>
                  매매 발언으로 안 읽힙니다. 방향(롱/숏)과 실제로 한 행동(잡았다·정리했다)이 들어가야 합니다.
                </span>
              ) : (
                <>
                  <div style={{ color: C.text, fontWeight: 700 }}>
                    {preview.symbol || '종목?'} {preview.side || ''} · {ACTION_LABEL[preview.action] ?? preview.action}
                    <span style={{ marginLeft: 8, color: CONF_TONE[preview.confidence] ?? C.dim }}>
                      {CONFIDENCE_LABEL[preview.confidence]?.text}
                    </span>
                  </div>
                  <div style={{ ...NUM, color: C.faint, marginTop: 3 }}>
                    {preview.entryPrice ? `진입 ${preview.entryPrice}` : '진입가 —'}
                    {preview.leverage ? ` · ${preview.leverage}배` : ''}
                    {preview.stopLoss ? ` · 손절 ${preview.stopLoss}` : ''}
                  </div>
                  <div style={{ color: C.faint, marginTop: 3 }}>{preview.reason}</div>
                </>
              )}
            </div>
          )}

          {/* 화면을 봤는지는 **사용자만 안다.** 안 봤으면 안 넘긴다 —
              false는 "확인해 봤는데 아니었다"는 다른 뜻이다. */}
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
            <input type="checkbox" checked={sawScreen} onChange={e => setSawScreen(e.target.checked)}
                   style={{ marginTop: 2, width: 18, height: 18, accentColor: C.up }}/>
            <span style={{ fontSize: FS.micro, lineHeight: 1.55, color: C.dim }}>
              방송 화면의 포지션도 직접 봤습니다
              <span style={{ display: 'block', color: C.faint, marginTop: 2 }}>
                체크해야 <b>확정</b>이 됩니다. 말만 들었으면 체크하지 마세요 — 말과 실제 포지션은 다를 수 있습니다.
              </span>
            </span>
          </label>

          <button onClick={addSignal} disabled={busy || !preview || !pickChannel}
            style={{ ...primaryBtn(C.accent, busy), minHeight: 42,
                     opacity: (busy || !preview || !pickChannel) ? 0.5 : 1 }}>
            {busy ? '기록 중…' : '기록하기'}
          </button>

          <div style={{ color: C.faint, fontSize: FS.micro, lineHeight: 1.6 }}>
            한 번 기록하면 지울 수 없습니다. 성적을 좋게 만들려고 진 신호를 지울 수 있으면
            이 기록의 의미가 없어지기 때문입니다.
          </div>
        </div>
      )}

      {msg && (
        <div style={{ padding: '9px 11px', borderRadius: 8, fontSize: FS.micro, lineHeight: 1.55,
                      color: msg.ok ? C.up : C.down, background: msg.ok ? C.upBg : C.downBg }}>
          {msg.text}
        </div>
      )}

      {/* 최근 기록 */}
      {signals.length > 0 && (
        <div>
          <div style={{ color: C.faint, fontSize: FS.micro, fontWeight: 700, marginBottom: 4 }}>
            최근 기록 ({signals.length})
          </div>
          {signals.slice(0, 20).map((s: any) => (
            <div key={s.id} style={{ padding: '7px 0', borderBottom: `1px solid ${C.hair}` }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <span style={{ color: C.text, fontSize: FS.micro, fontWeight: 700 }}>{s.trader || '—'}</span>
                <span style={{ color: s.side === 'LONG' ? C.up : s.side === 'SHORT' ? C.down : C.dim,
                               fontSize: FS.micro, fontWeight: 700 }}>
                  {s.symbol || '?'} {s.side || ''} {ACTION_LABEL[s.action] ?? s.action}
                </span>
                <span style={{ color: CONF_TONE[s.confidence] ?? C.dim, fontSize: FS.micro }}>
                  {CONFIDENCE_LABEL[s.confidence]?.text}
                </span>
                <span style={{ ...NUM, color: C.faint, fontSize: FS.micro, marginLeft: 'auto' }}>
                  {new Date(s.detected_at).toLocaleString('ko-KR')}
                </span>
              </div>
              <div style={{ color: C.faint, fontSize: FS.micro, marginTop: 2, lineHeight: 1.5 }}>{s.evidence}</div>
            </div>
          ))}
        </div>
      )}

      <button onClick={load} disabled={busy}
        style={{ ...ghostBtn(), minHeight: 32, opacity: busy ? 0.5 : 1 }}>
        {busy ? '읽는 중…' : '새로고침'}
      </button>
    </div>
  );
}
