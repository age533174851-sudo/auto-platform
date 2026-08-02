'use client';
// StrategyProfilesPanel — 고위험 단타 / 저위험 스윙 프로필을 분리 표시.
// 규칙 엔진(buildOrder)으로 프로필 한도 내 주문을 만들고, 프로필별 격리 리스크
// (PnL·MDD·일손실·킬스위치)를 독립 추적. 각 프로필 성적표(표본수 n 포함) 표시.
import React, { useState, useCallback } from 'react';
import { T } from '@/lib/constants';
import { notify } from '@/lib/notify/center';
import { listProfiles, type StrategyProfile, type StrategyType } from '@/lib/strategies/profiles';
import { buildOrder, type Signal } from '@/lib/strategies/ruleEngine';
import {
  loadProfileRisk, recordProfileTrade, canProfileEnter,
  resetProfileKill, resetProfileRisk, winRate, type ProfileRiskState,
} from '@/lib/strategies/profileRisk';

/**
 * 초를 사람이 읽는 기간으로.
 *
 * 시뮬은 1000회를 1초에 돌린다. 그러면 "이 전략 1000번"이 쉬운 일처럼
 * 보이는데 실제로는 몇 달치다. 그 감각이 없으면 시뮬 결과를 과신한다.
 */
function fmtDur(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '—';
  const m = sec / 60, h = m / 60, d = h / 24;
  if (d >= 365) return `${(d / 365).toFixed(1)}년`;
  if (d >= 30)  return `${(d / 30).toFixed(1)}개월`;
  if (d >= 1)   return `${d.toFixed(d < 10 ? 1 : 0)}일`;
  if (h >= 1)   return `${h.toFixed(h < 10 ? 1 : 0)}시간`;
  if (m >= 1)   return `${Math.round(m)}분`;
  return `${Math.round(sec)}초`;
}

/** 시뮬 한 건의 결과. 이름을 붙여 두면 화살표 함수의 반환 타입 자리에서
 *  `=>`가 타입의 일부로 읽히는 파싱 문제를 피할 수 있다. */
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
};

const AI_SOURCES = ['claude', 'gpt', 'gemini', 'grok'];
const SIM_PRICE = 140_000_000;

