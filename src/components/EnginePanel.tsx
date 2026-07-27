'use client';
// EnginePanel — 백엔드 실행 엔진 시각화. Signal Gateway → Risk Manager → Execution.
import React, { useState, useMemo } from 'react';
import { T } from '@/lib/constants';
import { Server, ArrowDown, ShieldCheck, Cpu, CheckCircle2, AlertTriangle } from 'lucide-react';
import { validateSignal } from '@/lib/engine/signalGateway';
import { planPosition } from '@/lib/engine/riskManager';
import { resolvePositions, detectConflicts, type PositionMode } from '@/lib/engine/executionEngine';

const DEMO_SIGNAL = { strategyId: 'btc-scalping-01', symbol: 'BTCUSDT', signal: 'LONG', confidence: 0.82, entryPrice: 65000, stopLoss: 64740, takeProfit: 66300, timeframe: '5m', timestamp: Date.now() };

export default function EnginePanel() {
  const [equity, setEquity] = useState(10000);
  const [maxLev, setMaxLev] = useState(50);
  const [mode, setMode] = useState<PositionMode>('net');

  const validation = useMemo(() => validateSignal(DEMO_SIGNAL), []);
  const plan = useMemo(() => validation.valid ? planPosition(validation.signal!, { accountEquity: equity, maxLeverage: maxLev, riskPerTradePct: 0.5 }) : null, [validation, equity, maxLev]);

  // 데모 다중 전략 (넷/헤지/격리 시연)
  const orders = useMemo(() => [
    { strategyId: 'longterm-01', bucket: 'longterm', symbol: 'BTCUSDT', side: 'LONG' as const, positionSize: 10000, leverage: 2 },
    { strategyId: 'scalp-01', bucket: 'scalping', symbol: 'BTCUSDT', side: 'SHORT' as const, positionSize: 1000, leverage: 5 },
  ], []);
  const resolved = useMemo(() => resolvePositions(orders, mode), [orders, mode]);
  const conflicts = useMemo(() => detectConflicts(orders, equity), [orders, equity]);

  const Stage = ({ icon: Icon, title, color, children }: any) => (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: '13px', marginBottom: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <div style={{ width: 28, height: 28, borderRadius: 7, background: color + '20', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon size={15} color={color} /></div>
        <span style={{ color: T.txt, fontSize: 13, fontWeight: 800 }}>{title}</span>
      </div>
      {children}
    </div>
  );

  return (
    <div style={{ background: 'linear-gradient(145deg,#0D1A35,#091228)', border: `1px solid ${T.border2}`, borderRadius: 18, padding: '16px', marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 6 }}>
        <div style={{ width: 34, height: 34, borderRadius: 9, background: '#0EA5E91F', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Server size={18} color="#38BDF8" />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ color: T.txt, fontWeight: 800, fontSize: 15 }}>실행 엔진 (백엔드)</div>
          <div style={{ color: T.muted, fontSize: 11 }}>신호 → 검증 → 위험 → 실행 파이프라인</div>
        </div>
      </div>
      <div style={{ color: T.muted, fontSize: 10, marginBottom: 14, lineHeight: 1.4 }}>파인스크립트는 신호만 보냅니다. 주문 크기·레버리지는 백엔드가 위험 기준으로 결정합니다.</div>

      {/* Stage 1: Signal Gateway */}
      <Stage icon={ShieldCheck} title="① Signal Gateway" color="#0EA5E9">
        <div style={{ fontFamily: 'monospace', fontSize: 10.5, background: T.alt, borderRadius: 8, padding: '9px 11px', color: T.sub, lineHeight: 1.6, marginBottom: 8 }}>
          {`{ "signal": "LONG", "confidence": 0.82,`}<br/>
          {`  "entryPrice": 65000, "stopLoss": 64740,`}<br/>
          {`  "timeframe": "5m" }`}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <CheckCircle2 size={13} color={T.grn} />
          <span style={{ color: T.grn, fontSize: 11.5, fontWeight: 700 }}>검증 통과</span>
          <span style={{ color: T.muted, fontSize: 10 }}>· 전략군: {validation.signal?.bucket}</span>
        </div>
      </Stage>
      <div style={{ display: 'flex', justifyContent: 'center', padding: '2px 0' }}><ArrowDown size={14} color={T.muted} /></div>

      {/* Stage 2: Risk Manager */}
      <Stage icon={Cpu} title="② Portfolio Risk Manager" color="#F59E0B">
        <div style={{ color: T.muted, fontSize: 10.5, marginBottom: 8 }}>레버리지가 아니라 <b style={{ color: T.sub }}>계좌 위험을 먼저</b> 정하고 배율을 역산합니다.</div>
        {plan && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 7 }}>
            {[
              ['허용 손실', `$${plan.riskAmount.toFixed(0)} (0.5%)`, T.red],
              ['손절 거리', `${plan.stopDistancePct.toFixed(2)}%`, T.sub],
              ['포지션 크기', `$${plan.positionSize.toFixed(0)}`, T.txt],
              ['역산 레버리지', `${plan.leverage}배`, T.acl],
              ['필요 증거금', `$${plan.requiredMargin.toFixed(0)}`, T.sub],
              ['청산까지', `${plan.liquidationDistancePct.toFixed(1)}%`, plan.liquidationDistancePct < 5 ? T.red : T.grn],
            ].map(([l, v, c]) => (
              <div key={l as string} style={{ background: T.alt, borderRadius: 8, padding: '7px 10px' }}>
                <div style={{ color: T.muted, fontSize: 9 }}>{l}</div>
                <div style={{ color: c as string, fontSize: 13, fontWeight: 800 }}>{v}</div>
              </div>
            ))}
          </div>
        )}
      </Stage>
      <div style={{ display: 'flex', justifyContent: 'center', padding: '2px 0' }}><ArrowDown size={14} color={T.muted} /></div>

      {/* Stage 3: Execution */}
      <Stage icon={Server} title="③ Execution Engine" color="#22C55E">
        <div style={{ display: 'flex', gap: 5, marginBottom: 10 }}>
          {(['net', 'hedge', 'isolation'] as const).map(m => (
            <button key={m} onClick={() => setMode(m)}
              style={{ flex: 1, padding: '6px 4px', background: mode === m ? T.acg : T.alt, color: mode === m ? T.acl : T.muted, border: `1px solid ${mode === m ? T.acl : T.border}`, borderRadius: 7, fontSize: 10.5, fontWeight: 700, cursor: 'pointer' }}>
              {m === 'net' ? '넷' : m === 'hedge' ? '헤지' : '격리'}
            </button>
          ))}
        </div>
        <div style={{ color: T.muted, fontSize: 9.5, marginBottom: 8 }}>
          예시: 장투 BTC 롱 $10,000 + 초단타 BTC 숏 $1,000
        </div>
        {resolved.map((r, i) => (
          <div key={i} style={{ background: T.alt, borderRadius: 8, padding: '9px 11px', marginBottom: 6 }}>
            <span style={{ color: T.sub, fontSize: 11.5, lineHeight: 1.4 }}>{r.note}</span>
          </div>
        ))}
        {conflicts.length > 0 && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', background: '#F59E0B12', borderRadius: 8, padding: '8px 10px', marginTop: 4 }}>
            <AlertTriangle size={12} color="#F59E0B" style={{ flexShrink: 0, marginTop: 1 }} />
            <span style={{ color: T.sub, fontSize: 10.5, lineHeight: 1.4 }}>{conflicts[0].detail}</span>
          </div>
        )}
      </Stage>

      {/* 컨트롤 */}
      <div style={{ background: T.card, borderRadius: 10, padding: '11px 13px', marginTop: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
          <span style={{ color: T.muted, fontSize: 10.5 }}>계좌 자산</span>
          <span style={{ color: T.txt, fontSize: 11.5, fontWeight: 700 }}>${equity.toLocaleString()}</span>
        </div>
        <input type="range" min={1000} max={100000} step={1000} value={equity} onChange={e => setEquity(Number(e.target.value))} style={{ width: '100%', accentColor: '#38BDF8', marginBottom: 8 }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
          <span style={{ color: T.muted, fontSize: 10.5 }}>레버리지 상한 (사용자 설정)</span>
          <span style={{ color: T.txt, fontSize: 11.5, fontWeight: 700 }}>{maxLev}배</span>
        </div>
        <input type="range" min={1} max={50} step={1} value={maxLev} onChange={e => setMaxLev(Number(e.target.value))} style={{ width: '100%', accentColor: '#38BDF8' }} />
      </div>

      <div style={{ color: T.muted, fontSize: 10, lineHeight: 1.5, marginTop: 10 }}>
        초보자 기본값은 넷 모드, 전문 사용자는 전략 격리 모드를 권장합니다. 각 전략군은 독립된 위험 예산(초단타 0.1~0.3%, 스윙 0.5~1.0%)으로 운영됩니다.
      </div>
    </div>
  );
}
