'use client';
// AiDcaPanel — 공포지수 기반 스마트 적립. 평소 소액, 공포일수록 증액.
import React, { useState, useEffect } from 'react';
import { T } from '@/lib/constants';
import { cvt } from '@/lib/utils';
import { Brain, TrendingDown, Check } from 'lucide-react';
import { notifySuccess } from '@/lib/notify/center';
import {
  loadAiDcaCfg, saveAiDcaCfg, tierForFng, computeBuyAmount, FREQ_LABEL,
  DEFAULT_TIERS, type AiDcaConfig,
} from '@/lib/dca/aiDca';

export default function AiDcaPanel({ currency = 'KRW' }: { currency?: string }) {
  const [cfg, setCfg] = useState<AiDcaConfig>(loadAiDcaCfg());
  const [fng, setFng] = useState<number | null>(null);
  const [fngLabel, setFngLabel] = useState('');
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);

  useEffect(() => { setCfg(loadAiDcaCfg()); }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch('/api/feargreed', { cache: 'no-store' });
        const d = await r.json();
        const v = d?.crypto?.value ?? d?.value ?? 50;
        if (alive) { setFng(v); setFngLabel(d?.crypto?.label || d?.label || ''); }
      } catch { if (alive) setFng(50); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, []);

  const curFng = fng ?? 50;
  const tier = tierForFng(curFng, cfg.tiers);
  const buyAmount = computeBuyAmount(cfg.baseAmount, curFng, cfg.tiers);

  const setBase = (v: number) => { setCfg(c => ({ ...c, baseAmount: Math.max(1000, v) })); setSaved(false); };
  const save = () => { saveAiDcaCfg(cfg); setSaved(true); notifySuccess('AI DCA 설정 저장됨', `${FREQ_LABEL[cfg.frequency]} 기본 ${cvt(cfg.baseAmount, currency)} · 공포지수 연동`); setTimeout(() => setSaved(false), 1800); };

  return (
    <div style={{ background: 'linear-gradient(145deg,#0D1A35,#091228)', border: `1px solid ${T.border2}`, borderRadius: 18, padding: '16px 16px 18px', marginBottom: 16 }}>
      {/* 헤더 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 14 }}>
        <div style={{ width: 36, height: 36, borderRadius: 10, background: '#8B5CF625', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Brain size={19} color="#A78BFA" />
        </div>
        <div>
          <div style={{ color: T.txt, fontWeight: 800, fontSize: 15 }}>AI 스마트 DCA</div>
          <div style={{ color: T.muted, fontSize: 11 }}>공포일수록 더 사고, 탐욕일수록 덜 산다</div>
        </div>
      </div>

      {/* 현재 F&G + 이번 회차 매수액 */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
        <div style={{ flex: 1, background: T.card, borderRadius: 12, padding: '12px 14px' }}>
          <div style={{ color: T.muted, fontSize: 10, marginBottom: 4 }}>현재 공포·탐욕 지수</div>
          {loading ? <div style={{ color: T.muted, fontSize: 13 }}>로딩…</div> : (
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
              <span style={{ color: tier.color, fontSize: 24, fontWeight: 900 }}>{curFng}</span>
              <span style={{ color: tier.color, fontSize: 11, fontWeight: 700 }}>{tier.label}</span>
            </div>
          )}
        </div>
        <div style={{ flex: 1, background: tier.color + '18', borderRadius: 12, padding: '12px 14px', border: `1px solid ${tier.color}40` }}>
          <div style={{ color: T.muted, fontSize: 10, marginBottom: 4 }}>이번 회차 매수액</div>
          <div style={{ color: tier.color, fontSize: 20, fontWeight: 900, fontFamily: 'Inter,monospace' }}>{cvt(buyAmount, currency)}</div>
          <div style={{ color: T.muted, fontSize: 9, marginTop: 2 }}>기본 × {tier.mult}배</div>
        </div>
      </div>

      {/* 기본 적립액 */}
      <div style={{ background: T.card, borderRadius: 12, padding: '12px 14px', marginBottom: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <span style={{ color: T.muted, fontSize: 12 }}>기본 적립액 (중립 기준)</span>
          <span style={{ color: T.txt, fontWeight: 800, fontSize: 14 }}>{cvt(cfg.baseAmount, currency)}</span>
        </div>
        <input type="range" min={10000} max={1000000} step={10000} value={cfg.baseAmount}
          onChange={e => setBase(Number(e.target.value))} style={{ width: '100%', accentColor: '#A78BFA' }} />
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          {(['daily', 'weekly', 'monthly'] as const).map(fq => (
            <button key={fq} onClick={() => { setCfg(c => ({ ...c, frequency: fq })); setSaved(false); }}
              style={{ flex: 1, background: cfg.frequency === fq ? '#8B5CF6' : T.alt, color: cfg.frequency === fq ? '#fff' : T.muted, border: 'none', borderRadius: 8, padding: '8px', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>
              {FREQ_LABEL[fq]}
            </button>
          ))}
        </div>
      </div>

      {/* 배수 구간 시각화 */}
      <div style={{ background: T.card, borderRadius: 12, padding: '12px 14px', marginBottom: 12 }}>
        <div style={{ color: T.muted, fontSize: 11, fontWeight: 700, marginBottom: 10 }}>공포지수별 매수 배수</div>
        {DEFAULT_TIERS.map((t, i) => {
          const active = tier.label === t.label;
          const lo = i === 0 ? 0 : DEFAULT_TIERS[i - 1].max + 1;
          return (
            <div key={t.label} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', opacity: active ? 1 : 0.6 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: t.color, flexShrink: 0 }} />
              <span style={{ color: T.txt, fontSize: 12, fontWeight: active ? 800 : 500, width: 78, flexShrink: 0 }}>{t.label}</span>
              <span style={{ color: T.muted, fontSize: 10, width: 50, flexShrink: 0 }}>{lo}–{t.max}</span>
              <div style={{ flex: 1, height: 6, background: T.alt, borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${Math.min(100, t.mult / 3 * 100)}%`, background: t.color }} />
              </div>
              <span style={{ color: t.color, fontSize: 12, fontWeight: 800, width: 40, textAlign: 'right' }}>{t.mult}×</span>
              {active && <Check size={14} color={t.color} style={{ flexShrink: 0 }} />}
            </div>
          );
        })}
      </div>

      <button onClick={save}
        style={{ width: '100%', background: `linear-gradient(135deg,#8B5CF6,#6D28D9)`, color: '#fff', border: 'none', borderRadius: 12, padding: '14px', fontWeight: 800, fontSize: 14, cursor: 'pointer' }}>
        {saved ? '저장됨 ✓' : 'AI DCA 설정 저장'}
      </button>

      <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginTop: 10 }}>
        <TrendingDown size={13} color={T.muted} style={{ flexShrink: 0, marginTop: 1 }} />
        <span style={{ color: T.muted, fontSize: 10, lineHeight: 1.5 }}>
          역발상 전략: 남들이 공포에 팔 때 더 사고, 탐욕에 살 때 덜 삽니다. F&G 지수는 실시간(alternative.me) 기준이며, 실제 매수는 모의매매로 검증 후 진행하세요.
        </span>
      </div>
    </div>
  );
}
