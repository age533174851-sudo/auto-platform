'use client';
// src/components/terminal/ScheduledExitPanel.tsx
//
// **시간 예약 청산** — "내일 15:30에 판다".
//
// 이 화면이 반드시 말해야 하는 것
// ───────────────────────────────
// "15:30 매도 예약됨"만 적으면 사람은 그 시각에 팔릴 것을 전제로 다른
// 결정을 한다 — 자러 가거나, 다른 포지션을 더 연다.
//
// 그런데 이 앱의 크론은 **하루 1회**다(Vercel 무료 플랜). 서버만으로는
// 15:30 예약이 다음날 09:00에 걸리고, 그건 늦어서 실행되지도 않는다.
//
// 그래서 이 판은 예약과 **함께 실행기 상태를 늘 띄운다.** 지금 무엇이
// 이 예약을 실행할 수 있는지, 제 시각에 나갈 수 있는지를 같이 적는다.
// 그 줄이 없으면 이 기능은 '되는 것처럼 보이는 기능'이 된다.
import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { errorTextOf } from '@/lib/http/errorText';
import { C, FS, NUM, input } from './theme';
import { useTerminal } from './TerminalContext';
import { toUtcMs, validateSchedule, accuracyNote, fmtGap } from '@/lib/engine/scheduleExit';
import { notifyError, notifySuccess } from '@/lib/notify/center';

const TZ = 'Asia/Seoul';

/** 오늘 날짜를 'YYYY-MM-DD'로 (그 시간대 기준) */
function todayISO(tz: string): string {
  try {
    // en-CA가 YYYY-MM-DD를 준다. 손으로 자르면 시간대가 어긋난다.
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  } catch { return ''; }
}

