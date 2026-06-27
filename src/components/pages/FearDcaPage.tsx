'use client';
import React, { useState, useEffect, useCallback } from 'react';
import { T } from '@/lib/constants';
import { Card } from './SharedUI';
import { TrendingDown, Info } from 'lucide-react';
import { DEFAULT_FEAR_DCA, evaluateFearDca, getDcaState, type FearDcaConfig } from '@/lib/strategies/fearDca';

const CFG_KEY = 'tg_fear_dca_cfg_v1';

export default function FearDcaPage() {
  const [cfg, setCfg] = useState<FearDcaConfig>(DEFAULT_FEAR_DCA);
  const [fng, setFng] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    try { const r = localStorage.getItem(CFG_KEY); if (r) setCfg({ ...DEFAULT_FEAR_DCA, ...JSON.parse(r) }); } catch {}
    fetch('/api/feargreed').then(r => r.json()).then(d => setFng(d)).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const update = useCallback((patch: Partial<FearDcaConfig>) => {
    setCfg(prev => { const next = { ...prev, ...patch }; try { localStorage.setItem(CFG_KEY, JSON.stringify(next)); } catch {} return next; });
  }, []);

  const fngVal = fng?.crypto?.value ?? 50;
  const decision = evaluateFearDca(cfg, fngVal, 1);
  const st = typeof window !== 'undefined' ? getDcaState(cfg.asset) : { invested: 0, buyCount: 0 };

  const zoneColor = fngVal <= 20 ? T.red : fngVal <= 40 ? T.ylw : fngVal <= 60 ? T.muted : fngVal <= 80 ? T.acl : T.grn;
  const zoneLabel = fngVal <= 20 ? '극단적 공포' : fngVal <= 40 ? '공포' : fngVal <= 60 ? '중립' : fngVal <= 80 ? '탐욕' : '극단적 탐욕';

  return (
    <div style={{ padding: '4px 0 20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <TrendingDown size={20} strokeWidth={2.2} color={T.red} />
        <span style={{ color: T.txt, fontWeight: 900, fontSize: 19 }}>공포 DCA 봇</span>
      </div>
      <div style={{ color: T.muted, fontSize: 12, marginBottom: 14 }}>시장이 극단적 공포일 때만 기계적으로 분할매수</div>

      {/* 현재 F&G */}
      <Card style={{ padding: 18, marginBottom: 12, borderLeft: `3px solid ${zoneColor}` }}>
        {loading ? <div style={{ color: T.muted, fontSize: 13, textAlign: 'center', padding: 12 }}>공포·탐욕 지수 로딩…</div> : (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
              <span style={{ color: T.muted, fontSize: 11, fontWeight: 700 }}>현재 공포·탐욕 지수</span>
              <span style={{ color: zoneColor, fontWeight: 900, fontSize: 13 }}>{zoneLabel}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
              <span style={{ color: zoneColor, fontSize: 38, fontWeight: 900, fontFamily: 'monospace' }}>{fngVal}</span>
              <span style={{ color: T.muted, fontSize: 12 }}>/ 100</span>
            </div>
            <div style={{ height: 8, background: T.alt, borderRadius: 4, overflow: 'hidden', position: 'relative' }}>
              <div style={{ position: 'absolute', left: `${fngVal}%`, top: -2, width: 3, height: 12, background: '#fff', borderRadius: 2 }} />
              <div style={{ height: '100%', width: '100%', background: 'linear-gradient(90deg,#EF4444,#F59E0B,#94A3B8,#60A5FA,#10B981)' }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
              <span style={{ color: T.red, fontSize: 8 }}>공포</span>
              <span style={{ color: T.grn, fontSize: 8 }}>탐욕</span>
            </div>
          </>
        )}
      </Card>

      {/* 현재 판단 */}
      <Card style={{ padding: 16, marginBottom: 12, background: decision.action === 'buy' ? T.grn + '12' : decision.action === 'exit' ? T.acl + '12' : T.card }}>
        <div style={{ color: T.muted, fontSize: 10, fontWeight: 700, marginBottom: 4 }}>봇 현재 판단</div>
        <div style={{ color: decision.action === 'buy' ? T.grn : decision.action === 'exit' ? T.acl : decision.action === 'blocked' ? T.ylw : T.muted, fontWeight: 800, fontSize: 14, marginBottom: 2 }}>
          {decision.action === 'buy' ? '분할매수 신호' : decision.action === 'exit' ? '🔵 청산 신호' : decision.action === 'blocked' ? '매수 제한' : '대기'}
        </div>
        <div style={{ color: T.sub, fontSize: 11, lineHeight: 1.5 }}>{decision.reason}</div>
        <div style={{ marginTop: 8, display: 'flex', gap: 12, fontSize: 10, color: T.muted }}>
          <span>투입률 <b style={{ color: T.txt }}>{(decision.investedPct ?? 0).toFixed(0)}%</b> / {cfg.maxInvestPct}%</span>
          <span>매수 <b style={{ color: T.txt }}>{st.buyCount}</b>회</span>
        </div>
      </Card>

      {/* 설정 */}
      <Card style={{ padding: 16, marginBottom: 12 }}>
        <div style={{ color: T.txt, fontWeight: 700, fontSize: 13, marginBottom: 12 }}>전략 설정</div>

        <Field label="대상 자산">
          <input value={cfg.asset} onChange={e => update({ asset: e.target.value.toUpperCase() })}
            style={inp} placeholder="BTC" />
        </Field>

        {[
          { k: 'buyPerTime', l: '1회 매수금액 (원)', step: 5000 },
          { k: 'totalSeed', l: '전체 시드 (원)', step: 100000 },
        ].map(f => (
          <Field key={f.k} label={f.l}>
            <input type="number" value={(cfg as any)[f.k]} step={f.step}
              onChange={e => update({ [f.k]: parseFloat(e.target.value) || 0 } as any)} style={inp} />
          </Field>
        ))}

        {[
          { k: 'maxInvestPct', l: '최대 투입비율 (%)', min: 10, max: 100, step: 5 },
          { k: 'cooldownDays', l: '쿨타임 (일)', min: 1, max: 30, step: 1 },
          { k: 'fearThreshold', l: '공포 매수 기준 (F&G ≤)', min: 5, max: 40, step: 5 },
          { k: 'greedExit', l: '탐욕 청산 기준 (F&G ≥)', min: 50, max: 90, step: 5 },
        ].map(f => (
          <Field key={f.k} label={`${f.l}: ${(cfg as any)[f.k]}`}>
            <input type="range" min={f.min} max={f.max} step={f.step} value={(cfg as any)[f.k]}
              onChange={e => update({ [f.k]: parseFloat(e.target.value) } as any)}
              style={{ width: '100%', accentColor: T.acl }} />
          </Field>
        ))}

        {/* 선물 토글 */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, padding: '10px 12px', background: T.alt, borderRadius: 10 }}>
          <div>
            <div style={{ color: T.txt, fontSize: 12, fontWeight: 700 }}>선물 사용</div>
            <div style={{ color: T.muted, fontSize: 9 }}>DCA는 현물 권장 — 선물은 물타다 청산 위험</div>
          </div>
          <button onClick={() => update({ useFutures: !cfg.useFutures })}
            style={{ width: 44, height: 26, borderRadius: 13, border: 'none', cursor: 'pointer', background: cfg.useFutures ? T.red : T.muted, position: 'relative' }}>
            <span style={{ position: 'absolute', top: 3, left: cfg.useFutures ? 21 : 3, width: 20, height: 20, borderRadius: '50%', background: '#fff', transition: 'left .2s' }} />
          </button>
        </div>
      </Card>

      {/* 안내 */}
      <div style={{ display: 'flex', gap: 8, padding: '12px 14px', background: T.acl + '10', border: `1px solid ${T.acl}25`, borderRadius: 12 }}>
        <Info size={16} color={T.acl} style={{ flexShrink: 0, marginTop: 1 }} />
        <div style={{ color: T.sub, fontSize: 11, lineHeight: 1.6 }}>
          <b style={{ color: T.acl }}>공포 DCA란?</b> 시장이 극단적 공포일 때(F&G ≤ {cfg.fearThreshold}) 남들이 팔 때 분할매수하는 전략입니다.
          쿨타임·최대 투입비율로 한 번에 다 넣는 것을 방지합니다. 백테스트·모의매매로 충분히 검증 후 사용하세요.
        </div>
      </div>
    </div>
  );
}

const inp: React.CSSProperties = { width: '100%', background: T.alt, border: `1px solid ${T.border}`, borderRadius: 8, padding: '10px 12px', color: T.txt, fontSize: 13, outline: 'none' };
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div style={{ marginBottom: 12 }}><div style={{ color: T.muted, fontSize: 10, fontWeight: 700, marginBottom: 4 }}>{label}</div>{children}</div>;
}
