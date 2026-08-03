'use client';
// src/components/AutotradeControl.tsx
//
// **자동매매를 이 화면에서 켜고 끈다.**
//
// 왜 만드는가
// ───────────
// 지금까지 자동매매를 켜려면 Supabase SQL 편집기에서 INSERT를 쳐야 했다.
// 화면에는 봇 카드가 여섯 장 있지만 그건 실행기에 연결돼 있지 않고,
// 실제로 도는 것(daily-ladder 크론)이 읽는 표에는 화면에서 줄을 만들
// 방법이 없었다.
//
// 그래서 "자동매매를 켰다"고 믿는 것과 실제로 켜진 상태 사이에 SQL 한
// 줄이 끼어 있었다. 그 줄을 안 친 동안 크론은 돌면서 아무 일도 하지
// 않았고, 화면 어디에도 그 사실이 없었다.
//
// 이 판이 반드시 말해야 하는 것
// ─────────────────────────────
//  · 지금 **실제로** 켜져 있는가 (설정값이 아니라 표에 든 줄)
//  · 마지막으로 **실제로** 돌았는가 (cron_runs)
//  · 언제 도는가 — 켠 직후에 안 도는 것을 고장으로 읽지 않게
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { errorTextOf } from '@/lib/http/errorText';
import { T } from '@/lib/constants';
import { A } from '@/lib/theme/colors';