export default function StrategyProfilesPanel() {
  const [tick, setTick] = useState(0);
  const [toast, setToast] = useState('');
  const refresh = useCallback(() => setTick(t => t + 1), []);
  const showToast = useCallback((m: string) => {
    const [title, ...rest] = m.split(' · ');
    const kind: any = /킬스위치|차단/.test(title) ? 'kill' : /익절|성공/.test(title) ? 'success' : /손절|실패|거부/.test(title) ? 'error' : 'info';
    notify(kind, title, rest.join(' · ') || undefined);
    setToast(''); void toast;
  }, [toast]);
  void tick;

  const [busy, setBusy] = useState<StrategyType | null>(null);

  /**
   * 한 건 시뮬. 결과를 **돌려준다** — 여러 번 돌릴 때 집계해야 하기 때문이다.
   *
   * 화면에 띄우지 않는 이유: 1000번 돌리면서 매번 토스트를 띄우면 아무것도
   * 읽을 수 없다. 요약은 부르는 쪽이 한 번만 한다.
   */
  const simOnce = (p: StrategyProfile): SimResult => {
    const can = canProfileEnter(p.id);
    if (!can.allowed) return { ok: false, reason: can.reason || '진입 차단' };
    const eq = loadProfileRisk(p.id).equity;
    const sig: Signal = {
      bias: Math.random() > 0.5 ? 'long' : 'short',
      desiredLeverage: p.maxLeverage + 20,   // 일부러 상한 초과 요구 → clamp 확인
      aiSource: AI_SOURCES[Math.floor(Math.random() * AI_SOURCES.length)],
    };
    const built = buildOrder({ signal: sig, profile: p, equityKRW: eq, price: SIM_PRICE });
    if (!built.ok) return { ok: false, reason: (built as any).reason || '주문 거부' };
    // 무작위 승패: 익절(+TP%) 또는 손절(-SL%) — notional 기준(레버리지 반영)
    const win = Math.random() < 0.5;
    const pnlPct = win ? p.takeProfitPct : -p.stopLossPct;
    const pnl = Math.round(built.order.notionalKRW * (pnlPct / 100));
    const st = recordProfileTrade(p.id, pnl);
    return { ok: true, win, pnl, killed: !!st.killed, killReason: st.killedReason };
  };

  /**
   * N번 돌린다.
   *
   * **중간에 멈추면 그 사실을 말한다.** 1000번을 눌렀는데 킬스위치가 12번째에
   * 걸려 멈췄다면, "1000번 돌렸다"고 적는 것은 거짓말이다. 실제 실행 횟수와
   * 멈춘 이유를 같이 적는다 — 오히려 그게 이 시뮬의 가장 쓸모 있는 결과다
   * (이 설정으로는 12번이면 하루 한도가 찬다는 뜻이니까).
   */
  const simTrades = (p: StrategyProfile, n: number) => {
    setBusy(p.id);
    let ran = 0, wins = 0, pnlSum = 0;
    let stopped = '';
    for (let i = 0; i < n; i++) {
      const r = simOnce(p);
      if (!r.ok) { stopped = r.reason; break; }
      ran++; pnlSum += r.pnl ?? 0; if (r.win) wins++;
      if (r.killed) { stopped = `킬스위치 — ${r.killReason || '사유 미상'}`; break; }
    }
    setBusy(null);
    refresh();

    if (ran === 0) { showToast(`${p.label} 실행 못 함 · ${stopped || '사유 미상'}`); return; }
    const rate = Math.round((wins / ran) * 100);
    const head = ran < n
      ? `${p.label} ${ran}/${n}회에서 멈춤`
      : `${p.label} ${ran}회 완료`;
    showToast([
      head,
      `승 ${wins} · 패 ${ran - wins} (${rate}%)`,
      `합계 ${pnlSum >= 0 ? '+' : ''}${pnlSum.toLocaleString('ko-KR')}원`,
      stopped ? `멈춘 이유: ${stopped}` : '',
    ].filter(Boolean).join(' · '));
  };

  /** 표본 기간 표시. 시간대는 기기 설정을 따른다 (Intl에 맡긴다) */
  const fmtStamp = (ms: number) => {
    try {
      return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(ms));
    } catch { return '알 수 없음'; }
  };

  const box: React.CSSProperties = { background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 14, marginBottom: 12 };
  const chip = (label: string, val: string, c = T.txt) => (
    <div style={{ background: T.alt, borderRadius: 8, padding: '6px 8px' }}>
      <div style={{ fontSize: 8, color: T.muted }}>{label}</div>
      <div style={{ fontSize: 11, fontWeight: 800, color: c }}>{val}</div>
    </div>
  );
  const btn = (bg: string): React.CSSProperties => ({ padding: '7px 10px', borderRadius: 8, border: 'none', background: bg, color: '#fff', fontSize: 11, fontWeight: 800, cursor: 'pointer' });

  return (
    <div>
      {toast && <div style={{ position: 'fixed', left: '50%', bottom: 90, transform: 'translateX(-50%)', zIndex: 9999, background: '#111', color: '#fff', padding: '10px 16px', borderRadius: 10, fontSize: 12, fontWeight: 700, maxWidth: '90vw', textAlign: 'center', boxShadow: '0 8px 24px rgba(0,0,0,.35)' }}>{toast}</div>}

      <div style={{ fontSize: 14, fontWeight: 800, color: T.txt, marginBottom: 10 }}>⚙️ 전략 프로필 (포트폴리오 봇)</div>

      {listProfiles().map(p => {
        const s: ProfileRiskState = loadProfileRisk(p.id);
        const isScalp = p.id === 'SCALP_HIGH_LEV';
        const accent = isScalp ? T.red : T.grn;
        return (
          <div key={p.id} style={box}>
            {/* 헤더 */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 800, color: T.txt }}>{p.label}</span>
                <span style={{ background: accent + '20', color: accent, fontSize: 8, fontWeight: 800, padding: '2px 7px', borderRadius: 5 }}>{isScalp ? 'HIGH LEV' : 'LOW LEV'}</span>
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
              </div>

              {/* **언제 쌓인 표본인가.** 기간 없는 성적표는 해석할 수 없다 —
                  같은 1002건이 10일치인지 반년치인지에 따라 완전히 다른
                  이야기다. 예전 기록에는 이 값이 없으므로 그때는 그렇게 적는다
                  (0으로 채우면 화면이 '1970년부터'라고 쓴다). */}
              {s.tradeCount > 0 && (
                <div style={{ fontSize: 8.5, color: T.muted, marginBottom: 6, lineHeight: 1.5 }}>
                  {s.firstTradeAt == null || s.lastTradeAt == null
                    ? '표본 기간: 기록되지 않음 (이 기능이 생기기 전에 쌓인 표본입니다 — 계좌 리셋 후 다시 모으면 기간이 남습니다)'
                    : `표본 기간: ${fmtStamp(s.firstTradeAt)} ~ ${fmtStamp(s.lastTradeAt)}`}
                </div>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 6 }}>
                {chip('누적손익', `${s.realizedPnL >= 0 ? '+' : ''}${Math.round(s.realizedPnL).toLocaleString('ko-KR')}`, s.realizedPnL >= 0 ? T.grn : T.red)}
                {chip('승률', s.tradeCount > 0 ? `${winRate(s).toFixed(0)}% (${s.winCount}/${s.tradeCount})` : '-')}
                {chip('MDD', `-${s.maxDrawdown.toFixed(1)}%`, T.red)}
                {chip('오늘손익', `${s.dayPnL >= 0 ? '+' : ''}${Math.round(s.dayPnL).toLocaleString('ko-KR')}`, s.dayPnL >= 0 ? T.grn : T.red)}
              </div>
              {s.tradeCount < 20 && s.tradeCount > 0 && (
                <div style={{ fontSize: 8, color: T.muted, marginTop: 5 }}>⚠️ 표본 {s.tradeCount}건 — 20건 미만은 우연일 수 있음 (승률 신뢰 낮음)</div>
              )}
              {s.killed && <div style={{ fontSize: 9, color: T.red, marginTop: 5 }}>⛔ {s.killedReason}</div>}
            </div>

            {/* 액션 — 몇 번 돌릴지 고른다.
                한 번씩만 눌러서는 표본이 안 모인다. 위 성적표가 "표본 20건
                미만은 우연"이라고 적어 두고 정작 20건을 모으려면 스무 번을
                눌러야 했다. */}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              {[1, 10, 100, 1000].map(n => (
                <button key={n} onClick={() => simTrades(p, n)}
                  style={{ ...btn(n === 1 ? accent : T.alt2 || '#334155'),
                           opacity: (s.killed || busy === p.id) ? 0.5 : 1,
                           display: 'inline-flex', flexDirection: 'column',
                           alignItems: 'center', gap: 1, lineHeight: 1.25 }}
                  disabled={s.killed || busy === p.id}>
                  {busy === p.id ? '…' : n === 1 ? '모의 진입 시뮬 (규칙엔진)' : `${n}회`}
                  {/* **누르기 전에** 그게 며칠치인지 보인다.
                      아래 문단에도 같은 값이 있지만, 거기까지 읽고 다시
                      버튼으로 눈을 올리는 사람은 많지 않다. 1000회를 1초에
                      돌리면 쉬운 일처럼 보이는데 실제로는 열흘치다 —
                      그 감각은 누르는 순간에 있어야 한다. */}
                  {busy !== p.id && n > 1 && p.maxHoldSec > 0 && (
                    <span style={{ fontSize: 8, opacity: 0.75, fontWeight: 500 }}>
                      ≈ {fmtDur(p.maxHoldSec * n)}
                    </span>
                  )}
                </button>
              ))}
              {s.killed && <button onClick={() => { resetProfileKill(p.id); refresh(); showToast('킬스위치 해제'); }} style={btn(T.muted)}>킬스위치 해제</button>}
              <button onClick={() => { resetProfileRisk(p.id); refresh(); showToast(`${p.label} 계좌 리셋`); }} style={btn(T.alt2 || '#334155')}>계좌 리셋</button>
            </div>

            {/* 실제로는 얼마나 걸리는 양인가.
                1000회를 1초에 돌리면 "이 전략 1000번"이 쉬운 일처럼 보인다.
                실제로는 몇 달치다. 그 감각이 없으면 시뮬 결과를 과신한다. */}
            <div style={{ fontSize: 9, color: T.muted, marginTop: 6, lineHeight: 1.5 }}>
              {p.maxHoldSec > 0
                ? `실제 소요 시간(최대 보유시간 ${fmtDur(p.maxHoldSec)} 기준 상한): `
                  + [10, 100, 1000].map(n => `${n}회 ≈ ${fmtDur(p.maxHoldSec * n)}`).join(' · ')
                  + '. 버튼에 적힌 기간이 이 값입니다. 실제로는 대부분 익절·손절이 먼저 닿아 이보다 짧습니다.'
                : '이 프로필은 최대 보유시간이 무제한이라 실제 소요 시간을 예측할 수 없습니다.'}
            </div>

            <div style={{ fontSize: 9, color: T.muted, marginTop: 8, lineHeight: 1.5 }}>{p.description}</div>
          </div>
        );
      })}

      <div style={{ ...box, background: T.alt }}>
        <div style={{ fontSize: 10, color: T.muted, lineHeight: 1.6 }}>
          <b style={{ color: T.txt }}>규칙 엔진 원칙:</b> AI/신호는 방향·국면만 제시하고, 레버리지·수량·손절은 프로필이 강제합니다.
          AI가 상한을 초과 요구해도 자동 clamp됩니다 (예: 100x 요청 → 스캘핑 50x로 제한).
          두 프로필의 <b style={{ color: T.txt }}>포지션·손익·MDD·킬스위치는 완전히 분리</b>되어, 한쪽이 정지돼도 다른 쪽은 계속 운용됩니다.
        </div>
      </div>
    </div>
  );
}
