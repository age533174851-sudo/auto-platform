'use client';
// src/components/SmokeTestPanel.tsx
//
// **강제 스모크 테스트 — 아침 9시를 기다리지 않는다. 그리고 한 번으로
// 끝내지 않는다.**
//
// 원본 전략의 판단 창은 하루 한 번 KST 09:10~09:30 20분뿐이다. 그래서
// "진입이 나가나 · 손절이 붙나 · 익절이 붙나 · 브라우저를 닫아도 청산이
// 도나 · 고아 주문이 남나"를 매일 아침 한 번씩만 확인할 수 있었다.
//
// 그런데 이번에 실제로 터진 고장은 전부 **두 번째 회차부터** 드러나는
// 것이었다 — 첫 회차는 깨끗한 계좌에서 시작하므로 무엇을 안 치웠는지
// 알 수가 없다. 그래서 횟수와 **LONG↔SHORT 교대**가 있다.
//
// 화면이 지켜야 하는 것
// ─────────────────────
//   · **모바일 한 화면에** 시작 · 회차별 진행 · 최종 판정이 다 보인다
//   · 판정은 서버가 준 것을 그대로 그린다. 화면이 만들지 않는다
//   · **대기 회차를 숨기지 않는다** — 안 보이면 끝난 줄 알고, 그 사이
//     다음 회차가 돌면 놀란다
//   · 예상 소요 시간을 먼저 보여준다. 10분 × 10회는 110분이다

import React, { useCallback, useEffect, useState } from 'react';
import { T } from '@/lib/constants';
import { A } from '@/lib/theme/colors';
import { errorTextOf } from '@/lib/http/errorText';
import { HOLD_CHOICES, SMOKE_SYMBOLS, DEFAULT_HOLD_MIN, type StepState } from '@/lib/smoke/smokePlan';
import {
  ATTEMPT_CHOICES, MAX_ATTEMPTS, DEFAULT_ATTEMPTS,
  type DirectionMode, type FailurePolicy, type StepMark,
} from '@/lib/smoke/smokeRun';

/** 단계 색. **PENDING은 회색이다** — 초록으로 그리면 안 한 것이 한 것처럼 보인다 */
const STEP_TONE: Record<StepState, string> = {
  PASS: T.grn, FAIL: T.red, UNKNOWN: T.ylw,
  RUNNING: T.acl, PENDING: T.muted, SKIPPED: T.muted,
};
const STEP_MARK: Record<StepState, string> = {
  PASS: '✅', FAIL: '❌', UNKNOWN: '⚠️', RUNNING: '⏳', PENDING: '·', SKIPPED: '—',
};
const ATTEMPT_MARK: Record<StepMark, string> = {
  PASS: '✅', FAIL: '❌', RUNNING: '⏳', WAITING: '·', BLOCKED: '⛔', UNKNOWN: '⚠️',
};
const ATTEMPT_TONE: Record<StepMark, string> = {
  PASS: T.grn, FAIL: T.red, RUNNING: T.acl, WAITING: T.muted, BLOCKED: T.ylw, UNKNOWN: T.ylw,
};

