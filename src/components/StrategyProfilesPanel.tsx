'use client';

// StrategyProfilesPanel — 내장 전략 프로필의 "계약"만 보여 준다.
//
// 예전 화면은 사용자가 +2/+5/+10%p 같은 가정 우위를 넣고,
// 그 가정 승률로 몬테카를로와 10만달러 도달 시뮬을 돌렸다.
// 승률을 올려 넣으면 결과가 좋아지는 것은 전략 검증이 아니라 산수다.
// 실제 캔들/체결에서 관측하지 않은 우위를 성과처럼 보여 주지 않는다.
//
// 따라서 이 화면에서는:
//   1) 가정 우위/가정 승률 입력을 없앤다.
//   2) 가정 승률 기반 랜덤 진입·몬테카를로 실행을 없앤다.
//   3) 프로필의 리스크 계약만 보여 준다.
//   4) 과거 가정 시뮬 장부는 "레거시"로 표시하고 한 번에 완전히 지울 수 있게 한다.
//   5) 실전 신뢰도는 실제 데이터 백테스트 → OOS/Walk-forward → PAPER/TESTNET
//      순서의 증거가 있을 때만 따로 판정한다.
//
// MAX_LEV_100X는 simulatableProfiles()에서 제외된다. 사용자의 전용 100배
// 실행 계약을 이 화면의 내장 프로필 정리와 섞지 않는다.

import React, { useMemo, useState } from 'react';
import { T } from '@/lib/constants';
import { notify } from '@/lib/notify/center';
import {
  simulatableProfiles,
  type StrategyProfile,
} from '@/lib/strategies/profiles';
import {
  applyPreset,
  mddStopPctOf,
  overrideOf,
  PRESET_INFO,
  DEFAULT_PRESET,
  bandText,
  withinBand,
  type RiskPresetId,
} from '@/lib/strategies/profilePreset';
import {
  loadBook,
  summarize,
  clearAllBooks,
} from '@/lib/strategies/roundLedger';
import {
  clearCycles,
} from '@/lib/strategies/profileRisk';

type EvidenceState = 'NOT_LINKED';

const EVIDENCE: Array<{ label: string; state: EvidenceState; desc: string }> = [
  { label: '실제 캔들 백테스트', state: 'NOT_LINKED', desc: '이 프로필 카드에는 실제 시장 백테스트 결과가 연결되어 있지 않습니다.' },
  { label: 'Out-of-sample / Walk-forward', state: 'NOT_LINKED', desc: '학습 구간 밖에서도 우위가 유지되는지 확인된 증거가 없습니다.' },
  { label: 'PAPER / TESTNET 실체결', state: 'NOT_LINKED', desc: '실제 체결 순서·비용·슬리피지 기반 성과가 이 카드에 연결되어 있지 않습니다.' },
];

export default function StrategyProfilesPanel() {
  return (
    <div>
      <div style={{ fontSize: 14, fontWeight: 800, color: T.txt, marginBottom: 10 }}>
        전략 프로필
      </div>

      <div style={{
        background: T.ylw + '12',
        border: `1px solid ${T.ylw}45`,
        borderRadius: 12,
        padding: 12,
        marginBottom: 12,
        color: T.muted,
        fontSize: 10,
        lineHeight: 1.65,
      }}>
        <b style={{ color: T.ylw }}>가정 우위·가정 승률 시뮬레이션을 제거했습니다.</b>
        {' '}+몇 %p를 임의로 넣어서 수익이 좋아지는 결과는 전략의 실력 증거가 아닙니다.
        이 화면은 이제 리스크 계약만 보여 주고, 성과는 실제 시장 데이터와 실제 체결 기록에서만 검증합니다.
      </div>

      {simulatableProfiles().map(p => (
        <ProfileCard key={p.id} base={p} />
      ))}

      <div style={{
        background: T.alt,
        border: `1px solid ${T.border}`,
        borderRadius: 12,
        padding: 14,
        marginBottom: 12,
        color: T.muted,
        fontSize: 10,
        lineHeight: 1.65,
      }}>
        <b style={{ color: T.txt }}>신뢰성 기준:</b>{' '}
        단일 백테스트 수익률이나 임의 승률로 실전 적합을 주장하지 않습니다.
        실제 데이터 백테스트 → OOS/Walk-forward → 비용·슬리피지 스트레스 → PAPER/TESTNET 실체결을
        순서대로 통과한 뒤에만 실전 승격 근거로 사용할 수 있습니다.
      </div>
    </div>
  );
}

