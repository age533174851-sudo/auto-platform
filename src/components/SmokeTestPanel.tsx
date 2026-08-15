'use client';
// src/components/SmokeTestPanel.tsx
//
// **강제 스모크 테스트 — 아침 9시를 기다리지 않는다.**
//
// 원본 전략의 판단 창은 하루에 한 번 KST 09:10~09:30 20분뿐이다.
// 그래서 "진입이 나가나 · 손절이 붙나 · 익절이 붙나 · 브라우저를 닫아도
// 청산이 도나 · 고아 주문이 남나"를 확인하려면 매일 아침 한 번씩만
// 시도할 수 있었다. 그 사이에 어제 사고가 났다.
//
// 이 판은 그 한 바퀴를 지금 돌린다. **시장 판단은 하지 않는다** —
// 방향은 사람이 고르고, 확인하려는 것은 배관이다.
//
// 화면이 지켜야 하는 것
// ─────────────────────
//   · **모바일 한 화면에** 시작 · 진행 · 최종 판정이 다 보인다
//   · 단계는 서버가 준 것을 그대로 그린다. 화면이 판정을 만들지 않는다
//   · **PENDING을 초록으로 그리지 않는다** — 확인 안 한 것은 통과가 아니다
//   · 테스트넷이 아니면 시작 버튼 자체가 없다

import React, { useCallback, useEffect, useState } from 'react';
import { T } from '@/lib/constants';
import { A } from '@/lib/theme/colors';
import { errorTextOf } from '@/lib/http/errorText';
import {
  HOLD_CHOICES, SMOKE_SYMBOLS, DEFAULT_HOLD_MIN, type StepState,
} from '@/lib/smoke/smokePlan';

/** 단계 색. **PENDING은 회색이다** — 초록으로 그리면 안 한 것이 한 것처럼 보인다 */
const STEP_TONE: Record<StepState, string> = {
  PASS: T.grn, FAIL: T.red, UNKNOWN: T.ylw,
  RUNNING: T.acl, PENDING: T.muted, SKIPPED: T.muted,
};
const STEP_MARK: Record<StepState, string> = {
  PASS: '✅', FAIL: '❌', UNKNOWN: '⚠️', RUNNING: '⏳', PENDING: '·', SKIPPED: '—',
};