export const ScheduledExitPanel = memo(function ScheduledExitPanel() {
  const { auth, symbol, modeResolution } = useTerminal();
  const connId = modeResolution?.connId || '';

  const [date, setDate] = useState(() => todayISO(TZ));
  const [time, setTime] = useState('15:30');
  const [portion, setPortion] = useState('');       // 비우면 전량
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [rows, setRows] = useState<any[] | null>(null);
  const [loadErr, setLoadErr] = useState('');

  // 지금 이 화면이 열려 있으니 앱 타이머는 살아 있다.
  // 외부 스케줄러가 붙었는지는 앱이 알 수 없다 — **모르는 것을 켜졌다고
  // 적지 않는다.**
  //
  // repoCron: 저장소 예약 워크플로(.github/workflows/scheduled-exit.yml)가
  // 5분마다 실행 주소를 부른다. **브라우저 없이 도는 유일한 실행기다.**
  // 이게 붙기 전에는 앱을 닫아 두면 하루 1회 크론이 전부라, 예약 시각에
  // 사실상 안 나갔다.
  const acc = accuracyNote({ appOpen: true, repoCron: true, dailyCron: true });

  const load = useCallback(async () => {
    if (!auth) { setRows(null); setLoadErr('로그인이 필요합니다'); return; }
    try {
      const r = await fetch('/api/autotrade/scheduled-exit?list=1', {
        headers: { Authorization: auth },
      });
      const j = await r.json();
      if (j?.ok) { setRows(Array.isArray(j.pending) ? j.pending : []); setLoadErr(''); }
      else setLoadErr(errorTextOf(j, '예약을 읽지 못했습니다'));
    } catch (e: any) { setLoadErr(`예약을 읽지 못했습니다 (${e?.message || e})`); }
  }, [auth]);

  useEffect(() => { load(); }, [load]);

  // ── 앱 타이머 ──
  //
  // 이 앱이 열려 있는 동안 30초마다 실행 주소를 부른다. 크론이 하루
  // 1회뿐이라, 실제로 제 시각에 나가게 하는 것은 지금 이것뿐이다.
  //
  // 30초인 이유: 유예가 30분이라 1분이어도 충분하지만, 화면을 열어 둔
  // 사람이 '지금 지났는데 왜 안 나가지'를 겪지 않으려면 짧은 쪽이 낫다.
  const ticking = useRef(false);
  useEffect(() => {
    if (!auth) return;
    let alive = true;
    const tick = async () => {
      if (ticking.current || !alive) return;
      ticking.current = true;
      try {
        const r = await fetch('/api/autotrade/scheduled-exit', { headers: { Authorization: auth } });
        const j = await r.json();
        if (alive && j?.ok && j.fired > 0) {
          for (const x of (j.results || [])) {
            if (x.result === 'ok') notifySuccess('예약 청산 실행됨', `${x.symbol} — ${x.detail}`);
            else notifyError('예약 청산이 나가지 않았습니다', `${x.symbol} — ${x.detail}`);
          }
          load();
        }
      } catch { /* 다음 주기에 다시 본다 */ }
      finally { ticking.current = false; }
    };
    const t = setInterval(tick, 30_000);
    tick();
    return () => { alive = false; clearInterval(t); };
  }, [auth, load]);

  const runAtMs = toUtcMs(date, time, TZ);
  const valid = validateSchedule(runAtMs, Date.now());

  const create = async () => {
    setMsg(null);
    if (!auth) { setMsg({ ok: false, text: '로그인이 필요합니다' }); return; }
    if (!connId) { setMsg({ ok: false, text: '이 모드에서 쓸 거래소 연결이 없습니다' }); return; }
    if (!valid.ok) { setMsg({ ok: false, text: valid.reason }); return; }

    setBusy(true);
    try {
      const r = await fetch('/api/autotrade/scheduled-exit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({
          connectionId: connId, symbol: symbol.id, runAtMs,
          timeZone: TZ, portionPct: portion === '' ? null : Number(portion),
        }),
      });
      const j = await r.json();
      if (r.ok && j?.ok) {
        setMsg({ ok: true, text: `${date} ${time}에 ${portion === '' ? '전량' : `${portion}%`} 청산 예약됨` });
        load();
      } else setMsg({ ok: false, text: errorTextOf(j, `실패 (${r.status})`) });
    } catch (e: any) { setMsg({ ok: false, text: `실패 (${e?.message || e})` }); }
    finally { setBusy(false); }
  };

  const cancel = async (id: string) => {
    if (!auth) return;
    try {
      await fetch(`/api/autotrade/scheduled-exit?id=${encodeURIComponent(id)}`,
        { method: 'DELETE', headers: { Authorization: auth } });
      load();
    } catch { /* 목록을 다시 읽으면 드러난다 */ }
  };

  return (
    <div style={{ padding: '10px 11px', display: 'flex', flexDirection: 'column', gap: 9 }}>

      {/* **제 시각에 나갈 수 있는가.** 이 판에서 가장 중요한 줄이다 —
          이게 없으면 "예약됨"만 보고 그 시각에 팔릴 것을 전제하게 된다. */}
      <div style={{
        padding: '8px 10px', borderRadius: 8, lineHeight: 1.6,
        background: acc.canBeOnTime ? C.raised : C.downBg,
        color: acc.canBeOnTime ? C.dim : C.down,
        fontSize: FS.micro,
      }}>
        {acc.text}
        {acc.canBeOnTime && (
          <div style={{ color: C.faint, marginTop: 4 }}>
            앱을 닫아도 제 시각에 나가게 하려면 외부 스케줄러가 필요합니다
            (분 단위로 <code>/api/autotrade/scheduled-exit</code>를 <code>x-admin-secret</code>과 함께 호출).
          </div>
        )}
      </div>

      <div style={{ color: C.faint, fontSize: FS.micro }}>
        {symbol.id} 포지션을 이 시각에 시장가로 닫습니다 (한국 시간).
      </div>

      <div style={{ display: 'flex', gap: 6 }}>
        <input type="date" value={date} onChange={e => setDate(e.target.value)}
          style={{ ...input, flex: 1.3, padding: '9px 10px', ...NUM }}/>
        <input type="time" value={time} onChange={e => setTime(e.target.value)}
          style={{ ...input, flex: 1, padding: '9px 10px', ...NUM }}/>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input value={portion} inputMode="numeric" placeholder="비율 (비우면 전량)"
          onChange={e => setPortion(e.target.value.replace(/[^0-9]/g, ''))}
          style={{ ...input, flex: 1, padding: '9px 10px', ...NUM }}/>
        <span style={{ color: C.dim, fontSize: FS.micro, fontWeight: 700 }}>%</span>
      </div>

      {/* 언제 나가는지를 숫자로 되짚어 준다. 날짜를 잘못 고른 것을
          여기서 잡는다 — 저장한 뒤에는 늦다. */}
      <div style={{ color: valid.ok ? C.faint : C.warn, fontSize: FS.micro, lineHeight: 1.5 }}>
        {runAtMs == null
          ? '날짜와 시각을 고르세요'
          : valid.ok
            ? `지금부터 ${fmtGap(runAtMs - Date.now())} 뒤`
            : valid.reason}
      </div>

      {msg && (
        <div style={{
          padding: '7px 9px', borderRadius: 7,
          background: msg.ok ? C.upBg : C.downBg, color: msg.ok ? C.up : C.down,
          fontSize: FS.micro, lineHeight: 1.5,
        }}>{msg.text}</div>
      )}

      <button onClick={create} disabled={busy || !valid.ok}
        style={{
          width: '100%', minHeight: 40, borderRadius: 8,
          cursor: busy || !valid.ok ? 'default' : 'pointer',
          background: C.accentBg, color: C.accent,
          border: `1px solid ${C.accent}`,
          fontSize: FS.small, fontWeight: 700,
          opacity: busy || !valid.ok ? .5 : 1,
        }}>{busy ? '만드는 중…' : '예약 만들기'}</button>

      {/* 대기 중인 예약 */}
      <div style={{ borderTop: `1px solid ${C.hair}`, paddingTop: 9 }}>
        <div style={{ color: C.faint, fontSize: FS.micro, marginBottom: 6 }}>대기 중인 예약</div>
        {loadErr && <div style={{ color: C.warn, fontSize: FS.micro, lineHeight: 1.5 }}>{loadErr}</div>}
        {!loadErr && rows == null && (
          <div style={{ color: C.faint, fontSize: FS.micro }}>읽는 중…</div>
        )}
        {!loadErr && rows != null && rows.length === 0 && (
          <div style={{ color: C.faint, fontSize: FS.micro }}>없습니다</div>
        )}
        {(rows || []).map((r: any) => {
          const at = r?.run_at ? new Date(r.run_at).getTime() : null;
          return (
            <div key={r.id} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '7px 0', borderBottom: `1px solid ${C.hair}`,
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: C.text, fontSize: FS.micro, fontWeight: 700 }}>
                  {r.symbol} · {r.portion_pct == null ? '전량' : `${r.portion_pct}%`}
                </div>
                <div style={{ color: C.faint, fontSize: FS.micro, marginTop: 2, ...NUM }}>
                  {at == null ? '시각 없음'
                    : `${new Intl.DateTimeFormat('ko-KR', {
                        timeZone: r.time_zone || TZ, dateStyle: 'short', timeStyle: 'short',
                      }).format(new Date(at))}`}
                  {at != null && at > Date.now() && ` · ${fmtGap(at - Date.now())} 뒤`}
                </div>
              </div>
              <button onClick={() => cancel(r.id)} style={{
                minHeight: 28, padding: '0 10px', borderRadius: 6, cursor: 'pointer',
                background: 'transparent', border: `1px solid ${C.hair}`,
                color: C.dim, fontSize: FS.micro, fontWeight: 700,
              }}>취소</button>
            </div>
          );
        })}
      </div>
    </div>
  );
});