export default function AutotradeControl() {
  // 토큰을 **직접 지켜본다.** 한 번 읽고 마는 화면은 접근 토큰이 만료되면
  // (1시간) 그때부터 조용히 401을 받고, 사용자에게는 '자동매매가 꺼진 것'
  // 으로 보인다. watchAuthToken이 갱신을 따라간다.
  const [auth, setAuth] = useState('');
  useEffect(() => {
    let stop: (() => void) | null = null;
    (async () => {
      const { watchAuthToken } = await import('@/lib/auth/authToken');
      stop = watchAuthToken(t => setAuth(t));
    })();
    return () => { if (stop) stop(); };
  }, []);

  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [symbol, setSymbol] = useState('BTCUSDT');
  const [connId, setConnId] = useState('');
  // 10슬롯 방식: 1회 위험 10% · 배율 상한 100. 이게 기본값이다.
  const [levCap, setLevCap] = useState('100');
  const [riskPct, setRiskPct] = useState('10');
  // 얼마나 자주 진입을 볼 것인가(분). 크론은 하루 1회지만, 앱이 열려
  // 있는 동안은 이 간격으로 본다.
  const [intervalMin, setIntervalMin] = useState('60');
  // 앱이 열려 있는 동안 진입 엔진을 부를 것인가.
  // **기본은 꺼짐** — 화면을 열었다는 이유만으로 주문이 나가면 안 된다.
  const [ticking, setTicking] = useState(false);

  const load = useCallback(async () => {
    if (!auth) { setErr('로그인이 필요합니다'); setData(null); return; }
    try {
      const r = await fetch('/api/autotrade/schedule', { headers: { Authorization: auth } });
      const j = await r.json();
      if (j?.ok) {
        setData(j); setErr('');
        // 테스트넷 연결을 먼저 고른다. 실전을 기본으로 두면, 아무 생각
        // 없이 켠 사람이 진짜 돈으로 시작한다.
        if (!connId) {
          const list = Array.isArray(j.connections) ? j.connections : [];
          const testnet = list.find((c: any) => c.is_testnet !== false);
          setConnId((testnet || list[0])?.id || '');
        }
      } else setErr(errorTextOf(j, '읽지 못했습니다'));
    } catch (e: any) { setErr(`읽지 못했습니다 (${e?.message || e})`); }
  }, [auth, connId]);

  useEffect(() => { load(); }, [load]);

  // ── 앱 타이머 ──
  //
  // 크론이 하루 1회뿐이라 단타가 안 된다. 이 화면이 열려 있는 동안
  // 30초마다 진입 엔진을 부른다 — **실제 진입 간격은 서버가 지킨다**
  // (autotrade_schedules.interval_min). 여기서 자주 부른다고 자주
  // 들어가는 것이 아니다.
  const busyRef = useRef(false);
  useEffect(() => {
    if (!ticking || !auth) return;
    let alive = true;
    const tick = async () => {
      if (busyRef.current || !alive) return;
      busyRef.current = true;
      try {
        const r = await fetch('/api/autotrade/daily-ladder', { headers: { Authorization: auth } });
        const j = await r.json();
        if (!alive) return;
        // 실제로 무언가 실행됐을 때만 목록을 다시 읽는다. 건너뛴 것까지
        // 새로 고치면 화면이 30초마다 깜빡인다.
        const did = Array.isArray(j?.results) && j.results.some((x: any) => !x?.skipped);
        if (did) load();
        if (j?.ok === false && j?.message) setMsg({ ok: false, text: j.message });
      } catch { /* 다음 주기에 다시 본다 */ }
      finally { busyRef.current = false; }
    };
    const t = setInterval(tick, 30_000);
    tick();
    return () => { alive = false; clearInterval(t); };
  }, [ticking, auth, load]);

  const save = async (enabled: boolean) => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/autotrade/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({
          symbol, connectionId: connId, mode: 'TESTNET', enabled,
          leverageCap: levCap === '' ? undefined : Number(levCap),
          riskPct: riskPct === '' ? undefined : Number(riskPct),
          intervalMin: intervalMin === '' ? undefined : Number(intervalMin),
        }),
      });
      const j = await r.json();
      setMsg({ ok: !!j?.ok, text: errorTextOf(j, `실패 (${r.status})`) });
      if (j?.ok) load();
    } catch (e: any) { setMsg({ ok: false, text: `실패 (${e?.message || e})` }); }
    finally { setBusy(false); }
  };

  const toggle = async (row: any) => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/autotrade/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({
          symbol: row.symbol, connectionId: row.connection_id,
          mode: row.mode, enabled: !row.enabled,
          // 켜고 끌 때 크기 설정을 **지우지 않는다.** 안 실어 보내면
          // null로 덮여서, 껐다 켠 것만으로 배율 상한이 사라진다.
          leverageCap: row.leverage_cap ?? undefined,
          riskPct: row.risk_pct ?? undefined,
          intervalMin: row.interval_min ?? undefined,
        }),
      });
      const j = await r.json();
      setMsg({ ok: !!j?.ok, text: errorTextOf(j, `실패 (${r.status})`) });
      if (j?.ok) load();
    } catch (e: any) { setMsg({ ok: false, text: `실패 (${e?.message || e})` }); }
    finally { setBusy(false); }
  };

  const box: React.CSSProperties = {
    background: T.card, border: `1px solid ${T.border}`,
    borderRadius: 12, padding: 14, marginBottom: 12,
  };

  const schedules: any[] = Array.isArray(data?.schedules) ? data.schedules : [];
  const on = schedules.filter(s => s.enabled);
  const runs: any[] = Array.isArray(data?.runs) ? data.runs : [];
  const lastRun = runs[0] || null;
  const conns: any[] = Array.isArray(data?.connections) ? data.connections : [];

  // **한 줄로 답한다.** 조건을 따로 보여주면 넷 중 하나만 빠져도 아무 일이
  // 안 일어나는데 화면에는 초록 셋과 회색 하나가 보인다.
  let verdict: { tone: string; text: string; action: string };
  if (err) verdict = { tone: T.ylw, text: '상태를 읽지 못했습니다', action: err };
  else if (!data) verdict = { tone: T.muted, text: '읽는 중…', action: '' };
  else if (on.length === 0) {
    verdict = { tone: T.red, text: '자동매매가 꺼져 있습니다',
      action: '아래에서 종목과 연결을 고르고 [자동매매 켜기]를 누르세요' };
  } else if (on.some(s => !s.connection_id)) {
    verdict = { tone: T.red, text: '연결이 없는 예약이 있습니다',
      action: '실행돼도 주문을 낼 수 없습니다 — 다시 켜서 연결을 지정하세요' };
  } else if (!data.adminSecretSet) {
    verdict = { tone: T.red, text: 'ADMIN_SECRET이 없습니다',
      action: '크론이 진입 엔진을 못 부르고 401로 끝납니다. Vercel에 넣고 **재배포**하세요' };
  } else if (!data.cronSecretSet) {
    verdict = { tone: T.red, text: 'CRON_SECRET이 없습니다',
      action: 'Vercel 크론이 인증되지 않습니다. 넣고 **재배포**하세요' };
  } else if (!lastRun) {
    verdict = { tone: T.ylw, text: `켜져 있습니다 — 아직 한 번도 실행되지 않았습니다`,
      action: '크론은 매일 23:00 UTC(한국 아침 8시)에 한 번 돕니다. 그 시각이 지난 뒤에도 비어 있으면 재배포를 확인하세요' };
  } else if (lastRun.status === 'failed') {
    verdict = { tone: T.red, text: '마지막 실행이 실패했습니다', action: lastRun.detail || '' };
  } else {
    verdict = { tone: T.grn, text: `켜져 있고 실제로 돌고 있습니다`,
      action: `마지막 실행 ${fmt(lastRun.started_at)} · ${lastRun.status}${lastRun.detail ? ` — ${lastRun.detail}` : ''}` };
  }

  return (
    <div style={box}>
      <div style={{ color: T.txt, fontWeight: 900, fontSize: 14, marginBottom: 10 }}>
        자동매매 (실제 실행)
      </div>

      {/* 판정 한 줄 */}
      <div style={{
        background: A(verdict.tone, '12'), border: `1px solid ${A(verdict.tone, '35')}`,
        borderRadius: 10, padding: '11px 12px', marginBottom: 12,
      }}>
        <div style={{ color: verdict.tone, fontWeight: 800, fontSize: 12.5 }}>{verdict.text}</div>
        {verdict.action && (
          <div style={{ color: T.muted, fontSize: 11, marginTop: 5, lineHeight: 1.6 }}>{verdict.action}</div>
        )}
      </div>

      {/* 지금 켜져 있는 예약 */}
      {schedules.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ color: T.muted, fontSize: 10, fontWeight: 700, marginBottom: 6 }}>등록된 예약</div>
          {schedules.map(s => (
            <div key={s.id} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '8px 0', borderBottom: `1px solid ${T.border}`,
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: T.txt, fontSize: 12, fontWeight: 700 }}>
                  {s.symbol}
                  <span style={{
                    marginLeft: 6, fontSize: 9, fontWeight: 800,
                    // 실전은 눈에 띄어야 한다. 테스트넷과 같은 색이면 못 알아본다.
                    color: String(s.mode).startsWith('LIVE') ? T.red : T.muted,
                  }}>{s.mode}</span>
                </div>
                <div style={{ color: T.muted, fontSize: 10, marginTop: 2 }}>
                  {s.connection_id ? '연결 있음' : <span style={{ color: T.red }}>연결 없음 — 주문을 낼 수 없습니다</span>}
                  {s.risk_pct != null ? ` · 위험 ${s.risk_pct}%` : ''}
                  {s.leverage_cap != null ? ` · 상한 ${s.leverage_cap}배` : ''}
                  {s.interval_min != null ? ` · ${s.interval_min}분마다` : ''}
                  {s.last_run_at ? ` · 마지막 ${fmt(s.last_run_at)}` : ' · 실행된 적 없음'}
                </div>
              </div>
              <button onClick={() => toggle(s)} disabled={busy} style={{
                minHeight: 30, padding: '0 12px', borderRadius: 8, cursor: busy ? 'default' : 'pointer',
                background: s.enabled ? A(T.grn, '18') : 'transparent',
                color: s.enabled ? T.grn : T.muted,
                border: `1px solid ${s.enabled ? A(T.grn, '40') : T.border}`,
                fontSize: 11, fontWeight: 800,
              }}>{s.enabled ? '켜짐' : '꺼짐'}</button>
            </div>
          ))}
        </div>
      )}

      {/* 새로 켜기 */}
      <div style={{ display: 'grid', gap: 7 }}>
        <div style={{ display: 'flex', gap: 6 }}>
          <input value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase())}
            placeholder="BTCUSDT"
            style={{
              flex: 1, minWidth: 0, background: T.alt, border: `1px solid ${T.border}`,
              borderRadius: 8, padding: '9px 10px', color: T.txt, fontSize: 12, outline: 'none',
            }}/>
          <select value={connId} onChange={e => setConnId(e.target.value)}
            style={{
              flex: 1.4, minWidth: 0, background: T.alt, border: `1px solid ${T.border}`,
              borderRadius: 8, padding: '9px 10px', color: T.txt, fontSize: 11, outline: 'none',
            }}>
            {conns.length === 0 && <option value="">거래소 연결 없음</option>}
            {conns.map(c => (
              <option key={c.id} value={c.id}>
                {c.label || c.exchange_id} · {c.is_testnet === false ? '실전' : '테스트넷'}
              </option>
            ))}
          </select>
        </div>

        {/* 크기와 배율 — 10슬롯 방식이면 위험 10% · 상한 100배 */}
        <div style={{ display: 'flex', gap: 6 }}>
          <div style={{ flex: 1 }}>
            <div style={{ color: T.muted, fontSize: 10, marginBottom: 3 }}>1회 위험 (%)</div>
            <input value={riskPct} inputMode="decimal"
              onChange={e => setRiskPct(e.target.value.replace(/[^0-9.]/g, ''))}
              style={{
                width: '100%', background: T.alt, border: `1px solid ${T.border}`,
                borderRadius: 8, padding: '9px 10px', color: T.txt, fontSize: 12, outline: 'none',
              }}/>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ color: T.muted, fontSize: 10, marginBottom: 3 }}>배율 상한 (배)</div>
            <input value={levCap} inputMode="numeric"
              onChange={e => setLevCap(e.target.value.replace(/[^0-9]/g, ''))}
              style={{
                width: '100%', background: T.alt, border: `1px solid ${T.border}`,
                borderRadius: 8, padding: '9px 10px',
                color: Number(levCap) >= 50 ? T.ylw : T.txt, fontSize: 12, outline: 'none',
              }}/>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ color: T.muted, fontSize: 10, marginBottom: 3 }}>간격 (분)</div>
            <input value={intervalMin} inputMode="numeric"
              onChange={e => setIntervalMin(e.target.value.replace(/[^0-9]/g, ''))}
              style={{
                width: '100%', background: T.alt, border: `1px solid ${T.border}`,
                borderRadius: 8, padding: '9px 10px', color: T.txt, fontSize: 12, outline: 'none',
              }}/>
          </div>
        </div>

        {/* **간격을 짧게 잡아도 실행기가 없으면 그 간격으로 안 돈다.**
            이걸 안 적으면 '5분으로 해놨는데 왜 안 돌지'가 된다. */}
        <div style={{
          background: A(ticking ? T.grn : T.ylw, '10'),
          border: `1px solid ${A(ticking ? T.grn : T.ylw, '30')}`,
          borderRadius: 8, padding: '9px 10px',
          color: ticking ? T.grn : T.ylw, fontSize: 10.5, lineHeight: 1.6,
        }}>
          {ticking
            ? <>이 화면이 열려 있는 동안 <b>{intervalMin || '?'}분</b> 간격으로 진입을 봅니다.
                <b> 화면을 닫으면 멈추고</b>, 그때부터는 하루 1회 크론만 남습니다.</>
            : <>지금은 <b>하루 1회 크론</b>만 있습니다 (한국 아침 8시).
                아래 스위치를 켜면 이 화면이 열려 있는 동안 자주 봅니다.</>}
        </div>

        <button onClick={() => setTicking(v => !v)} style={{
          minHeight: 34, borderRadius: 8, cursor: 'pointer',
          background: ticking ? A(T.grn, '18') : 'transparent',
          color: ticking ? T.grn : T.muted,
          border: `1px solid ${ticking ? A(T.grn, '40') : T.border}`,
          fontSize: 11.5, fontWeight: 800,
        }}>{ticking ? '자주 보기 켜짐 — 끄기' : '이 화면이 열려 있는 동안 자주 보기'}</button>

        {/* **상한이지 목표가 아니다.** 이걸 안 적으면 '100배로 나간다'로 읽는다. */}
        <div style={{ color: T.muted, fontSize: 10.5, lineHeight: 1.6 }}>
          배율은 <b style={{ color: T.txt }}>손절 거리에서 역산</b>되고 이 상한에서 잘립니다 —
          여기에 100을 넣어도 손절이 넓으면 더 작은 배율로 나갑니다.
          {Number(levCap) > 0 && (
            <> {levCap}배가 실제로 나오려면 손절이 약{' '}
              <b style={{ color: T.ylw }}>{(100 / Number(levCap) * 0.26).toFixed(2)}%</b> 안쪽이어야 하고,
              그건 BTC 노이즈 수준이라 진입 직후 손절될 수 있습니다.</>
          )}
        </div>

        {/* **테스트넷 고정이다.** 실전은 화면에서 한 번에 켤 수 있으면 안 된다 —
            며칠 돌려 보고 올리는 것이 이 사다리의 존재 이유다. */}
        <div style={{ color: T.muted, fontSize: 10.5, lineHeight: 1.6 }}>
          이 버튼은 <b style={{ color: T.txt }}>테스트넷</b>으로만 켭니다. 실전으로 올리는 것은
          테스트넷에서 며칠 돌려 본 뒤에 하세요 — 그러라고 단계를 나눠 뒀습니다.
          {conns.some(c => c.is_testnet === false) && (
            <><br/><b style={{ color: T.ylw }}>실전 연결을 고르면 거부됩니다</b> (모드와 연결이 어긋나면 막습니다).</>
          )}
        </div>

        {msg && (
          <div style={{
            background: A(msg.ok ? T.grn : T.red, '12'), borderRadius: 8,
            padding: '9px 10px', color: msg.ok ? T.grn : T.red, fontSize: 11, lineHeight: 1.6,
          }}>{msg.text}</div>
        )}

        <button onClick={() => save(true)} disabled={busy || !connId} style={{
          minHeight: 40, borderRadius: 10, cursor: busy || !connId ? 'default' : 'pointer',
          background: A(T.acl, '18'), color: T.acl, border: `1px solid ${A(T.acl, '45')}`,
          fontSize: 12.5, fontWeight: 800, opacity: busy || !connId ? .5 : 1,
        }}>{busy ? '저장 중…' : '자동매매 켜기 (테스트넷)'}</button>
      </div>

      {/* 실제 실행 기록 — **설정이 아니라 일어난 일**이다 */}
      <div style={{ marginTop: 14, borderTop: `1px solid ${T.border}`, paddingTop: 10 }}>
        <div style={{ color: T.muted, fontSize: 10, fontWeight: 700, marginBottom: 6 }}>
          실제 실행 기록 (daily-ladder)
        </div>
        {data?.runsError && (
          <div style={{ color: T.ylw, fontSize: 11, lineHeight: 1.5 }}>{data.runsError}</div>
        )}
        {!data?.runsError && runs.length === 0 && (
          <div style={{ color: T.muted, fontSize: 11, lineHeight: 1.6 }}>
            아직 없습니다. 크론은 매일 <b style={{ color: T.txt }}>23:00 UTC(한국 아침 8시)</b>에
            한 번 돕니다 — 그 전에는 비어 있는 것이 정상입니다.
          </div>
        )}
        {runs.map((r, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, padding: '5px 0', fontSize: 10.5 }}>
            <span style={{
              color: r.status === 'ok' ? T.grn : r.status === 'failed' ? T.red : T.muted,
              fontWeight: 800, width: 46, flexShrink: 0,
            }}>{r.status}</span>
            <span style={{ flex: 1, minWidth: 0, color: T.muted, lineHeight: 1.5 }}>{r.detail || '-'}</span>
            <span style={{ color: T.muted, flexShrink: 0 }}>{fmt(r.started_at)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function fmt(iso: any): string {
  try {
    return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'short', timeStyle: 'short' })
      .format(new Date(iso));
  } catch { return '-'; }
}