export default function SmokeTestPanel({
  auth, connectionId, isTestnet,
}: { auth: string; connectionId: string; isTestnet: boolean }) {
  const [symbol, setSymbol] = useState<string>('ETHUSDT');
  const [side, setSide] = useState<'LONG' | 'SHORT'>('LONG');
  const [marginUsd, setMarginUsd] = useState('10');
  const [leverage, setLeverage] = useState('100');
  const [holdMin, setHoldMin] = useState(DEFAULT_HOLD_MIN);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [data, setData] = useState<any>(null);
  const [open, setOpen] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const load = useCallback(async () => {
    if (!auth) return;
    try {
      const r = await fetch('/api/autotrade/smoke-test', { headers: { Authorization: auth } });
      const j = await r.json();
      setData(j);
    } catch { /* 다음 주기에 다시 읽는다 */ }
  }, [auth]);

  useEffect(() => { if (open) load(); }, [open, load]);

  // 유지 중인 테스트가 있으면 남은 시간이 흐른다. **이 타이머는 표시용이다** —
  // 실제 청산은 서버(Fly Worker)가 한다. 탭을 닫아도 닫힌다.
  const tests: any[] = Array.isArray(data?.tests) ? data.tests : [];
  const live = tests.find(t => ['PREFLIGHT', 'ENTERING', 'HOLDING', 'CLOSING'].includes(String(t?.state)));
  useEffect(() => {
    if (!open || !live) return;
    const id = setInterval(() => { setNowMs(Date.now()); load(); }, 10_000);
    const t = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => { clearInterval(id); clearInterval(t); };
  }, [open, live, load]);

  const start = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/autotrade/smoke-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({
          symbol, side, connectionId, mode: 'TESTNET',
          marginUsd: Number(marginUsd), leverage: Number(leverage), holdMin,
        }),
      });
      const j = await r.json().catch(() => null);
      setMsg({ ok: !!j?.ok, text: errorTextOf(j, `실패 (${r.status})`) });
      await load();
    } catch (e: any) {
      setMsg({ ok: false, text: `실패 (${e?.message || e})` });
    } finally { setBusy(false); }
  };

  const box: React.CSSProperties = {
    background: T.card, border: `1px solid ${T.border}`,
    borderRadius: 12, padding: 12, marginBottom: 12, minWidth: 0, maxWidth: '100%',
  };

  // ── 테스트넷이 아니면 시작 자체를 안 만든다 ──
  //
  // "실전에서도 눌러 볼 수 있는데 서버가 막는다"가 아니라, 애초에
  // 버튼이 없어야 한다. 진짜 돈으로 배관을 확인하지 않는다.
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

  const remainMs = live?.holdUntil ? Date.parse(String(live.holdUntil)) - nowMs : null;
  const remainText = remainMs == null || !Number.isFinite(remainMs) ? null
    : remainMs > 0
      ? `${Math.floor(remainMs / 60_000)}분 ${Math.floor((remainMs % 60_000) / 1000)}초 뒤 자동 청산`
      : '청산 대기 중 — 서버가 정리하고 있습니다';

  const chip = (on: boolean, tone: string): React.CSSProperties => ({
    flex: 1, minWidth: 0, minHeight: 34, padding: '0 8px', borderRadius: 8,
    background: on ? A(tone, '20') : 'transparent',
    color: on ? tone : T.muted,
    border: `1px solid ${on ? A(tone, '55') : T.border}`,
    fontSize: 11, fontWeight: 800, cursor: 'pointer',
  });

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
        {live && (
          <span style={{ fontSize: 9.5, fontWeight: 800, color: T.acl }}>진행 중</span>
        )}
        <span style={{ color: T.muted, fontSize: 11 }}>{open ? '접기' : '열기'}</span>
      </button>

      {!open ? (
        <div style={{ fontSize: 10, color: T.muted, marginTop: 5, lineHeight: 1.6 }}>
          아침 판단 창을 기다리지 않고 지금 진입 → SL/TP 부착 → 유지 → 청산 →
          고아 주문 정리까지 한 바퀴 확인합니다.
        </div>
      ) : (
        <div style={{ marginTop: 10, display: 'grid', gap: 10 }}>
          <div style={{ fontSize: 10, color: T.muted, lineHeight: 1.6 }}>
            <b style={{ color: T.txt }}>이 거래는 전략 성과에 섞이지 않습니다.</b> 사람이 방향을 고른
            왕복이라 승률·손익·회차 원장(strategy_cycles)에 들어가지 않습니다.
            시작하면 <b style={{ color: T.txt }}>브라우저를 닫아도</b> 서버가 유지 시간 뒤에 전량 청산합니다.
          </div>

          {/* ── 고르기 ── 모바일에서 한 줄에 두 개씩 접히게 둔다 */}
          <div style={{ display: 'grid', gap: 6 }}>
            <Row label="종목">
              {(data?.options?.symbols ?? SMOKE_SYMBOLS).map((s: string) => (
                <button key={s} onClick={() => setSymbol(s)} style={chip(symbol === s, T.acl)}>{s}</button>
              ))}
            </Row>
            <Row label="방향">
              <button onClick={() => setSide('LONG')} style={chip(side === 'LONG', T.grn)}>LONG</button>
              <button onClick={() => setSide('SHORT')} style={chip(side === 'SHORT', T.red)}>SHORT</button>
            </Row>
            <Row label="유지">
              {(data?.options?.holdChoices ?? HOLD_CHOICES).map((m: number) => (
                <button key={m} onClick={() => setHoldMin(m)} style={chip(holdMin === m, T.ylw)}>{m}분</button>
              ))}
            </Row>
            <Row label="증거금">
              <input
                value={marginUsd} onChange={e => setMarginUsd(e.target.value)}
                inputMode="decimal"
                style={{
                  flex: 1, minWidth: 0, minHeight: 34, padding: '0 10px', borderRadius: 8,
                  background: 'transparent', color: T.txt, border: `1px solid ${T.border}`, fontSize: 12,
                }}
              />
              <span style={{ color: T.muted, fontSize: 11, alignSelf: 'center' }}>USDT</span>
            </Row>
            <Row label="배율">
              <input
                value={leverage} onChange={e => setLeverage(e.target.value)}
                inputMode="numeric"
                style={{
                  flex: 1, minWidth: 0, minHeight: 34, padding: '0 10px', borderRadius: 8,
                  background: 'transparent', color: T.txt, border: `1px solid ${T.border}`, fontSize: 12,
                }}
              />
              <span style={{ color: T.muted, fontSize: 11, alignSelf: 'center' }}>배</span>
            </Row>
          </div>

          <button
            onClick={start}
            disabled={busy || !connectionId || !!live}
            style={{
              minHeight: 42, borderRadius: 10, fontSize: 12.5, fontWeight: 800,
              background: live ? 'transparent' : A(T.ylw, '20'),
              color: live ? T.muted : T.ylw,
              border: `1px solid ${live ? T.border : A(T.ylw, '55')}`,
              cursor: busy || !connectionId || live ? 'default' : 'pointer',
              opacity: busy || !connectionId ? 0.55 : 1,
            }}
          >
            {busy ? '진행 중…' : live ? '이미 진행 중입니다' : '테스트 시작'}
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

          {/* ── 진행 상태와 최종 판정 ── 같은 화면에 있어야 한다 */}
          {tests.slice(0, 3).map(t => (
            <TestCard key={t.id} t={t} remainText={t.id === live?.id ? remainText : null} />
          ))}
          {tests.length === 0 && !data?.error && (
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

function TestCard({ t, remainText }: { t: any; remainText: string | null }) {
  const v = t?.verdict ?? {};
  const tone = v.code === 'PASS' ? T.grn : v.code === 'FAIL' ? T.red
    : v.code === 'RUNNING' ? T.acl : T.ylw;
  return (
    <div style={{
      border: `1px solid ${A(tone, '35')}`, borderRadius: 10, padding: 9,
      background: A(tone, '08'), minWidth: 0,
    }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11.5, fontWeight: 800, color: T.txt }}>
          {t.symbol} {t.side}
        </span>
        <span style={{ fontSize: 9.5, color: T.muted }}>
          ${t.marginUsd} · {t.leverage}배 · {t.holdMin}분
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 900, color: tone }}>
          {v.code === 'PASS' ? 'PASS' : v.code === 'FAIL' ? 'FAIL'
            : v.code === 'RUNNING' ? '진행 중' : v.code === 'BLOCKED' ? '시작 못 함' : '확인 못 함'}
        </span>
      </div>

      {remainText && (
        <div style={{ fontSize: 10.5, fontWeight: 700, color: T.acl, marginTop: 4 }}>{remainText}</div>
      )}

      {/* 단계는 **서버가 준 것을 그대로** 그린다. 화면이 판정을 만들지 않는다 */}
      <div style={{ marginTop: 6, display: 'grid', gap: 2 }}>
        {(Array.isArray(t.steps) ? t.steps : []).map((s: any) => (
          <div key={s.id} style={{ display: 'flex', gap: 6, fontSize: 10, lineHeight: 1.55, minWidth: 0 }}>
            <span style={{ width: 14, flexShrink: 0 }}>{STEP_MARK[s.state as StepState] ?? '·'}</span>
            <span style={{
              color: STEP_TONE[s.state as StepState] ?? T.muted,
              fontWeight: s.state === 'PASS' || s.state === 'FAIL' ? 800 : 600,
              minWidth: 96, flexShrink: 0,
            }}>{s.label}</span>
            <span style={{ color: T.muted, minWidth: 0, overflowWrap: 'anywhere' }}>{s.note}</span>
          </div>
        ))}
      </div>

      {t.entry?.avgPrice != null && (
        <div style={{ marginTop: 5, fontSize: 9.5, color: T.muted, overflowWrap: 'anywhere' }}>
          실제 체결가 {t.entry.avgPrice} · 수량 {t.entry.qty ?? '?'}
          {t.entry.slTrigger != null && ` · 손절 ${t.entry.slTrigger}`}
          {t.entry.tpTrigger != null && ` · 익절 ${t.entry.tpTrigger}`}
        </div>
      )}
      {v.reason && (
        <div style={{ marginTop: 4, fontSize: 10, color: tone, lineHeight: 1.55, overflowWrap: 'anywhere' }}>
          {v.reason}
        </div>
      )}
      {t.reason && t.reason !== v.reason && (
        <div style={{ marginTop: 2, fontSize: 9.5, color: T.muted, lineHeight: 1.55, overflowWrap: 'anywhere' }}>
          {t.reason}
        </div>
      )}
    </div>
  );
}
