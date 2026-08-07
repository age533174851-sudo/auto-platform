'use client';
// src/components/terminal/StrategyAccountPanel.tsx
//
// 전략 계좌 — **거래소 계좌 하나를 장부로 나눈다.**
//
// 왜 화면이 필요한가
// ──────────────────
// 표(041)와 API는 만들어 뒀는데 **화면이 없으면 만든 사람 말고는 못
// 쓴다.** 권한 표(039)에서 정확히 그 실수를 한 번 했다 — 표를 만들고
// 값을 넣을 방법을 SQL 말고 안 만들어서, 마이그레이션을 돌린 순간
// 저장소 소유자 본인이 잠겼다.
//
// 이 화면이 반드시 보여야 하는 것
// ───────────────────────────────
//   · 표가 아직 설치되지 않았다는 사실 (빈 목록으로 그리면 "계좌가
//     하나도 없네"로 읽힌다 — 완전히 다른 상태다)
//   · **배정 합계가 실제 자금을 넘는가.** 넘으면 두 전략이 같은 돈을
//     각자 자기 것으로 세고, 둘 다 진입하는 순간 증거금이 모자란다
//   · 각 계좌가 지금 무엇을 들고 있는가 — 그게 소유권 판정의 근거다
//
// 여기서 계산하지 않는다
// ──────────────────────
// 자산·가용·배분 초과는 전부 서버가 준 값을 그대로 그린다. 화면이 자기
// 계산을 가지면 서버와 다른 숫자를 말하기 시작하고, 사용자는 어느 쪽이
// 맞는지 알 방법이 없다.
import React, { useCallback, useEffect, useState } from 'react';
import { errorTextOf } from '@/lib/http/errorText';
import { C, FS, NUM, ghostBtn, fmtPrice } from './theme';
import { useTerminal } from './TerminalContext';

/** 승격 단계 — 뒤로 갈수록 실제 돈에 가깝다 */
const STAGE_LABEL: Record<string, string> = {
  SPECIFICATION: '설계', BACKTEST: '백테스트', WALK_FORWARD: '워크포워드',
  PAPER: '모의', SHADOW: '섀도', TESTNET: '테스트넷',
  LIVE_SMALL: '실전 소액', LIVE_LIMITED: '실전 제한',
};
const REAL_MONEY = new Set(['LIVE_SMALL', 'LIVE_LIMITED']);

