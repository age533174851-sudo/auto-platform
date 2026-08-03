'use client';
// StrategyProfilesPanel — 스캘핑 / 스윙 / 10슬롯 프로필을 분리 표시.
// 규칙 엔진(buildOrder)으로 프로필 한도 내 주문을 만들고, 프로필별 격리 리스크
// (PnL·MDD·일손실·킬스위치)를 독립 추적. 각 프로필 성적표(표본수 n 포함) 표시.
//
// **여기서 나가는 주문은 없다.** 전부 모의다.
import React, { useState, useCallback } from 'react';
import { T } from '@/lib/constants';
import { notify } from '@/lib/notify/center';
import {
  listProfiles, simHoldSecOf, simPriceOf, simSeedOf,
  type StrategyProfile, type StrategyType,
} from '@/lib/strategies/profiles';
import { buildOrder, type Signal } from '@/lib/strategies/ruleEngine';
import {
  loadProfileRisk, recordProfileTrade, canProfileEnter, skipToNextSimDay,
  resetProfileKill, resetProfileRisk, clearCycles, completeCycle,
  simTargetOf, winRate, type ProfileRiskState,
} from '@/lib/strategies/profileRisk';
import { fmtDur, fmtMoney, samplePeriodText } from '@/lib/strategies/simFormat';
import {
  assumedWinRate, noEdgeWinRate, breakevenWinRate, expectancyPctOfNotional,
  tradePnlPctOfNotional, roundTripFeePct, EDGE_CHOICES,
} from '@/lib/strategies/simModel';

/** 시뮬 한 건의 결과.
 *  이 저장소는 `strict: false`라 `{ok:true}|{ok:false}` 판별 유니온이
 *  좁혀지지 않는다(boolean 리터럴이 넓어진다). 그래서 한 모양으로 둔다. */
type SimResult = {
  ok: boolean;
  /** ok=false일 때의 사유 */
  reason?: string;
  win?: boolean;
  pnl?: number;
  killed?: boolean;
  killReason?: string;
  /** 이 거래 뒤의 잔고 — 목표 도달 판정에 쓴다 */
  equity?: number;
};

/** 한 판(회차)을 돌린 결과. */
type RunResult = {
  ran: number;
  wins: number;
  pnl: number;
  reached: boolean;      // 목표 금액에 닿았나
  reason: string;        // 끝난 이유
  simSeconds: number;    // 이 판이 잡아먹은 모의 시간
  restDays: number;      // 하루 한도에 걸려 쉰 날 수
  endEquity: number;
};

const AI_SOURCES = ['claude', 'gpt', 'gemini', 'grok'];

/** 목표까지 돌릴 때의 상한. 실제 계획이 '3개월'이라 그 길이로 잡는다. */
const TARGET_MAX_SIM_DAYS = 90;
/** 어떤 경우에도 브라우저가 멎으면 안 된다. */
const HARD_ITER_CAP = 200_000;