export default function SmokeTestPanel({
  auth, connectionId, isTestnet,
}: { auth: string; connectionId: string; isTestnet: boolean }) {
  const [symbol, setSymbol] = useState<string>('ETHUSDT');
  const [side, setSide] = useState<'LONG' | 'SHORT'>('LONG');
  const [marginUsd, setMarginUsd] = useState('10');
  const [leverage, setLeverage] = useState('100');
  const [holdMin, setHoldMin] = useState(DEFAULT_HOLD_MIN);
  const [attempts, setAttempts] = useState<number>(DEFAULT_ATTEMPTS);
  const [customAttempts, setCustomAttempts] = useState('');
  const [directionMode, setDirectionMode] = useState<DirectionMode>('ALTERNATE');
  const [failurePolicy, setFailurePolicy] = useState<FailurePolicy>('SAFE');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [data, setData] = useState<any>(null);
  const [open, setOpen] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  // 거래소에 남은 보호주문. **null은 '아직 안 봤다'이고 []는 '없다'이다.**
  const [orphans, setOrphans] = useState<any>(null);

  const load = useCallback(async () => {
    if (!auth) return;
    try {
      const r = await fetch('/api/autotrade/smoke-test', { headers: { Authorization: auth } });
      setData(await r.json());
    } catch { /* 다음 주기에 다시 읽는다 */ }
  }, [auth]);

  useEffect(() => { if (open) load(); }, [open, load]);

  const runs: any[] = Array.isArray(data?.runs) ? data.runs : [];
  const liveRun = runs.find(r => String(r?.state) === 'RUNNING');
  const liveTest = liveRun?.tests?.find((t: any) =>
    ['PREFLIGHT', 'ENTERING', 'HOLDING', 'CLOSING'].includes(String(t?.state)));

  // 남은 시간은 **표시용**이다. 실제 청산과 다음 회차 시작은 서버(Fly
  // Worker)가 한다 — 탭을 닫아도 끝까지 돈다.
  useEffect(() => {
    if (!open || !liveRun) return;
    const poll = setInterval(() => { setNowMs(Date.now()); load(); }, 10_000);
    const tick = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => { clearInterval(poll); clearInterval(tick); };
  }, [open, liveRun, load]);

  const effectiveAttempts = (() => {
    const n = Number(customAttempts);
    if (customAttempts !== '' && Number.isFinite(n)) return Math.round(n);
    return attempts;
  })();
  const estimatedMin = effectiveAttempts > 0 ? effectiveAttempts * (holdMin + 1) : null;

  const start = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/autotrade/smoke-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({
          symbol, side, connectionId, mode: 'TESTNET',
          marginUsd: Number(marginUsd), leverage: Number(leverage), holdMin,
          attempts: effectiveAttempts, directionMode, failurePolicy,
        }),
      });
      const j = await r.json().catch(() => null);
      setMsg({ ok: !!j?.ok, text: errorTextOf(j, `실패 (${r.status})`) });
      await load();
    } catch (e: any) {
      setMsg({ ok: false, text: `실패 (${e?.message || e})` });
    } finally { setBusy(false); }
  };

  const stop = async (runId: string) => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/autotrade/smoke-test/advance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({ stop: true, runId }),
      });
      const j = await r.json().catch(() => null);
      setMsg({ ok: !!j?.ok, text: errorTextOf(j, `실패 (${r.status})`) });
      await load();
    } catch (e: any) {
      setMsg({ ok: false, text: `실패 (${e?.message || e})` });
    } finally { setBusy(false); }
  };

  // ── 거래소에 남은 보호주문 ──
  //
  // **아무것도 지우지 않고 먼저 보여 준다.** 2026-08-15에 포지션 0인데
  // 조건부 주문 2건이 남았을 때, 그 두 건의 정확한 주문 번호를 볼
  // 방법이 없어서 화면의 트리거 가격으로 추측해야 했다.
  const scanOrphans = async () => {
    if (!connectionId) return;
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(
        `/api/autotrade/smoke-test/orphans?connectionId=${encodeURIComponent(connectionId)}&symbol=${encodeURIComponent(symbol)}`,
        { headers: { Authorization: auth } });
      const j = await r.json().catch(() => null);
      setOrphans(j);
      if (!j?.ok) setMsg({ ok: false, text: errorTextOf(j, `확인 실패 (${r.status})`) });
    } catch (e: any) {
      setMsg({ ok: false, text: `확인 실패 (${e?.message || e})` });
    } finally { setBusy(false); }
  };

  // **번호 하나만 지운다.** 전체 취소 버튼은 만들지 않는다 —
  // 만들면 언젠가 눌리고, 그때 다른 전략의 손절이 같이 사라진다.
  const cancelOne = async (id: string) => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/autotrade/smoke-test/orphans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({ connectionId, symbol, ids: [id] }),
      });
      const j = await r.json().catch(() => null);
      setMsg({
        ok: !!j?.ok,
        text: j?.ledger?.entries?.[0]?.note || errorTextOf(j, `취소 실패 (${r.status})`),
      });
      await scanOrphans();
    } catch (e: any) {
      setMsg({ ok: false, text: `취소 실패 (${e?.message || e})` });
    } finally { setBusy(false); }
  };

  const box: React.CSSProperties = {
    background: T.card, border: `1px solid ${T.border}`,
    borderRadius: 12, padding: 12, marginBottom: 12, minWidth: 0, maxWidth: '100%',
  };

  // ── 테스트넷이 아니면 시작 자체를 안 만든다 ──
  if (!isTestnet) {
    return (
      <div style={box}>
        <div style={{ fontSize: 12, fontWeight: 800, color: T.txt }}>강제 스모크 테스트</div>
        <div style={{ fontSize: 10.5, color: T.muted, marginTop: 5, lineHeight: 1.6 }}>
          테스트넷 연결에서만 돕니다 — 진짜 돈으로 배관을 확인하지 않습니다.
          위에서 테스트넷 연결을 고르면 여기에 시작 버튼이 생깁니다.
        </div>
      </div>
    );
  }

  const remainMs = liveTest?.holdUntil ? Date.parse(String(liveTest.holdUntil)) - nowMs : null;
  const remainText = remainMs == null || !Number.isFinite(remainMs) ? null
    : remainMs > 0
      ? `${Math.floor(remainMs / 60_000)}분 ${Math.floor((remainMs % 60_000) / 1000)}초 뒤 자동 청산`
      : '청산 대기 중 — 서버가 정리하고 있습니다';

  const chip = (on: boolean, tone: string): React.CSSProperties => ({
    flex: 1, minWidth: 0, minHeight: 34, padding: '0 6px', borderRadius: 8,
    background: on ? A(tone, '20') : 'transparent',
    color: on ? tone : T.muted,
    border: `1px solid ${on ? A(tone, '55') : T.border}`,
    fontSize: 11, fontWeight: 800, cursor: 'pointer',
  });
  const input: React.CSSProperties = {
    flex: 1, minWidth: 0, minHeight: 34, padding: '0 10px', borderRadius: 8,
    background: 'transparent', color: T.txt, border: `1px solid ${T.border}`, fontSize: 12,
  };

  return (
    <div style={box}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 8,
          background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left',
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 800, color: T.txt, flex: 1, minWidth: 0 }}>
          강제 스모크 테스트
          <span style={{ color: T.ylw, fontWeight: 700, marginLeft: 6, fontSize: 10 }}>TESTNET</span>
        </span>
        {liveRun && (
          <span style={{ fontSize: 9.5, fontWeight: 800, color: T.acl }}>
            {liveRun.progress?.headline ?? '진행 중'}
          </span>
        )}
        <span style={{ color: T.muted, fontSize: 11 }}>{open ? '접기' : '열기'}</span>
      </button>

      {!open ? (
        <div style={{ fontSize: 10, color: T.muted, marginTop: 5, lineHeight: 1.6 }}>
          아침 판단 창을 기다리지 않고 진입 → SL/TP → 유지 → 청산 → 고아 주문 정리를
          한 바퀴 확인합니다. 반복(최대 {MAX_ATTEMPTS}회)과 LONG↔SHORT 교대를 고를 수 있습니다.
        </div>
      ) : (
        <div style={{ marginTop: 10, display: 'grid', gap: 10 }}>
          <div style={{ fontSize: 10, color: T.muted, lineHeight: 1.6 }}>
            <b style={{ color: T.txt }}>이 거래는 전략 성과에 섞이지 않습니다.</b> 승률·손익·회차
            원장(strategy_cycles)에 들어가지 않습니다. 시작하면 <b style={{ color: T.txt }}>브라우저를
            닫아도</b> 서버가 유지 시간 뒤에 청산하고 다음 회차를 이어 갑니다.
          </div>

          <div style={{ display: 'grid', gap: 6 }}>
            <Row label="종목">
              {(data?.options?.symbols ?? SMOKE_SYMBOLS).map((s: string) => (
                <button key={s} onClick={() => setSymbol(s)} style={chip(symbol === s, T.acl)}>{s}</button>
              ))}
            </Row>

            {/* ── 방향 ──
                교대가 기본이다. 이번에 터진 고장이 "전날 숏이 남은 상태에서
                다음 롱이 들어가 상계된 것"이라, 같은 방향 10번보다 번갈아
                도는 쪽이 lifecycle 버그를 훨씬 잘 잡는다. */}
            <Row label="방향">
              <button onClick={() => { setDirectionMode('LONG'); setSide('LONG'); }}
                style={chip(directionMode === 'LONG', T.grn)}>LONG 고정</button>
              <button onClick={() => { setDirectionMode('SHORT'); setSide('SHORT'); }}
                style={chip(directionMode === 'SHORT', T.red)}>SHORT 고정</button>
              <button onClick={() => setDirectionMode('ALTERNATE')}
                style={chip(directionMode === 'ALTERNATE', T.acl)}>교대</button>
            </Row>
            {directionMode === 'ALTERNATE' && (
              <Row label="1회차">
                <button onClick={() => setSide('LONG')} style={chip(side === 'LONG', T.grn)}>LONG부터</button>
                <button onClick={() => setSide('SHORT')} style={chip(side === 'SHORT', T.red)}>SHORT부터</button>
              </Row>
            )}

            {/* ── 횟수 ──
                한 번 통과한 것은 통과가 아니다. 다만 10분 × 10회는 110분이라,
                검증은 1분 × 10회로 먼저 하고 안정되면 10분으로 한 번 더 돈다. */}
            <Row label="횟수">
              {(data?.options?.attemptChoices ?? ATTEMPT_CHOICES).map((n: number) => (
                <button key={n}
                  onClick={() => { setAttempts(n); setCustomAttempts(''); }}
                  style={chip(customAttempts === '' && attempts === n, T.ylw)}>{n}회</button>
              ))}
              <input
                value={customAttempts} onChange={e => setCustomAttempts(e.target.value)}
                placeholder="직접" inputMode="numeric"
                style={{ ...input, flex: 0.8, textAlign: 'center' }}
              />
            </Row>

            <Row label="유지">
              {(data?.options?.holdChoices ?? HOLD_CHOICES).map((m: number) => (
                <button key={m} onClick={() => setHoldMin(m)} style={chip(holdMin === m, T.ylw)}>{m}분</button>
              ))}
            </Row>

            {/* ── 실패 정책 ──
                어느 쪽이든 UNKNOWN에서는 다음 회차로 가지 않는다. 모르는
                상태에서 새 주문을 내는 것이 이번 사고의 뿌리다. */}
            <Row label="실패 시">
              <button onClick={() => setFailurePolicy('SAFE')}
                style={chip(failurePolicy === 'SAFE', T.red)}>즉시 중지</button>
              <button onClick={() => setFailurePolicy('DURABLE')}
                style={chip(failurePolicy === 'DURABLE', T.ylw)}>정리 확인 시 계속</button>
            </Row>

            <Row label="증거금">
              <input value={marginUsd} onChange={e => setMarginUsd(e.target.value)} inputMode="decimal" style={input} />
              <span style={{ color: T.muted, fontSize: 11, alignSelf: 'center' }}>USDT</span>
            </Row>
            <Row label="배율">
              <input value={leverage} onChange={e => setLeverage(e.target.value)} inputMode="numeric" style={input} />
              <span style={{ color: T.muted, fontSize: 11, alignSelf: 'center' }}>배</span>
            </Row>
          </div>

          {/* **먼저 얼마나 걸리는지 알려 준다.** 모르고 시작하면
              "왜 안 끝나지"가 된다. */}
          {estimatedMin != null && (
            <div style={{ fontSize: 10, color: estimatedMin > 60 ? T.ylw : T.muted, lineHeight: 1.6 }}>
              {effectiveAttempts}회 × 유지 {holdMin}분 → <b>예상 {estimatedMin}분</b>
              {estimatedMin > 60 && ' — 먼저 유지 1분으로 반복 검증한 뒤, 안정되면 긴 유지로 한 번 더 도세요'}
            </div>
          )}

          <button
            onClick={start}
            disabled={busy || !connectionId || !!liveRun}
            style={{
              minHeight: 42, borderRadius: 10, fontSize: 12.5, fontWeight: 800,
              background: liveRun ? 'transparent' : A(T.ylw, '20'),
              color: liveRun ? T.muted : T.ylw,
              border: `1px solid ${liveRun ? T.border : A(T.ylw, '55')}`,
              cursor: busy || !connectionId || liveRun ? 'default' : 'pointer',
              opacity: busy || !connectionId ? 0.55 : 1,
            }}
          >
            {busy ? '진행 중…' : liveRun ? '이미 진행 중입니다' : `테스트 시작 (${effectiveAttempts}회)`}
          </button>
          {!connectionId && (
            <div style={{ fontSize: 10, color: T.muted }}>거래소 연결을 먼저 고르세요 — 대신 골라 주지 않습니다</div>
          )}

          {msg && (
            <div style={{
              fontSize: 10.5, lineHeight: 1.6, padding: 8, borderRadius: 8,
              color: msg.ok ? T.grn : T.red,
              background: A(msg.ok ? T.grn : T.red, '12'),
              border: `1px solid ${A(msg.ok ? T.grn : T.red, '35')}`,
              overflowWrap: 'anywhere',
            }}>{msg.text}</div>
          )}

          {data?.error === 'table_missing' && (
            <div style={{ fontSize: 10.5, color: T.ylw, lineHeight: 1.6 }}>{data.message}</div>
          )}

          {/* ── 거래소에 남은 보호주문 ──
              포지션 0인데 조건부 주문이 남으면 다음 진입이 예상치 못하게
              닫힌다. **추측하지 않고 거래소가 준 번호를 그대로 보여 준다.** */}
          <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 10, display: 'grid', gap: 6 }}>
            <button
              onClick={scanOrphans}
              disabled={busy || !connectionId}
              style={{
                minHeight: 34, borderRadius: 9, fontSize: 11.5, fontWeight: 700,
                background: 'transparent', color: T.acl,
                border: `1px solid ${A(T.acl, '45')}`,
                cursor: busy || !connectionId ? 'default' : 'pointer',
                opacity: busy || !connectionId ? 0.55 : 1,
              }}
            >{busy ? '확인 중…' : `${symbol} 남은 보호주문 확인 (지우지 않습니다)`}</button>

            {orphans && (
              <div style={{ display: 'grid', gap: 6 }}>
                <div style={{ fontSize: 10, color: T.muted, lineHeight: 1.6 }}>
                  포지션 {orphans?.position?.ok === false ? '확인 불가'
                    : orphans?.position?.found ? `${orphans?.position?.qty ?? '?'} 열림` : '0'}
                  {' · '}
                  {orphans?.ordersReadable === false
                    ? '조건부 주문 목록을 읽지 못했습니다 (0건과 다릅니다)'
                    : `조건부 주문 ${(orphans?.orders ?? []).length}건`}
                </div>
                {(orphans?.orders ?? []).map((o: any) => (
                  <div key={o.id} style={{
                    border: `1px solid ${T.border}`, borderRadius: 9, padding: 8,
                    display: 'grid', gap: 4, minWidth: 0,
                  }}>
                    <div style={{ fontSize: 10.5, color: T.txt, overflowWrap: 'anywhere' }}>
                      <b>#{o.id}</b> · 트리거 {o.triggerPrice ?? '?'} · rule {o.rule ?? '?'}
                      {o.autoSize ? ` · ${o.autoSize}` : ''}
                    </div>
                    <div style={{ fontSize: 10, color: T.muted, overflowWrap: 'anywhere' }}>
                      식별자 {o.text ?? '없음'} · 판정 <b style={{
                        color: o.ownership === 'MINE' ? T.grn : o.ownership === 'FOREIGN' ? T.ylw : T.red,
                      }}>{o.ownership}</b>
                    </div>
                    {/* **남의 전략 주문에는 취소 버튼을 만들지 않는다.** */}
                    {o.ownership !== 'FOREIGN' && (
                      <button
                        onClick={() => cancelOne(o.id)}
                        disabled={busy}
                        style={{
                          minHeight: 30, borderRadius: 8, fontSize: 11, fontWeight: 700,
                          background: A(T.red, '14'), color: T.red,
                          border: `1px solid ${A(T.red, '40')}`,
                          cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.55 : 1,
                        }}
                      >이 주문만 취소 (#{o.id})</button>
                    )}
                  </div>
                ))}
                {(orphans?.orders ?? []).length === 0 && orphans?.ordersReadable !== false && (
                  <div style={{ fontSize: 10, color: T.grn }}>남은 조건부 주문이 없습니다.</div>
                )}
              </div>
            )}
          </div>

          {runs.slice(0, 3).map(r => (
            <RunCard key={r.id} run={r} remainText={r.id === liveRun?.id ? remainText : null}
              onStop={r.state === 'RUNNING' ? () => stop(r.id) : null} busy={busy} />
          ))}
          {runs.length === 0 && !data?.error && (
            <div style={{ fontSize: 10, color: T.muted }}>아직 돌린 테스트가 없습니다.</div>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <span style={{ color: T.muted, fontSize: 10.5, minWidth: 42, flexShrink: 0 }}>{label}</span>
      <div style={{ display: 'flex', gap: 5, flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  );
}

function RunCard({ run, remainText, onStop, busy }: {
  run: any; remainText: string | null; onStop: (() => void) | null; busy: boolean;
}) {
  const s = run?.summary ?? {};
  const p = run?.progress ?? {};
  const tone = s.code === 'PASS' ? T.grn : s.code === 'FAIL' ? T.red
    : s.code === 'RUNNING' ? T.acl : T.ylw;
  const [openAttempt, setOpenAttempt] = React.useState<number | null>(null);

  return (
    <div style={{
      border: `1px solid ${A(tone, '35')}`, borderRadius: 10, padding: 9,
      background: A(tone, '08'), minWidth: 0,
    }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11.5, fontWeight: 800, color: T.txt }}>
          {run.symbol} {run.directionMode === 'ALTERNATE' ? `${run.firstSide}↔` : run.directionMode}
        </span>
        <span style={{ fontSize: 9.5, color: T.muted }}>
          ${run.marginUsd} · {run.leverage}배 · {run.holdMin}분 · {run.failurePolicy === 'SAFE' ? '즉시중지' : '정리확인'}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 900, color: tone }}>
          {s.code === 'PASS' ? 'PASS' : s.code === 'FAIL' ? 'FAIL'
            : s.code === 'RUNNING' ? '진행 중' : '중단'}
        </span>
      </div>

      {/* ── 총 10회 · 완료 3 · 진행 1 · 대기 6 ── */}
      <div style={{ marginTop: 5, fontSize: 10.5, fontWeight: 700, color: T.txt }}>{p.headline}</div>

      {/* 회차별 한 줄. **대기 회차를 숨기지 않는다** */}
      <div style={{ marginTop: 5, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {(Array.isArray(p.marks) ? p.marks : []).map((m: any) => (
          <button key={m.attemptNo}
            onClick={() => setOpenAttempt(openAttempt === m.attemptNo ? null : m.attemptNo)}
            style={{
              display: 'flex', gap: 3, alignItems: 'center',
              padding: '3px 6px', borderRadius: 6, minWidth: 0,
              border: `1px solid ${A(ATTEMPT_TONE[m.state as StepMark] ?? T.muted, '35')}`,
              background: openAttempt === m.attemptNo ? A(ATTEMPT_TONE[m.state as StepMark] ?? T.muted, '18') : 'transparent',
              color: ATTEMPT_TONE[m.state as StepMark] ?? T.muted,
              fontSize: 9.5, fontWeight: 800, cursor: 'pointer',
            }}>
            <span>{m.attemptNo}</span>
            <span>{ATTEMPT_MARK[m.state as StepMark] ?? '·'}</span>
            <span style={{ fontWeight: 600 }}>{m.side ?? ''}</span>
          </button>
        ))}
      </div>

      {remainText && (
        <div style={{ fontSize: 10.5, fontWeight: 700, color: T.acl, marginTop: 5 }}>{remainText}</div>
      )}

      {/* 고른 회차의 단계 — 서버가 준 것을 그대로 그린다 */}
      {openAttempt != null && (() => {
        const t = (run.tests ?? []).find((x: any) => x.attemptNo === openAttempt);
        if (!t) {
          return <div style={{ marginTop: 6, fontSize: 10, color: T.muted }}>
            {openAttempt}회차는 아직 시작하지 않았습니다 — 앞 회차가 끝나야 시작합니다.
          </div>;
        }
        return (
          <div style={{ marginTop: 6, borderTop: `1px solid ${T.border}`, paddingTop: 6 }}>
            <div style={{ fontSize: 10, color: T.muted, marginBottom: 4 }}>
              {t.attemptNo}회차 {t.side}
              {t.source ? ` · ${t.source === 'FLY_WORKER' ? '서버가 시작' : '사람이 시작'}` : ''}
              {t.timing?.entryLatencyMs != null ? ` · 진입 ${t.timing.entryLatencyMs}ms` : ''}
              {t.timing?.slippagePct != null ? ` · 슬리피지 ${t.timing.slippagePct}%` : ''}
            </div>
            <div style={{ display: 'grid', gap: 2 }}>
              {(Array.isArray(t.steps) ? t.steps : []).map((st: any) => (
                <div key={st.id} style={{ display: 'flex', gap: 6, fontSize: 10, lineHeight: 1.55, minWidth: 0 }}>
                  <span style={{ width: 14, flexShrink: 0 }}>{STEP_MARK[st.state as StepState] ?? '·'}</span>
                  <span style={{
                    color: STEP_TONE[st.state as StepState] ?? T.muted,
                    fontWeight: st.state === 'PASS' || st.state === 'FAIL' ? 800 : 600,
                    minWidth: 96, flexShrink: 0,
                  }}>{st.label}</span>
                  <span style={{ color: T.muted, minWidth: 0, overflowWrap: 'anywhere' }}>{st.note}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {/* ── 최종 결과 ── */}
      <div style={{ marginTop: 6, display: 'grid', gap: 1 }}>
        {(Array.isArray(s.lines) ? s.lines : []).map((l: string, k: number) => (
          <div key={k} style={{ fontSize: 10, color: T.txt, lineHeight: 1.55, overflowWrap: 'anywhere' }}>{l}</div>
        ))}
      </div>

      {/* 성능. **표본이 없으면 0이 아니라 '측정 없음'이다** */}
      {run.metrics && run.metrics.samples > 0 && (
        <div style={{ marginTop: 4, fontSize: 9.5, color: T.muted, lineHeight: 1.55, overflowWrap: 'anywhere' }}>
          진입 지연 평균 {fmtMs(run.metrics.entryLatencyMsAvg)} · 청산 지연 평균 {fmtMs(run.metrics.exitLatencyMsAvg)}
          {' · '}슬리피지 평균 {run.metrics.slippagePctAvg == null ? '측정 없음' : `${run.metrics.slippagePctAvg}%`}
          {' · '}최대 API 지연 {fmtMs(run.metrics.apiLatencyMsMax)}
        </div>
      )}

      {(s.reason || run.reason) && (
        <div style={{ marginTop: 4, fontSize: 10, color: tone, lineHeight: 1.55, overflowWrap: 'anywhere' }}>
          {s.reason || run.reason}
        </div>
      )}
      {run.advance?.reason && run.state === 'RUNNING' && (
        <div style={{ marginTop: 2, fontSize: 9.5, color: T.muted, lineHeight: 1.55, overflowWrap: 'anywhere' }}>
          {run.advance.reason}
        </div>
      )}

      {onStop && (
        <button onClick={onStop} disabled={busy} style={{
          marginTop: 7, minHeight: 30, width: '100%', borderRadius: 8,
          background: 'transparent', color: T.muted, border: `1px solid ${T.border}`,
          fontSize: 10.5, fontWeight: 700, cursor: busy ? 'default' : 'pointer',
        }}>다음 회차 중지 (열려 있는 회차는 마감 시각에 청산됩니다)</button>
      )}
    </div>
  );
}

const fmtMs = (v: number | null | undefined) =>
  v == null ? '측정 없음' : v >= 1000 ? `${(v / 1000).toFixed(1)}초` : `${Math.round(v)}ms`;
