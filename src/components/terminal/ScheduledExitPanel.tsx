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
import { toUtcMs, validateSchedule, fmtGap } from '@/lib/engine/scheduleExit';
// **화면이 실행기 상태를 지어내지 않는다.** 서버가 준 사실로 판정한다.
import { scheduledExitRunnerOf } from '@/lib/engine/scheduledExitRunner';
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
  /** 끝난 예약. **null은 '아직 안 읽음'이지 '없음'이 아니다** */
  const [hist, setHist] = useState<any[] | null>(null);
  const [histErr, setHistErr] = useState('');
  const [histOpen, setHistOpen] = useState(false);

  // ── 제 시각에 나갈 수 있는가 ──
  //
  // **예전에는 세 인자가 전부 하드코딩 true였다:**
  //
  //   accuracyNote({ appOpen: true, repoCron: true, dailyCron: true })
  //
  // 아무것도 확인하지 않고 "앱을 닫아도 제 시각에 나갑니다"를 적었다.
  // 그리고 그 약속은 사실이 아니었다 — 브라우저 없이 도는 실행기는
  // GitHub 예약 하나뿐이었고, 실측 간격은 중앙값 50분·최대 10시간인데
  // 유예는 30분이다. 유예를 넘긴 예약은 **영원히 나가지 않는다.**
  //
  // 지금은 서버가 사실을 준다: 워커가 살아 있는가 · **이미 놓친 예약이
  // 몇 건인가.** 판정은 `scheduledExitRunnerOf`에 있고 테스트가 붙어 있다.
  const [runner, setRunner] = useState<any>(null);
  const acc = scheduledExitRunnerOf({
    workerLastSeenMs: runner?.workerLastSeenMs ?? null,
    overdue: runner?.overdue ?? null,
    nowMs: Date.now(),
    appOpen: true,
  });

  const load = useCallback(async () => {
    if (!auth) { setRows(null); setLoadErr('로그인이 필요합니다'); return; }
    try {
      const r = await fetch('/api/autotrade/scheduled-exit?list=1', {
        headers: { Authorization: auth },
      });
      const j = await r.json();
      if (j?.ok) {
        setRows(Array.isArray(j.pending) ? j.pending : []);
        // **못 받았으면 null 그대로.** 화면이 "확인하지 못했습니다"를 말한다.
        setRunner(j?.runner ?? null);
        setLoadErr('');
      }
      else setLoadErr(errorTextOf(j, '예약을 읽지 못했습니다'));
    } catch (e: any) { setLoadErr(`예약을 읽지 못했습니다 (${e?.message || e})`); }
  }, [auth]);

  /**
   * 끝난 예약(취소·발사).
   *
   * **지우지 않았으므로 볼 수 있어야 한다.** 예전에는 예정된 것만
   * 조회해서, 취소한 줄이 목록에서 통째로 사라졌다 — 지운 것과
   * 구분되지 않았다. 펼칠 때만 읽는다(기본 화면을 무겁게 하지 않는다).
   */
  const loadHistory = useCallback(async () => {
    if (!auth) return;
    setHistErr('');
    try {
      const r = await fetch('/api/autotrade/scheduled-exit?list=history', {
        headers: { Authorization: auth },
      });
      const j = await r.json();
      if (j?.ok) setHist(Array.isArray(j.pending) ? j.pending : []);
      else { setHist(null); setHistErr(errorTextOf(j, '기록을 읽지 못했습니다')); }
    } catch (e: any) { setHist(null); setHistErr(`기록을 읽지 못했습니다 (${e?.message || e})`); }
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

  /**
   * 예약청산 취소.
   *
   * 예전에는 **응답을 아예 안 읽었다** — `await fetch()` 뒤에 바로
   * `load()`였고 catch는 비어 있었다. 서버가 실패해도 화면에는 아무
   * 말이 없고, 목록이 그대로인 이유를 사용자가 알 수 없었다.
   *
   * 그리고 확인 없이 한 번에 취소됐다. 예약청산은 "이 시각에 팔겠다"는
   * 약속이라, 잘못 누르면 그 시각에 아무 일도 안 일어난다.
   */
  const cancel = async (row: any) => {
    if (!auth) return;
    const { confirmDialog } = await import('@/lib/confirm/dialog');
    const ok = await confirmDialog(
      `${row?.symbol || '이'} 예약청산을 취소할까요?\n\n`
      + '그 시각에 자동으로 팔지 않습니다.\n'
      + '이미 열린 포지션은 그대로 남습니다 — 취소가 정리해 주지 않습니다.',
      { title: '예약청산 취소', confirmText: '취소하기', danger: true },
    );
    if (!ok) return;

    try {
      const r = await fetch(`/api/autotrade/scheduled-exit?id=${encodeURIComponent(row.id)}`,
        { method: 'DELETE', headers: { Authorization: auth } });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.ok) {
        // **실패를 조용히 넘기지 않는다.** 목록만 다시 읽으면 왜 안
        // 사라졌는지 알 방법이 없다.
        setMsg({ ok: false, text: errorTextOf(j, `취소하지 못했습니다 (${r.status})`) });
        return;
      }
      setMsg({ ok: true, text: j?.note ? `${j.message} (${j.note})` : (j?.message || '예약청산을 취소했습니다') });
      load();
    } catch (e: any) {
      setMsg({ ok: false, text: `취소하지 못했습니다 — ${e?.message || e}` });
    }
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
        {/* **사용자가 할 일을 여기에 적지 않는다.**
            예전에는 "분 단위로 /api/autotrade/scheduled-exit를
            x-admin-secret과 함께 호출하세요"가 적혀 있었다 — 그건
            사용자에게 스케줄러를 붙이라고 시키는 문장이다. 이제 서버가
            한다. 남는 것은 시스템이 한 일과, 못 한 이유뿐이다. */}
        <div style={{ color: C.faint, marginTop: 4 }}>{acc.detail}</div>
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
              <button onClick={() => cancel(r)} style={{
                minHeight: 28, padding: '0 10px', borderRadius: 6, cursor: 'pointer',
                background: 'transparent', border: `1px solid ${C.hair}`,
                color: C.dim, fontSize: FS.micro, fontWeight: 700,
              }}>취소</button>
            </div>
          );
        })}
      </div>

      {/* ── 끝난 예약 ──
          취소했거나 이미 쏜 것. **지우지 않았으므로 볼 수 있어야 한다.**
          기본은 접어 둔다 — 기본 화면에는 앞으로 일어날 일만 둔다. */}
      <div style={{ borderTop: `1px solid ${C.hair}`, paddingTop: 7 }}>
        <button
          onClick={() => { const n = !histOpen; setHistOpen(n); if (n && hist == null) loadHistory(); }}
          style={{
            background: 'transparent', border: 'none', color: C.faint,
            fontSize: FS.micro, fontWeight: 700, cursor: 'pointer',
            padding: '5px 0', minHeight: 30, width: '100%', textAlign: 'left',
          }}>
          {histOpen ? '끝난 예약 접기 ▲' : '끝난 예약 보기 ▼'}
        </button>

        {histOpen && histErr && (
          <div style={{ color: C.down, fontSize: FS.micro, padding: '4px 0' }}>{histErr}</div>
        )}
        {/* **못 읽은 것과 없는 것을 구분한다.** null은 아직 안 읽었거나
            읽지 못한 것이고, 빈 배열이라야 '없음'이다. */}
        {histOpen && !histErr && hist == null && (
          <div style={{ color: C.faint, fontSize: FS.micro, padding: '4px 0' }}>불러오는 중…</div>
        )}
        {histOpen && !histErr && hist != null && hist.length === 0 && (
          <div style={{ color: C.faint, fontSize: FS.micro, padding: '4px 0' }}>끝난 예약이 없습니다</div>
        )}
        {histOpen && !histErr && (hist ?? []).map((h: any) => {
          const at = h?.run_at ? new Date(h.run_at).getTime() : null;
          const done = !!h?.fired_at;
          return (
            <div key={h.id} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '6px 0', borderTop: `1px solid ${C.hair}`, opacity: 0.72,
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: C.dim, fontSize: FS.micro, fontWeight: 700 }}>{h.symbol}</div>
                <div style={{ color: C.faint, fontSize: FS.micro, marginTop: 2, ...NUM }}>
                  {at == null ? '시각 없음'
                    : new Intl.DateTimeFormat('ko-KR', {
                        timeZone: h.time_zone || TZ, dateStyle: 'short', timeStyle: 'short',
                      }).format(new Date(at))}
                  {/* 서버가 적은 결과를 그대로 쓴다. 화면이 다시 판단하지 않는다. */}
                  {h.result ? ` · ${h.result}` : ''}
                </div>
                {h.detail && (
                  <div style={{ color: C.faint, fontSize: FS.micro, marginTop: 1, overflowWrap: 'anywhere' }}>
                    {h.detail}
                  </div>
                )}
              </div>
              <span style={{
                fontSize: FS.micro, fontWeight: 800, color: C.faint,
                border: `1px solid ${C.hair}`, borderRadius: 5, padding: '2px 6px',
              }}>{done ? '실행됨' : '취소됨'}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
});