export default function StrategyProfilesPanel() {
  const [tick, setTick] = useState(0);
  const [toast, setToast] = useState('');
  const refresh = useCallback(() => setTick(t => t + 1), []);
  const showToast = useCallback((m: string) => {
    const [title, ...rest] = m.split(' · ');
    const kind: any = /킬스위치|차단/.test(title) ? 'kill' : /익절|성공|달성/.test(title) ? 'success' : /손절|실패|거부/.test(title) ? 'error' : 'info';
    notify(kind, title, rest.join(' · ') || undefined);
    setToast(''); void toast;
  }, [toast]);
  void tick;

  const [busy, setBusy] = useState<StrategyType | null>(null);

  /**
   * 가정한 우위(%p). 프로필마다 따로 고른다.
   *
   * 기본은 0 — **우위가 없다고 가정한다.** 시뮬이 사용자 편을 들면
   * 안 된다. 우위가 있다고 치고 싶으면 그건 사용자가 명시적으로
   * 고르는 것이고, 그 가정이 화면에 숫자로 남는다.
   */
  const [edge, setEdge] = useState<Record<string, number>>({});
  const edgeOf = (p: StrategyProfile) => Number(edge[p.id]) || 0;

  /**
   * 한 건 시뮬. 결과를 **돌려준다** — 여러 번 돌릴 때 집계해야 하기 때문이다.
   *
   * 화면에 띄우지 않는 이유: 1000번 돌리면서 매번 토스트를 띄우면 아무것도
   * 읽을 수 없다. 요약은 부르는 쪽이 한 번만 한다.
   */
  const simOnce = (p: StrategyProfile, winRate: number): SimResult => {
    const can = canProfileEnter(p.id);
    if (!can.allowed) return { ok: false, reason: can.reason || '진입 차단' };
    const eq = loadProfileRisk(p.id).equity;
    const sig: Signal = {
      bias: Math.random() > 0.5 ? 'long' : 'short',
      desiredLeverage: p.maxLeverage + 20,   // 일부러 상한 초과 요구 → clamp 확인
      aiSource: AI_SOURCES[Math.floor(Math.random() * AI_SOURCES.length)],
    };
    const built = buildOrder({ signal: sig, profile: p, equityKRW: eq, price: simPriceOf(p) });
    if (!built.ok) return { ok: false, reason: (built as any).reason || '주문 거부' };
    // **동전 던지기가 아니다.** 익절이 손절보다 멀면 먼저 닿을 확률이
    // 그만큼 낮다. 그 기준선 위에 사용자가 고른 우위만 얹는다.
    // 수수료는 이기든 지든 나간다 — 100배에서는 이게 승부를 가른다.
    const win = Math.random() < winRate;
    const pnl = built.order.notionalKRW * (tradePnlPctOfNotional(p, win) / 100);
    const st = recordProfileTrade(p.id, pnl, simHoldSecOf(p));
    return { ok: true, win, pnl, killed: !!st.killed, killReason: st.killedReason, equity: st.equity };
  };

  /**
   * 한 판을 돌린다.
   *
   * **하루 한도에 걸리면 멈추지 않고 다음 날로 넘어간다.**
   * 예전에는 여기서 통째로 멈췄다. 그래서 "1000회"를 눌러도 12회쯤에서
   * 끝났고, 화면은 "이 전략은 12번이면 하루 한도가 찬다"고 적었다.
   * 맞는 말이긴 한데 답이 아니다 — 실제로는 그날 쉬고 다음 날 다시
   * 시작하니까. 모의 시계를 하루 넘기고 계속 돌리는 것이 실제에 가깝고,
   * 그래야 "며칠 걸리는가"를 알 수 있다.
   *
   * 쉰 날 수는 따로 세서 결과에 적는다 — 그것도 성적의 일부다.
   */
  const runSim = (p: StrategyProfile, opts: { maxTrades: number; maxSimDays: number }): RunResult => {
    const target = simTargetOf(p);
    const start = loadProfileRisk(p.id);
    const startSim = start.simSeconds;
    const winRate = assumedWinRate(p, edgeOf(p));
    // 시드의 0.5% 밑으로 떨어지면 사실상 끝이다. 여기서 안 끊으면 소수점
    // 잔고로 몇 만 건을 더 돌면서 "아직 살아 있다"고 적는다.
    const bustAt = simSeedOf(p) * 0.005;

    let ran = 0, wins = 0, pnlSum = 0, restDays = 0;
    let reached = false, reason = '';

    for (let i = 0; i < HARD_ITER_CAP; i++) {
      if (ran >= opts.maxTrades) { reason = `${opts.maxTrades.toLocaleString('ko-KR')}회 완료`; break; }

      const cur = loadProfileRisk(p.id);
      const elapsedDays = (cur.simSeconds - startSim) / 86400;
      if (elapsedDays >= opts.maxSimDays) { reason = `모의 ${opts.maxSimDays}일 도달 — 목표 미달`; break; }
      if (cur.equity <= bustAt) { reason = '파산 — 시드의 0.5% 미만'; break; }

      const can = canProfileEnter(p.id);
      if (!can.allowed) {
        // 하루 한도는 '오늘'만 막는다. 다른 사유(수동 킬 등)는 진짜 중단이다.
        if (can.reason && can.reason.includes('일손실')) {
          skipToNextSimDay(p.id); restDays++; continue;
        }
        reason = can.reason || '진입 차단'; break;
      }

      const r = simOnce(p, winRate);
      if (!r.ok) { reason = r.reason || '주문 거부'; break; }
      ran++; pnlSum += r.pnl ?? 0; if (r.win) wins++;

      if (target != null && (r.equity ?? 0) >= target) {
        reached = true; reason = '목표 달성'; break;
      }
    }
    if (!reason) reason = `안전 상한 ${HARD_ITER_CAP.toLocaleString('ko-KR')}회 도달`;

    const end = loadProfileRisk(p.id);
    return { ran, wins, pnl: pnlSum, reached, reason, simSeconds: end.simSeconds - startSim, restDays, endEquity: end.equity };
  };

  /** 정해진 횟수만큼 (스캘핑·스윙) */
  const simTrades = (p: StrategyProfile, n: number) => {
    setBusy(p.id);
    // 하루 한도로 쉬는 날이 있으니 넉넉히. 한 건이 하루를 넘는 프로필도 있다.
    const perDay = Math.max(1, Math.floor(86400 / simHoldSecOf(p)));
    const budgetDays = Math.ceil(n / perDay) * 3 + 30;
    const res = runSim(p, { maxTrades: n, maxSimDays: budgetDays });
    setBusy(null);
    refresh();

    if (res.ran === 0) { showToast(`${p.label} 실행 못 함 · ${res.reason}`); return; }
    const cur = p.simCurrency || 'KRW';
    const rate = Math.round((res.wins / res.ran) * 100);
    showToast([
      res.ran < n ? `${p.label} ${res.ran}/${n}회에서 멈춤` : `${p.label} ${res.ran}회 완료`,
      `승 ${res.wins} · 패 ${res.ran - res.wins} (${rate}%)`,
      `합계 ${fmtMoney(res.pnl, cur, true)}`,
      `모의 ${fmtDur(res.simSeconds)}`,
      res.restDays > 0 ? `하루 한도로 ${res.restDays}일 쉼` : '',
      res.ran < n ? `멈춘 이유: ${res.reason}` : '',
    ].filter(Boolean).join(' · '));
  };

  /**
   * 목표 금액까지 (10슬롯).
   *
   * **끝나면 한 회차로 기록하고 계좌를 시드로 되돌린다.** 그래야 "몇 번
   * 만에 됐는가"가 남는다. 누적손익 한 줄만 있으면 열 판을 이긴 건지
   * 한 판이 길었던 건지 구분이 안 된다.
   */
  const simToTarget = (p: StrategyProfile) => {
    const target = simTargetOf(p);
    if (target == null) return;
    setBusy(p.id);
    const res = runSim(p, { maxTrades: HARD_ITER_CAP, maxSimDays: TARGET_MAX_SIM_DAYS });
    const cur = p.simCurrency || 'KRW';

    if (res.ran === 0) {
      setBusy(null); refresh();
      showToast(`${p.label} 실행 못 함 · ${res.reason}`);
      return;
    }

    const st = loadProfileRisk(p.id);
    const no = st.cycleNo;
    completeCycle(p.id, res.reason, res.reached);
    setBusy(null);
    refresh();

    const rate = Math.round((res.wins / res.ran) * 100);
    showToast([
      res.reached
        ? `${p.label} ${no}회차 목표 달성 (${fmtMoney(target, cur)})`
        : `${p.label} ${no}회차 종료 — ${res.reason}`,
      `${res.ran}건 · 승률 ${rate}%`,
      `잔고 ${fmtMoney(res.endEquity, cur)}`,
      `모의 ${fmtDur(res.simSeconds)}`,
      res.restDays > 0 ? `하루 한도로 ${res.restDays}일 쉼` : '',
    ].filter(Boolean).join(' · '));
  };

  const box: React.CSSProperties = { background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 14, marginBottom: 12 };
  const chip = (label: string, val: string, c: string = T.txt) => (
    <div style={{ background: T.alt, borderRadius: 8, padding: '6px 8px', minWidth: 0 }}>
      <div style={{ fontSize: 8, color: T.muted }}>{label}</div>
      <div style={{ fontSize: 11, fontWeight: 800, color: c, overflowWrap: 'anywhere' }}>{val}</div>
    </div>
  );
  const btn = (bg: string): React.CSSProperties => ({ padding: '7px 10px', borderRadius: 8, border: 'none', background: bg, color: '#fff', fontSize: 11, fontWeight: 800, cursor: 'pointer' });

  return (
    <div>
      {toast && <div style={{ position: 'fixed', left: '50%', bottom: 90, transform: 'translateX(-50%)', zIndex: 9999, background: '#111', color: '#fff', padding: '10px 16px', borderRadius: 10, fontSize: 12, fontWeight: 700, maxWidth: '90vw', textAlign: 'center', boxShadow: '0 8px 24px rgba(0,0,0,.35)' }}>{toast}</div>}

      <div style={{ fontSize: 14, fontWeight: 800, color: T.txt, marginBottom: 10 }}>⚙️ 전략 프로필 (포트폴리오 봇)</div>

      {listProfiles().map(p => {
        const s: ProfileRiskState = loadProfileRisk(p.id);
        const cur: 'KRW' | 'USD' = p.simCurrency || 'KRW';
        const target = simTargetOf(p);
        // 예전에는 스캘핑만 HIGH LEV였다. 10슬롯(상한 100배)이 LOW LEV
        // 초록 배지를 달고 있었다 — 화면이 위험을 반대로 말한 것이다.
        const highLev = p.maxLeverage >= 20;
        const accent = highLev ? T.red : T.grn;
        const holdAssumed = !(p.maxHoldSec > 0);
        return (
          <div key={p.id} style={box}>
            {/* 헤더 */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, fontWeight: 800, color: T.txt }}>{p.label}</span>
                <span style={{ background: accent + '20', color: accent, fontSize: 8, fontWeight: 800, padding: '2px 7px', borderRadius: 5 }}>{highLev ? 'HIGH LEV' : 'LOW LEV'}</span>
                {target != null && (
                  <span style={{ background: T.ylw + '20', color: T.ylw, fontSize: 8, fontWeight: 800, padding: '2px 7px', borderRadius: 5 }}>
                    {s.cycleNo}회차 진행 중
                  </span>
                )}
                {s.killed && <span style={{ background: T.red, color: '#fff', fontSize: 8, fontWeight: 800, padding: '2px 7px', borderRadius: 5 }}>KILLED</span>}
              </div>
            </div>

            {/* 프로필 파라미터 */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 6, marginBottom: 8 }}>
              {chip('레버리지', `${p.leverage}~${p.maxLeverage}x`, accent)}
              {chip('자산비중', `${p.maxPortfolioPct}%`)}
              {chip('1회위험', `${p.riskPercentPerTrade}%`)}
              {chip('마진', p.marginModes.join('/'))}
              {chip('익절', `${p.takeProfitPct}%`)}
              {chip('손절', `${p.stopLossPct}%`)}
              {chip('주문', p.orderType === 'post_only_limit' ? 'PostOnly' : p.orderType === 'limit' ? '지정가' : '시장가')}
              {chip('일손실한도', `${p.dailyLossLimitPct}%`)}
            </div>

            {/* 프로필별 격리 성적표 */}
            <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 8, marginBottom: 8 }}>
              {/* **이건 시뮬레이션 결과다.** 실제 계좌 성적과 같은 모양으로
                  그려 두면 그렇게 읽힌다 — 이 저장소에서 이미 한 번
                  일어난 일이다(안 도는 봇이 +₩847,000을 표시했다). */}
              <div style={{ fontSize: 9, color: T.muted, marginBottom: 6 }}>
                성적표 · <b style={{ color: T.ylw }}>모의 시뮬</b> (거래소에 나가지 않음) · 표본 n={s.tradeCount}
                {target != null && <> · 시드 {fmtMoney(simSeedOf(p), cur)} → 목표 <b style={{ color: T.ylw }}>{fmtMoney(target, cur)}</b></>}
              </div>

              {/* ── 무엇을 가정하고 돌리는가 ──
                  예전에는 승패가 그냥 동전 던지기(50%)였다. 익절 1.5% /
                  손절 0.5%짜리를 50%로 돌리면 돈 찍는 기계가 되고,
                  화면에 +238해원 같은 게 뜬다. 숫자가 큰 게 문제가
                  아니라 **전제가 틀린** 것이다.
                  이제 기준선은 손익비에서 나오고, 우위는 사용자가 고른다. */}
              {(() => {
                const e = edgeOf(p);
                const w = assumedWinRate(p, e);
                const be = breakevenWinRate(p);
                const exp = expectancyPctOfNotional(p, w);
                const posOdds = exp > 0;
                return (
                  <div style={{ background: T.alt, borderRadius: 8, padding: '7px 8px', marginBottom: 6 }}>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 5 }}>
                      {EDGE_CHOICES.map(c => (
                        <button key={c.pp} onClick={() => setEdge(m => ({ ...m, [p.id]: c.pp }))}
                          title={c.note}
                          style={{ padding: '4px 8px', borderRadius: 6, border: `1px solid ${e === c.pp ? T.ylw : T.border}`,
                                   background: e === c.pp ? T.ylw + '20' : 'transparent',
                                   color: e === c.pp ? T.ylw : T.muted, fontSize: 9, fontWeight: 800, cursor: 'pointer' }}>
                          {c.label}
                        </button>
                      ))}
                    </div>
                    <div style={{ fontSize: 8.5, color: T.muted, lineHeight: 1.55 }}>
                      가정 승률 <b style={{ color: T.txt }}>{(w * 100).toFixed(0)}%</b>
                      {' '}(무우위 기준선 {(noEdgeWinRate(p) * 100).toFixed(0)}% = 손절 {p.stopLossPct}% ÷ (익절 {p.takeProfitPct}% + 손절 {p.stopLossPct}%))
                      {' · '}본전 승률 <b style={{ color: T.txt }}>{(be * 100).toFixed(0)}%</b> (수수료 왕복 {roundTripFeePct(p).toFixed(2)}% 포함)
                      <br />
                      1건 기대값 <b style={{ color: posOdds ? T.grn : T.red }}>{exp >= 0 ? '+' : ''}{exp.toFixed(3)}%</b> (명목가 대비)
                      {' — '}
                      {posOdds
                        ? '기대값이 양수라 오래 돌리면 늘어납니다. 그래도 한 판이 망하는 것과는 다른 이야기입니다.'
                        : '기대값이 음수입니다. 오래 돌릴수록 줄어듭니다 — 우위 없이는 수수료에 집니다.'}
                    </div>
                  </div>
                );
              })()}

              {/* **언제 쌓인 표본인가.** 기간 없는 성적표는 해석할 수 없다 —
                  같은 1000건이 10일치인지 반년치인지에 따라 완전히 다른
                  이야기다. 벽시계로는 전부 1초라 기간이 안 나온다. */}
              {s.tradeCount > 0 && (
                <div style={{ fontSize: 8.5, color: T.muted, marginBottom: 6, lineHeight: 1.5 }}>
                  {samplePeriodText({
                    trades: s.tradeCount, simSeconds: s.simSeconds,
                    assumed: holdAssumed, firstAt: s.firstTradeAt, lastAt: s.lastTradeAt,
                  })}
                </div>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 6 }}>
                {chip('잔고', fmtMoney(s.equity, cur), s.realizedPnL >= 0 ? T.grn : T.red)}
                {chip('누적손익', fmtMoney(s.realizedPnL, cur, true), s.realizedPnL >= 0 ? T.grn : T.red)}
                {chip('승률', s.tradeCount > 0 ? `${winRate(s).toFixed(0)}% (${s.winCount}/${s.tradeCount})` : '-')}
                {chip('MDD', `-${s.maxDrawdown.toFixed(1)}%`, T.red)}
              </div>
              {s.tradeCount < 20 && s.tradeCount > 0 && (
                <div style={{ fontSize: 8, color: T.muted, marginTop: 5 }}>⚠️ 표본 {s.tradeCount}건 — 20건 미만은 우연일 수 있음 (승률 신뢰 낮음)</div>
              )}
              {s.killed && <div style={{ fontSize: 9, color: T.red, marginTop: 5 }}>⛔ {s.killedReason}</div>}
            </div>

            {/* ── 회차 기록 ──
                "몇 번 만에 목표에 닿았나"가 이 시뮬에서 알고 싶은 거의
                유일한 것이다. 누적손익 한 줄로는 안 보인다. */}
            {s.cycles.length > 0 && (
              <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 8, marginBottom: 8 }}>
                <div style={{ fontSize: 9, color: T.muted, marginBottom: 5 }}>
                  회차 기록 · 목표 달성 <b style={{ color: T.grn }}>{s.cycles.filter(c => c.reached).length}</b> / {s.cycles.length}판
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {s.cycles.slice().reverse().map(c => (
                    <div key={c.n} style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 9, color: T.muted, flexWrap: 'wrap' }}>
                      <b style={{ color: T.txt, fontSize: 10 }}>{c.n}회차</b>
                      <span style={{ color: c.reached ? T.grn : T.red, fontWeight: 800 }}>{c.reached ? '목표 달성' : c.reason}</span>
                      <span>{fmtMoney(c.startEquity, cur)} → {fmtMoney(c.endEquity, cur)}</span>
                      <span>{c.trades}건 · 승률 {c.trades > 0 ? Math.round(c.wins / c.trades * 100) : 0}%</span>
                      <span>모의 {fmtDur(c.simSeconds)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 액션 */}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              {target != null ? (
                /* 목표가 있는 프로필은 횟수로 돌리지 않는다. **금액에 닿을
                   때까지** 돌리고, 그 한 판이 한 회차다. */
                <button onClick={() => simToTarget(p)}
                  style={{ ...btn(accent), opacity: busy === p.id ? 0.5 : 1, padding: '9px 14px', fontSize: 12,
                           display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 1, lineHeight: 1.3 }}
                  disabled={busy === p.id}>
                  {busy === p.id ? '돌리는 중…' : `${fmtMoney(target, cur)}까지 돌리기 (${s.cycleNo}회차)`}
                  {busy !== p.id && (
                    <span style={{ fontSize: 8, opacity: 0.8, fontWeight: 500 }}>
                      최대 모의 {TARGET_MAX_SIM_DAYS}일 · 닿거나 기간이 차면 끝
                    </span>
                  )}
                </button>
              ) : (
                [1, 10, 100, 1000].map(n => (
                  <button key={n} onClick={() => simTrades(p, n)}
                    style={{ ...btn(n === 1 ? accent : (T as any).alt2 || '#334155'),
                             opacity: (s.killed || busy === p.id) ? 0.5 : 1,
                             display: 'inline-flex', flexDirection: 'column',
                             alignItems: 'center', gap: 1, lineHeight: 1.25 }}
                    disabled={s.killed || busy === p.id}>
                    {busy === p.id ? '…' : n === 1 ? '모의 진입 시뮬 (규칙엔진)' : `${n}회`}
                    {/* **누르기 전에** 그게 며칠치인지 보인다.
                        1000회를 1초에 돌리면 쉬운 일처럼 보이는데 실제로는
                        열흘치다 — 그 감각은 누르는 순간에 있어야 한다. */}
                    {busy !== p.id && n > 1 && (
                      <span style={{ fontSize: 8, opacity: 0.75, fontWeight: 500 }}>
                        ≈ {fmtDur(simHoldSecOf(p) * n)}
                      </span>
                    )}
                  </button>
                ))
              )}
              {s.killed && <button onClick={() => { resetProfileKill(p.id); refresh(); showToast('킬스위치 해제'); }} style={btn(T.muted)}>킬스위치 해제</button>}
              <button onClick={() => { resetProfileRisk(p.id); refresh(); showToast(`${p.label} 계좌 리셋 (회차 기록은 남김)`); }} style={btn((T as any).alt2 || '#334155')}>계좌 리셋</button>
              {s.cycles.length > 0 && (
                <button onClick={() => { clearCycles(p.id); refresh(); showToast(`${p.label} 회차 기록 삭제 — 1회차부터 다시`); }} style={btn((T as any).alt2 || '#334155')}>회차 기록 지우기</button>
              )}
            </div>

            {/* 실제로는 얼마나 걸리는 양인가. */}
            <div style={{ fontSize: 9, color: T.muted, marginTop: 6, lineHeight: 1.5 }}>
              {target != null
                ? `한 건이 최대 ${fmtDur(simHoldSecOf(p))}이라 모의 하루에 약 ${Math.max(1, Math.floor(86400 / simHoldSecOf(p)))}건까지 돕니다. `
                  + `하루 손실 한도(${p.dailyLossLimitPct}%)에 걸리면 그날은 쉬고 다음 날 다시 시작합니다 — 쉰 날 수도 결과에 적힙니다.`
                : (p.maxHoldSec > 0
                    ? `실제 소요 시간(최대 보유시간 ${fmtDur(simHoldSecOf(p))} 기준): `
                      + [10, 100, 1000].map(n => `${n}회 ≈ ${fmtDur(simHoldSecOf(p) * n)}`).join(' · ')
                      + `. 버튼에 적힌 기간이 이 값입니다. 익절·손절이 먼저 닿으면 짧아지고, 하루 손실 한도(${p.dailyLossLimitPct}%)에 걸려 쉬는 날이 생기면 길어집니다 — 쉰 날 수는 결과에 적힙니다.`
                    : `이 프로필은 최대 보유시간이 무제한이라 실제 소요 시간을 알 수 없습니다. 모의 시계는 한 건을 ${fmtDur(simHoldSecOf(p))}로 **가정**해서 돌립니다 — 화면의 기간은 그 가정 위의 값입니다.`)}
            </div>

            <div style={{ fontSize: 9, color: T.muted, marginTop: 8, lineHeight: 1.5 }}>{p.description}</div>
          </div>
        );
      })}

      <div style={{ ...box, background: T.alt }}>
        <div style={{ fontSize: 10, color: T.muted, lineHeight: 1.6 }}>
          <b style={{ color: T.txt }}>규칙 엔진 원칙:</b> AI/신호는 방향·국면만 제시하고, 레버리지·수량·손절은 프로필이 강제합니다.
          AI가 상한을 초과 요구해도 자동 clamp됩니다 (예: 100x 요청 → 스캘핑 50x로 제한).
          세 프로필의 <b style={{ color: T.txt }}>포지션·손익·MDD·킬스위치는 완전히 분리</b>되어, 한쪽이 정지돼도 다른 쪽은 계속 운용됩니다.
          <br /><br />
          <b style={{ color: T.ylw }}>기간은 모의 시계 기준입니다.</b> 1000건이 실제로는 1초에 끝나므로 벽시계로는 기간이 나오지 않습니다.
          하루 손실 한도도 이 모의 시계의 하루마다 풀립니다.
        </div>
      </div>
    </div>
  );
}
