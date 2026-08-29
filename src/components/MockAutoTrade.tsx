'use client';
// ─────────────────────────────────────────────────────────────
// MockAutoTrade — **모의투자 상태를 보여 주는 화면.**
//
// 예전에는 이 파일이 엔진이었다
// ─────────────────────────────
// 자체 `decide()` · 자체 TP/SL(+0.3% / −0.2%) · 자체 체결(`paperBuy`) ·
// 원화 잔고 · localStorage 장부를 전부 갖고 있었다. 그래서 모의계좌가
// **두 개**였다:
//
//   서버 PAPER      paper_accounts · paper_positions · USDT · 실제 전략 평가
//   이 컴포넌트     localStorage · 원화 · 자체 판단 · 자체 손절
//
// 자동매매 MOCK 화면과 지갑 MOCK 탭이 **서로 다른 잔고**를 보여 줬고,
// 어느 쪽이 진짜인지 알 방법이 없었다. 그 상태로 색깔과 레이아웃을
// 갈아엎으면 예쁜 화면 두 곳이 다른 답을 하는 꼴이 된다.
//
// 지금 이 파일은
// ──────────────
//   · 판단하지 않는다      — 전략 평가는 서버가 한다
//   · 주문하지 않는다      — 체결은 paperDispatch가 한다
//   · TP/SL을 계산하지 않는다
//   · 잔고·손익을 따로 세지 않는다
//   · localStorage를 장부로 쓰지 않는다
//
// 서버 PAPER 상태를 읽어서 보여 주고, 시작/초기화를 요청할 뿐이다.
// **브라우저를 닫아도 모의 자동매매는 계속 돈다** — 그게 이 변경의 요점이다.
import React, { useState, useEffect, useCallback } from 'react';
import { T } from '@/lib/constants';
import { A } from '@/lib/theme/colors';
import { errorTextOf } from '@/lib/http/errorText';
import { watchAuthToken } from '@/lib/auth/authToken';
import { paperViewOf, type PaperView } from '@/lib/portfolio/paperView';
import { PAPER_SEED_CHOICES, validateSeed } from '@/lib/portfolio/paperAccount';
import { legacyLocalPaper, LEGACY_PAPER_KEYS } from '@/lib/portfolio/legacyPaper';
// **문장을 여기서 새로 짓지 않는다.** '상시 실행인가'의 표현은 한 곳에
// 있고, 다른 화면도 같은 문장을 쓴다.
import { DURABILITY_NOTE } from '@/lib/runtime/persistentRuntime';

const num = (v: number | null, digits = 2) =>
  v == null ? '확인 불가' : v.toLocaleString('ko-KR', { maximumFractionDigits: digits });