export function StrategyAccountPanel() {
  const { auth } = useTerminal();
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  // 새 계좌 입력
  const [sleeveId, setSleeveId] = useState('');
  const [label, setLabel] = useState('');
  const [allocated, setAllocated] = useState('');
  const [stage, setStage] = useState('SPECIFICATION');
  // **총 자금은 사용자가 적는다.** 서버가 지어내면 그 값으로 배분 초과를
  // 판정하게 되고, 그건 검사를 켜 놓고 안 거는 것과 같다.
  const [totalUsd, setTotalUsd] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!auth) { setErr('로그인이 필요합니다'); return; }
    setBusy(true);
    try {
      const q = Number(totalUsd) > 0 ? `?totalUsd=${encodeURIComponent(totalUsd)}` : '';
      const r = await fetch(`/api/strategy-accounts${q}`, { headers: { Authorization: auth } });
      const j = await r.json();
      if (!r.ok || !j?.ok) {
        // **조회 실패를 '계좌 없음'으로 그리지 않는다.** 빈 목록과 못 읽은
        // 목록은 화면에서 둘 다 비어 보이는데, 뜻은 정반대다.
        setData(null);
        setErr(errorTextOf(j, `조회 실패 (${r.status})`));
        return;
      }
      setErr('');
      setData(j);
    } catch (e: any) {
      setData(null);
      setErr(`전략 계좌를 읽지 못했습니다 (${e?.message || e})`);
    } finally { setBusy(false); }
  }, [auth, totalUsd]);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!auth) { setMsg({ ok: false, text: '로그인이 필요합니다' }); return; }
    const id = sleeveId.trim().toUpperCase();
    if (!id) { setMsg({ ok: false, text: '전략 식별자를 적으세요 — 주문에 이 값이 새겨집니다' }); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/strategy-accounts', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: auth },
        body: JSON.stringify({
          sleeveId: id,
          label: label.trim() || id,
          allocated: Number(allocated) || 0,
          stage,
          // 적어 뒀으면 같이 보낸다 — 서버가 배분 합계를 검사한다.
          ...(Number(totalUsd) > 0 ? { totalUsd: Number(totalUsd) } : {}),
        }),
      });
      const j = await r.json();
      if (!r.ok || !j?.ok) {
        setMsg({ ok: false, text: errorTextOf(j, `저장 실패 (${r.status})`) });
        return;
      }
      setMsg({ ok: true, text: j.message || '저장했습니다' });
      setSleeveId(''); setLabel(''); setAllocated('');
      await load();
    } catch (e: any) {
      setMsg({ ok: false, text: `저장하지 못했습니다 (${e?.message || e})` });
    } finally { setBusy(false); }
  };

  const accounts: any[] = Array.isArray(data?.accounts) ? data.accounts : [];
  const alloc = data?.allocation ?? null;

  return (
    <div style={{ padding: '12px 14px', display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ color: C.text, fontWeight: 700, fontSize: FS.small }}>전략 계좌</span>
        <span style={{ color: C.faint, fontSize: FS.micro, flex: 1, minWidth: 0 }}>
          거래소 계좌는 하나여도 장부는 나뉩니다
        </span>
        <button onClick={load} disabled={busy} style={{ ...ghostBtn(), minHeight: 30 }}>
          {busy ? '읽는 중…' : '새로고침'}
        </button>
      </div>

      {/* **표가 없다는 것과 계좌가 없다는 것은 다르다.** */}
      {data && data.installed === false && (
        <div style={{
          padding: '9px 11px', borderRadius: 8, background: C.warnBg,
          color: C.warn, fontSize: FS.micro, lineHeight: 1.6,
        }}>
          <b>전략 계좌 표가 아직 설치되지 않았습니다.</b>
          <div style={{ color: C.dim, marginTop: 3 }}>
            Supabase에서 <b>041_strategy_accounts.sql</b>을 실행하세요. 그전까지
            소유권 검사는 <b>아무것도 막지 않습니다</b> — 지금 상태는 전략 계좌가
            없던 어제와 같습니다.
          </div>
        </div>
      )}

      {/* 표는 있는데 못 읽은 경우. 위와 다른 상태다 */}
      {data && data.installed !== false && data.known === false && (
        <div style={{
          padding: '9px 11px', borderRadius: 8, background: C.downBg,
          color: C.down, fontSize: FS.micro, lineHeight: 1.6,
        }}>
          <b>전략 계좌를 읽지 못했습니다.</b> {data.reason}
          <div style={{ color: C.dim, marginTop: 3 }}>
            이 상태에서는 전략 계좌를 지목한 청산이 <b>막힙니다</b> —
            모르는 채로 남의 포지션을 닫지 않습니다.
          </div>
        </div>
      )}

      {err && (
        <div style={{
          padding: '9px 11px', borderRadius: 8, background: C.downBg,
          color: C.down, fontSize: FS.micro, lineHeight: 1.55,
        }}>{err}</div>
      )}

      {/* ── 총 자금과 배분 합계 ── */}
      <div style={{
        padding: '9px 11px', borderRadius: 8, background: C.raised,
        display: 'grid', gap: 7,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: C.dim, fontSize: FS.micro, flexShrink: 0 }}>총 자금(USDT)</span>
          <input
            value={totalUsd} onChange={e => setTotalUsd(e.target.value)}
            inputMode="decimal" placeholder="50000"
            style={{
              flex: 1, minWidth: 0, background: C.panel, border: `1px solid ${C.hair}`,
              borderRadius: 7, padding: '7px 9px', color: C.text, fontSize: 16, ...NUM,
              outline: 'none',
            }}/>
        </div>
        {/* **안 적으면 검사하지 않는다.** 0으로 치면 모든 배정이 초과로
            보이고, 큰 수를 지어내면 초과를 못 잡는다. */}
        {!(Number(totalUsd) > 0) ? (
          <div style={{ color: C.faint, fontSize: FS.micro, lineHeight: 1.55 }}>
            총 자금을 적으면 <b>배정 합계가 실제 자금을 넘는지</b> 검사합니다.
            안 적으면 검사하지 않습니다 — 지어낸 값으로 판정하지 않습니다.
          </div>
        ) : alloc && (
          <div style={{
            color: alloc.ok ? C.dim : C.down, fontSize: FS.micro, lineHeight: 1.6,
          }}>
            배정 {fmtPrice(alloc.allocated, 2)} / 총 {fmtPrice(alloc.total, 2)}
            {' · '}예비 {fmtPrice(alloc.reserve, 2)}
            {!alloc.ok && <div><b>{alloc.reason}</b></div>}
          </div>
        )}
      </div>

      {/* ── 계좌 목록 ── */}
      {accounts.length === 0 && data?.known && (
        <div style={{ color: C.faint, fontSize: FS.micro, padding: '10px 0', textAlign: 'center' }}>
          아직 전략 계좌가 없습니다. 아래에서 만드세요.
        </div>
      )}

      {accounts.map(a => {
        const syms = Object.keys(a.positions || {});
        return (
          <div key={a.sleeveId} style={{
            background: C.raised, borderRadius: 9, padding: '10px 12px',
            borderLeft: `2px solid ${a.halted ? C.down : REAL_MONEY.has(a.stage) ? C.warn : C.hair3}`,
            minWidth: 0, overflowWrap: 'anywhere',
          }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, flexWrap: 'wrap' }}>
              <span style={{ color: C.text, fontWeight: 700, fontSize: FS.small }}>{a.label}</span>
              <span style={{ color: C.faint, fontSize: FS.micro, ...NUM }}>{a.sleeveId}</span>
              <span style={{
                color: REAL_MONEY.has(a.stage) ? C.warn : C.dim, fontSize: FS.micro, fontWeight: 700,
              }}>
                {STAGE_LABEL[a.stage] || a.stage}
                {REAL_MONEY.has(a.stage) ? ' · 실제 돈' : ''}
              </span>
            </div>

            <div style={{ marginTop: 6, color: C.dim, fontSize: FS.micro, lineHeight: 1.7 }}>
              <div>
                배정 <b style={NUM}>{fmtPrice(a.allocated, 2)}</b>
                {' · '}자산 <b style={NUM}>{fmtPrice(a.equity, 2)}</b>
                {' · '}가용 <b style={NUM}>{fmtPrice(a.available, 2)}</b>
              </div>
              <div>
                실현 <span style={{ ...NUM, color: a.realizedPnl >= 0 ? C.up : C.down }}>
                  {fmtPrice(a.realizedPnl, 2)}
                </span>
                {' · '}미실현 <span style={{ ...NUM, color: a.unrealizedPnl >= 0 ? C.up : C.down }}>
                  {fmtPrice(a.unrealizedPnl, 2)}
                </span>
                {' · '}낙폭 <span style={NUM}>{Number(a.drawdownPct || 0).toFixed(1)}%</span>
              </div>
              {/* **이 줄이 소유권 판정의 근거다.** 여기 없는 심볼은
                  거래소에 포지션이 있어도 이 계좌 것이 아니다. */}
              <div style={{ color: syms.length ? C.text : C.faint }}>
                보유 {syms.length === 0 ? '없음'
                  : syms.map(s => `${s} ${a.positions[s]}`).join(' · ')}
              </div>
            </div>

            {a.halted && (
              <div style={{
                marginTop: 6, padding: '6px 8px', borderRadius: 6,
                background: C.downBg, color: C.down, fontSize: FS.micro,
              }}>
                멈춤 — {a.haltReason || '사유 없음'}
              </div>
            )}
          </div>
        );
      })}

      {/* ── 만들기 ── */}
      <button onClick={() => setOpen(v => !v)} style={{ ...ghostBtn(open), minHeight: 38 }}>
        {open ? '접기' : '전략 계좌 만들기'}
      </button>

      {open && (
        <div style={{ background: C.raised, borderRadius: 9, padding: '11px 12px', display: 'grid', gap: 8 }}>
          <Field label="전략 식별자" hint="주문에 새겨집니다 (예: MINERVINI_TREND)">
            <input value={sleeveId} onChange={e => setSleeveId(e.target.value.toUpperCase())}
              placeholder="MINERVINI_TREND" style={inputStyle}/>
          </Field>
          <Field label="이름" hint="화면에 보일 이름">
            <input value={label} onChange={e => setLabel(e.target.value)}
              placeholder="미네르비니 추세" style={{ ...inputStyle, ...({} as any) }}/>
          </Field>
          <Field label="배정액(USDT)" hint="이 계좌가 쓸 수 있는 원금">
            <input value={allocated} onChange={e => setAllocated(e.target.value)}
              inputMode="decimal" placeholder="5000" style={inputStyle}/>
          </Field>
          <Field label="단계" hint="실전은 마지막 두 단계뿐입니다">
            <select value={stage} onChange={e => setStage(e.target.value)} style={inputStyle}>
              {(data?.stages ?? Object.keys(STAGE_LABEL)).map((s: string) => (
                <option key={s} value={s}>{STAGE_LABEL[s] || s}</option>
              ))}
            </select>
          </Field>

          <button onClick={save} disabled={busy} style={{
            minHeight: 42, borderRadius: 8, border: 'none', cursor: busy ? 'default' : 'pointer',
            background: busy ? C.hair : C.accent, color: '#fff', fontWeight: 700, fontSize: FS.small,
          }}>{busy ? '저장 중…' : '저장'}</button>

          {msg && (
            <div style={{
              padding: '7px 9px', borderRadius: 7, fontSize: FS.micro, lineHeight: 1.55,
              background: msg.ok ? C.upBg : C.downBg, color: msg.ok ? C.up : C.down,
            }}>{msg.text}</div>
          )}
        </div>
      )}

      <div style={{ color: C.faint, fontSize: FS.micro, lineHeight: 1.6 }}>
        전략 계좌를 <b>지목한 청산만</b> 소유권을 따집니다. 손으로 누르는
        청산은 지금까지와 똑같이 나갑니다 — 넓게 막으면 자기 포지션을 못
        닫게 됩니다.
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%', minWidth: 0, background: C.panel, border: `1px solid ${C.hair}`,
  borderRadius: 7, padding: '8px 10px', color: C.text,
  // 16px 아래로 내려가면 iOS가 입력할 때 화면을 확대한다.
  fontSize: 16, outline: 'none',
};

function Field(
  { label, hint, children }: { label: string; hint?: string; children: React.ReactNode },
) {
  return (
    <label style={{ display: 'grid', gap: 4 }}>
      <span style={{ color: C.dim, fontSize: FS.micro, fontWeight: 700 }}>{label}</span>
      {children}
      {hint && <span style={{ color: C.faint, fontSize: FS.micro }}>{hint}</span>}
    </label>
  );
}
