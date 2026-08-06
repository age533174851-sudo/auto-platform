'use client';
// StrategyProfilesPanel — 스캘핑 / 스윙 / 10슬롯 프로필을 분리 표시.
// 규칙 엔진(buildOrder)으로 프로필 한도 내 주문을 만들고, 프로필별 격리 리스크
// (PnL·MDD·일손실·킬스위치)를 독립 추적.
//
// **여기서 나가는 주문은 없다.** 전부 모의다.
//
// 이 화면이 최근까지 틀리게 말하던 것 셋
// ──────────────────────────────────────
// 1. **한 경로를 결론으로 읽게 놔뒀다.** 1,000건을 한 번 돌린 끝 잔고가
//    성적표였다. 몬테카를로 엔진은 이미 있었는데 화면에 안 붙어 있었다.
//    이제 분포가 본문이고, 한 번 돌린 결과는 '예시 경로'로 접어 둔다.
// 2. **되감긴 계좌를 사실로 적었다.** 목표에 닿으면 계좌가 시드로
//    돌아가서, 세 판을 내리 파산시켜도 화면은 `잔고 $1,000 · 누적손익 $0`
//    이었다. 이제 현재 회차와 전체 회차를 따로 적는다.
// 3. **기본값이 연구용이었다.** 1회 위험 10%, 상한 100배가 처음 여는
//    사람이 보는 값이었다. 이제 기본은 안정화이고, 그 극단값은
//    '연구용' 프리셋으로 따로 고른다.
import React, { useState, useCallback, useMemo } from 'react';
import { T } from '@/lib/constants';
import { notify } from '@/lib/notify/center';
import {
  listProfiles, simHoldSecOf, simPriceOf, simSeedOf,
  type StrategyProfile,
} from '@/lib/strategies/profiles';
import { buildOrder, type Signal } from '@/lib/strategies/ruleEngine';
import {
  loadProfileRisk, recordProfileTrade, canProfileEnter, skipToNextSimDay,
  resetProfileKill, resetProfileRisk, simTargetOf, winRate,
  roundStartEquityOf, roundPnlOf, type ProfileRiskState,
} from '@/lib/strategies/profileRisk';
import { fmtDur, fmtMoney, samplePeriodText } from '@/lib/strategies/simFormat';
import {
  assumedWinRate, noEdgeWinRate, breakevenWinRate, expectancyPctOfNotional,
  tradePnlPctOfNotional, roundTripFeePct, EDGE_CHOICES,
} from '@/lib/strategies/simModel';
import {
  applyPreset, mddStopPctOf, warnsOnNegativeExpectancy, bandText, withinBand,
  overrideOf, PRESET_INFO, DEFAULT_PRESET, type RiskPresetId,
} from '@/lib/strategies/profilePreset';
import {
  loadBook, summarize, clearBook, clearAllBooks, MODE_INFO, ALL_ROUND_MODES,
  DEFAULT_ROUND_MODE, nextStartEquity, type RoundMode,
} from '@/lib/strategies/roundLedger';
import { finishRound, restartCurrentRound } from '@/lib/strategies/roundRunner';
import { runProfileMonteCarlo, DEFAULT_PATHS, DEFAULT_TRADES } from '@/lib/strategies/profileMonteCarlo';
import { verdictOf } from '@/lib/strategies/monteCarlo';

/** 시뮬 한 건의 결과.
 *  이 저장소는 `strict: false`라 `{ok:true}|{ok:false}` 판별 유니온이
 *  좁혀지지 않는다(boolean 리터럴이 넓어진다). 그래서 한 모양으로 둔다. */
type SimResult = {
  ok: boolean;
  reason?: string;
  win?: boolean;
  pnl?: number;
  killed?: boolean;
  killReason?: string;
  equity?: number;
};

/** 한 판(회차)을 돌린 결과. */
type RunResult = {
  ran: number;
  wins: number;
  pnl: number;
  reached: boolean;
  ruined: boolean;
  reason: string;
  simSeconds: number;
  restDays: number;
  endEquity: number;
};

const AI_SOURCES = ['claude', 'gpt', 'gemini', 'grok'];

/** 목표까지 돌릴 때의 상한. 실제 계획이 '3개월'이라 그 길이로 잡는다. */
const TARGET_MAX_SIM_DAYS = 90;
/** 어떤 경우에도 브라우저가 멎으면 안 된다. */
const HARD_ITER_CAP = 200_000;

