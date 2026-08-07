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
import { autotradeHealth, agoText } from '@/lib/engine/autotradeHealth';
import { stopPctForLeverage, liquidationDistancePct, maxLeverageBeforeLiquidation, riskMarginVerdict } from '@/lib/engine/leverageMath';
import { errorTextOf } from '@/lib/http/errorText';
import { classifyRun, savedButBlockedText, type OutcomeVerdict } from '@/lib/autotrade/runOutcome';
import { nextRunPlan, nextRunLines, RUNNER_INTERVAL_MIN } from '@/lib/autotrade/nextRun';
import { recoveryPlan } from '@/lib/engine/mismatchRecovery';
import {
  autoTitle, headerEnvOf, ENV_LABEL, ENV_TONE,
  healthSummaryOf, healthTone, decisionCardOf, alertsOf,
  stopStrategyEffect, type Tone,
} from '@/lib/ui/autoOverview';
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
  // 점검 결과. **주문을 내지 않고** 진짜 관문을 끝까지 돌린 결과다.
  const [check, setCheck] = useState<any>(null);
  const [checking, setChecking] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  /**
   * 켜는 것과 첫 점검은 **다른 단계다.**
   *
   * 예전에는 둘 다 `busy` 하나였다. 그래서 예약이 저장된 뒤 첫 점검이
   * 도는 동안 화면은 여전히 '저장 중…'이었고, 사용자는 저장이 오래
   * 걸린다고 읽었다. 무엇을 기다리는지 모르면 기다리지 못한다.
   */
  const [phase, setPhase] = useState<'' | 'SAVING' | 'FIRST_RUN'>('');
  /** 첫 점검 결과. 예약 저장 성공과 **따로** 표시한다 */
  const [firstRun, setFirstRun] = useState<OutcomeVerdict | null>(null);
  /** 방금 켠 예약의 id — 그 줄에만 '지금 첫 점검 중'을 적는다 */
  const [justEnabled, setJustEnabled] = useState('');
  const [showUtc, setShowUtc] = useState(false);

  const [symbol, setSymbol] = useState('BTCUSDT');
  const [connId, setConnId] = useState('');
  // 10슬롯 방식: 1회 위험 10% · 배율 상한 100. 이게 기본값이다.
  const [levCap, setLevCap] = useState('100');
  // 실전으로 켤 것인가. **기본은 테스트넷이다** — 화면을 열자마자 실전이
  // 선택돼 있으면, 켜기만 누르면 진짜 돈이 나간다.
  const [live, setLive] = useState(false);
  const [riskPct, setRiskPct] = useState('10');
  // 1회 증거금 비율. **배율을 실제로 결정하는 값이다** — 이게 없으면
  // 증거금 예산이 가용 전액이 되어 배율이 낮게 역산된다.
  const [marginPct, setMarginPct] = useState('10');
  // 얼마나 자주 진입을 볼 것인가(분). 크론은 하루 1회지만, 앱이 열려
  // 있는 동안은 이 간격으로 본다.
  const [intervalMin, setIntervalMin] = useState('60');
  // 앱이 열려 있는 동안 진입 엔진을 부를 것인가.
  // **기본은 꺼짐** — 화면을 열었다는 이유만으로 주문이 나가면 안 된다.
  const [ticking, setTicking] = useState(false);
  /**
   * 점검 목록을 펼쳤는가.
   *
   * **null은 '사용자가 아직 안 건드렸다'**는 뜻이고, 그때는 판정이 정한다
   * (막힌 항목이 있으면 펼침). 한 번 누르면 그 선택을 존중한다 — 사용자가
   * 접었는데 다음 새로고침에서 도로 펴지면 그건 화면이 말을 안 듣는 것이다.
   */
  const [checksOpen, setChecksOpen] = useState<boolean | null>(null);
  /** 예약 전체 목록은 기본으로 접는다 — 기본 화면에는 요약 한 줄이면 된다 */
  const [schedOpen, setSchedOpen] = useState(false);

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
          // **규칙은 pickConnection 한 곳에만 있다.** 여기가 자기 규칙을
          // 들고 있던 동안, 이 화면과 매매 화면이 같은 계정 같은 순간에
          // 서로 다른 계좌를 고른 채로 열렸다.
          const { pickConnection } = await import('@/lib/exchanges/pickConnection');
          setConnId(pickConnection(j.connections).id || '');
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
      // **상태만 다시 읽는다. 진입 엔진을 부르지 않는다.**
      //
      // 예전에는 이 타이머가 daily-ladder를 직접 불렀다. 즉 화면이
      // 열려 있는 동안에는 브라우저가 **실행기 노릇을 했다.** 그러면
      // 두 가지가 어긋난다:
      //
      //   · 화면을 닫으면 실행 주기가 바뀐다 — 사용자는 같은 예약이
      //     화면 여부에 따라 다르게 도는 것을 알 수 없다
      //   · 서버 실행기와 겹쳐 같은 예약을 동시에 두 번 부른다
      //
      // 실행기는 서버(autotrade-tick)다. 이 스위치는 **보조 새로고침**일
      // 뿐이고, 꺼도 예약은 그대로 돈다.
      try { await load(); } catch { /* 다음 주기에 다시 본다 */ }
      finally { busyRef.current = false; }
    };
    const t = setInterval(tick, 30_000);
    tick();
    return () => { alive = false; clearInterval(t); };
  }, [ticking, auth, load]);

  /**
   * 미확정 주문을 거래소와 대조해 확정한다.
   *
   * **왜 이 화면에 있어야 하나**
   * 결과를 모르는 주문이 남아 있으면 신규 진입이 막힌다. 그건 맞는
   * 동작이다 — 나갔는지 모르는 주문 위에 또 얹으면 두 배로 들어간다.
   *
   * 문제는 이 화면이 "아래 '미확정 주문 확정' 버튼을 눌러..."라고
   * 안내하면서 **그 버튼을 여기 두지 않았다**는 것이다. 버튼은 매매
   * 화면에만 있었다. 막힌 자리에서 푸는 방법이 없으면, 안내는 안내가
   * 아니라 막다른 길이다.
   */
  const reconcile = async () => {
    if (!connId) { setMsg({ ok: false, text: '거래소 연결을 먼저 고르세요' }); return; }
    setReconciling(true); setMsg(null);
    try {
      const r = await fetch(`/api/orders/reconcile?connectionId=${encodeURIComponent(connId)}`,
        { headers: { Authorization: auth } });
      const j = await r.json();
      // 몇 건을 어떻게 했는지 그대로 보여준다. 모르면 다시 눌러야 하는지
      // 알 수 없고, "확정했다"만 뜨면 아직 남은 것을 놓친다.
      // **몇 건을 어떻게 했는지 그대로 보여준다.** '확정했다'만 뜨면
      // 아직 남은 것을 놓치고, 다시 눌러야 하는지도 알 수 없다.
      const still = Number(j?.stillUnknown) || 0;
      setMsg({ ok: !!j?.ok, text: j?.ok
        ? `대조 완료 — ${j?.resolved ?? 0}건 확정`
          + (still ? ` · ${still}건은 거래소에도 없어 아직 모름` : '')
          + (still ? ' (거래소에 없다고 성공으로 확정하지 않았습니다)' : '')
        : errorTextOf(j, `대조 실패 (${r.status})`) });
      if (j?.ok) {
        load();
        // ── 대조 뒤에 점검을 **자동으로 다시 돌린다** ──
        //
        // 예전에는 setCheck(null)이라 결과가 사라지기만 했다. 그러면
        // 사용자는 "지금 풀렸나?"를 알려면 [지금 점검하기]를 따로 눌러야
        // 하는데, 방금 누른 버튼이 무엇을 바꿨는지 모르는 채로 다음 버튼을
        // 찾는 것은 막다른 길과 다르지 않다.
        setCheck(null);
        await runCheck();
      }
    } catch (e: any) {
      setMsg({ ok: false, text: `대조 요청이 응답하지 않았습니다 (${e?.message || e})` });
    } finally { setReconciling(false); }
  };

  /**
   * **지금 눌러서 내일을 확인한다.**
   *
   * 예약을 켜 놓고 다음 날 아침을 기다렸다가 "안 됐네"를 아는 것은 너무
   * 늦다. 이 버튼은 크론이 부르는 것과 **같은 경로**를 그대로 돌린다 —
   * 모드 관문, 시계, 상태 대조, 마진 모드, 손실 한도, 서브계좌 한도까지.
   * 마지막 주문만 안 낸다.
   */
  const runCheck = async () => {
    setChecking(true); setCheck(null); setMsg(null);
    try {
      const r = await fetch('/api/autotrade/daily-ladder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({
          checkOnly: true, symbol, connectionId: connId,
          mode: live ? 'LIVE_LIMITED' : 'TESTNET',
          leverageCap: levCap === '' ? undefined : Number(levCap),
          riskPct: riskPct === '' ? undefined : Number(riskPct),
          marginPct: marginPct === '' ? undefined : Number(marginPct),
        }),
      });
      const j = await r.json();
      setCheck(j);
      if (!j?.checklist) setMsg({ ok: false, text: errorTextOf(j, `점검 실패 (${r.status})`) });
    } catch (e: any) { setMsg({ ok: false, text: `점검 실패 (${e?.message || e})` }); }
    finally { setChecking(false); }
  };

  /**
   * **켜는 순간 한 번 돌린다.**
   *
   * 예전에는 `enabled=true`만 저장하고 끝이었다. 화면에는 '켜짐'이라고
   * 뜨는데 실제 점검은 서버 실행기가 올 때까지(최대 15분) 시작되지
   * 않았다. 사용자는 켜 놓고 아무 일도 안 일어나는 것을 본다.
   *
   * **안전장치를 건너뛴다는 뜻이 아니다.** 크론이 부르는 것과 같은 경로를
   * 그대로 부른다 — 체크리스트도, 거부권도, 하루 1회 제약도 전부 돈다.
   * 켠 순간부터 점검과 조건 판정을 시작한다는 뜻일 뿐이다.
   *
   * 서버 실행기와 겹칠 수 있다. 그때 두 번째가 받는 ALREADY_* 는 오류가
   * 아니라 중복 방지가 일한 것이고, classifyRun이 그렇게 읽는다.
   */
  const runFirstCheck = async () => {
    setPhase('FIRST_RUN');
    try {
      const r = await fetch('/api/autotrade/daily-ladder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({
          // **예약에 저장한 것과 같은 값을 보낸다.** 다른 값을 보내면
          // 첫 점검과 이후 실행이 서로 다른 설정으로 돌고, 첫 결과가
          // 앞으로 일어날 일을 대표하지 못한다.
          symbol, connectionId: connId,
          mode: live ? 'LIVE_LIMITED' : 'TESTNET',
          leverageCap: levCap === '' ? undefined : Number(levCap),
          riskPct: riskPct === '' ? undefined : Number(riskPct),
          marginPct: marginPct === '' ? undefined : Number(marginPct),
        }),
      });
      const body = await r.json().catch(() => null);
      setFirstRun(classifyRun({ status: r.status, body }));
    } catch (e: any) {
      setFirstRun(classifyRun(null));
      void e;
    } finally {
      setPhase('');
      setJustEnabled('');
      load();
    }
  };

  const save = async (enabled: boolean) => {
    setBusy(true); setPhase('SAVING'); setMsg(null); setFirstRun(null);
    try {
      const r = await fetch('/api/autotrade/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({
          symbol, connectionId: connId,
          // **LIVE_SMALL이 아니라 LIVE_LIMITED다.**
          // LIVE_SMALL은 정의상 건마다 사람이 확인하는 모드라, 예약(크론)에
          // 걸어 두면 매일 409로 끝난다 — 화면은 '켜짐'인데 주문은 한 건도
          // 안 나간다. 예약은 사람이 없을 때 도는 것이므로, 켜는 순간에
          // 한 번 확인받고(아래 확인창) 그 뒤로는 확인 없이 나가는 모드를 쓴다.
          mode: live ? 'LIVE_LIMITED' : 'TESTNET', enabled,
          leverageCap: levCap === '' ? undefined : Number(levCap),
          riskPct: riskPct === '' ? undefined : Number(riskPct),
          marginPct: marginPct === '' ? undefined : Number(marginPct),
          intervalMin: intervalMin === '' ? undefined : Number(intervalMin),
        }),
      });
      const j = await r.json();
      setMsg({ ok: !!j?.ok, text: errorTextOf(j, `실패 (${r.status})`) });
      if (!j?.ok) { setBusy(false); setPhase(''); return; }

      load();
      // **저장이 성공했을 때만** 첫 점검을 돌린다. 저장이 실패했는데
      // 돌리면, 켜지지도 않은 예약의 첫 결과를 보여주게 된다.
      if (enabled) {
        setJustEnabled(`${symbol}:${connId}`);
        await runFirstCheck();
      }
    } catch (e: any) { setMsg({ ok: false, text: `실패 (${e?.message || e})` }); }
    finally { setBusy(false); setPhase(''); }
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
          marginPct: row.margin_pct ?? undefined,
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
    // 안쪽에서 무엇이 넘치든 카드가 화면을 밀어내지는 않게 한다.
    // 넘치는 것을 고치는 것이 먼저고, 이건 마지막 방어선이다.
    minWidth: 0, maxWidth: '100%', overflowWrap: 'anywhere',
  };

  const schedules: any[] = Array.isArray(data?.schedules) ? data.schedules : [];
  const on = schedules.filter(s => s.enabled);
  const runs: any[] = Array.isArray(data?.runs) ? data.runs : [];
  const lastRun = runs[0] || null;
  const conns: any[] = Array.isArray(data?.connections) ? data.connections : [];

  // 항목별 점검. **판정은 순수 함수 한 곳에서만 한다.**
  //
  // 예전에는 이 파일이 한 줄 판정을 따로 계산했다. 그 계산은 마지막 실행이
  // ok이기만 하면 초록으로 "켜져 있고 실제로 돌고 있습니다"라고 적었는데,
  // 아래 점검 목록은 같은 순간에 "실거래가 잠겨 있습니다"를 빨갛게 띄우고
  // 있었다. **같은 상태를 두 곳에서 다르게 읽은 것이다.** 사람은 큰 글씨를
  // 믿는다. 그래서 판정은 하나만 남긴다.
  const health = autotradeHealth({
    nowMs: Date.now(),
    schedules: schedules as any,
    runs: (data?.runs || []) as any,
    runsError: data?.runsError || null,
    tableMissing: data?.error === 'table_missing',
    adminSecretSet: data?.adminSecretSet,
    cronSecretSet: data?.cronSecretSet,
    liveUnlocked: data?.liveUnlocked,
    liveGate: data?.liveGate ?? null,
    marginColumnPresent: data?.marginColumnPresent ?? null,
    exitRuns: (data?.exitRuns ?? null) as any,
    openTradeCount: data?.openTradeCount ?? null,
    connections: (data?.connections || []) as any,
    cronUtcHour: data?.cronUtcHour ?? null,
  });


  // 화면 상태(읽는 중·읽기 실패)만 여기서 더한다 — 그건 점검 함수가 모르는
  // 것이고, 서버 상태에 대한 판단이 아니다.
  let verdict: { tone: string; text: string; action: string };
  if (err) verdict = { tone: T.ylw, text: '상태를 읽지 못했습니다', action: err };
  else if (!data) verdict = { tone: T.muted, text: '읽는 중…', action: '' };
  else {
    const anyBad = health.items.some(i => i.state === 'bad');
    verdict = {
      tone: anyBad ? T.red : health.running === true ? T.grn : T.ylw,
      text: health.verdict,
      action: health.nextAction
        || (lastRun ? `마지막 실행 ${fmt(lastRun.started_at)} · ${lastRun.status}${lastRun.detail ? ` — ${lastRun.detail}` : ''}` : ''),
    };
  }

  // ── 접기·올리기 판정 ──
  //
  // 무엇을 접고 무엇을 올릴지는 `lib/ui/autoOverview`가 정한다. 여기서
  // 하면 "정상인데 왜 펼쳐졌나"를 아무도 확인할 수 없다.
  const env = headerEnvOf(schedules);
  const checks = healthSummaryOf(health.items);
  const checksExpanded = checksOpen ?? checks.expandByDefault;
  const stopNote = stopStrategyEffect().note;

  // 가장 최근에 판단한 예약 하나. **맨 아래 작은 글씨가 아니라 위로 올린다** —
  // 사용자가 이 화면에 오는 이유가 대부분 이것이다.
  const decidedRows = schedules
    .map(s => ({ s, t: msOf(s.last_run_at) }))
    .filter(x => Number.isFinite(x.t) && (x.t as number) > 0)
    .sort((a, b) => (b.t as number) - (a.t as number));
  const latestDecided = decidedRows[0] || null;
  const decision = latestDecided
    ? decisionCardOf({
      symbol: latestDecided.s.symbol,
      lastResult: latestDecided.s.last_result,
      // 구조화 기록이 있으면 이쪽이 쓰인다. 없으면(마이그레이션 043 전)
      // 예전처럼 문장에서 되짚는다 — 화면이 죽지는 않는다.
      stored: latestDecided.s.last_decision ?? null,
      lastRunAtMs: latestDecided.t, nowMs: Date.now(),
    })
    : null;

  // 정상일 때는 경고 자리를 아예 안 쓴다. 늘 자리를 차지하면 그 자리는
  // 배경이 되고, 진짜 경고가 떠도 아무도 안 본다.
  const alerts = alertsOf({ blockingLabels: checks.blockingLabels });

  const toneColor = (t: Tone): string =>
    t === 'good' ? T.grn : t === 'bad' ? T.red : t === 'live' ? T.red
      : t === 'warn' ? T.ylw : T.muted;

  return (
    <div style={box}>
      <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <span style={{ color: T.txt, fontWeight: 900, fontSize: 14 }}>{autoTitle(env)}</span>
        <span style={{
          background: A(toneColor(ENV_TONE[env]), '18'),
          color: toneColor(ENV_TONE[env]),
          border: `1px solid ${A(toneColor(ENV_TONE[env]), '40')}`,
          borderRadius: 6, padding: '2px 6px', fontSize: 9, fontWeight: 900,
        }}>{ENV_LABEL[env]}</span>
      </div>

      {/* ── 문제가 있을 때만 뜨는 경고 ── */}
      {alerts.map(a => (
        <div key={a.id} style={{
          background: A(toneColor(a.tone), '15'), border: `1px solid ${A(toneColor(a.tone), '40')}`,
          borderRadius: 10, padding: '9px 11px', marginBottom: 8,
          color: toneColor(a.tone), fontSize: 11.5, fontWeight: 800, lineHeight: 1.5,
        }}>⚠️ {a.text}</div>
      ))}

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

      {/* ── 마지막 판단 ──
          예전에는 이 정보가 점검 목록 안쪽 한 줄로 묻혀 있었다. '돌았다'와
          '진입했다'는 다르고, 대부분의 날은 조건이 안 맞아 진입하지 않는다 —
          그게 정상이라는 것이 보여야 사용자가 기다릴 수 있다. */}
      {decision && (
        <div style={{
          border: `1px solid ${A(toneColor(decision.tone), '45')}`,
          background: A(toneColor(decision.tone), '10'),
          borderRadius: 10, padding: '11px 12px', marginBottom: 12,
        }}>
          <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ color: T.txt, fontWeight: 900, fontSize: 13 }}>
              {decision.symbol || '심볼 미상'}
            </span>
            <span style={{
              background: A(toneColor(decision.tone), '22'), color: toneColor(decision.tone),
              borderRadius: 6, padding: '2px 7px', fontSize: 10, fontWeight: 900,
            }}>{decision.badge}</span>
            {decision.agoMs != null && latestDecided && (
              <span style={{ color: T.muted, fontSize: 10 }}>
                {agoText(latestDecided.t as number, Date.now())}
              </span>
            )}
          </div>

          {/* 점수는 **읽었을 때만** 그린다. 못 읽었는데 0:0을 그리면
              그건 '모름'이 아니라 '완전한 무승부'로 읽힌다. */}
          {decision.scoresKnown ? (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 8 }}>
              <div style={{ background: T.alt, borderRadius: 8, padding: '6px 8px' }}>
                <div style={{ color: T.muted, fontSize: 9 }}>LONG</div>
                <div style={{ color: T.grn, fontSize: 15, fontWeight: 900 }}>{decision.longScore}</div>
              </div>
              <div style={{ background: T.alt, borderRadius: 8, padding: '6px 8px' }}>
                <div style={{ color: T.muted, fontSize: 9 }}>SHORT</div>
                <div style={{ color: T.red, fontSize: 15, fontWeight: 900 }}>{decision.shortScore}</div>
              </div>
            </div>
          ) : (
            <div style={{ color: T.muted, fontSize: 10, marginTop: 6, lineHeight: 1.55 }}>
              이 판단에는 점수가 기록되지 않았습니다 — 아래 원문을 보세요
              {data?.decisionColumnPresent === false && (
                <><br />판단 기록 칸이 없습니다 (마이그레이션 043) — 적용하면 다음 판단부터 점수가 남습니다</>
              )}
            </div>
          )}

          <div style={{ color: T.txt, fontSize: 11.5, fontWeight: 700, marginTop: 8, lineHeight: 1.55 }}>
            {decision.headline}
          </div>
          {decision.detail && (
            <div style={{ color: T.muted, fontSize: 10.5, marginTop: 4, lineHeight: 1.55 }}>
              {decision.detail}
            </div>
          )}
        </div>
      )}

      {/* ── 안전 점검 ──
          예전에는 여덟 줄이 늘 펼쳐져 있어서, 이 화면이 조작 화면이
          아니라 진단 로그처럼 보였다. **정상일 때는 한 줄이다.**
          막힌 항목이 있을 때만 저절로 펼쳐진다. */}
      {health.items.length > 0 && (
        <div style={{ marginBottom: 12, background: T.alt, borderRadius: 10, padding: '9px 11px' }}>
          <button
            onClick={() => setChecksOpen(!checksExpanded)}
            style={{
              width: '100%', display: 'flex', alignItems: 'center', gap: 7,
              background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
              // 손가락으로 누르는 줄이라 44px을 지킨다.
              minHeight: 40, textAlign: 'left',
            }}>
            <span style={{ fontSize: 12 }}>
              {checks.bad > 0 ? '⚠️' : checks.unknown > 0 ? '❔' : '✅'}
            </span>
            <span style={{ color: T.txt, fontSize: 11.5, fontWeight: 800, flex: 1, minWidth: 0 }}>
              안전 점검 <span style={{ color: toneColor(healthTone(checks)) }}>{checks.label}</span>
            </span>
            <span style={{ color: T.muted, fontSize: 10, fontWeight: 700 }}>
              {checksExpanded ? '접기 ▲' : '상세보기 ▼'}
            </span>
          </button>

          {checksExpanded && health.items.map((it, i) => (
            <div key={it.id} style={{
              padding: '6px 0',
              borderBottom: i < health.items.length - 1 ? `1px solid ${T.border}` : 'none',
            }}>
              <div style={{ display: 'flex', gap: 7, alignItems: 'baseline' }}>
                <span style={{ fontSize: 11 }}>
                  {it.state === 'ok' ? '✅' : it.state === 'bad' ? '❌' : '❔'}
                </span>
                <span style={{
                  color: it.state === 'bad' ? T.red : it.state === 'unknown' ? T.ylw : T.txt,
                  fontSize: 11.5, fontWeight: 700,
                }}>{it.label}</span>
              </div>
              <div style={{ color: T.muted, fontSize: 10.5, lineHeight: 1.55, marginTop: 2, paddingLeft: 18 }}>
                {it.detail}
              </div>
              {it.action && (
                <div style={{ color: T.ylw, fontSize: 10.5, lineHeight: 1.55, marginTop: 3, paddingLeft: 18 }}>
                  → {it.action}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── 예약 ──
          **켜 놓은 것만 기본으로 보여준다.** 꺼 둔 예약은 오늘 아무것도
          안 하는데, 켜진 것과 같은 크기로 늘어서 있으면 매번 그 사이를
          찾아 스크롤해야 한다. 지우는 것이 아니라 접는다. */}
      {schedules.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span style={{ color: T.muted, fontSize: 10, fontWeight: 700, flex: 1 }}>
              등록된 예약 · 켜짐 {on.length}개 / 전체 {schedules.length}개
            </span>
            {schedules.length > on.length && (
              <button onClick={() => setSchedOpen(v => !v)} style={{
                background: 'transparent', border: 'none', color: T.muted,
                fontSize: 10, fontWeight: 700, cursor: 'pointer', padding: '6px 0', minHeight: 32,
              }}>
                {schedOpen ? '꺼진 예약 접기 ▲' : `꺼진 예약 ${schedules.length - on.length}개 보기 ▼`}
              </button>
            )}
          </div>
          {schedules.filter(s => s.enabled || schedOpen).map(s => (
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
                </div>

                {/* ── 언제 다음에 보는가 ──
                    예전에는 이 자리가 없고 맨 아래에 "크론은 매일 23:00
                    UTC(한국 아침 8시)"라고 **고정 문구**가 적혀 있었다.
                    그 문구는 vercel.json 크론 시절 것이고, 지금 실행기는
                    15분마다 돈다. 실제 진입 가능 시각은 예약마다 다르고
                    마지막 점검이 언제였느냐로 움직인다. */}
                {(() => {
                  const input = {
                    nowMs: Date.now(),
                    enabledAtMs: msOf(s.updated_at ?? s.created_at),
                    lastRunAtMs: msOf(s.last_run_at),
                    lastEntryAtMs: msOf(s.last_entry_at),
                    intervalMin: s.interval_min,
                    firstCheckRunning: phase === 'FIRST_RUN'
                      && justEnabled === `${s.symbol}:${s.connection_id}`,
                  };
                  const plan = nextRunPlan(input, !!s.enabled);
                  return (
                    <div style={{ marginTop: 4 }}>
                      <div style={{
                        color: plan.state === 'FIRST_CHECK_RUNNING' ? T.ylw : T.muted,
                        fontSize: 10, fontWeight: 700,
                      }}>{plan.summary}</div>
                      <div style={{ marginTop: 3, display: 'grid', gap: 1 }}>
                        {nextRunLines(input, plan).map(l => (
                          <div key={l.label} style={{
                            display: 'flex', gap: 6, fontSize: 9.5, lineHeight: 1.5,
                            color: l.unknown ? T.muted : T.txt, opacity: l.unknown ? 0.75 : 1,
                          }}>
                            <span style={{ color: T.muted, minWidth: 74, flexShrink: 0 }}>{l.label}</span>
                            <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                              {l.value}
                              {/* UTC 원문은 **기본으로 안 보여준다.** 한국 사용자가
                                  매번 9시간을 더해 읽어야 하는 화면은 읽히지 않는다. */}
                              {showUtc && l.utc && (
                                <span style={{ color: T.muted, marginLeft: 5 }}>({l.utc})</span>
                              )}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}
              </div>
              {/* **끄면 무엇이 멈추는지 적는다.** 이 줄이 없으면 사용자는
                  끄는 순간 손절까지 꺼졌다고 믿거나, 반대로 포지션이
                  정리된 줄 안다. 못 여는 것은 불편이고 못 닫는 것은 사고다. */}
              <div style={{ display: 'grid', gap: 3, justifyItems: 'end', flexShrink: 0 }}>
                <button onClick={() => toggle(s)} disabled={busy} style={{
                  minHeight: 30, padding: '0 12px', borderRadius: 8, cursor: busy ? 'default' : 'pointer',
                  background: s.enabled ? A(T.grn, '18') : 'transparent',
                  color: s.enabled ? T.grn : T.muted,
                  border: `1px solid ${s.enabled ? A(T.grn, '40') : T.border}`,
                  fontSize: 11, fontWeight: 800,
                }}>{s.enabled ? '켜짐' : '꺼짐'}</button>
                {s.enabled && (
                  <span style={{ color: T.muted, fontSize: 8.5, textAlign: 'right', maxWidth: 150, lineHeight: 1.45 }}>
                    끄면 {stopNote}
                  </span>
                )}
              </div>
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
        {/* ── 왜 grid이고 왜 auto-fit인가 ──
            여기가 `display:flex` + `flex:1`이었다. flex 아이템의 기본
            min-width는 auto라서 **input의 기본 폭 아래로는 안 줄어든다.**
            네 칸이면 최소 폭이 600px쯤 되고, 폰(360px)에서는 이 줄 하나가
            카드 전체를 화면 밖으로 밀어낸다 — 그래서 위아래 모든 글자가
            오른쪽에서 잘렸다. 한 줄이 넘치면 카드가 통째로 넘친다.

            minmax(112px, 1fr)이면 좁은 화면에서 두 칸씩 두 줄로 접히고
            넓은 화면에서는 네 칸으로 편다. 미디어 쿼리 없이 된다. */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(112px, 1fr))',
          gap: 6,
        }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ color: T.muted, fontSize: 10, marginBottom: 3 }}>1회 위험 (%)</div>
            <input value={riskPct} inputMode="decimal"
              onChange={e => setRiskPct(e.target.value.replace(/[^0-9.]/g, ''))}
              style={{
                width: '100%', background: T.alt, border: `1px solid ${T.border}`,
                borderRadius: 8, padding: '9px 10px', color: T.txt, fontSize: 12, outline: 'none',
              }}/>
          </div>
          <div style={{ minWidth: 0 }}>
            {/* **배율을 실제로 결정하는 값.**
                배율 = 명목가 ÷ 증거금 예산이다. 이 칸이 없던 동안 예산이
                '가용 전액'이라 배율이 낮게 역산됐다 — 상한에 100을 적어도
                5배쯤이 나갔다. 계좌의 10%만 묶으면 같은 명목가에서 배율이
                열 배가 된다. "100배로 10%씩 10번"의 그 10%다. */}
            <div style={{ color: T.muted, fontSize: 10, marginBottom: 3 }}>1회 증거금 (%)</div>
            <input value={marginPct} inputMode="decimal"
              onChange={e => setMarginPct(e.target.value.replace(/[^0-9.]/g, ''))}
              style={{
                width: '100%', background: T.alt, border: `1px solid ${T.border}`,
                borderRadius: 8, padding: '9px 10px', color: T.txt, fontSize: 12, outline: 'none',
              }}/>
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ color: T.muted, fontSize: 10, marginBottom: 3 }}>배율 상한 (배)</div>
            <input value={levCap} inputMode="numeric"
              onChange={e => setLevCap(e.target.value.replace(/[^0-9]/g, ''))}
              style={{
                width: '100%', background: T.alt, border: `1px solid ${T.border}`,
                borderRadius: 8, padding: '9px 10px',
                color: Number(levCap) >= 50 ? T.ylw : T.txt, fontSize: 12, outline: 'none',
              }}/>
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ color: T.muted, fontSize: 10, marginBottom: 3 }}>간격 (분)</div>
            <input value={intervalMin} inputMode="numeric"
              onChange={e => setIntervalMin(e.target.value.replace(/[^0-9]/g, ''))}
              style={{
                width: '100%', background: T.alt, border: `1px solid ${T.border}`,
                borderRadius: 8, padding: '9px 10px', color: T.txt, fontSize: 12, outline: 'none',
              }}/>
          </div>
        </div>

        {/* ── 위험% 대 증거금% ──
            손절 거리를 아무리 조절해도 안 되는 조합이 있다. 손절 손실이
            증거금 전액이면 손절 자리가 곧 청산 자리이고, 유지증거금만큼
            청산이 항상 먼저다. 고칠 곳은 손절이 아니라 이 비율이다. */}
        {(() => {
          const v = riskMarginVerdict(Number(riskPct), Number(marginPct));
          if (!v) return null;
          return (
            <div style={{
              background: A(v.ok ? T.grn : T.red, '12'),
              border: `1px solid ${A(v.ok ? T.grn : T.red, '40')}`,
              borderRadius: 8, padding: '9px 10px',
              color: v.ok ? T.grn : T.red, fontSize: 10.5, lineHeight: 1.65,
            }}>
              {v.message.split('**').map((part, i) =>
                i % 2 === 1 ? <b key={i}>{part}</b> : <span key={i}>{part}</span>)}
            </div>
          );
        })()}

        {/* **간격을 짧게 잡아도 실행기가 없으면 그 간격으로 안 돈다.**
            이걸 안 적으면 '5분으로 해놨는데 왜 안 돌지'가 된다. */}
        <div style={{
          background: A(ticking ? T.grn : T.ylw, '10'),
          border: `1px solid ${A(ticking ? T.grn : T.ylw, '30')}`,
          borderRadius: 8, padding: '9px 10px',
          color: ticking ? T.grn : T.ylw, fontSize: 10.5, lineHeight: 1.6,
        }}>
          {/* **폰을 닫아도 돈다.** 예약은 DB에 있고, 서버 쪽 실행기가
              15분마다 물어본다(GitHub Actions: autotrade-tick). 실제 진입
              간격은 아래 '간격(분)'이 정한다 — 15분마다 물어봐도 간격이
              안 됐으면 건너뛴다. 배포해도, 화면을 닫아도 안 꺼진다.
              끄는 방법은 이 화면의 스위치뿐이다. */}
          {/* **간격은 '얼마나 자주 보는가'이지 '얼마나 자주 들어가는가'가 아니다.**
              계단식 전략은 DB에 unique(user, strategy, trade_date) 제약이
              걸려 있어 **성공한 진입은 하루 최대 1회**다. 앞 문구는
              "실제 진입 간격 60분"이라고 적었는데, 그건 60분마다 포지션이
              생긴다는 뜻으로 읽힌다. 실제로는 하루 한 번이다. */}
          {ticking
            ? <>서버가 <b>{RUNNER_INTERVAL_MIN}분마다</b>, 이 예약은 <b>{intervalMin || '?'}분</b>마다 조건을 봅니다.
                진입은 <b>하루 최대 1회</b>입니다(계단식 전략의 하루 1회 제약).
                이 화면은 더 자주 볼 뿐이라 <b>닫아도 자동매매는 계속 돕니다.</b></>
            : <>서버가 <b>{RUNNER_INTERVAL_MIN}분마다</b> 확인하고, 이 예약은 <b>{intervalMin || '?'}분</b>마다 조건을 봅니다 —
                조건이 맞으면 그때 들어가고, <b>진입은 하루 최대 1회</b>입니다.
                <b> 폰을 닫아도, 배포를 해도 계속 돕니다</b> — 예약은 서버에 저장돼 있습니다.
                아래 스위치는 이 화면이 열려 있는 동안만 더 자주 보는 용도입니다.</>}
        </div>

        {/* ── 첫 점검 결과 ──
            **예약이 켜졌다는 사실을 숨기지 않는다.** 첫 실행이 막혔다고
            "실패"만 적으면 사용자는 자동매매가 안 켜진 줄 알고 다시
            누르고, 그러면 같은 자리에서 또 막힌다. */}
        {(phase === 'FIRST_RUN' || firstRun) && (
          <div style={{
            background: A(phase === 'FIRST_RUN' ? T.ylw
              : firstRun?.tone === 'good' ? T.grn
              : firstRun?.tone === 'bad' ? T.red : T.ylw, '12'),
            border: `1px solid ${A(phase === 'FIRST_RUN' ? T.ylw
              : firstRun?.tone === 'good' ? T.grn
              : firstRun?.tone === 'bad' ? T.red : T.ylw, '40')}`,
            borderRadius: 10, padding: '10px 11px',
          }}>
            <div style={{
              fontWeight: 800, fontSize: 12,
              color: phase === 'FIRST_RUN' ? T.ylw
                : firstRun?.tone === 'good' ? T.grn
                : firstRun?.tone === 'bad' ? T.red : T.ylw,
            }}>
              {phase === 'FIRST_RUN' ? '첫 점검 실행 중…' : firstRun?.label}
            </div>
            {phase !== 'FIRST_RUN' && firstRun && (
              <>
                <div style={{ color: T.muted, fontSize: 10.5, marginTop: 4, lineHeight: 1.6 }}>
                  {firstRun.detail}
                </div>
                {firstRun.action && (
                  <div style={{ color: T.ylw, fontSize: 10.5, marginTop: 4, lineHeight: 1.6 }}>
                    → {firstRun.action}
                  </div>
                )}
                {savedButBlockedText(firstRun) && (
                  <div style={{
                    color: T.txt, fontSize: 10.5, marginTop: 6, lineHeight: 1.6,
                    borderTop: `1px solid ${T.border}`, paddingTop: 6,
                  }}>{savedButBlockedText(firstRun)}</div>
                )}
              </>
            )}
          </div>
        )}

        <button onClick={() => setShowUtc(v => !v)} style={{
          minHeight: 28, borderRadius: 8, cursor: 'pointer',
          background: 'transparent', color: T.muted,
          border: `1px solid ${T.border}`, fontSize: 10, fontWeight: 700,
        }}>{showUtc ? 'UTC 원문 숨기기' : '자세히 — UTC 원문 함께 보기'}</button>

        <button onClick={() => setTicking(v => !v)} style={{
          minHeight: 34, borderRadius: 8, cursor: 'pointer',
          background: ticking ? A(T.grn, '18') : 'transparent',
          color: ticking ? T.grn : T.muted,
          border: `1px solid ${ticking ? A(T.grn, '40') : T.border}`,
          fontSize: 11.5, fontWeight: 800,
        }}>{ticking
          ? '실행 상태 자주 새로고침 — 끄기'
          : '화면에서 실행 상태 자주 새로고침'}</button>
        {/* **이름이 동작을 말해야 한다.** '자주 보기'는 더 자주 진입한다는
            뜻으로 읽혔다. 이 스위치는 화면을 새로 읽을 뿐이고, 주문은
            서버 실행기만 낸다 — 꺼도 예약은 그대로 돈다. */}
        <div style={{ color: T.muted, fontSize: 9.5, lineHeight: 1.55, marginTop: -2 }}>
          이 스위치는 <b style={{ color: T.txt }}>화면을 새로 읽기만</b> 합니다.
          주문은 서버 실행기가 냅니다 — 꺼도, 화면을 닫아도 예약은 그대로 돕니다.
        </div>

        {/* ── 지금 눌러서 내일을 확인한다 ──
            켜 놓고 다음 날 아침에 "안 됐네"를 아는 것은 너무 늦다. */}
        <button onClick={runCheck} disabled={checking || !connId} style={{
          minHeight: 36, borderRadius: 8, cursor: checking || !connId ? 'default' : 'pointer',
          background: A(T.ylw, '14'), color: T.ylw, border: `1px solid ${A(T.ylw, '40')}`,
          fontSize: 11.5, fontWeight: 800,
        }}>{checking ? '점검 중…' : '지금 점검하기 (주문은 안 냅니다)'}</button>

        {/* ── 미확정 주문 확정 ──
            막힌 자리에서 푸는 방법이 있어야 한다. 예전에는 이 화면이
            "아래 버튼을 눌러"라고 안내하면서 그 버튼을 안 뒀다. */}
        <button onClick={reconcile} disabled={reconciling || !connId} style={{
          minHeight: 34, borderRadius: 8,
          cursor: reconciling || !connId ? 'default' : 'pointer',
          background: 'transparent', color: T.muted,
          border: `1px solid ${T.border}`, fontSize: 11, fontWeight: 700,
          opacity: reconciling ? 0.6 : 1,
        }}>{reconciling ? '거래소와 대조 중…' : '미확정 주문 확정 (거래소와 대조)'}</button>

        {check?.checklist && (
          <div style={{
            background: A(check.checklist.allowed ? T.grn : T.red, '10'),
            border: `1px solid ${A(check.checklist.allowed ? T.grn : T.red, '35')}`,
            borderRadius: 10, padding: '10px 11px',
          }}>
            <div style={{ color: check.checklist.allowed ? T.grn : T.red, fontWeight: 800, fontSize: 12 }}>
              {check.checklist.allowed ? '통과' : '막힘'} · {check.checklist.passed}/{check.checklist.total}
              {check.checklist.unknownCount > 0 && ` · 확인 못 함 ${check.checklist.unknownCount}`}
            </div>
            {check.note && (
              <div style={{ color: T.muted, fontSize: 10.5, marginTop: 4, lineHeight: 1.6 }}>{check.note}</div>
            )}
            <div style={{ marginTop: 7 }}>
              {(check.checklist.results || []).map((r: any) => (
                <div key={r.id} style={{ display: 'flex', gap: 6, alignItems: 'baseline', padding: '3px 0' }}>
                  <span style={{ fontSize: 10 }}>
                    {r.status === 'pass' ? '✅' : r.status === 'fail' ? '❌' : r.status === 'warn' ? '⚠️' : '❔'}
                  </span>
                  <span style={{ color: T.txt, fontSize: 10.5, fontWeight: 700, minWidth: 108 }}>{r.label}</span>
                  <span style={{ color: T.muted, fontSize: 10.5, lineHeight: 1.5, flex: 1 }}>{r.detail}</span>
                </div>
              ))}
            </div>
            {/* ── 무엇이 어긋났는가 ──
                "불일치 10건 (심각 1 · 경고 9)"만 적으면 고칠 수가 없다.
                개수는 상태가 아니라 개수일 뿐이다. 심각한 것부터 적는다. */}
            {Array.isArray(check.mismatches) && check.mismatches.length > 0 && (
              <div style={{ marginTop: 8, borderTop: `1px solid ${T.border}`, paddingTop: 7 }}>
                <div style={{ color: T.muted, fontSize: 10, fontWeight: 700, marginBottom: 5 }}>
                  앱과 거래소가 어긋난 곳 ({check.mismatches.length}건)
                </div>
                {[...check.mismatches]
                  .sort((a: any, b: any) => (b.severity === 'critical' ? 1 : 0) - (a.severity === 'critical' ? 1 : 0))
                  .slice(0, 12)
                  .map((m: any, i: number) => (
                    <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'baseline', padding: '3px 0' }}>
                      <span style={{ fontSize: 10 }}>
                        {m.severity === 'critical' ? '🛑' : m.severity === 'warn' ? '⚠️' : 'ℹ️'}
                      </span>
                      <span style={{ color: T.txt, fontSize: 10.5, fontWeight: 700, minWidth: 66 }}>
                        {m.symbol || '—'}
                      </span>
                      <span style={{ color: T.muted, fontSize: 10.5, lineHeight: 1.5, flex: 1 }}>
                        {m.detail}
                        {(m.app != null || m.exchange != null) && (
                          <> <span style={{ opacity: 0.8 }}>(앱 {String(m.app ?? '—')} · 거래소 {String(m.exchange ?? '—')})</span></>
                        )}
                      </span>
                    </div>
                  ))}
                {check.mismatches.length > 12 && (
                  <div style={{ color: T.muted, fontSize: 10, marginTop: 3 }}>
                    …외 {check.mismatches.length - 12}건
                  </div>
                )}
                {/* ── 어떻게 되돌리는가 ──
                    예전에는 "무엇이 다른지"까지만 적고 끝났다. 사용자가 볼 수
                    있는 것은 막혔다는 사실과 목록뿐이었고, 그 목록을 어떻게
                    없애는지는 아무 데도 없었다 — 막힌 자리에서 푸는 방법이
                    없으면 그건 안전장치가 아니라 막다른 길이다. */}
                {(() => {
                  const plan = recoveryPlan(check.mismatches);
                  if (plan.steps.length === 0) return null;
                  return (
                    <div style={{ marginTop: 7, borderTop: `1px solid ${T.border}`, paddingTop: 7 }}>
                      <div style={{ color: T.txt, fontSize: 10, fontWeight: 800, marginBottom: 5 }}>
                        복구 방법 — {plan.summary}
                      </div>
                      {plan.steps.filter(st => st.action !== 'NONE').slice(0, 8).map((st, i) => (
                        <div key={i} style={{
                          padding: '5px 0',
                          borderBottom: i < Math.min(plan.steps.length, 8) - 1 ? `1px solid ${T.border}` : 'none',
                        }}>
                          <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
                            <span style={{ fontSize: 10 }}>{st.destructive ? '⚠️' : st.safeToAutomate ? '🔧' : '👤'}</span>
                            <span style={{ color: T.txt, fontSize: 10.5, fontWeight: 700 }}>{st.symbol}</span>
                            <span style={{ color: st.destructive ? T.red : T.ylw, fontSize: 10.5, fontWeight: 700 }}>
                              {st.label}
                            </span>
                            <span style={{ color: T.muted, fontSize: 10 }}>
                              앱 {st.appValue} → 거래소 {st.exchangeValue}
                            </span>
                          </div>
                          <div style={{ color: T.muted, fontSize: 10, lineHeight: 1.5, marginTop: 2, paddingLeft: 18 }}>
                            {st.why}
                            {st.destructive && (
                              <b style={{ color: T.red }}> · 되돌릴 수 없어 확인을 받습니다</b>
                            )}
                          </div>
                        </div>
                      ))}
                      <div style={{ color: T.ylw, fontSize: 10, marginTop: 5, lineHeight: 1.55 }}>
                        → 🔧 표시는 위 [미확정 주문 확정]으로 대부분 풀립니다.
                        {plan.manualSteps.length > 0 && ' 👤 표시는 거래소에서 직접 확인해야 합니다 — 앱이 임의로 정하면 안 되는 것들입니다.'}
                        {plan.destructiveSteps.length > 0 && ' ⚠️ 표시는 앱 기록을 지웁니다. 거래소의 포지션·체결 이력은 건드리지 않습니다.'}
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}

            {check.syntheticPlan && (
              <div style={{ color: T.muted, fontSize: 10, marginTop: 6, lineHeight: 1.55 }}>
                지금은 진입 신호가 없어서, 계획이 필요한 항목은 <b style={{ color: T.txt }}>지금 설정으로 만든 가상 계획</b>으로 확인했습니다.
              </div>
            )}
          </div>
        )}

        {/* **상한이지 목표가 아니다.** 이걸 안 적으면 '100배로 나간다'로 읽는다. */}
        <div style={{ color: T.muted, fontSize: 10.5, lineHeight: 1.6 }}>
          배율은 <b style={{ color: T.txt }}>손절 거리에서 역산</b>되고 이 상한에서 잘립니다 —
          여기에 100을 넣어도 손절이 넓으면 더 작은 배율로 나갑니다.
          {/* **식은 한 곳에만 둔다.** 여기 있던 `100/levCap*0.26`은 1회 증거금
              칸이 생기기 전의 식이었다. 증거금 10%를 넣은 지금 같은 조건의
              답은 0.26%가 아니라 1%다 — 네 배 차이인데 화면은 계속 옛날
              숫자를 적고 있었다. */}
          {(() => {
            const st = stopPctForLeverage(Number(levCap), Number(riskPct), Number(marginPct));
            if (st == null) return null;
            // **청산이 손절보다 먼저 오는가.** 이걸 안 보면 손절을 걸어
            // 두고도 청산당한다 — 이 계좌에서 실제로 두 번 일어났다.
            const liq = liquidationDistancePct(Number(levCap));
            const safeLev = maxLeverageBeforeLiquidation(st);
            return (
              <> {levCap}배가 실제로 나오려면 (1회 위험 {riskPct}% · 1회 증거금 {marginPct}%에서)
                손절이 약 <b style={{ color: T.ylw }}>{st.toFixed(2)}%</b> 안쪽이어야 합니다.
                {liq != null && (
                  <><br/>그런데 {levCap}배의 <b>청산은 약 {liq.toFixed(2)}%</b>에 옵니다
                    (유지증거금 0.4% 기준).{' '}
                    {st >= liq
                      ? <b style={{ color: T.red }}>손절 {st.toFixed(2)}%는 청산 뒤에 있어 작동하지 못합니다 —
                          증거금 전액이 사라집니다. 이 손절이면 {safeLev != null ? Math.floor(safeLev) : '?'}배까지가 안전합니다.</b>
                      : <span style={{ color: T.grn }}>손절이 청산보다 먼저 닿습니다 — 이 조합은 안전합니다.</span>}
                  </>
                )}</>
            );
          })()}
        </div>

        {/* ── 테스트넷 / 실전 ──
            예전에는 mode가 'TESTNET'으로 코드에 박혀 있어서 **실전 자동매매를
            켤 방법이 아예 없었다.** 사다리를 지키려던 것인데, 결과는 기능이
            없는 것이었다.

            그래서 고르게 하되 **기본은 테스트넷**이고, 실전은 고른 연결이
            실계좌일 때만 켤 수 있다. 서버도 같은 검사를 한다(모드와 연결이
            어긋나면 거부) — 화면만 막으면 화면을 우회하는 순간 뚫린다. */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 6 }}>
          {([[false, '테스트넷'], [true, '실전']] as const).map(([v, label]) => {
            const on = live === v;
            const tone = v ? T.red : T.acl;
            return (
              <button key={String(v)} onClick={() => setLive(v)} style={{
                minHeight: 34, borderRadius: 8, cursor: 'pointer',
                background: on ? A(tone, '20') : 'transparent',
                color: on ? tone : T.muted,
                border: `1px solid ${on ? A(tone, '55') : T.border}`,
                fontSize: 11.5, fontWeight: 800,
              }}>{label}</button>
            );
          })}
        </div>

        <div style={{ color: T.muted, fontSize: 10.5, lineHeight: 1.6 }}>
          {live ? (
            <>
              <b style={{ color: T.red }}>실전은 사람이 안 보는 동안 진짜 돈이 나갑니다.</b>{' '}
              고른 연결이 <b style={{ color: T.txt }}>실계좌</b>여야 켜집니다 — 테스트넷 연결을
              고르면 서버가 거부합니다.
              <br/>건당 명목가 상한은 <b style={{ color: T.txt }}>자산의 20배</b>(최소 $1,000)입니다.
              100배 배율이면 증거금 20%까지가 그 안입니다 — "10%씩 열 번"은 여기 들어옵니다.
              <br/>서버에 <b style={{ color: T.txt }}>ALLOW_LIVE_TRADING=true</b>가 없으면 실전 예약은
              매번 거부됩니다. 아래 점검 목록이 그걸 확인해 줍니다.
            </>
          ) : (
            <>
              <b style={{ color: T.txt }}>테스트넷</b>으로 켭니다. 실전으로 올리기 전에 며칠
              돌려 보시는 것이 안전합니다 — 그러라고 단계를 나눠 뒀습니다.
            </>
          )}
        </div>

        {msg && (
          <div style={{
            background: A(msg.ok ? T.grn : T.red, '12'), borderRadius: 8,
            padding: '9px 10px', color: msg.ok ? T.grn : T.red, fontSize: 11, lineHeight: 1.6,
          }}>{msg.text}</div>
        )}

        <button
          onClick={async () => {
            // 실전은 한 번 더 묻는다. 켜는 순간부터 사람이 안 보는 동안
            // 주문이 나가므로, **켜는 그 순간을 사람이 지나가게** 한다.
            if (live) {
              const { confirmDialog } = await import('@/lib/confirm/dialog');
              const ok = await confirmDialog([
                `${symbol} 자동매매를 **실전**으로 켭니다.`,
                '',
                '이제부터 사람이 안 보는 동안 **건별 확인 없이** 진짜 돈으로 주문이 나갑니다.',
                `배율 상한 ${levCap || '기본'}배 · 1회 위험 ${riskPct || '기본'}% · 1회 증거금 ${marginPct || '기본'}%`,
                '건당 명목가 상한은 자산의 20배(최소 $1,000)입니다.',
                '지금 누르는 이 확인이, 앞으로 나갈 모든 주문에 대한 확인입니다.',
                '',
                '되돌리려면 이 화면에서 스위치를 끄면 됩니다.',
              ].join('\n'), { danger: true });
              if (!ok) return;
            }
            save(true);
          }}
          disabled={busy || !connId} style={{
          minHeight: 40, borderRadius: 10, cursor: busy || !connId ? 'default' : 'pointer',
          background: A(live ? T.red : T.acl, '18'), color: live ? T.red : T.acl,
          border: `1px solid ${A(live ? T.red : T.acl, '45')}`,
          fontSize: 12.5, fontWeight: 800, opacity: busy || !connId ? .5 : 1,
        }}>{busy ? '저장 중…' : `자동매매 켜기 (${live ? '실전 · 진짜 돈' : '테스트넷'})`}</button>
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
            {/* **"매일 23:00 UTC"는 사실이 아니었다.** 그 문구는 vercel.json
                크론(하루 1회) 시절 것이다. 지금 실행기는 GitHub Actions이고
                15분마다 예약을 확인한다 — 위 예약 줄이 실제 시각을 적는다. */}
            아직 없습니다. 서버 실행기가 <b style={{ color: T.txt }}>{RUNNER_INTERVAL_MIN}분마다</b> 예약을
            확인하고, 실제 진입 가능 시각은 예약마다 다릅니다 — 위 예약 줄에 적혀 있습니다.
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

/**
 * ISO 문자열 → ms. **없으면 null이다.**
 *
 * `Number(null)`은 0이라 그냥 넘기면 1970년이 된다 — nextRun이 같은
 * 실수로 한 번 깨졌던 자리다.
 */
function msOf(v: any): number | null {
  if (v == null || v === '') return null;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

function fmt(iso: any): string {
  try {
    return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'short', timeStyle: 'short' })
      .format(new Date(iso));
  } catch { return '-'; }
}
