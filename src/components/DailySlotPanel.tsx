'use client';
import { A } from '@/lib/theme/colors';
// DailySlotPanel — DAILY_HIGH_LEV 10슬롯 격리 전략.
// 슬롯 현황 + 배율 역산 + 100배 스트레스 테스트를 한 화면에서 보여준다.
import React, { useState, useMemo } from 'react';
import { T } from '@/lib/constants';
import { Layers, ShieldAlert, Lock, TrendingDown, Info } from 'lucide-react';
import { maxSafeLeverage, runStressTest, type StressCandle } from '@/lib/backtest/stressTest';
import { ACCOUNT_CEILING, DEFAULT_SLOT_COUNT } from '@/lib/strategies/slotManager';

function demoCandles(n: number, seed = 7): StressCandle[] {
  const out: StressCandle[] = []; let p = 65000; let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  for (let i = 0; i < n; i++) {
    const r = (rnd() - 0.5) * 0.003 + 0.00002;
    const open = p, close = p * (1 + r), wick = 0.0009 * rnd();
    out.push({ t: i, open, high: Math.max(open, close) * (1 + wick), low: Math.min(open, close) * (1 - wick), close });
    p = close;
  }
  return out;
}

export default function DailySlotPanel() {
  const [equity, setEquity] = useState(7000);
  const [stopPct, setStopPct] = useState(0.5);
  const [requestedLev, setRequestedLev] = useState(100);

  const slotSize = equity / DEFAULT_SLOT_COUNT;
  const protectedBalance = equity - slotSize;
  const enabled = equity <= ACCOUNT_CEILING;

  const safeLev = useMemo(() => maxSafeLeverage(stopPct), [stopPct]);
  const actualLev = Math.min(requestedLev, safeLev);
  const clamped = requestedLev > safeLev;

  const stress = useMemo(() => {
    const cs = demoCandles(3000);
    const signals = Array.from({ length: 30 }, (_, i) => i * 90);
    return runStressTest(cs, signals, {
      leverage: actualLev, marginPerTrade: slotSize, stopLossPct: stopPct, takeProfitPct: stopPct * 3,
    });
  }, [actualLev, slotSize, stopPct]);

  const liqColor = stress.liquidationRate >= 50 ? T.red : stress.liquidationRate >= 20 ? T.ylw : T.grn;

  return (
    <div style={{ background: 'linear-gradient(145deg,var(--t-card),var(--t-bg))', border: `1px solid ${T.border2}`, borderRadius: 18, padding: '16px', marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 6 }}>
        <div style={{ width: 34, height: 34, borderRadius: 9, background: '#F59E0B1F', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Layers size={18} color="#FBBF24" />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ color: T.txt, fontWeight: 800, fontSize: 15 }}>10슬롯 격리 전략</div>
          <div style={{ color: T.muted, fontSize: 11 }}>자산 ÷ 10 = 슬롯 1개 · 슬롯당 하루 1회</div>
        </div>
        <span style={{ background: enabled ? A(T.grn,'20') : A(T.red,'20'), color: enabled ? T.grn : T.red, fontSize: 10, fontWeight: 800, padding: '4px 9px', borderRadius: 6 }}>
          {enabled ? '활성' : '비활성'}
        </span>
      </div>

      {!enabled && (
        <div style={{ background: A(T.red,'12'), border: `1px solid ${A(T.red,'30')}`, borderRadius: 10, padding: '10px 12px', marginBottom: 12 }}>
          <span style={{ color: T.sub, fontSize: 11.5 }}>
            자산이 ${ACCOUNT_CEILING.toLocaleString()}을 넘어 이 전략은 비활성화됩니다. 단타/스윙/장투 배분을 사용하세요.
          </span>
        </div>
      )}

      {/* 자금 격리 구조 */}
      <div style={{ background: T.card, borderRadius: 12, padding: '13px', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
          <Lock size={13} color="#FBBF24" />
          <span style={{ color: T.txt, fontSize: 12, fontWeight: 700 }}>자금 격리 (ISOLATED 강제)</span>
        </div>
        <div style={{ display: 'flex', height: 20, borderRadius: 6, overflow: 'hidden', marginBottom: 8 }}>
          <div style={{ width: '10%', background: '#F59E0B', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ color: '#000', fontSize: 8, fontWeight: 800 }}>1</span>
          </div>
          <div style={{ width: '90%', background: T.border2, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ color: T.muted, fontSize: 9, fontWeight: 700 }}>보호 자금 (9슬롯)</span>
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
          <span style={{ color: '#FBBF24', fontWeight: 700 }}>슬롯 1개 ${slotSize.toFixed(0)}</span>
          <span style={{ color: T.muted }}>보호 ${protectedBalance.toFixed(0)}</span>
        </div>
        <div style={{ color: T.muted, fontSize: 10, marginTop: 6, lineHeight: 1.4 }}>
          Cross 마진은 거부됩니다 — 다른 슬롯 자금이 청산에 끌려가면 격리 구조가 무너집니다.
        </div>
      </div>

      {/* 배율 역산 (핵심) */}
      <div style={{ background: T.card, borderRadius: 12, padding: '13px', marginBottom: 12 }}>
        <div style={{ color: T.txt, fontSize: 12, fontWeight: 700, marginBottom: 10 }}>배율은 손절 거리에서 역산됩니다</div>

        <div style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ color: T.muted, fontSize: 10.5 }}>손절 거리</span>
            <span style={{ color: T.txt, fontSize: 11.5, fontWeight: 700 }}>{stopPct.toFixed(2)}%</span>
          </div>
          <input type="range" min={0.2} max={3} step={0.1} value={stopPct}
            onChange={e => setStopPct(Number(e.target.value))} style={{ width: '100%', accentColor: '#F59E0B' }} />
        </div>

        <div style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ color: T.muted, fontSize: 10.5 }}>요청 배율 (상한 100)</span>
            <span style={{ color: T.txt, fontSize: 11.5, fontWeight: 700 }}>{requestedLev}배</span>
          </div>
          <input type="range" min={1} max={100} step={1} value={requestedLev}
            onChange={e => setRequestedLev(Number(e.target.value))} style={{ width: '100%', accentColor: '#F59E0B' }} />
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1, background: T.alt, borderRadius: 9, padding: '9px 11px' }}>
            <div style={{ color: T.muted, fontSize: 9.5 }}>안전 최대 배율</div>
            <div style={{ color: T.acl, fontSize: 15, fontWeight: 900 }}>{safeLev}배</div>
          </div>
          <div style={{ flex: 1, background: clamped ? A(T.ylw,'15') : T.alt, borderRadius: 9, padding: '9px 11px' }}>
            <div style={{ color: T.muted, fontSize: 9.5 }}>실제 적용</div>
            <div style={{ color: clamped ? T.ylw : T.grn, fontSize: 15, fontWeight: 900 }}>{actualLev}배</div>
          </div>
        </div>
        {clamped && (
          <div style={{ color: T.ylw, fontSize: 10.5, marginTop: 7, lineHeight: 1.4 }}>
            요청 {requestedLev}배는 손절 {stopPct}%에서 청산이 손절보다 먼저 옵니다 → {actualLev}배로 낮춤
          </div>
        )}
      </div>

      {/* 스트레스 테스트 */}
      <div style={{ background: T.card, borderRadius: 12, padding: '13px', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
          <TrendingDown size={13} color={liqColor} />
          <span style={{ color: T.txt, fontSize: 12, fontWeight: 700 }}>스트레스 테스트 (캔들 내부 청산 반영)</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 7, marginBottom: 10 }}>
          {[
            ['청산률', `${stress.liquidationRate.toFixed(0)}%`, liqColor],
            ['승률', `${stress.winRate.toFixed(0)}%`, T.sub],
            ['순손익', `$${stress.totalNetPnl.toFixed(0)}`, stress.totalNetPnl >= 0 ? T.grn : T.red],
            ['최대 연속손실', `${stress.maxConsecutiveLosses}회`, T.sub],
          ].map(([l, v, c]) => (
            <div key={l as string} style={{ background: T.alt, borderRadius: 8, padding: '8px 10px' }}>
              <div style={{ color: T.muted, fontSize: 9 }}>{l}</div>
              <div style={{ color: c as string, fontSize: 14, fontWeight: 800 }}>{v}</div>
            </div>
          ))}
        </div>
        <div style={{ background: liqColor + '10', borderRadius: 8, padding: '9px 11px', marginBottom: 8 }}>
          <span style={{ color: T.sub, fontSize: 11, lineHeight: 1.45 }}>{stress.verdict}</span>
        </div>
        {stress.overstatement > 0 && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
            <Info size={11} color={T.muted} style={{ flexShrink: 0, marginTop: 2 }} />
            <span style={{ color: T.muted, fontSize: 10, lineHeight: 1.4 }}>
              캔들 내부 청산을 무시하면 ${stress.overstatement.toFixed(0)} 부풀려집니다. 일반 백테스트는 이 손실을 못 봅니다.
            </span>
          </div>
        )}
      </div>

      {/* 자산 슬라이더 */}
      <div style={{ background: T.card, borderRadius: 10, padding: '11px 13px', marginBottom: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
          <span style={{ color: T.muted, fontSize: 10.5 }}>계좌 자산</span>
          <span style={{ color: T.txt, fontSize: 11.5, fontWeight: 700 }}>${equity.toLocaleString()}</span>
        </div>
        <input type="range" min={500} max={15000} step={500} value={equity}
          onChange={e => setEquity(Number(e.target.value))} style={{ width: '100%', accentColor: '#F59E0B' }} />
      </div>

      <div style={{ display: 'flex', gap: 7, alignItems: 'flex-start', background: '#F59E0B10', borderRadius: 10, padding: '11px 13px' }}>
        <ShieldAlert size={14} color="#F59E0B" style={{ flexShrink: 0, marginTop: 1 }} />
        <span style={{ color: T.sub, fontSize: 10.5, lineHeight: 1.5 }}>
          슬롯 10개를 모두 잃으면 이 전략에 배정한 자금 전체가 소진됩니다. 일일 손실 한도와 연속 손실 제한을 함께 설정하세요.
          슬롯 기록은 DB에 저장되어 서버가 재시작해도 하루 제한이 유지됩니다.
        </span>
      </div>
    </div>
  );
}
