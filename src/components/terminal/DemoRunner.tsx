'use client';
// src/components/terminal/DemoRunner.tsx
//
// 데모(모의) 자동매매 스위치.
//
// 이 스위치가 켜져 있는 동안 브라우저가 주기적으로 `/api/paper/run`을
// 부른다. 한 번 부를 때마다 한 사이클이 돈다: 청산 점검 → 손실 한도 →
// 진입.
//
// **이 창을 닫으면 멈춘다.** 이건 한계지 기능이 아니다. 그래서 화면에
// 그대로 적는다 — "돌고 있는 줄 알았는데 안 돌고 있었다"가 자동매매에서
// 가장 흔하고 가장 비싼 착각이다. 창을 닫고도 돌리려면 서버 스케줄러가
// 같은 주소를 주기적으로 부르면 된다.
//
// '미리보기'가 따로 있는 이유
// ───────────────────────────
// 안 들어가는 이유를 볼 수 있어야 한다. 아무 일도 안 일어나는 화면과
// "횡보장이라 안 들어감"은 완전히 다른 상태인데, 로그가 없으면 똑같이
// 보인다.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { C, FS, NUM, ghostBtn } from './theme';
import { useTerminal } from './TerminalContext';

const INTERVALS: Array<[number, string]> = [[60, '1분'], [300, '5분'], [900, '15분']];

interface RunLog {
  at: number;
  ok: boolean;
  text: string;
  dryRun?: boolean;
}

export function DemoRunner({ dense, symbol, onChanged }: {
  dense?: boolean;
  symbol?: string;
  onChanged?: () => void;
}) {
  const { auth } = useTerminal();
  const [on, setOn] = useState(false);
  const [everySec, setEverySec] = useState(60);
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<RunLog[]>([]);
  const [nextAt, setNextAt] = useState<number | null>(null);
  const [tick, setTick] = useState(0);

  // 사이클이 겹치지 않게 한다. 겹치면 같은 포지션에 청산 지시가 두 번 나가고
  // 손익이 두 번 적힌다.
  const running = useRef(false);

  const push = (l: RunLog) => setLogs(prev => [l, ...prev].slice(0, 6));

  const run = useCallback(async (dryRun: boolean) => {
    if (!auth) { push({ at: Date.now(), ok: false, text: '로그인이 필요합니다' }); return; }
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      const qs = symbol ? `?symbols=${encodeURIComponent(symbol)}` : '';
      const r = dryRun
        ? await fetch(`/api/paper/run${qs}`, { headers: { Authorization: auth } })
        : await fetch('/api/paper/run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: auth },
            body: JSON.stringify(symbol ? { symbols: symbol } : {}),
          });
      const j = await r.json().catch(() => null);
      const ok = r.ok && !!j?.ok;
      push({
        at: Date.now(), ok, dryRun,
        text: j?.message || j?.error || `응답 없음 (${r.status})`,
      });
      if (ok && !dryRun && (j?.closed?.length || j?.entered)) onChanged?.();
    } catch (e: any) {
      // 네트워크가 끊긴 것을 '아무 일 없음'으로 그리지 않는다.
      push({ at: Date.now(), ok: false, dryRun, text: `호출 실패 — ${e?.message || e}` });
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, [auth, symbol, onChanged]);

  useEffect(() => {
    if (!on) { setNextAt(null); return; }
    let alive = true;
    const cycle = async () => {
      if (!alive) return;
      await run(false);
      if (alive) setNextAt(Date.now() + everySec * 1000);
    };
    cycle();
    const t = setInterval(cycle, everySec * 1000);
    return () => { alive = false; clearInterval(t); };
  }, [on, everySec, run]);

  // 남은 시간 표시용 — 켜져 있을 때만 돈다
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setTick(v => v + 1), 1000);
    return () => clearInterval(t);
  }, [on]);

  const left = nextAt ? Math.max(0, Math.round((nextAt - Date.now()) / 1000)) : null;

  return (
    <div style={{
      background: C.raised, borderRadius: 8,
      padding: dense ? '8px 10px' : '10px 12px',
      border: `1px solid ${on ? `${C.accent}55` : C.hair}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ color: C.faint, fontSize: FS.micro, fontWeight: 700 }}>
          데모 자동매매{symbol ? ` · ${symbol}` : ''}
        </span>
        <span style={{ ...NUM, fontSize: FS.micro, color: on ? C.accent : C.faint }}>
          {on ? (busy ? '실행 중…' : left != null ? `${left}초 뒤` : '대기') : '꺼짐'}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 5, marginTop: 8 }}>
        <button onClick={() => setOn(v => !v)} style={{
          flex: 1, minHeight: 32, borderRadius: 7, cursor: 'pointer',
          background: on ? C.downBg : C.accentBg,
          color: on ? C.down : C.accent,
          border: `1px solid ${on ? `${C.down}55` : `${C.accent}55`}`,
          fontSize: FS.small, fontWeight: 700,
        }}>{on ? '정지' : '시작'}</button>
        <button onClick={() => run(false)} disabled={busy}
          style={{ ...ghostBtn(), flex: 1, minHeight: 32, fontSize: FS.micro, opacity: busy ? 0.5 : 1 }}>
          지금 한 번
        </button>
        <button onClick={() => run(true)} disabled={busy}
          style={{ ...ghostBtn(), flex: 1, minHeight: 32, fontSize: FS.micro, opacity: busy ? 0.5 : 1 }}>
          미리보기
        </button>
      </div>

      <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
        {INTERVALS.map(([s, label]) => (
          <button key={s} onClick={() => setEverySec(s)}
            style={{ ...ghostBtn(everySec === s), flex: 1, minHeight: 26, fontSize: FS.micro }}>
            {label}
          </button>
        ))}
      </div>

      {logs.length > 0 && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {logs.map((l, i) => (
            <div key={`${l.at}-${i}`} style={{
              fontSize: FS.micro, lineHeight: 1.5,
              color: l.ok ? (i === 0 ? C.text : C.dim) : C.warn,
            }}>
              <span style={{ ...NUM, color: C.faint }}>
                {new Date(l.at).toLocaleTimeString('ko-KR', { hour12: false })}
              </span>
              {l.dryRun && <span style={{ color: C.faint }}> [미리보기]</span>}
              {' '}{l.text}
            </div>
          ))}
        </div>
      )}

      {/* 이 두 줄이 없으면 "돌고 있는 줄 알았는데" 가 생긴다 */}
      <div style={{ color: C.faint, fontSize: FS.micro, marginTop: 8, lineHeight: 1.55 }}>
        가상 자금입니다. 거래소로 아무것도 나가지 않습니다.<br />
        <b>이 창을 닫으면 멈춥니다.</b> 새로고침해도 자동으로 다시 켜지지
        않습니다 — 켠 적 없는 자동매매가 도는 일은 없어야 하니까요.
      </div>
    </div>
  );
}
