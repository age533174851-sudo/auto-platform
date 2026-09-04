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
import { savedButBlockedText, type OutcomeVerdict, firstEvaluationVerdict } from '@/lib/autotrade/runOutcome';
import { nextRunPlan, nextRunLines, RUNNER_INTERVAL_MIN } from '@/lib/autotrade/nextRun';
// 켜고 끄기는 정체를 다시 조립하지 않는다 — 판정은 한 곳에만 둔다.
import {
  toggleRequest, rebindRequest, applyToggleResult, toggleFailureNote,
} from '@/lib/autotrade/scheduleToggle';
import { recoveryPlan } from '@/lib/engine/mismatchRecovery';
import {
  RECONCILE_STEPS, reconcileRunOf, blockCountsOf, type StepResult,
} from '@/lib/engine/reconcilePlan';
import {
  leverageLadder, tierAllowedIn, TIER_LIMITS, DEFAULT_SAFETY_BUFFER_PCT,
  type RiskTier, type TierLimit,
} from '@/lib/engine/leverageLadder';
import {
  autoTitle, headerEnvOf, ENV_LABEL, ENV_TONE,
  healthSummaryOf, healthTone, decisionCardOf, alertsOf,
  stopStrategyEffect, type Tone,
} from '@/lib/ui/autoOverview';
import { T } from '@/lib/constants';
import { confirmDialog } from '@/lib/confirm/dialog';
import { A } from '@/lib/theme/colors';
import { strategyRunRequest } from '@/lib/strategies/runRequest';
import { LEGACY_STRATEGY_ID } from '@/lib/strategies/registry';
import SmokeTestPanel from './SmokeTestPanel';
import { MIN_CONTROL_TARGET } from '@/lib/ui/panelPrefs';

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
  const [phase, setPhase] = useState<'' | 'SAVING'>('');
  /** 첫 점검 결과. 예약 저장 성공과 **따로** 표시한다 */
  const [firstRun, setFirstRun] = useState<OutcomeVerdict | null>(null);
  /** 방금 켠 예약의 id — 그 줄에만 '지금 첫 점검 중'을 적는다 */
  const [justEnabled, setJustEnabled] = useState('');
  const [showUtc, setShowUtc] = useState(false);

  const [symbol, setSymbol] = useState('BTCUSDT');
  const [connId, setConnId] = useState('');
  // ── 거래소가 이 심볼에서 몇 배까지 허용하는가 ──
  //
  // 배율 사다리의 '거래소 최대' 칸을 **아무도 채우지 않고 있었다.** 그래서
  // 일반 경로는 상한이 없는 것처럼 통과하고, 스트레스 실험은 "몇 배까지
  // 되는지 모른다"로 매번 막혔다.
  //
  // 브라우저가 직접 거래소를 부를 수는 없다(바이낸스는 서명이 필요하고
  // 키는 서버에만 있다). 서버가 읽어 준 값을 받는다.
  //
  // **못 읽으면 null로 둔다.** 여기서 125를 채우면 없는 상한을 있다고
  // 적는 것이고, 그 숫자로 청산가·증거금이 전부 계산된다.
  // **어느 전략을 켤 것인가.** 지금까지 이 상태가 아예 없었다 —
  // 서버는 strategies 목록을 내려주는데 화면은 언제나 계단식을 불렀다.
  const [strategyId, setStrategyId] = useState<string>(LEGACY_STRATEGY_ID);
  const [venueMax, setVenueMax] = useState<number | null>(null);
  const [venueMaxNote, setVenueMaxNote] = useState<string>('');
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
  /** 취소한 예약은 기본으로 접는다 — 기본 화면에는 살아 있는 것만 */
  const [cancelOpen, setCancelOpen] = useState(false);
  /** [모두 자동 대조]가 지금까지 끝낸 단계들 */
  const [runSteps, setRunSteps] = useState<StepResult[]>([]);

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

  useEffect(() => {
    if (!connId || !symbol) { setVenueMax(null); setVenueMaxNote(''); return; }
    let alive = true;
    setVenueMax(null);
    setVenueMaxNote('읽는 중…');
    (async () => {
      try {
        const r = await fetch(
          `/api/exchange/max-leverage?connectionId=${encodeURIComponent(connId)}`
          + `&symbol=${encodeURIComponent(symbol)}`,
          { headers: { Authorization: auth } });
        const j = await r.json();
        if (!alive) return;
        const n = Number(j?.maxLeverage);
        if (j?.ok && Number.isFinite(n) && n > 0) {
          setVenueMax(n);
          setVenueMaxNote(String(j?.source || ''));
        } else {
          setVenueMax(null);
          setVenueMaxNote(String(j?.message || j?.error || '거래소 배율 상한을 읽지 못했습니다'));
        }
      } catch (e: any) {
        if (!alive) return;
        setVenueMax(null);
        setVenueMaxNote(`거래소 배율 상한을 읽지 못했습니다 (${e?.message || e})`);
      }
    })();
    return () => { alive = false; };
  }, [auth, connId, symbol]);

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
   * **모두 자동 대조.**
   *
   * 대조할 것이 여러 개인데 버튼은 흩어져 있었다. 그런데 이것들은
   * **순서가 있다** — 미확정 주문을 먼저 확정하지 않으면 나머지 비교가
   * 전부 흔들린다. 나갔는지 모르는 주문이 있는 상태에서 포지션을
   * 비교하면, 그 차이가 미확정 때문인지 진짜 불일치인지 알 수 없다.
   *
   * 사용자가 버튼을 순서대로 누르기를 기대하면 안 된다. 한 번 누르면
   * 정해진 순서로 돈다. 순서는 `lib/engine/reconcilePlan`이 정한다.
   */
  const reconcileAll = async () => {
    if (!connId) { setMsg({ ok: false, text: '거래소 연결을 먼저 고르세요' }); return; }
    setReconciling(true); setMsg(null); setRunSteps([]);
    const steps: StepResult[] = [];
    const push = (id: any, state: any, fixed?: number | null, detail?: string) => {
      steps.push({ id, state, fixed, detail });
      setRunSteps([...steps]);
    };
    try {
      // ── 주문 대조 ──
      //
      // 지금 이 저장소에는 주문 대조 엔드포인트 하나(/api/orders/reconcile)가
      // 이 네 단계를 함께 처리한다. **네 줄로 나눠 적되, 실제로 한 번에
      // 처리됐다는 것을 detail에 남긴다** — 안 그러면 돌지도 않은 단계를
      // 통과로 세게 된다.
      const r = await fetch(`/api/orders/reconcile?connectionId=${encodeURIComponent(connId)}`,
        { headers: { Authorization: auth } });
      const j = await r.json();
      const okOrders = r.ok && j?.ok !== false;
      const resolved = Number(j?.resolved) || 0;
      const still = Number(j?.stillUnknown) || 0;
      const note = '/api/orders/reconcile가 함께 처리';

      for (const id of ['OPEN_ORDERS', 'ORDER_HISTORY'] as const) {
        push(id, okOrders ? 'OK' : 'FAILED', null, okOrders ? note : errorTextOf(j, `실패 (${r.status})`));
      }
      push('MATCH_UNKNOWN', okOrders ? 'OK' : 'FAILED', resolved,
        okOrders
          ? (still ? `${resolved}건 확정 · ${still}건은 거래소에도 없어 아직 모름` : `${resolved}건 확정`)
          : errorTextOf(j, `실패 (${r.status})`));
      // **거래소에도 없는 것을 성공으로 확정하지 않는다.**
      push('SETTLE_LOCAL_ONLY', okOrders ? (still > 0 ? 'FAILED' : 'OK') : 'FAILED',
        null,
        still > 0 ? `${still}건은 최종 상태를 못 찾았습니다 — 지우지 않고 남겨 둡니다` : note);

      if (!okOrders || still > 0) {
        // 여기가 안 풀리면 뒤 단계의 비교가 뜻을 잃는다.
        setMsg({ ok: false, text: reconcileRunOf(steps).summary });
        load();
        return;
      }

      // ── 포지션·설정 대조 ──
      //
      // 점검 경로가 포지션·배율·포지션 모드·청산가·보호주문·잔고를
      // 한 번에 확인한다. 그 결과를 단계별로 옮겨 적는다.
      const c = await fetch('/api/autotrade/daily-ladder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({
          symbol, connectionId: connId, mode: live ? 'LIVE_SMALL' : 'TESTNET',
          checkOnly: true,
        }),
      });
      const cj = await c.json();

      // ── 점검 결과를 읽는 법 ──
      //
      // 여기가 세 군데 어긋나 있었고, 그래서 여섯 항목이 전부 '점검 항목을
      // 찾지 못했습니다'로 떴다. 서버는 멀쩡히 조회하고 있었다:
      //
      //   1. `cj.checklist`는 **배열이 아니라 객체**다. 항목은 `.results`에
      //      들어 있다. Array.isArray가 false라 목록이 통째로 빈 배열이 됐다.
      //   2. 항목의 상태 칸 이름은 `state`가 아니라 **`status`**이고,
      //      값은 'ok'가 아니라 **'pass' | 'warn' | 'fail' | 'unknown'**이다.
      //   3. id를 부분 문자열로 찾고 있었다. 'mode'는 POSITION_MODE보다
      //      **운영 모드(MODE)**에 먼저 걸리고, 'balance'는 아무 항목에도
      //      안 걸린다(잔고 항목의 id는 MARGIN_SUFFICIENT다).
      //
      // 그래서 **정확한 id로 맞춘다.** 부분 일치는 항목이 하나 늘 때마다
      // 조용히 다른 것을 가리키기 시작한다.
      const list: any[] = Array.isArray(cj?.checklist?.results) ? cj.checklist.results
        : Array.isArray(cj?.checklist) ? cj.checklist : [];
      const stateOf = (checkId: string) => {
        const hit = list.find(x => String(x?.id ?? '') === checkId);
        if (!hit) {
          return { state: 'UNKNOWN' as const,
            detail: `점검 항목(${checkId})이 결과에 없습니다 — 서버가 이 값을 조회하지 못했습니다` };
        }
        const status = String(hit.status ?? hit.state ?? '').toLowerCase();
        const detail = hit.detail || hit.label || '';
        // **모름과 실패를 구분한다.** 앞은 연결을 봐야 하고 뒤는 값을 고쳐야 한다.
        if (status === 'unknown' || status === '') return { state: 'UNKNOWN' as const, detail };
        if (status === 'pass' || status === 'ok') return { state: 'OK' as const, detail };
        // warn은 사실 전달이다(기존 포지션 보유 등). 막지 않지만 통과로도 적지 않는다.
        if (status === 'warn') return { state: 'OK' as const, detail };
        return { state: 'FAILED' as const, detail };
      };
      const okCheck = c.ok && cj?.ok !== false;
      if (!okCheck) {
        for (const id of ['POSITIONS','LEVERAGE','POSITION_MODE','LIQUIDATION','PROTECTIVE_STOP','BALANCE'] as const) {
          push(id, 'FAILED', null, errorTextOf(cj, `점검 실패 (${c.status})`));
        }
      } else {
        // 대조 단계 → 점검 항목 id. **정확히 하나씩** 짝을 짓는다.
        //
        // PROTECTIVE_STOP이 STOP_ATTACHED가 아니라 PROTECTIVE_ORDER인 것이
        // 요점이다. STOP_ATTACHED는 **계획의 손절가**를 보고, 이 단계가
        // 물어보는 것은 "거래소에 손절이 실제로 걸려 있는가"다.
        const map: Array<[any, string]> = [
          ['POSITIONS', 'EXISTING_POSITION'],
          ['LEVERAGE', 'LEVERAGE'],
          ['POSITION_MODE', 'POSITION_MODE'],
          ['LIQUIDATION', 'LIQUIDATION_DISTANCE'],
          ['PROTECTIVE_STOP', 'PROTECTIVE_ORDER'],
          ['BALANCE', 'MARGIN_SUFFICIENT'],
        ];
        for (const [id, checkId] of map) {
          const v = stateOf(checkId);
          push(id, v.state, null, v.detail);
        }
      }

      setCheck(cj);
      push('RECHECK', okCheck ? 'OK' : 'FAILED', null, okCheck ? '' : '점검을 다시 돌리지 못했습니다');
      const run = reconcileRunOf(steps);
      setMsg({ ok: run.completed, text: run.summary });
      load();
    } catch (e: any) {
      push('RECHECK', 'FAILED', null, String(e?.message || e));
      setMsg({ ok: false, text: `대조가 응답하지 않았습니다 (${e?.message || e})` });
    } finally { setReconciling(false); }
  };

  /**
   * 지금 고른 전략을 **점검으로** 부를 요청 하나.
   *
   * **주소와 본문을 화면이 직접 적지 않는다.** 서버의 주기 평가와
   * 같은 함수(`strategyRunRequest`)를 쓴다 — 세 곳이 각자 적으면
   * 전략을 추가할 때 한 곳이 빠지고, 그때 예약에 저장한 전략과 실제로
   * 도는 전략이 갈린다. 실제로 그랬다.
   *
   * **`checkOnly`는 인자가 아니라 고정값이다.** 예전에는
   * `buildRun({ checkOnly })`였고, 그 값 없이 부르는 곳이 하나
   * 있었다(`runFirstCheck`) — 그게 브라우저에서 나가는 **진짜 실행**
   * 요청이었다. 그래서 자동매매를 켤 때 실평가가 두 경로였다.
   *
   * 지금 실평가는 서버(`evaluateIfDue`)와 Worker poll뿐이고, 그 둘은
   * `last_run_at` 선점으로 한 번만 돈다. 화면에서 나가는 요청에 실행
   * 여지를 남겨 두면 그 방어 밖에 세 번째 경로가 다시 생긴다.
   * **선택지를 없애서 막는다.**
   */
  const buildCheckRun = () => strategyRunRequest({
    strategyId,
    env: live ? 'LIVE' : 'TESTNET',
    symbol, connectionId: connId,
    mode: live ? 'LIVE_LIMITED' : 'TESTNET',
    intervalMin: intervalMin === '' ? null : Number(intervalMin),
    leverageCap: levCap === '' ? null : Number(levCap),
    riskPct: riskPct === '' ? null : Number(riskPct),
    marginPct: marginPct === '' ? null : Number(marginPct),
    checkOnly: true,
  });

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
    const req = buildCheckRun();
    if (!req.ok || !req.route) {
      setChecking(false);
      setMsg({ ok: false, text: req.message });
      return;
    }
    try {
      const r = await fetch(req.route, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify(req.body),
      });
      const j = await r.json();
      setCheck(j);
      if (!j?.checklist) setMsg({ ok: false, text: errorTextOf(j, `점검 실패 (${r.status})`) });
    } catch (e: any) { setMsg({ ok: false, text: `점검 실패 (${e?.message || e})` }); }
    finally { setChecking(false); }
  };

  const save = async (enabled: boolean) => {
    setBusy(true); setPhase('SAVING'); setMsg(null); setFirstRun(null);
    // **첫 평가는 이제 이 요청 안에서 돈다.** 그래서 '첫 점검 중' 표시도
    // 응답을 받은 뒤가 아니라 **보내기 전에** 켠다. 예전에는 응답 뒤에
    // 켰는데, 그때는 화면이 따로 한 번 더 돌렸기 때문이다.
    // 끄는 경우에는 지난번 값을 지운다 — 안 지우면 엉뚱한 줄에
    // '첫 점검 중'이 남는다.
    setJustEnabled(enabled ? `${symbol}:${connId}` : '');
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
          // **어느 전략인지 저장한다.** 이걸 안 보내면 서버가 계단식으로
          // 되돌리고, 화면에서 고른 전략은 아무 데도 안 남는다.
          strategyId,
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
      // ── 첫 평가는 서버가 이미 돌렸다 ──
      //
      // 예전에는 여기서 `runFirstCheck()`를 불렀다. 그건 `checkOnly`가
      // 아니라 **진짜 실행 요청**이었고, 그래서 자동매매를 켤 때마다
      // 실평가 경로가 둘이었다:
      //
      //   POST /api/autotrade/schedule
      //     ├ 예약 저장
      //     └ 서버가 evaluateIfDue() 실행        ← 첫 번째
      //   → runFirstCheck() → 전략 API POST      ← 두 번째
      //
      // 아래쪽 중복 방어가 받아 주고 있었다 — `last_run_at`
      // compare-and-set, scalp의 봉 단위 키, 원본 v1의 거래일 기준
      // 결정적 clientOrderId. 그래서 "무조건 두 번 나간다"는 아니었다.
      //
      // **그래도 둘을 유지할 이유가 없다.** 실평가 경로 둘을 아래쪽
      // 방어에 기대어 두면, 그 방어 중 하나가 약해지는 날 주문이 두 번
      // 나간다. 그리고 그 날은 이 구조를 모르는 사람이 코드를 고칠 때 온다.
      //
      // 서버는 첫 평가 결과를 `firstEvaluation`으로 이미 보내 준다.
      // 화면은 그걸 그리기만 한다.
      if (enabled) setFirstRun(firstEvaluationVerdict(j?.firstEvaluation));
    } catch (e: any) { setMsg({ ok: false, text: `실패 (${e?.message || e})` }); }
    finally { setBusy(false); setPhase(''); }
  };

  /**
   * 예약을 켜고 끈다.
   *
   * **정체를 다시 조립하지 않는다.** 예전에는 이 함수가 POST(upsert)로
   * `{symbol, connectionId, mode, enabled}`를 보냈는데, 거기에 전략이
   * 없어서 서버가 계단식으로 되돌렸다 — my-original-v1 예약을 끄려고
   * 눌러도 **정체가 다른 줄이 바뀌었고**, 화면은 200을 받아 성공이라고
   * 적었다. 실제로는 예약이 계속 켜져 있었다.
   *
   * 지금은 그 줄의 기본키(`id`)만 보내고 `enabled` 한 칸만 바꾼다.
   * 재연결은 별개다(아래 `rebind`).
   */
  /**
   * 예약 취소.
   *
   * 사용자에게는 "삭제"로 보이지만 서버는 **지우지 않고 취소를 기록한다**
   * (069: `cancelled_at`). 이미 실행된 이력이 함께 사라지면 안 되기 때문이다.
   *
   * **서버가 실패라고 하면 목록에서 지우지 않는다.** 화면에서 사라졌는데
   * 워커가 계속 도는 것이 이 기능에서 가장 나쁜 결과다.
   */
  const cancelSchedule = async (row: any) => {
    const ok = await confirmDialog(
      `${row.symbol} 예약을 취소할까요?\n\n`
      + '자동매매가 이 종목을 더는 평가하지 않습니다.\n'
      + '이미 열린 포지션과 보호주문은 그대로 남습니다 — 취소가 정리해 주지 않습니다.',
      { title: '예약 취소', confirmText: '예약 취소', danger: true },
    );
    if (!ok) return;

    setBusy(true); setMsg(null);
    try {
      const r = await fetch(`/api/autotrade/schedule?id=${encodeURIComponent(row.id)}`,
        { method: 'DELETE', headers: { Authorization: auth } });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.ok) {
        // 서버가 말한 이유를 그대로 적는다. 실패를 성공처럼 뒤집지 않는다.
        setMsg({ ok: false, text: j?.message || '예약을 취소하지 못했습니다' });
        return;
      }
      setMsg({ ok: true, text: j?.note ? `${j.message} (${j.note})` : (j?.message || '예약을 취소했습니다') });
      await load();
    } catch (e: any) {
      setMsg({ ok: false, text: `예약을 취소하지 못했습니다 — ${e?.message || e}` });
    } finally { setBusy(false); }
  };

  const toggle = async (row: any) => {
    const req = toggleRequest(row);
    if (!req.ok) { setMsg({ ok: false, text: req.message }); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(req.route!, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify(req.body),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.ok) {
        // **실패를 성공처럼 뒤집지 않는다.** 서버가 말한 이유를 그대로 적고
        // 화면 상태는 건드리지 않는다.
        setMsg({ ok: false, text: toggleFailureNote(r.status, j) });
        return;
      }
      // 돌아온 줄로 먼저 반영하고(누른 즉시 보이게), GET으로 다시 대조한다.
      // 반영에 실패했으면 짐작으로 뒤집지 않는다 — GET 결과만 믿는다.
      setData((prev: any) => {
        const next = applyToggleResult(prev?.schedules, j.schedule);
        return next ? { ...prev, schedules: next } : prev;
      });
      setMsg({ ok: true, text: errorTextOf(j, '바꿨습니다') });
      await load();
    } catch (e: any) { setMsg({ ok: false, text: `실패 (${e?.message || e})` }); }
    finally { setBusy(false); }
  };

  /**
   * 이 예약의 연결만 바꾼다(재연결).
   *
   * 연결을 다시 등록하면 id가 새로 생기는데 예약은 옛 id를 그대로 들고
   * 있어서, 그 상태로는 켤 수도 끌 수도 없다. **이건 켜고 끄기와 다른
   * 일이다** — 실제로 정체의 한 칸(connection_id)을 바꾸므로 POST 경로를
   * 그대로 쓰되, **어느 전략의 줄인지 명시해서** 보낸다.
   *
   * **대신 골라 주지 않는다.** 화면에서 지금 고른 연결만 쓴다.
   */
  const rebind = async (row: any, rebindTo: string) => {
    const req = rebindRequest(row, rebindTo);
    if (!req.ok) { setMsg({ ok: false, text: req.message }); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(req.route!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify(req.body),
      });
      const j = await r.json().catch(() => null);
      setMsg({ ok: !!j?.ok, text: j?.ok ? errorTextOf(j, '연결을 바꿨습니다') : toggleFailureNote(r.status, j) });
      if (j?.ok) await load();
    } catch (e: any) { setMsg({ ok: false, text: `실패 (${e?.message || e})` }); }
    finally { setBusy(false); }
  };

  // ── '첫 점검 중'은 이제 저장 요청 중이라는 뜻이다 ──
  //
  // 예전에는 별도 단계(`phase === 'FIRST_RUN'`)가 있었다. 화면이 저장
  // 뒤에 전략 실행기를 **한 번 더** 불렀기 때문이다. 그 두 번째 경로를
  // 없앴으므로 그 단계도 없다 — 첫 평가는 저장 요청(`SAVING`) 안에서
  // 서버가 돌리고, 응답에 결과가 실려 온다.
  //
  // 끄는 경우에는 `justEnabled`가 비어 있어서 켜지지 않는다.
  const firstEvalRunning = phase === 'SAVING' && justEnabled !== '';

  const box: React.CSSProperties = {
    background: T.card, border: `1px solid ${T.border}`,
    borderRadius: 12, padding: 14, marginBottom: 12,
    // 안쪽에서 무엇이 넘치든 카드가 화면을 밀어내지는 않게 한다.
    // 넘치는 것을 고치는 것이 먼저고, 이건 마지막 방어선이다.
    minWidth: 0, maxWidth: '100%', overflowWrap: 'anywhere',
  };

  const schedules: any[] = Array.isArray(data?.schedules) ? data.schedules : [];
  // 상태 배지 글자는 **서버가 준 것을 그대로 쓴다.** 같은 표를 화면에도
  // 적어 두면 한쪽만 바뀌고, 그때 같은 상태가 두 이름으로 보인다.
  const runtimeLabels = data?.runtimeLabels ?? null;
  // ── 지금 환경에서 켤 수 있는 전략 ──
  //
  // **서버가 정한 목록만 쓴다.** 화면에 목록을 또 적으면 한쪽만 바뀌고,
  // 그때 실행 경로가 없는 전략을 고를 수 있게 된다.
  //
  // 못 읽었으면 빈 배열이 아니라 null이다 — 빈 목록을 '고를 게 없다'로
  // 그리면 서버가 잠깐 안 뜬 것과 구분이 안 된다.
  const strategyList: any[] | null = (() => {
    const byEnv = data?.strategies;
    if (!byEnv) return null;
    const arr = live ? byEnv.LIVE : byEnv.TESTNET;
    return Array.isArray(arr) ? arr : null;
  })();
  const pickedSpec = (strategyList || []).find((x: any) => x.id === strategyId) || null;
  // ── 이미 있는 예약의 전략을 덮어쓰지 않는다 ──
  //
  // 선택기 기본값은 계단식이다. 그런데 화면의 심볼이 **이미 다른 전략으로
  // 켜져 있는 예약**과 같으면, 그 상태로 저장을 누르는 순간 그 예약의
  // 전략이 조용히 계단식으로 바뀐다. 사용자는 설정 하나만 고치려던 것이다.
  //
  // 그래서 심볼이 바뀌면 그 예약이 쓰는 전략으로 선택기를 맞춘다.
  const existingStrategyId = (schedules.find(
    (x: any) => String(x.symbol).toUpperCase() === String(symbol).toUpperCase(),
  ) as any)?.strategyId ?? null;
  useEffect(() => {
    if (existingStrategyId && existingStrategyId !== strategyId) setStrategyId(existingStrategyId);
    // 심볼이 바뀔 때만 맞춘다 — 사용자가 방금 고른 값을 되돌리면 안 된다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, existingStrategyId]);
  // ── 세 갈래로 나눈다 ──
  //
  // **취소는 끄기가 아니다.** 예전에는 `enabled`만 봐서 취소한 예약이
  // '꺼진 예약 N개' 안에 그대로 남아 있었다 — 사용자는 삭제를 눌렀는데
  // 목록에서 안 사라진다.
  //
  // 판정은 서버가 준 `state`를 그대로 쓴다(scheduleStateOf). 화면이 다시
  // 판단하면 규칙이 두 곳이 되고, 그때 한쪽만 고쳐진다.
  const cancelled = schedules.filter(s => s.state === 'CANCELLED');
  const living = schedules.filter(s => s.state !== 'CANCELLED');
  const on = living.filter(s => s.enabled);
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
  // ── 못 읽은 것과 빈 목록을 가른다 ──
  //
  // `schedules`는 읽기 실패 때도 `[]`가 된다(위 642행). 그 `[]`를
  // `headerEnvOf`에 넣으면 기본값인 TESTNET이 나오고, 화면은 아무것도
  // 읽지 못한 채로 "자동매매 (테스트넷) TESTNET"이라고 **단정한다.**
  // 실제로 실전 예약이 켜져 있어도 그렇게 보인다 — 첫 줄이 LIVE인데
  // 바로 아래 카드가 TESTNET이라고 말하는 화면이 나왔다(실측 캡처).
  //
  // 못 읽었으면 환경을 말하지 않는다.
  const schedulesRead = Array.isArray(data?.schedules);
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

  // ── 배율 사다리 ──
  //
  // 사용자 상한 · 전략 상한 · 청산안전 상한 · 위험엔진 배율은 **서로 다른
  // 값이다.** 하나로 뭉뚱그리는 동안 화면은 71배가 한계라고 계산해 놓고
  // 100배를 그대로 허용했다.
  const stopForLadder = stopPctForLeverage(Number(levCap), Number(riskPct), Number(marginPct));

  // 이 설정이 어느 위험 등급인가. **10%/100배는 매매 설정이 아니다.**
  const tierNow: TierLimit = (() => {
    const r = Number(riskPct), l = Number(levCap);
    const order: RiskTier[] = ['STABILIZE', 'AGGRESSIVE', 'RESEARCH', 'STRESS'];
    for (const k of order) {
      const t = TIER_LIMITS[k];
      if (Number.isFinite(r) && r <= t.maxRiskPct && Number.isFinite(l) && l <= t.maxLeverage) return t;
    }
    return TIER_LIMITS.STRESS;
  })();
  const tierKey: RiskTier =
    (Object.keys(TIER_LIMITS) as RiskTier[]).find(k => TIER_LIMITS[k] === tierNow) ?? 'STRESS';
  const tierCheck = tierAllowedIn(tierKey, live ? 'LIVE' : 'TESTNET');

  // ── 테스트넷 스트레스면 깎지 않는다 ──
  //
  // 사용자가 100배를 명시했는데 청산안전 상한이 57배라고 57배로 낮춰
  // 주문하면, 그건 실험이 아니라 다른 설정으로 매매한 것이다. 화면에는
  // '이번 주문 57배'가 뜨고, 보려던 100배의 거동은 어디에도 안 남는다.
  //
  // **실전에서는 절대 켜지 않는다.** 등급 관문이 이미 막지만 여기서도
  // `!live`를 같이 본다 — 조건이 한 곳에만 있으면 언젠가 그 한 곳이 바뀐다.
  const stressTestnet = !live && tierKey === 'STRESS';
  const ladder = leverageLadder({
    userCap: levCap === '' ? null : Number(levCap),
    stopPct: stopForLadder,
    // 서버가 거래소에서 실제로 읽은 값. 못 읽었으면 null이 그대로 간다 —
    // 사다리가 '확인 실패'로 표시하고, 스트레스에서는 막는다.
    venueCap: venueMax,
    stressTestnet,
  });

  const toneColor = (t: Tone): string =>
    t === 'good' ? T.grn : t === 'bad' ? T.red : t === 'live' ? T.red
      : t === 'warn' ? T.ylw : T.muted;

  return (
    <div style={box}>
      <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <span style={{ color: T.txt, fontWeight: 900, fontSize: 14 }}>
          {schedulesRead ? autoTitle(env) : '자동매매'}
        </span>
        {/* 못 읽었으면 환경 배지를 그리지 않는다. 없는 사실을 색과 글자로
            주장하는 자리가 되기 때문이다. */}
        {schedulesRead ? (
          <span style={{
            background: A(toneColor(ENV_TONE[env]), '18'),
            color: toneColor(ENV_TONE[env]),
            border: `1px solid ${A(toneColor(ENV_TONE[env]), '40')}`,
            borderRadius: 6, padding: '2px 6px', fontSize: 9, fontWeight: 900,
          }}>{ENV_LABEL[env]}</span>
        ) : (
          <span style={{
            background: A(T.muted, '18'), color: T.muted,
            border: `1px solid ${A(T.muted, '40')}`,
            borderRadius: 6, padding: '2px 6px', fontSize: 9, fontWeight: 900,
          }}>확인 못 함</span>
        )}
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
              등록된 예약 · 켜짐 {on.length}개 / 전체 {living.length}개
            </span>
            {living.length > on.length && (
              <button onClick={() => setSchedOpen(v => !v)} style={{
                background: 'transparent', border: 'none', color: T.muted,
                fontSize: 10, fontWeight: 700, cursor: 'pointer', padding: '6px 0', minHeight: MIN_CONTROL_TARGET,
              }}>
                {schedOpen ? '꺼진 예약 접기 ▲' : `꺼진 예약 ${living.length - on.length}개 보기 ▼`}
              </button>
            )}
          </div>
          {living.filter(s => s.enabled || schedOpen).map(s => (
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
                  {/* 서버가 판정한 상태를 그대로 쓴다. 화면이 다시 판단하면
                      규칙이 두 곳이 되고, 그때 한쪽만 고쳐진다. */}
                  {s.connectionState === 'OK' ? '연결 있음'
                    : s.connectionState === 'UNKNOWN'
                      ? <span style={{ color: T.ylw }}>{s.connectionNote}</span>
                      : <span style={{ color: T.red }}>{s.connectionNote || '연결 없음 — 주문을 낼 수 없습니다'}</span>}
                  {s.risk_pct != null ? ` · 위험 ${s.risk_pct}%` : ''}
                  {s.leverage_cap != null ? ` · 상한 ${s.leverage_cap}배` : ''}
                </div>

                {/* ── 지금 실제로 돌고 있는가 ──
                    **`켜짐`은 `돌고 있음`이 아니다.** 실행기가 죽어 있으면
                    켜짐 배지만 초록이고 아무 일도 안 일어난다 — 사용자는
                    자동매매가 자기 돈을 지키고 있다고 믿는다.
                    판정은 서버(evaluationLoop)가 한다. 화면이 다시 판단하면
                    규칙이 두 곳이 되고, 그때 한쪽만 고쳐진다. */}
                {s.runtime && (
                  <div style={{ marginTop: 3, fontSize: 10, lineHeight: 1.5 }}>
                    <span style={{
                      fontWeight: 800,
                      color: s.runtime.tone === 'good' ? T.grn
                        : s.runtime.tone === 'bad' ? T.red
                          : s.runtime.tone === 'warn' ? T.ylw : T.muted,
                    }}>
                      {(runtimeLabels as any)?.[s.runtime.state] || s.runtime.state}
                    </span>
                    <span style={{ color: T.muted, marginLeft: 6, overflowWrap: 'anywhere' }}>
                      {s.runtime.reason}
                    </span>
                  </div>
                )}

                {/* ── 연결이 낡았으면 고칠 길을 준다 ──
                    안내만 하고 방법을 안 주면 사용자는 예약을 지우고 다시
                    만든다. 그러면 설정도 이력도 같이 사라진다.
                    **지금 위에서 고른 연결로만** 바꾼다 — 대신 고르지 않는다. */}
                {s.needsRebind && (
                  <div style={{ marginTop: 5, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <button
                      onClick={() => rebind(s, connId)}
                      disabled={busy || !connId}
                      style={{
                        fontSize: 9.5, fontWeight: 800, padding: '4px 8px', borderRadius: 6,
                        border: `1px solid ${T.ylw}`, background: 'transparent', color: T.ylw,
                        cursor: busy || !connId ? 'default' : 'pointer',
                        opacity: busy || !connId ? 0.5 : 1,
                      }}
                    >지금 고른 연결로 재연결</button>
                    <span style={{ fontSize: 9, color: T.muted }}>
                      {connId
                        ? '아래에서 고른 연결로 이 예약의 연결만 바꿉니다 (켜짐 상태는 그대로)'
                        : '아래에서 연결을 먼저 고르세요 — 대신 골라 주지 않습니다'}
                    </span>
                  </div>
                )}

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
                    // **판정을 여기서 다시 적지 않는다.** 위의
                    // `firstEvalRunning`과 같은 뜻이어야 한다 — 두 곳에
                    // 적으면 언젠가 한쪽만 바뀐다. 여기서 더하는 것은
                    // "그게 이 줄인가"뿐이다.
                    firstCheckRunning: firstEvalRunning
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
                  minHeight: MIN_CONTROL_TARGET, padding: '0 12px', borderRadius: 8, cursor: busy ? 'default' : 'pointer',
                  background: s.enabled ? A(T.grn, '18') : 'transparent',
                  color: s.enabled ? T.grn : T.muted,
                  border: `1px solid ${s.enabled ? A(T.grn, '40') : T.border}`,
                  fontSize: 11, fontWeight: 800,
                }}>{s.enabled ? '켜짐' : '꺼짐'}</button>
                {/* **끄기와 취소는 다르다.** 끄기는 잠깐 멈추는 것이고
                    취소는 이 예약을 목록에서 내리는 것이다. 예전에는
                    삭제가 곧 끄기여서 둘이 구분되지 않았다. */}
                <button onClick={() => cancelSchedule(s)} disabled={busy} aria-label={`${s.symbol} 예약 취소`}
                  style={{
                    minHeight: MIN_CONTROL_TARGET, padding: '0 8px', borderRadius: 6,
                    cursor: busy ? 'default' : 'pointer',
                    background: 'transparent', color: T.muted,
                    border: `1px solid ${T.border}`, fontSize: 9.5, fontWeight: 700,
                  }}>예약 취소</button>
                {s.enabled && (
                  <span style={{ color: T.muted, fontSize: 8.5, textAlign: 'right', maxWidth: 150, lineHeight: 1.45 }}>
                    끄면 {stopNote}
                  </span>
                )}
              </div>
            </div>
          ))}

          {/* ── 취소한 예약 ──
              **지우지 않았으므로 볼 수 있어야 한다.** 활성 목록에서는
              빠지지만 여기 남는다 — 나중에 "그 예약 어디 갔나"를 물었을 때
              답할 자리가 없으면 지운 것과 같아진다. */}
          {cancelled.length > 0 && (
            <div style={{ marginTop: 10, paddingTop: 8, borderTop: `1px solid ${T.border}` }}>
              <button onClick={() => setCancelOpen(v => !v)} style={{
                background: 'transparent', border: 'none', color: T.muted,
                fontSize: 10, fontWeight: 700, cursor: 'pointer', padding: '6px 0',
                minHeight: MIN_CONTROL_TARGET, width: '100%', textAlign: 'left',
              }}>
                {cancelOpen ? '취소한 예약 접기 ▲' : `취소한 예약 ${cancelled.length}개 보기 ▼`}
              </button>
              {cancelOpen && cancelled.map(s => (
                <div key={s.id} style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '7px 0', borderBottom: `1px solid ${T.border}`, opacity: 0.72,
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: T.muted, fontSize: 11.5, fontWeight: 700 }}>
                      {s.symbol}
                      <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 800, color: T.muted }}>
                        {s.mode}
                      </span>
                    </div>
                    <div style={{ color: T.muted, fontSize: 9.5, marginTop: 2 }}>
                      {/* **시각을 지어내지 않는다.** 069 이전에 끈 줄에는
                          취소 시각이 없다 — 그걸 '방금'으로 적으면 안 된다. */}
                      {s.cancelled_at
                        ? `${new Date(s.cancelled_at).toLocaleString('ko-KR')} 취소`
                        : '취소 시각을 기록하지 못했습니다'}
                    </div>
                  </div>
                  <span style={{
                    fontSize: 9, fontWeight: 800, color: T.muted,
                    border: `1px solid ${T.border}`, borderRadius: 5, padding: '3px 7px',
                  }}>취소됨</span>
                </div>
              ))}
              {cancelOpen && (
                <div style={{ color: T.muted, fontSize: 9, marginTop: 6, lineHeight: 1.5 }}>
                  같은 종목으로 예약을 다시 만들면 이 줄이 되살아납니다.
                </div>
              )}
            </div>
          )}
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
          {/* ── 어느 전략을 켤 것인가 ──
              이 칸이 없어서, 서버가 strategies 목록을 내려주는데도 화면은
              언제나 계단식을 불렀다. 예약에 strategy_id를 저장해도 점검과
              첫 평가는 daily-ladder였다 — 그리고 아무 오류도 안 났다.
              **서버가 준 목록만 그린다.** 실행 경로가 없는 전략은 여기
              나오지 않는다. */}
          <div style={{ minWidth: 0, gridColumn: '1 / -1' }}>
            <div style={{ color: T.muted, fontSize: 10, marginBottom: 3 }}>전략</div>
            {strategyList == null ? (
              <div style={{
                background: T.alt, border: `1px solid ${T.border}`, borderRadius: 8,
                padding: '9px 10px', color: T.muted, fontSize: 11,
              }}>전략 목록을 읽지 못했습니다 — 새로고침 뒤에도 같으면 서버 상태를 확인하세요</div>
            ) : strategyList.length === 0 ? (
              <div style={{
                background: T.alt, border: `1px solid ${T.red}`, borderRadius: 8,
                padding: '9px 10px', color: T.red, fontSize: 11,
              }}>{live ? '실전' : '테스트넷'}에서 켤 수 있는 전략이 없습니다</div>
            ) : (
              <select
                value={strategyId}
                onChange={e => setStrategyId(e.target.value)}
                style={{
                  width: '100%', background: T.alt, border: `1px solid ${T.border}`,
                  borderRadius: 8, padding: '9px 10px', color: T.txt, fontSize: 12, outline: 'none',
                }}
              >
                {/* 저장돼 있던 전략이 지금 환경에서 못 도는 경우가 있다
                    (원본 v1은 실전이 아직 닫혀 있다). 그때 목록에 없는 값이
                    선택돼 있으면 브라우저가 첫 항목으로 바꿔 버려서, 사용자가
                    모르는 사이에 다른 전략이 저장된다. 그래서 그 사실을
                    항목으로 보여 준다. */}
                {!pickedSpec && (
                  <option value={strategyId}>
                    {strategyId} — {live ? '실전에서는 켤 수 없습니다' : '이 환경에서 켤 수 없습니다'}
                  </option>
                )}
                {strategyList.map((x: any) => (
                  <option key={x.id} value={x.id}>{x.name} (v{x.version})</option>
                ))}
              </select>
            )}
            {pickedSpec?.note && (
              <div style={{ color: T.muted, fontSize: 9.5, marginTop: 3, lineHeight: 1.5 }}>
                {pickedSpec.note}
              </div>
            )}
            {!pickedSpec && strategyList != null && strategyList.length > 0 && (
              <div style={{ color: T.red, fontSize: 9.5, marginTop: 3, lineHeight: 1.5 }}>
                지금 고른 전략은 {live ? '실전' : '테스트넷'}에서 켤 수 없습니다 — 목록에서 다시 고르세요
              </div>
            )}
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
        {(firstEvalRunning || firstRun) && (
          <div style={{
            background: A(firstEvalRunning ? T.ylw
              : firstRun?.tone === 'good' ? T.grn
              : firstRun?.tone === 'bad' ? T.red : T.ylw, '12'),
            border: `1px solid ${A(firstEvalRunning ? T.ylw
              : firstRun?.tone === 'good' ? T.grn
              : firstRun?.tone === 'bad' ? T.red : T.ylw, '40')}`,
            borderRadius: 10, padding: '10px 11px',
          }}>
            <div style={{
              fontWeight: 800, fontSize: 12,
              color: firstEvalRunning ? T.ylw
                : firstRun?.tone === 'good' ? T.grn
                : firstRun?.tone === 'bad' ? T.red : T.ylw,
            }}>
              {firstEvalRunning ? '첫 점검 실행 중…' : firstRun?.label}
            </div>
            {!firstEvalRunning && firstRun && (
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
          minHeight: MIN_CONTROL_TARGET, borderRadius: 8, cursor: 'pointer',
          background: 'transparent', color: T.muted,
          border: `1px solid ${T.border}`, fontSize: 10, fontWeight: 700,
        }}>{showUtc ? 'UTC 원문 숨기기' : '자세히 — UTC 원문 함께 보기'}</button>

        <button onClick={() => setTicking(v => !v)} style={{
          minHeight: MIN_CONTROL_TARGET, borderRadius: 8, cursor: 'pointer',
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
          minHeight: MIN_CONTROL_TARGET, borderRadius: 8, cursor: checking || !connId ? 'default' : 'pointer',
          background: A(T.ylw, '14'), color: T.ylw, border: `1px solid ${A(T.ylw, '40')}`,
          fontSize: 11.5, fontWeight: 800,
        }}>{checking ? '점검 중…' : '지금 점검하기 (주문은 안 냅니다)'}</button>

        {/* ── 미확정 주문 확정 ──
            막힌 자리에서 푸는 방법이 있어야 한다. 예전에는 이 화면이
            "아래 버튼을 눌러"라고 안내하면서 그 버튼을 안 뒀다. */}
        <button onClick={reconcile} disabled={reconciling || !connId} style={{
          minHeight: MIN_CONTROL_TARGET, borderRadius: 8,
          cursor: reconciling || !connId ? 'default' : 'pointer',
          background: 'transparent', color: T.muted,
          border: `1px solid ${T.border}`, fontSize: 11, fontWeight: 700,
          opacity: reconciling ? 0.6 : 1,
        }}>{reconciling ? '거래소와 대조 중…' : '미확정 주문 확정 (거래소와 대조)'}</button>

        {/* ── 모두 자동 대조 ──
            대조할 것이 여러 개인데 버튼은 흩어져 있었다. 그런데 순서가
            있다 — 미확정 주문을 먼저 확정하지 않으면 나머지 비교가 전부
            흔들린다. 한 번 누르면 정해진 순서로 돈다. */}
        <button onClick={reconcileAll} disabled={reconciling || !connId} style={{
          minHeight: 40, borderRadius: 10,
          cursor: reconciling || !connId ? 'default' : 'pointer',
          background: A(T.acl, '16'), color: T.acl,
          border: `1px solid ${A(T.acl, '45')}`, fontSize: 12, fontWeight: 800,
          opacity: reconciling || !connId ? 0.5 : 1,
        }}>{reconciling ? '대조 중…' : `모두 자동 대조 (${RECONCILE_STEPS.length}단계)`}</button>

        {/* ── 강제 스모크 테스트 ──
            위의 [지금 점검하기]는 주문을 내지 않는다 — 조건만 본다.
            그런데 "진입이 실제로 나가나 · 손절이 붙나 · 익절이 붙나 ·
            브라우저를 닫아도 청산이 도나 · 고아 주문이 남나"는 주문을
            내 봐야만 알 수 있고, 그걸 확인할 수 있는 것은 하루에 한 번
            아침 20분 창뿐이었다. 이 판이 그 한 바퀴를 지금 돌린다. */}
        <SmokeTestPanel
          auth={auth} connectionId={connId}
          // **is_testnet === false 만 실전이다** (저장소 전체 규칙).
          // 여기서만 다르게 읽으면 값이 빈 연결이 실전으로 보인다.
          isTestnet={(() => {
            const c = conns.find((x: any) => String(x.id) === String(connId));
            return !!c && c.is_testnet !== false;
          })()}
        />

        {runSteps.length > 0 && (() => {
          const run = reconcileRunOf(runSteps);
          return (
            <div style={{ background: T.alt, borderRadius: 10, padding: '9px 11px' }}>
              <div style={{
                color: run.completed ? T.grn : run.stoppedAt ? T.red : T.ylw,
                fontSize: 11, fontWeight: 800, marginBottom: 6,
              }}>{run.summary}</div>
              {run.results.map(r => {
                const step = RECONCILE_STEPS.find(x => x.id === r.id);
                const c = r.state === 'OK' ? T.grn
                  : r.state === 'FAILED' ? T.red
                  : r.state === 'UNKNOWN' ? T.ylw : T.muted;
                return (
                  <div key={r.id} style={{ display: 'flex', gap: 7, alignItems: 'baseline', padding: '2px 0' }}>
                    <span style={{ fontSize: 10, flexShrink: 0 }}>
                      {r.state === 'OK' ? '✅' : r.state === 'FAILED' ? '❌'
                        : r.state === 'UNKNOWN' ? '❓' : '·'}
                    </span>
                    <span style={{ color: c, fontSize: 10, flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
                      {step?.label ?? r.id}
                      {r.detail ? <span style={{ color: T.muted }}> — {r.detail}</span> : null}
                    </span>
                  </div>
                );
              })}
              {run.remaining.length > 0 && (
                <div style={{ color: T.ylw, fontSize: 9.5, marginTop: 6, lineHeight: 1.55 }}>
                  남은 문제: {run.remaining.join(' · ')}
                </div>
              )}
            </div>
          );
        })()}

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

        {/* ── 배율 사다리 ──
            **설명만 하고 막지 않으면 그건 경고가 아니라 장식이다.**
            화면이 스스로 "이 손절이면 71배까지가 안전"이라고 계산해 놓고
            설정은 100배를 그대로 허용하고 있었다. 이제 가장 낮은 상한이
            실제 상한이고, 그 값이 여기 뜬다. */}
        {ladder && (
          <div style={{
            background: T.alt, borderRadius: 10, padding: '9px 11px',
            border: `1px solid ${ladder.blocked ? A(T.red, '40') : T.border}`,
          }}>
            <div style={{ color: T.muted, fontSize: 10, fontWeight: 700, marginBottom: 6 }}>배율</div>
            {ladder.rows.map(r => (
              <div key={r.id} style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '3px 0' }}>
                <span style={{ color: T.muted, fontSize: 10, flex: 1, minWidth: 0 }}>{r.label}</span>
                <span style={{
                  color: !r.known ? (r.required ? T.red : T.muted)
                    : ladder.boundBy === r.label ? T.ylw : T.txt,
                  fontSize: 11, fontWeight: 800, flexShrink: 0,
                }}>
                  {/* **모르는 것을 빈칸이나 0으로 두지 않는다.** 필수인데
                      모르면 빨갛게, 없어도 되는 것이면 '제한 없음'이다. */}
                  {/* 거래소 최대는 못 읽으면 '제한 없음'이 아니다 — 모르는 것이다.
                      '제한 없음'으로 적으면 상한이 없다는 뜻이 되어, 사용자가
                      거래소가 거절할 배율을 그대로 밀어 넣는다. */}
                  {r.known ? `${Math.floor(r.value!)}x`
                    : r.id === 'venue' ? '확인 실패'
                    : (r.required ? '확인 실패' : '제한 없음')}
                </span>
              </div>
            ))}
            {venueMaxNote && venueMax == null && (
              <div style={{ color: T.ylw, fontSize: 9, marginTop: 2, lineHeight: 1.5 }}>
                거래소 최대: {venueMaxNote}
              </div>
            )}
            <div style={{ borderTop: `1px solid ${T.border}`, marginTop: 6, paddingTop: 6 }}>
              {/* ── 요청 · 권고 · 실제는 서로 다른 값이다 ──
                  한 칸에 뭉치면 "100배로 켰는데 왜 57배로 나갔나"가 설명되지
                  않는다. 세 숫자를 나란히 둔다. */}
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ color: T.muted, fontSize: 10, flex: 1 }}>요청 배율</span>
                <span style={{ color: T.txt, fontSize: 11, fontWeight: 800 }}>
                  {ladder.requested != null ? `${ladder.requested}x` : '—'}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 2 }}>
                <span style={{ color: T.muted, fontSize: 10, flex: 1 }}>청산안전 권고</span>
                <span style={{ color: T.muted, fontSize: 11, fontWeight: 800 }}>
                  {ladder.liquidationSafeCap != null ? `${ladder.liquidationSafeCap}x` : '확인 실패'}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 4 }}>
                <span style={{ color: T.txt, fontSize: 11, fontWeight: 800, flex: 1 }}>
                  {stressTestnet ? '실제 주문 요청' : '이번 주문'}
                </span>
                <span style={{ color: ladder.blocked ? T.red : T.grn, fontSize: 14, fontWeight: 900 }}>
                  {ladder.allowed != null ? `${ladder.allowed}x` : '불가'}
                </span>
              </div>
              <div style={{ color: ladder.blocked ? T.red : T.muted, fontSize: 9.5, marginTop: 4, lineHeight: 1.55 }}>
                {ladder.blocked ? `🚫 ${ladder.blockReason}` : ladder.summary}
              </div>
              {/* 스트레스 실험이라 깎지 않고 넘어간 것들. **경고이지 실패가 아니다.** */}
              {ladder.warnings.map((w, i) => (
                <div key={i} style={{ color: T.ylw, fontSize: 9.5, marginTop: 3, lineHeight: 1.55 }}>
                  ⚠ {w}
                </div>
              ))}
              {ladder.liquidationTheoreticalCap != null && !ladder.blocked && (
                <div style={{ color: T.muted, fontSize: 9, marginTop: 3, lineHeight: 1.5 }}>
                  이론 최대 {Math.floor(ladder.liquidationTheoreticalCap)}배 ·
                  안전 버퍼 {DEFAULT_SAFETY_BUFFER_PCT}% 적용 → {ladder.liquidationSafeCap}배.
                  유지증거금 변동·수수료·슬리피지·마크가격 튐이 이론값의 여유를 갉아먹습니다.
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── 위험 등급 ──
            1회 위험 10% + 100배는 일반 설정이 아니다. 한 번 손절할 때
            계좌의 10%가 사라지는 구조인데, 지금까지 아무 표시 없이
            기본 화면에 앉아 있었다. */}
        {tierCheck && !tierCheck.ok && (
          <div style={{
            background: A(T.red, '12'), border: `1px solid ${A(T.red, '35')}`,
            borderRadius: 10, padding: '9px 11px', color: T.red, fontSize: 10.5, lineHeight: 1.6,
          }}>
            ⚠️ {tierCheck.reason}
            <div style={{ color: T.muted, fontSize: 9.5, marginTop: 4 }}>
              이 설정은 <b style={{ color: T.ylw }}>{tierNow.label}</b> 등급입니다 — {tierNow.desc}
            </div>
          </div>
        )}

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
                minHeight: MIN_CONTROL_TARGET, borderRadius: 8, cursor: 'pointer',
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
          // **여기서 실제로 막는다.** 지금까지는 화면이 "이 손절이면
          // 71배까지가 안전"이라고 적어 놓고도 켜기 버튼은 멀쩡했다.
          // 설명만 하고 막지 않으면 그건 경고가 아니라 장식이다.
          disabled={busy || !connId || ladder.blocked || !tierCheck.ok} style={{
          minHeight: 40, borderRadius: 10,
          cursor: busy || !connId || ladder.blocked || !tierCheck.ok ? 'default' : 'pointer',
          background: A(live ? T.red : T.acl, '18'), color: live ? T.red : T.acl,
          border: `1px solid ${A(live ? T.red : T.acl, '45')}`,
          fontSize: 12.5, fontWeight: 800,
          opacity: busy || !connId || ladder.blocked || !tierCheck.ok ? .5 : 1,
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