const pctText = (v: number | null | undefined, digits = 1) =>
  v == null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(digits)}%`;

export default function StrategyProfilesPanel() {
  const [toast, setToast] = useState('');
  const showToast = useCallback((m: string) => {
    const [title, ...rest] = m.split(' · ');
    const kind: any = /킬스위치|차단|파산/.test(title) ? 'kill'
      : /익절|성공|달성/.test(title) ? 'success'
      : /손절|실패|거부/.test(title) ? 'error' : 'info';
    notify(kind, title, rest.join(' · ') || undefined);
    setToast(''); void toast;
  }, [toast]);

  return (
    <div>
      <div style={{ fontSize: 14, fontWeight: 800, color: T.txt, marginBottom: 10 }}>⚙️ 전략 프로필 (포트폴리오 봇)</div>
      {listProfiles().map(p => <ProfileCard key={p.id} base={p} onToast={showToast} />)}

      <div style={{ background: T.alt, border: `1px solid ${T.border}`, borderRadius: 12, padding: 14, marginBottom: 12 }}>
        <div style={{ fontSize: 10, color: T.muted, lineHeight: 1.6 }}>
          <b style={{ color: T.txt }}>규칙 엔진 원칙:</b> AI/신호는 방향·국면만 제시하고, 레버리지·수량·손절은 프로필이 강제합니다.
          AI가 상한을 초과 요구해도 자동 clamp됩니다.
          세 프로필의 <b style={{ color: T.txt }}>포지션·손익·MDD·킬스위치는 완전히 분리</b>되어, 한쪽이 정지돼도 다른 쪽은 계속 운용됩니다.
          <br /><br />
          <b style={{ color: T.ylw }}>기간은 모의 시계 기준입니다.</b> 1000건이 실제로는 1초에 끝나므로 벽시계로는 기간이 나오지 않습니다.
          하루 손실 한도도 이 모의 시계의 하루마다 풀립니다.
          <br /><br />
          <b style={{ color: T.ylw }}>확률 시뮬과 실제 백테스트는 다릅니다.</b> 이 화면의 분포는 &ldquo;승률이 이만큼이라면 자금 관리가 어떻게
          되는가&rdquo;를 봅니다. 진입 조건에 실제로 우위가 있는지는 <b style={{ color: T.txt }}>여기서 전혀 검증되지 않습니다</b> —
          그건 실제 캔들로 도는 백테스트가 할 일입니다.
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// 프로필 카드
// ────────────────────────────────────────────────────────────

function ProfileCard({ base, onToast }: { base: StrategyProfile; onToast: (m: string) => void }) {
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick(t => t + 1), []);
  void tick;

  const [busy, setBusy] = useState(false);
  const [preset, setPreset] = useState<RiskPresetId>(DEFAULT_PRESET);
  const [mode, setMode] = useState<RoundMode>(DEFAULT_ROUND_MODE);
  const [edgePp, setEdgePp] = useState(0);
  const [showPath, setShowPath] = useState(false);
  const [lastPath, setLastPath] = useState<RunResult | null>(null);
  /** 전체 회차 기록 초기화는 한 번 더 묻는다 — 되돌릴 수 없다 */
  const [armClear, setArmClear] = useState(false);
  /** 기대값이 음수인데도 돌리겠다고 명시적으로 고른 상태 */
  const [ackNegative, setAckNegative] = useState(false);

  // **프리셋이 얹힌 프로필이 진짜 프로필이다.** 아래 모든 계산과 표시가
  // 이 값을 쓴다. 한 군데라도 원본 `base`를 쓰면 화면과 계산이 갈린다.
  const p = useMemo(() => applyPreset(base, preset), [base, preset]);
  const ov = overrideOf(base.id, preset);
  const mddStop = mddStopPctOf(base.id, preset);

  const cur: 'KRW' | 'USD' = p.simCurrency || 'KRW';
  const target = simTargetOf(p);
  const s: ProfileRiskState = loadProfileRisk(p.id);
  const roundStart = roundStartEquityOf(s, p.id);
  const roundPnl = roundPnlOf(s, p.id);

  const book = loadBook(p.id, mode);
  const sum = summarize(book);

  const w = assumedWinRate(p, edgePp);
  const be = breakevenWinRate(p);
  const exp = expectancyPctOfNotional(p, w);
  const negative = exp <= 0;
  const warnNegative = negative && warnsOnNegativeExpectancy(base.id, preset);
  const blockedByWarning = warnNegative && !ackNegative;

  // 몬테카를로. 설정이 안 바뀌면 다시 안 돈다 — 같은 설정에 같은 결과가
  // 나오도록 시드도 설정에서 뽑는다(벽시계 안 씀).
  const mc = useMemo(() => {
    try {
      return runProfileMonteCarlo(p, {
        edgePp, preset, startEquity: roundStart,
        paths: DEFAULT_PATHS, trades: DEFAULT_TRADES,
      });
    } catch { return null; }
  }, [p, edgePp, preset, roundStart]);
  const verdict = mc ? verdictOf(mc) : null;

  const highLev = p.maxLeverage >= 20;
  const accent = highLev ? T.red : T.grn;
  const holdAssumed = !(p.maxHoldSec > 0);

  // ── 시뮬 ─────────────────────────────────────────────────

  const simOnce = (winProb: number): SimResult => {
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
    const win = Math.random() < winProb;
    const pnl = built.order.notionalKRW * (tradePnlPctOfNotional(p, win) / 100);
    // **프리셋의 한도로 판정한다.** 프로필 표의 값을 쓰면 화면에는
    // '하루 -5%'라고 적혀 있는데 실제로는 -30%까지 돈다.
    const st = recordProfileTrade(p.id, pnl, simHoldSecOf(p), {
      dailyLossLimitPct: p.dailyLossLimitPct,
      mddStopPct: mddStop,
    });
    return { ok: true, win, pnl, killed: !!st.killed, killReason: st.killedReason, equity: st.equity };
  };

  const runSim = (opts: { maxTrades: number; maxSimDays: number }): RunResult => {
    const start = loadProfileRisk(p.id);
    const startSim = start.simSeconds;
    const winProb = assumedWinRate(p, edgePp);
    // 회차 시작 잔고의 0.5% 밑이면 사실상 끝이다. **시드가 아니라 이
    // 회차가 시작한 금액 기준이다** — 연속 복리에서 잔고가 커졌는데
    // 시드 기준으로 재면 파산선이 사실상 없어진다.
    const bustAt = roundStartEquityOf(start, p.id) * 0.005;

    let ran = 0, wins = 0, pnlSum = 0, restDays = 0;
    let reached = false, ruined = false, reason = '';

    for (let i = 0; i < HARD_ITER_CAP; i++) {
      if (ran >= opts.maxTrades) { reason = `${opts.maxTrades.toLocaleString('ko-KR')}회 완료`; break; }

      const c = loadProfileRisk(p.id);
      const elapsedDays = (c.simSeconds - startSim) / 86400;
      if (elapsedDays >= opts.maxSimDays) { reason = `모의 ${opts.maxSimDays}일 도달 — 목표 미달`; break; }
      if (c.equity <= bustAt) { ruined = true; reason = '파산 — 회차 시작 자금의 0.5% 미만'; break; }

      const can = canProfileEnter(p.id);
      if (!can.allowed) {
        // 하루 한도는 '오늘'만 막는다. 낙폭 중단선과 수동 킬은 진짜 중단이다.
        if (can.reason && can.reason.includes('일손실')) {
          skipToNextSimDay(p.id); restDays++; continue;
        }
        reason = can.reason || '진입 차단'; break;
      }

      const r = simOnce(winProb);
      if (!r.ok) { reason = r.reason || '주문 거부'; break; }
      ran++; pnlSum += r.pnl ?? 0; if (r.win) wins++;

      if (target != null && (r.equity ?? 0) >= target) { reached = true; reason = '목표 달성'; break; }
    }
    if (!reason) reason = `안전 상한 ${HARD_ITER_CAP.toLocaleString('ko-KR')}회 도달`;

    const end = loadProfileRisk(p.id);
    return {
      ran, wins, pnl: pnlSum, reached, ruined, reason,
      simSeconds: end.simSeconds - startSim, restDays, endEquity: end.equity,
    };
  };

  /** 정해진 횟수만큼 (목표 없는 프로필) */
  const simTrades = (n: number) => {
    setBusy(true);
    const perDay = Math.max(1, Math.floor(86400 / simHoldSecOf(p)));
    const budgetDays = Math.ceil(n / perDay) * 3 + 30;
    const res = runSim({ maxTrades: n, maxSimDays: budgetDays });
    setBusy(false); setLastPath(res); refresh();

    if (res.ran === 0) { onToast(`${p.label} 실행 못 함 · ${res.reason}`); return; }
    const rate = Math.round((res.wins / res.ran) * 100);
    onToast([
      res.ran < n ? `${p.label} ${res.ran}/${n}회에서 멈춤` : `${p.label} ${res.ran}회 완료`,
      `승 ${res.wins} · 패 ${res.ran - res.wins} (${rate}%)`,
      `합계 ${fmtMoney(res.pnl, cur, true)}`,
      `모의 ${fmtDur(res.simSeconds)}`,
      res.restDays > 0 ? `하루 한도로 ${res.restDays}일 쉼` : '',
      res.ran < n ? `멈춘 이유: ${res.reason}` : '',
    ].filter(Boolean).join(' · '));
  };

  /** 목표 금액까지 — 끝나면 한 회차로 장부에 남긴다 */
  const simToTarget = () => {
    if (target == null) return;
    setBusy(true);
    const res = runSim({ maxTrades: HARD_ITER_CAP, maxSimDays: TARGET_MAX_SIM_DAYS });
    setLastPath(res);

    if (res.ran === 0) {
      setBusy(false); refresh();
      onToast(`${p.label} 실행 못 함 · ${res.reason}`);
      return;
    }
    const no = loadProfileRisk(p.id).cycleNo;
    const fin = finishRound(p, mode, { preset, reason: res.reason, reached: res.reached, ruined: res.ruined });
    setBusy(false); refresh();

    const rate = Math.round((res.wins / res.ran) * 100);
    onToast([
      res.reached ? `${p.label} ${no}회차 목표 달성 (${fmtMoney(target, cur)})`
                  : `${p.label} ${no}회차 종료 — ${res.reason}`,
      `${res.ran}건 · 승률 ${rate}%`,
      `잔고 ${fmtMoney(res.endEquity, cur)}`,
      `전체 ${fin.summary.totalRounds}회차 · 순손익 ${fmtMoney(fin.summary.totalNetPnl, cur, true)}`,
    ].join(' · '));
  };

  /** 목표가 없는 프로필도 회차를 손으로 끊을 수 있어야 장부가 쌓인다 */
  const endRoundManually = () => {
    const st = loadProfileRisk(p.id);
    if (st.tradeCount === 0) { onToast(`${p.label} 회차 종료 못 함 · 이 회차에 거래가 없습니다`); return; }
    const fin = finishRound(p, mode, {
      preset, reason: `손으로 회차 종료 (${st.tradeCount}건)`,
      reached: target != null && st.equity >= target,
      ruined: st.equity <= roundStartEquityOf(st, p.id) * 0.005,
    });
    setLastPath(null); refresh();
    onToast(`${p.label} ${fin.book.rounds.length}회차 기록 · 전체 순손익 ${fmtMoney(fin.summary.totalNetPnl, cur, true)}`);
  };

  const resetCurrentRound = () => {
    resetProfileRisk(p.id, restartCurrentRound(p, mode));
    setLastPath(null); refresh();
    onToast(`${p.label} 현재 회차 초기화 · 전체 회차 기록은 그대로입니다`);
  };

  const clearLedger = () => {
    clearBook(p.id, mode);
    setArmClear(false); setLastPath(null); refresh();
    onToast(`${p.label} ${MODE_INFO[mode].label} 전체 회차 기록 삭제`);
  };

  // ── 스타일 ───────────────────────────────────────────────
  const box: React.CSSProperties = { background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 14, marginBottom: 12 };
  const chip = (label: string, val: string, c: string = T.txt) => (
    <div style={{ background: T.alt, borderRadius: 8, padding: '6px 8px', minWidth: 0 }}>
      <div style={{ fontSize: 8, color: T.muted }}>{label}</div>
      <div style={{ fontSize: 11, fontWeight: 800, color: c, overflowWrap: 'anywhere' }}>{val}</div>
    </div>
  );
  const btn = (bg: string): React.CSSProperties => ({ padding: '7px 10px', borderRadius: 8, border: 'none', background: bg, color: '#fff', fontSize: 11, fontWeight: 800, cursor: 'pointer' });
  const tab = (on: boolean): React.CSSProperties => ({
    padding: '4px 9px', borderRadius: 6, border: `1px solid ${on ? T.ylw : T.border}`,
    background: on ? T.ylw + '20' : 'transparent', color: on ? T.ylw : T.muted,
    fontSize: 9, fontWeight: 800, cursor: 'pointer',
  });

  return (
    <div style={box}>
      {/* 헤더 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 800, color: T.txt }}>{p.label}</span>
        <span style={{ background: accent + '20', color: accent, fontSize: 8, fontWeight: 800, padding: '2px 7px', borderRadius: 5 }}>{highLev ? 'HIGH LEV' : 'LOW LEV'}</span>
        <span style={{ background: T.ylw + '20', color: T.ylw, fontSize: 8, fontWeight: 800, padding: '2px 7px', borderRadius: 5 }}>
          {s.cycleNo}회차 진행 중
        </span>
        {s.killed && <span style={{ background: T.red, color: '#fff', fontSize: 8, fontWeight: 800, padding: '2px 7px', borderRadius: 5 }}>KILLED</span>}
      </div>

      {/* ── 프리셋 ── */}
      <div style={{ background: T.alt, borderRadius: 8, padding: '7px 8px', marginBottom: 8 }}>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 5 }}>
          <span style={{ fontSize: 8.5, color: T.muted, alignSelf: 'center', marginRight: 2 }}>위험 설정</span>
          {(['STABILIZE', 'RESEARCH'] as RiskPresetId[]).map(k => (
            <button key={k} onClick={() => { setPreset(k); setAckNegative(false); }}
              title={PRESET_INFO[k].desc} style={tab(preset === k)}>
              {PRESET_INFO[k].label}
            </button>
          ))}
        </div>
        <div style={{ fontSize: 8.5, color: preset === 'RESEARCH' ? T.red : T.muted, lineHeight: 1.5 }}>
          {PRESET_INFO[preset].desc}
          {preset === 'RESEARCH' && ' — 이 설정으로 나온 회차는 장부에 연구용으로 표시됩니다'}
        </div>
      </div>

      {/* 프로필 파라미터 — 권장 범위를 같이 적는다 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 6, marginBottom: 4 }}>
        {chip('레버리지', `${p.leverage}~${p.maxLeverage}x`, withinBand(ov.leverageBand, p.maxLeverage) ? accent : T.red)}
        {chip('자산비중', `${p.maxPortfolioPct}%`)}
        {chip('1회위험', `${p.riskPercentPerTrade}%`, withinBand(ov.riskBand, p.riskPercentPerTrade) ? T.txt : T.red)}
        {chip('마진', p.marginModes.join('/'))}
        {chip('익절', `${p.takeProfitPct}%`)}
        {chip('손절', `${p.stopLossPct}%`)}
        {chip('주문', p.orderType === 'post_only_limit' ? 'PostOnly' : p.orderType === 'limit' ? '지정가' : '시장가')}
        {chip('일손실한도', `${p.dailyLossLimitPct}%`, withinBand(ov.dailyLossBand, p.dailyLossLimitPct) ? T.txt : T.red)}
      </div>
      <div style={{ fontSize: 8, color: T.muted, marginBottom: 8, lineHeight: 1.5 }}>
        {[
          ov.leverageBand ? `배율 ${bandText(ov.leverageBand, p.maxLeverage, '배')}` : '',
          ov.riskBand ? `1회 위험 ${bandText(ov.riskBand, p.riskPercentPerTrade, '%')}` : '',
          ov.dailyLossBand ? `하루 한도 ${bandText(ov.dailyLossBand, p.dailyLossLimitPct, '%')}` : '',
          mddStop != null ? `낙폭 ${mddStop}%면 회차 중단` : '',
        ].filter(Boolean).join(' · ') || '연구용 설정입니다 — 권장 범위가 없습니다'}
      </div>

      {/* ── 가정 ── */}
      <div style={{ background: T.alt, borderRadius: 8, padding: '7px 8px', marginBottom: 8 }}>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 5 }}>
          {EDGE_CHOICES.map(c => (
            <button key={c.pp} onClick={() => { setEdgePp(c.pp); setAckNegative(false); }} title={c.note} style={tab(edgePp === c.pp)}>
              {c.label}
            </button>
          ))}
        </div>
        <div style={{ fontSize: 8.5, color: T.muted, lineHeight: 1.55 }}>
          가정 승률 <b style={{ color: T.txt }}>{(w * 100).toFixed(0)}%</b>
          {' '}(무우위 기준선 {(noEdgeWinRate(p) * 100).toFixed(0)}% = 손절 {p.stopLossPct}% ÷ (익절 {p.takeProfitPct}% + 손절 {p.stopLossPct}%))
          {' · '}본전 승률 <b style={{ color: T.txt }}>{(be * 100).toFixed(1)}%</b> (수수료 왕복 {roundTripFeePct(p).toFixed(2)}% 포함)
          <br />
          1건 기대값 <b style={{ color: negative ? T.red : T.grn }}>{exp >= 0 ? '+' : ''}{exp.toFixed(3)}%</b> (명목가 대비)
          {' — '}
          {negative
            ? '기대값이 음수입니다. 오래 돌릴수록 줄어듭니다 — 우위 없이는 수수료에 집니다.'
            : '기대값이 양수라 오래 돌리면 늘어납니다. 그래도 한 판이 망하는 것과는 다른 이야기입니다.'}
        </div>
      </div>

      {/* ── 몬테카를로: 이게 본문이다 ──
          한 경로는 일화이고 분포가 성적이다. 엔진은 진작 있었는데
          화면에 안 붙어 있었다. */}
      <div style={{ border: `1px solid ${verdict?.ok ? T.grn + '55' : T.red + '55'}`, borderRadius: 10, padding: 10, marginBottom: 8 }}>
        <div style={{ fontSize: 9.5, color: T.muted, marginBottom: 6 }}>
          🎲 <b style={{ color: T.txt }}>확률 시뮬 (몬테카를로)</b> · 같은 설정으로{' '}
          <b style={{ color: T.txt }}>{(mc?.paths ?? DEFAULT_PATHS).toLocaleString('ko-KR')}개 경로</b> ×{' '}
          {(mc?.trades ?? DEFAULT_TRADES).toLocaleString('ko-KR')}건 · 시작 {fmtMoney(roundStart, cur)}
        </div>

        {!mc ? (
          <div style={{ fontSize: 9, color: T.red }}>분포를 계산하지 못했습니다 — 설정값을 확인해 주세요</div>
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 6, marginBottom: 6 }}>
              {chip('최종 잔고 중앙값', fmtMoney(mc.medianEquity, cur), mc.medianEquity >= roundStart ? T.grn : T.red)}
              {chip('하위 5%', fmtMoney(mc.p5Equity, cur), T.red)}
              {chip('상위 95%', fmtMoney(mc.p95Equity, cur), T.grn)}
              {chip('수익 확률', pctText(mc.profitProb), mc.profitProb >= 0.5 ? T.grn : T.red)}
              {chip('파산 확률', pctText(mc.ruinProb), mc.ruinProb > 0 ? T.red : T.grn)}
              {chip('목표 달성 확률', mc.targetProb == null ? '목표 없음' : pctText(mc.targetProb),
                    mc.targetProb == null ? T.muted : (mc.targetProb >= 0.5 ? T.grn : T.ylw))}
              {chip('MDD 중앙값', `-${mc.medianMddPct.toFixed(1)}%`, T.red)}
              {chip('최악 MDD', `-${mc.worstMddPct.toFixed(1)}%`, T.red)}
              {chip('상한에 잘린 거래', pctText(mc.cappedTradeRatio), mc.cappedTradeRatio > 0.1 ? T.red : T.muted)}
            </div>

            {mc.cappedTradeRatio > 0.1 && (
              <div style={{ fontSize: 8.5, color: T.red, marginBottom: 6, lineHeight: 1.5 }}>
                ⚠️ 거래의 {pctText(mc.cappedTradeRatio, 0)}가 배율 상한({p.maxLeverage}배)에 잘렸습니다 —
                화면의 &lsquo;1회 위험 {p.riskPercentPerTrade}%&rsquo;는 그만큼 실행된 적이 없습니다.
              </div>
            )}

            {verdict && (
              <div style={{ background: (verdict.ok ? T.grn : T.red) + '15', borderRadius: 8, padding: '7px 8px' }}>
                <div style={{ fontSize: 10, fontWeight: 800, color: verdict.ok ? T.grn : T.red, marginBottom: 3 }}>
                  {verdict.ok ? '분포가 양수입니다' : '실전 연결 부적합'} · {verdict.code}
                </div>
                <div style={{ fontSize: 8.5, color: T.muted, lineHeight: 1.5 }}>{verdict.reason}</div>
              </div>
            )}
          </>
        )}
      </div>

      {/* ── 현재 회차 ── */}
      <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 8, marginBottom: 8 }}>
        <div style={{ fontSize: 9, color: T.muted, marginBottom: 6 }}>
          <b style={{ color: T.txt }}>[현재 회차]</b> {s.cycleNo}회차 · <b style={{ color: T.ylw }}>모의 시뮬</b> (거래소에 나가지 않음) · 표본 n={s.tradeCount}
          {' · '}시작 {fmtMoney(roundStart, cur)}
          {target != null && <> → 목표 <b style={{ color: T.ylw }}>{fmtMoney(target, cur)}</b></>}
        </div>
        {s.tradeCount > 0 && (
          <div style={{ fontSize: 8.5, color: T.muted, marginBottom: 6, lineHeight: 1.5 }}>
            {samplePeriodText({
              trades: s.tradeCount, simSeconds: s.simSeconds,
              assumed: holdAssumed, firstAt: s.firstTradeAt, lastAt: s.lastTradeAt,
            })}
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 6 }}>
          {chip('잔고', fmtMoney(s.equity, cur), roundPnl >= 0 ? T.grn : T.red)}
          {chip('회차 손익', fmtMoney(roundPnl, cur, true), roundPnl >= 0 ? T.grn : T.red)}
          {chip('승률', s.tradeCount > 0 ? `${winRate(s).toFixed(0)}% (${s.winCount}/${s.tradeCount})` : '-')}
          {chip('MDD', `-${s.maxDrawdown.toFixed(1)}%`, T.red)}
        </div>
        {s.tradeCount < 20 && s.tradeCount > 0 && (
          <div style={{ fontSize: 8, color: T.muted, marginTop: 5 }}>⚠️ 표본 {s.tradeCount}건 — 20건 미만은 우연일 수 있음 (승률 신뢰 낮음)</div>
        )}
        {s.killed && <div style={{ fontSize: 9, color: T.red, marginTop: 5 }}>⛔ {s.killedReason}</div>}
      </div>

      {/* ── 전체 회차 ── */}
      <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 8, marginBottom: 8 }}>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6, alignItems: 'center' }}>
          <b style={{ fontSize: 9, color: T.txt }}>[전체 회차]</b>
          {ALL_ROUND_MODES.map(m => (
            <button key={m} onClick={() => { setMode(m); setArmClear(false); }} title={MODE_INFO[m].desc} style={tab(mode === m)}>
              {MODE_INFO[m].label}
            </button>
          ))}
        </div>
        <div style={{ fontSize: 8.5, color: T.muted, marginBottom: 6, lineHeight: 1.5 }}>
          {MODE_INFO[mode].desc}
          {' — '}두 모드의 장부는 <b style={{ color: T.txt }}>따로 쌓입니다.</b> 섞어서 더하면 총 투입이 뜻을 잃습니다.
        </div>

        {sum.totalRounds === 0 ? (
          <div style={{ fontSize: 9, color: T.muted }}>
            아직 끝난 회차가 없습니다 — 성공률·파산률은 <b style={{ color: T.txt }}>0%가 아니라 없음</b>입니다.
          </div>
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 6 }}>
              {chip('총 회차', `${sum.totalRounds}회`)}
              {chip('총 투입', fmtMoney(sum.totalCapitalInjected, cur))}
              {chip('총 회수', fmtMoney(sum.totalFinalEquity, cur))}
              {chip('전체 순손익', fmtMoney(sum.totalNetPnl, cur, true), sum.totalNetPnl >= 0 ? T.grn : T.red)}
              {chip('성공률', `${pctText(sum.targetHitRate, 0)} (${sum.successfulRounds}/${sum.totalRounds})`,
                    (sum.targetHitRate ?? 0) >= 0.5 ? T.grn : T.ylw)}
              {chip('파산률', `${pctText(sum.ruinRate, 0)} (${sum.ruinedRounds}/${sum.totalRounds})`,
                    (sum.ruinRate ?? 0) > 0 ? T.red : T.grn)}
              {chip('회차 잔고 중앙값', fmtMoney(sum.medianRoundEquity ?? 0, cur))}
              {chip('전체 거래', `${sum.totalTrades.toLocaleString('ko-KR')}건`)}
              {chip('전체 모의 기간', fmtDur(sum.totalSimSeconds))}
            </div>
            {sum.mixedPresets && (
              <div style={{ fontSize: 8.5, color: T.red, marginTop: 6, lineHeight: 1.5 }}>
                ⚠️ 이 장부에는 <b>안정화와 연구용 회차가 섞여</b> 있습니다 — 합계는 그 사실 위의 값입니다.
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
              {book.rounds.slice().reverse().slice(0, 12).map(r => (
                <div key={r.n} style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 9, color: T.muted, flexWrap: 'wrap' }}>
                  <b style={{ color: T.txt, fontSize: 10 }}>{r.n}회차</b>
                  <span style={{ color: r.reached ? T.grn : r.ruined ? T.red : T.ylw, fontWeight: 800 }}>
                    {r.reached ? '목표 달성' : r.ruined ? '파산' : r.reason}
                  </span>
                  <span>{fmtMoney(r.startEquity, cur)} → {fmtMoney(r.endEquity, cur)}</span>
                  <span>{r.trades}건 · 승률 {r.trades > 0 ? Math.round(r.wins / r.trades * 100) : 0}%</span>
                  <span>투입 {fmtMoney(r.capitalInjected, cur)}</span>
                  {r.preset === 'RESEARCH' && <span style={{ color: T.red }}>연구용</span>}
                </div>
              ))}
              {book.rounds.length > 12 && (
                <div style={{ fontSize: 8.5, color: T.muted }}>… 외 {book.rounds.length - 12}회차</div>
              )}
            </div>
          </>
        )}
      </div>

      {/* ── 기대값 경고 ── */}
      {warnNegative && (
        <div style={{ background: T.red + '18', border: `1px solid ${T.red}55`, borderRadius: 8, padding: '8px 9px', marginBottom: 8 }}>
          <div style={{ fontSize: 9.5, fontWeight: 800, color: T.red, marginBottom: 3 }}>
            기대값이 {exp.toFixed(3)}%입니다 — 오래 돌릴수록 확실히 집니다
          </div>
          <div style={{ fontSize: 8.5, color: T.muted, lineHeight: 1.5, marginBottom: 6 }}>
            본전 승률 {(be * 100).toFixed(1)}%인데 가정 승률이 {(w * 100).toFixed(0)}%입니다.
            돌리는 것을 막지는 않습니다 — 음수 기대값이 어떻게 무너지는지 보는 것도 시뮬의 용도입니다.
            다만 모르고 지나가면 안 됩니다.
          </div>
          <button onClick={() => setAckNegative(true)} style={{ ...btn(T.red), fontSize: 10 }}>
            알겠습니다 · 그래도 돌리기
          </button>
        </div>
      )}

      {/* ── 실행 ── */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {target != null ? (
          <button onClick={simToTarget}
            style={{ ...btn(accent), opacity: (busy || blockedByWarning) ? 0.45 : 1, padding: '9px 14px', fontSize: 12,
                     display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 1, lineHeight: 1.3 }}
            disabled={busy || blockedByWarning}>
            {busy ? '돌리는 중…' : `${fmtMoney(target, cur)}까지 돌리기 (${s.cycleNo}회차)`}
            {!busy && (
              <span style={{ fontSize: 8, opacity: 0.8, fontWeight: 500 }}>
                최대 모의 {TARGET_MAX_SIM_DAYS}일 · 닿거나 기간이 차면 회차 종료
              </span>
            )}
          </button>
        ) : (
          [1, 10, 100, 1000].map(n => (
            <button key={n} onClick={() => simTrades(n)}
              style={{ ...btn(n === 1 ? accent : (T as any).alt2 || '#334155'),
                       opacity: (s.killed || busy || blockedByWarning) ? 0.45 : 1,
                       display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 1, lineHeight: 1.25 }}
              disabled={s.killed || busy || blockedByWarning}>
              {busy ? '…' : n === 1 ? '모의 진입 시뮬 (규칙엔진)' : `${n}회`}
              {!busy && n > 1 && (
                <span style={{ fontSize: 8, opacity: 0.75, fontWeight: 500 }}>≈ {fmtDur(simHoldSecOf(p) * n)}</span>
              )}
            </button>
          ))
        )}
        {target == null && s.tradeCount > 0 && (
          <button onClick={endRoundManually} style={btn(T.ylw)}>회차 종료 · 장부에 기록</button>
        )}
        {s.killed && <button onClick={() => { resetProfileKill(p.id); refresh(); onToast('킬스위치 해제'); }} style={btn(T.muted)}>킬스위치 해제</button>}
      </div>

      {/* ── 리셋: 둘은 다른 일이다 ──
          '현재 회차 초기화'는 돌리다 만 판을 버리는 것이고,
          '전체 회차 기록 초기화'는 지금까지의 성적을 없애는 것이다.
          한 버튼으로 묶으면 앞의 것을 누르려다 뒤의 것이 일어난다. */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 }}>
        <button onClick={resetCurrentRound} style={btn((T as any).alt2 || '#334155')}>
          현재 회차 초기화
        </button>
        {sum.totalRounds > 0 && (
          armClear ? (
            <>
              <button onClick={clearLedger} style={btn(T.red)}>
                정말 지웁니다 · {MODE_INFO[mode].label} {sum.totalRounds}회차
              </button>
              <button onClick={() => setArmClear(false)} style={btn(T.muted)}>취소</button>
            </>
          ) : (
            <button onClick={() => setArmClear(true)} style={{ ...btn('transparent'), border: `1px solid ${T.red}`, color: T.red }}>
              전체 회차 기록 초기화
            </button>
          )
        )}
        {(loadBook(p.id, 'INDEPENDENT_ROUNDS').rounds.length + loadBook(p.id, 'CONTINUOUS_COMPOUND').rounds.length) > 0 && armClear && (
          <button onClick={() => { clearAllBooks(p.id); setArmClear(false); refresh(); onToast(`${p.label} 두 모드 장부 모두 삭제`); }}
            style={{ ...btn('transparent'), border: `1px solid ${T.red}`, color: T.red }}>
            두 모드 모두 지우기
          </button>
        )}
      </div>
      <div style={{ fontSize: 8, color: T.muted, marginTop: 5, lineHeight: 1.5 }}>
        &lsquo;현재 회차 초기화&rsquo;는 돌리다 만 판만 버립니다 — 전체 회차 기록은 그대로입니다.
        {mode === 'CONTINUOUS_COMPOUND' && ` 연속 복리에서는 ${fmtMoney(nextStartEquity(p.id, mode, simSeedOf(p)).equity, cur)}에서 다시 시작합니다.`}
      </div>

      {/* ── 예시 경로: 접어 둔다 ──
          한 번 돌린 결과는 분포의 한 점이지 결론이 아니다. */}
      {lastPath && (
        <div style={{ marginTop: 8, borderTop: `1px solid ${T.border}`, paddingTop: 8 }}>
          <button onClick={() => setShowPath(v => !v)}
            style={{ background: 'transparent', border: 'none', color: T.muted, fontSize: 9, fontWeight: 700, cursor: 'pointer', padding: 0 }}>
            {showPath ? '▾' : '▸'} 예시 경로 1개 (방금 돌린 결과) — 분포의 한 점입니다
          </button>
          {showPath && (
            <div style={{ fontSize: 8.5, color: T.muted, marginTop: 5, lineHeight: 1.6 }}>
              {lastPath.ran}건 · 승 {lastPath.wins} / 패 {lastPath.ran - lastPath.wins}
              {' · '}손익 {fmtMoney(lastPath.pnl, cur, true)}
              {' · '}끝 잔고 {fmtMoney(lastPath.endEquity, cur)}
              {' · '}모의 {fmtDur(lastPath.simSeconds)}
              {lastPath.restDays > 0 && ` · 하루 한도로 ${lastPath.restDays}일 쉼`}
              <br />
              끝난 이유: {lastPath.reason}
              <br />
              <span style={{ color: T.ylw }}>
                이 한 경로가 좋아 보여도 판단은 위의 분포로 하세요 — 같은 설정에서 다시 돌리면 다른 숫자가 나옵니다.
              </span>
            </div>
          )}
        </div>
      )}

      {/* 실제로는 얼마나 걸리는 양인가. */}
      <div style={{ fontSize: 9, color: T.muted, marginTop: 8, lineHeight: 1.5 }}>
        {target != null
          ? `한 건이 최대 ${fmtDur(simHoldSecOf(p))}이라 모의 하루에 약 ${Math.max(1, Math.floor(86400 / simHoldSecOf(p)))}건까지 돕니다. `
            + `하루 손실 한도(${p.dailyLossLimitPct}%)에 걸리면 그날은 쉬고 다음 날 다시 시작합니다.`
          : (p.maxHoldSec > 0
              ? `실제 소요 시간(최대 보유시간 ${fmtDur(simHoldSecOf(p))} 기준): `
                + [10, 100, 1000].map(n => `${n}회 ≈ ${fmtDur(simHoldSecOf(p) * n)}`).join(' · ')
                + `. 하루 손실 한도(${p.dailyLossLimitPct}%)에 걸려 쉬는 날이 생기면 길어집니다.`
              : `이 프로필은 최대 보유시간이 무제한이라 실제 소요 시간을 알 수 없습니다. 모의 시계는 한 건을 ${fmtDur(simHoldSecOf(p))}로 **가정**해서 돌립니다.`)}
      </div>

      <div style={{ fontSize: 9, color: T.muted, marginTop: 8, lineHeight: 1.5 }}>{p.description}</div>
    </div>
  );
}