export default function MockAutoTrade() {
  const [auth, setAuth] = useState<string | null>(null);
  useEffect(() => watchAuthToken(setAuth), []);

  const [loaded, setLoaded] = useState(false);
  const [payload, setPayload] = useState<any>(null);
  const [history, setHistory] = useState<any[] | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [seedOpen, setSeedOpen] = useState(false);
  const [seedInput, setSeedInput] = useState('');
  const [detailOpen, setDetailOpen] = useState(false);
  const [legacy, setLegacy] = useState(() => legacyLocalPaper(
    typeof window === 'undefined' ? null : window.localStorage));

  // ── 서버가 진실이다 ──
  //
  // **localStorage를 읽지 않는다.** 읽지 않으므로 로컬 값이 서버 값을
  // 덮을 수 없다 — 규칙을 적는 대신 덮을 통로를 없앤다.
  const load = useCallback(async () => {
    if (auth == null) return;
    try {
      const r = await fetch('/api/paper/account', {
        headers: auth ? { Authorization: auth } : undefined,
      });
      const j = await r.json().catch(() => null);
      setPayload(j);
    } catch {
      setPayload(null);   // **못 읽은 것을 '계좌 없음'으로 두지 않는다**
    } finally {
      setLoaded(true);
    }
    try {
      const r2 = await fetch('/api/paper/positions', {
        headers: auth ? { Authorization: auth } : undefined,
      });
      const j2 = await r2.json().catch(() => null);
      setHistory(j2?.ok && Array.isArray(j2.recentClosed) ? j2.recentClosed : null);
    } catch { setHistory(null); }
  }, [auth]);

  useEffect(() => { load(); }, [load]);
  // 서버가 15분마다 자산을 찍고 워커가 전략을 돌린다. 화면은 30초마다
  // **읽기만** 한다 — 이 타이머가 멈춰도 매매는 계속된다.
  useEffect(() => {
    const t = setInterval(() => { load(); }, 30_000);
    return () => clearInterval(t);
  }, [load]);

  const view: PaperView = paperViewOf({ loaded, payload });

  const start = async (seed: number) => {
    if (busy) return;
    const v = validateSeed(seed);
    if (v.code !== 'OK' || v.value == null) { setMsg({ ok: false, text: v.reason }); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/paper/account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
        body: JSON.stringify({ action: 'reset', seed: v.value }),
      });
      const j = await r.json().catch(() => null);
      // **성공을 지어내지 않는다.** 서버가 ok라고 한 것만 성공이다.
      if (!r.ok || !j?.ok) { setMsg({ ok: false, text: errorTextOf(j, `시작하지 못했습니다 (${r.status})`) }); return; }
      setSeedOpen(false); setSeedInput('');
      setMsg({ ok: true, text: j?.message || '모의 계좌를 시작했습니다' });
      await load();
    } catch (e: any) {
      setMsg({ ok: false, text: `시작 요청이 실패했습니다 — ${e?.message || e}` });
    } finally { setBusy(false); }
  };

  const dropLegacy = () => {
    try {
      for (const k of LEGACY_PAPER_KEYS) window.localStorage.removeItem(k);
      setLegacy(legacyLocalPaper(window.localStorage));
    } catch { /* 못 지워도 서버 값에는 영향이 없다 */ }
  };

  const card: React.CSSProperties = {
    background: T.card, border: `1px solid ${T.border}`, borderRadius: 14,
    padding: '14px 16px', marginBottom: 12,
  };
  const muted: React.CSSProperties = { color: T.muted, fontSize: 10, lineHeight: 1.6 };
  const numFont: React.CSSProperties = { fontFamily: 'Inter,monospace', fontVariantNumeric: 'tabular-nums' };

  const Row = ({ label, value, tone }: { label: string; value: string; tone?: string }) => (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '7px 0', borderBottom: `1px solid ${T.border}` }}>
      <span style={{ color: T.muted, fontSize: 10.5, minWidth: 88 }}>{label}</span>
      <span style={{ marginLeft: 'auto', color: tone || T.txt, fontSize: 12, fontWeight: 800, ...numFont }}>{value}</span>
    </div>
  );
  const signed = (v: number | null) => v == null ? T.muted : v > 0 ? T.grn : v < 0 ? T.red : T.txt;

  return (
    <div>
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
          <span style={{ color: T.txt, fontSize: 13, fontWeight: 800 }}>모의투자</span>
          <span style={{ marginLeft: 'auto', ...muted }}>장부 통화 USDT</span>
        </div>

        {/* **이 화면은 실행기가 아니다.** 사용자가 그것을 알아야
            탭을 닫아도 되는지 판단할 수 있다. */}
        <div style={{ ...muted, background: T.surf, padding: '8px 10px', borderRadius: 8, marginBottom: 10 }}>
          전략 판단과 체결은 <b style={{ color: T.txt }}>서버</b>가 합니다 —
          {' '}{DURABILITY_NOTE.SERVER}. 여기 보이는 값은
          지갑의 모의 탭과 <b style={{ color: T.txt }}>같은 장부</b>입니다.
        </div>

        {view.code === 'LOADING' && <div style={muted}>{view.note}</div>}

        {view.code === 'UNREADABLE' && (
          <>
            <div style={{ ...muted, color: T.ylw }}>{view.note}</div>
            {view.detail && (
              <div style={{ marginTop: 6 }}>
                <button onClick={() => setDetailOpen(v => !v)} style={{
                  background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                  color: T.muted, fontSize: 9.5, textDecoration: 'underline',
                }}>{detailOpen ? '자세히 닫기' : '자세히'}</button>
                {detailOpen && <div style={{ ...muted, marginTop: 4, wordBreak: 'break-all' }}>{view.detail}</div>}
              </div>
            )}
          </>
        )}

        {view.code === 'NOT_STARTED' && (
          <>
            <div style={{ ...muted, marginBottom: 10 }}>{view.note}</div>
            {!seedOpen ? (
              <button onClick={() => { setSeedOpen(true); setMsg(null); }} style={{
                width: '100%', minHeight: 42, borderRadius: 10, cursor: 'pointer',
                background: T.acg, color: T.acl, border: `1px solid ${T.acl}`,
                fontSize: 12, fontWeight: 800,
              }}>모의투자 시작하기</button>
            ) : (
              <>
                <div style={{ color: T.txt, fontSize: 11, fontWeight: 700, marginBottom: 6 }}>초기자금</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                  {PAPER_SEED_CHOICES.map(v => (
                    <button key={v} disabled={busy} onClick={() => start(v)} style={{
                      flex: '1 1 30%', minWidth: 92, minHeight: 40, borderRadius: 10,
                      cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.5 : 1,
                      background: 'transparent', color: T.txt, border: `1px solid ${T.border}`,
                      fontSize: 11.5, fontWeight: 800, ...numFont,
                    }}>{v.toLocaleString('ko-KR')} USDT</button>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input value={seedInput} onChange={e => setSeedInput(e.target.value)}
                    inputMode="decimal" placeholder="직접 입력 (USDT)"
                    style={{
                      flex: 1, minHeight: 34, borderRadius: 8, padding: '0 10px',
                      background: 'transparent', color: T.txt, border: `1px solid ${T.border}`,
                      fontSize: 11, ...numFont,
                    }} />
                  <button disabled={busy || seedInput.trim() === ''} onClick={() => start(Number(seedInput))}
                    style={{
                      minHeight: 34, padding: '0 14px', borderRadius: 8,
                      cursor: busy || seedInput.trim() === '' ? 'not-allowed' : 'pointer',
                      opacity: busy || seedInput.trim() === '' ? 0.5 : 1,
                      background: T.acg, color: T.acl, border: `1px solid ${T.acl}`,
                      fontSize: 11, fontWeight: 800,
                    }}>{busy ? '만드는 중…' : '계좌 만들기'}</button>
                </div>
              </>
            )}
          </>
        )}

        {view.code === 'READY' && (
          <>
            <Row label="총자산" value={view.totalEquity == null ? '확인 불가' : `${num(view.totalEquity)} USDT`} />
            <Row label="현금" value={view.cash == null ? '확인 불가' : `${num(view.cash)} USDT`} />
            <Row label="포지션 증거금" value={view.usedMargin == null ? '확인 불가' : `${num(view.usedMargin)} USDT`} />
            <Row label="미실현손익" value={view.unrealizedPnl == null ? '확인 불가' : `${num(view.unrealizedPnl)} USDT`} tone={signed(view.unrealizedPnl)} />
            <Row label="실현손익" value={view.realizedPnl == null ? '확인 불가' : `${num(view.realizedPnl)} USDT`} tone={signed(view.realizedPnl)} />
            <Row label="오늘 손익" value={view.todayPnl == null ? '확인 불가' : `${num(view.todayPnl)} USDT`} tone={signed(view.todayPnl)} />
            {view.note && <div style={{ ...muted, marginTop: 8, color: T.ylw }}>{view.note}</div>}
          </>
        )}

        {msg && (
          <div style={{ ...muted, marginTop: 8, color: msg.ok ? T.grn : T.red }}>{msg.text}</div>
        )}
      </div>

      {view.code === 'READY' && (
        <div style={card}>
          <div style={{ color: T.txt, fontSize: 12, fontWeight: 800, marginBottom: 8 }}>
            열린 포지션 {view.positions.length}건
          </div>
          {view.positions.length === 0 ? (
            <div style={muted}>열린 모의 포지션이 없습니다.</div>
          ) : view.positions.map(p => (
            <div key={p.id ?? `${p.symbol}-${p.openedAt}`} style={{ padding: '7px 0', borderBottom: `1px solid ${T.border}` }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ color: T.txt, fontSize: 11.5, fontWeight: 800 }}>{p.symbol}</span>
                <span style={{ color: p.side === 'LONG' ? T.grn : T.red, fontSize: 10, fontWeight: 800 }}>{p.side}</span>
                <span style={{ marginLeft: 'auto', color: signed(p.unrealizedPnl), fontSize: 11.5, fontWeight: 800, ...numFont }}>
                  {p.unrealizedPnl == null ? '확인 불가' : `${num(p.unrealizedPnl)} USDT`}
                </span>
              </div>
              <div style={{ ...muted, marginTop: 2 }}>
                수량 {num(p.quantity, 8)} · 진입 {num(p.entryPrice)} · 현재 {p.markPrice == null ? '확인 불가' : num(p.markPrice)}
              </div>
            </div>
          ))}
        </div>
      )}

      {view.code === 'READY' && history != null && history.length > 0 && (
        <div style={card}>
          <div style={{ color: T.txt, fontSize: 12, fontWeight: 800, marginBottom: 8 }}>최근 청산</div>
          {history.slice(0, 10).map((h: any, i: number) => (
            <div key={h?.id ?? i} style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '6px 0', borderBottom: `1px solid ${T.border}` }}>
              <span style={{ color: T.txt, fontSize: 11 }}>{h?.symbol}</span>
              <span style={{ ...muted }}>{h?.closedAt ? new Date(h.closedAt).toLocaleString('ko-KR') : ''}</span>
              <span style={{ marginLeft: 'auto', color: signed(Number(h?.realizedPnl)), fontSize: 11, fontWeight: 800, ...numFont }}>
                {h?.realizedPnl == null ? '확인 불가' : `${num(Number(h.realizedPnl))} USDT`}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* ── 예전 로컬 연습 기록 ──
          **서버 장부에 합치지 않는다.** 원화·체결 방식·TP/SL 규칙이
          달라서 자동으로 옮기면 성적표가 오염된다. 있다는 사실만 알리고
          지울 수 있게 한다. */}
      {legacy.present && (
        <div style={{ ...card, borderColor: A(T.ylw, '55') }}>
          <div style={{ color: T.ylw, fontSize: 11.5, fontWeight: 800, marginBottom: 6 }}>
            예전 로컬 연습 기록이 남아 있습니다
          </div>
          <div style={{ ...muted, marginBottom: 8 }}>
            이 브라우저에만 있던 옛 모의 기록입니다({legacy.keys.length}개 항목).
            원화 기준이고 체결·손절 규칙이 지금과 달라 <b style={{ color: T.txt }}>서버 장부에 합치지 않습니다</b> —
            합치면 성적표가 오염됩니다. 위 숫자에는 포함되지 않습니다.
          </div>
          <button onClick={dropLegacy} style={{
            minHeight: 32, padding: '0 12px', borderRadius: 8, cursor: 'pointer',
            background: 'transparent', color: T.ylw, border: `1px solid ${A(T.ylw, '55')}`,
            fontSize: 10.5, fontWeight: 800,
          }}>이 브라우저에서 지우기</button>
        </div>
      )}
    </div>
  );
}