function ProfileCard({ base }: { base: StrategyProfile }) {
  const [preset, setPreset] = useState<RiskPresetId>(DEFAULT_PRESET);
  const [armClear, setArmClear] = useState(false);
  const [rev, setRev] = useState(0);
  void rev;

  const p = useMemo(() => applyPreset(base, preset), [base, preset]);
  const ov = overrideOf(base.id, preset);
  const mddStop = mddStopPctOf(base.id, preset);

  const independent = summarize(loadBook(base.id, 'INDEPENDENT_ROUNDS'));
  const continuous = summarize(loadBook(base.id, 'CONTINUOUS_COMPOUND'));
  const legacyRounds = independent.totalRounds + continuous.totalRounds;
  const legacyTrades = independent.totalTrades + continuous.totalTrades;

  const clearLegacy = () => {
    // "전체 회차 기록 초기화"는 장부만 비우고 현재 회차 번호를 남기면 안 된다.
    // roundLedger 두 모드 + profileRisk의 cycle/current state를 함께 초기화한다.
    clearAllBooks(base.id);
    clearCycles(base.id);
    setArmClear(false);
    setRev(x => x + 1);
    notify('success', '가정 시뮬 기록 전체 삭제', `${p.label} · 회차/현재 상태 모두 1회차 초기값으로 복원`);
  };

  const highLev = p.maxLeverage >= 20;
  const accent = highLev ? T.red : T.grn;

  const chip = (label: string, value: string, color = T.txt) => (
    <div style={{
      background: T.alt,
      borderRadius: 9,
      padding: '8px 9px',
      minWidth: 0,
    }}>
      <div style={{ fontSize: 8.5, color: T.muted }}>{label}</div>
      <div style={{ fontSize: 11, fontWeight: 800, color, marginTop: 2, overflowWrap: 'anywhere' }}>
        {value}
      </div>
    </div>
  );

  const tab = (active: boolean): React.CSSProperties => ({
    minHeight: 34,
    padding: '0 12px',
    borderRadius: 8,
    border: `1px solid ${active ? T.ylw : T.border}`,
    background: active ? T.ylw + '18' : T.card,
    color: active ? T.ylw : T.muted,
    fontSize: 10,
    fontWeight: 800,
    cursor: 'pointer',
  });

  return (
    <div style={{
      background: T.card,
      border: `1px solid ${T.border}`,
      borderRadius: 14,
      padding: 14,
      marginBottom: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 850, color: T.txt }}>{p.label}</span>
        <span style={{
          background: accent + '18',
          color: accent,
          fontSize: 8,
          fontWeight: 800,
          padding: '3px 7px',
          borderRadius: 6,
        }}>
          {highLev ? 'HIGH LEV' : 'LOW LEV'}
        </span>
        <span style={{
          marginLeft: 'auto',
          background: T.muted + '18',
          color: T.muted,
          fontSize: 8.5,
          fontWeight: 800,
          padding: '3px 7px',
          borderRadius: 6,
        }}>
          성과 검증 전
        </span>
      </div>

      <div style={{ background: T.alt, borderRadius: 10, padding: '9px 10px', marginBottom: 10 }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
          <span style={{ fontSize: 9, color: T.muted, alignSelf: 'center', marginRight: 2 }}>위험 설정</span>
          {(['STABILIZE', 'RESEARCH'] as RiskPresetId[]).map(k => (
            <button key={k} onClick={() => setPreset(k)} style={tab(preset === k)}>
              {PRESET_INFO[k].label}
            </button>
          ))}
        </div>
        <div style={{ fontSize: 9, color: preset === 'RESEARCH' ? T.red : T.muted, lineHeight: 1.5 }}>
          {PRESET_INFO[preset].desc}
          {preset === 'RESEARCH' && ' · 연구용 설정은 실전 권장값이 아닙니다'}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: 6, marginBottom: 7 }}>
        {chip('레버리지', `${p.leverage}~${p.maxLeverage}x`, withinBand(ov.leverageBand, p.maxLeverage) ? accent : T.red)}
        {chip('자산비중', `${p.maxPortfolioPct}%`)}
        {chip('1회위험', `${p.riskPercentPerTrade}%`, withinBand(ov.riskBand, p.riskPercentPerTrade) ? T.txt : T.red)}
        {chip('마진', p.marginModes.join('/'))}
        {chip('익절', p.takeProfitPct == null ? '고정 없음' : `${p.takeProfitPct}%`)}
        {chip('손절', p.stopLossPct == null ? '고정 없음' : `${p.stopLossPct}%`)}
        {chip('주문', p.orderType === 'post_only_limit' ? 'PostOnly' : p.orderType === 'limit' ? '지정가' : '시장가')}
        {chip('일손실한도', `${p.dailyLossLimitPct}%`, withinBand(ov.dailyLossBand, p.dailyLossLimitPct) ? T.txt : T.red)}
      </div>

      <div style={{ fontSize: 8.5, color: T.muted, lineHeight: 1.5, marginBottom: 10 }}>
        {[
          ov.leverageBand ? `배율 ${bandText(ov.leverageBand, p.maxLeverage, '배')}` : '',
          ov.riskBand ? `1회 위험 ${bandText(ov.riskBand, p.riskPercentPerTrade, '%')}` : '',
          ov.dailyLossBand ? `하루 한도 ${bandText(ov.dailyLossBand, p.dailyLossLimitPct, '%')}` : '',
          mddStop != null ? `낙폭 ${mddStop}%면 중단` : '',
        ].filter(Boolean).join(' · ') || '연구용 리스크 계약'}
      </div>

      <div style={{
        border: `1px solid ${T.border}`,
        borderRadius: 10,
        padding: 10,
        marginBottom: 10,
      }}>
        <div style={{ color: T.txt, fontSize: 10.5, fontWeight: 800, marginBottom: 7 }}>
          검증 증거
        </div>
        {EVIDENCE.map((e, i) => (
          <div key={e.label} style={{
            display: 'flex',
            gap: 8,
            alignItems: 'flex-start',
            padding: '7px 0',
            borderTop: i ? `1px solid ${T.border}` : 'none',
          }}>
            <span style={{
              flexShrink: 0,
              marginTop: 2,
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: T.muted,
            }} />
            <div style={{ minWidth: 0 }}>
              <div style={{ color: T.sub, fontSize: 9.5, fontWeight: 750 }}>{e.label} · 미연결</div>
              <div style={{ color: T.muted, fontSize: 8.5, lineHeight: 1.45, marginTop: 2 }}>{e.desc}</div>
            </div>
          </div>
        ))}
        <div style={{
          marginTop: 7,
          background: T.ylw + '10',
          borderRadius: 8,
          padding: '7px 8px',
          color: T.ylw,
          fontSize: 8.5,
          lineHeight: 1.5,
        }}>
          이 증거가 없는 동안 승률·수익률·목표달성률을 지어내서 표시하지 않습니다.
        </div>
      </div>

      {legacyRounds > 0 || legacyTrades > 0 ? (
        <div style={{
          background: T.red + '0E',
          border: `1px solid ${T.red}35`,
          borderRadius: 10,
          padding: 10,
        }}>
          <div style={{ color: T.red, fontSize: 10, fontWeight: 850, marginBottom: 4 }}>
            과거 가정 시뮬 기록
          </div>
          <div style={{ color: T.muted, fontSize: 9, lineHeight: 1.55, marginBottom: 8 }}>
            기존에 임의 승률/우위로 만든 기록입니다. 검증 성과로 사용하지 않습니다.
            현재 저장됨: 독립 {independent.totalRounds}회 · 연속복리 {continuous.totalRounds}회 · 거래 {legacyTrades.toLocaleString('ko-KR')}건.
          </div>
          {armClear ? (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button onClick={clearLegacy} style={{
                minHeight: 38, padding: '0 12px', borderRadius: 8, border: 'none',
                background: T.red, color: '#fff', fontSize: 10, fontWeight: 850, cursor: 'pointer',
              }}>
                정말 전체 삭제 · 현재 회차도 1회차로
              </button>
              <button onClick={() => setArmClear(false)} style={{
                minHeight: 38, padding: '0 12px', borderRadius: 8,
                border: `1px solid ${T.border}`, background: T.card,
                color: T.muted, fontSize: 10, fontWeight: 800, cursor: 'pointer',
              }}>
                취소
              </button>
            </div>
          ) : (
            <button onClick={() => setArmClear(true)} style={{
              minHeight: 38, padding: '0 12px', borderRadius: 8,
              border: `1px solid ${T.red}`, background: 'transparent',
              color: T.red, fontSize: 10, fontWeight: 850, cursor: 'pointer',
            }}>
              가정 시뮬 기록 전체 초기화
            </button>
          )}
        </div>
      ) : (
        <div style={{ color: T.muted, fontSize: 9 }}>
          가정 시뮬 기록 없음
        </div>
      )}

      <div style={{ fontSize: 9, color: T.muted, marginTop: 9, lineHeight: 1.55 }}>
        {p.description}
      </div>
    </div>
  );
}
