'use client';
import { A } from '@/lib/theme/colors';
// DerivativesPanel — 파생시장 실데이터 (펀딩비 + 미결제약정).
// 5v5의 파생 축이 쓰는 데이터를 그대로 보여준다.
import React, { useState, useEffect } from 'react';
import { T } from '@/lib/constants';
import { Activity, TrendingUp, TrendingDown, RefreshCw, AlertCircle } from 'lucide-react';

interface Row {
  symbol: string;
  data: {
    fundingRate: number | null;
    openInterest: number | null;
    openInterestValue: number | null;
    oiChangePct24h: number | null;
    priceChangePct24h: number | null;
    markPrice: number | null;
    source: string;
    error?: string;
  };
  signal: {
    pattern: string;
    patternLabel: string;
    patternMeaning: string;
    longConfirmation: number;
    shortConfirmation: number;
    crowding: string;
    crowdingNote: string;
    reliability: number;
    notes: string[];
  };
}

const PATTERN_COLOR: Record<string, string> = {
  NEW_LONGS: '#22C55E',
  SHORT_COVERING: '#F59E0B',
  NEW_SHORTS: '#EF4444',
  LONG_LIQUIDATION: '#8B5CF6',
  NEUTRAL: '#64748B',
};

export default function DerivativesPanel({ symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'] }: { symbols?: string[] }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = async () => {
    setLoading(true); setError('');
    try {
      const r = await fetch(`/api/derivatives?symbols=${symbols.join(',')}`, { cache: 'no-store' });
      const d = await r.json();
      if (d?.results) setRows(d.results);
      if (!d?.ok) setError(d?.note || '데이터를 가져오지 못했습니다');
    } catch (e: any) {
      setError(e?.message || '조회 실패');
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const fmtOi = (v: number | null) => {
    if (v == null) return '—';
    if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
    if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
    return `$${v.toFixed(0)}`;
  };

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 16, padding: '16px', marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 6 }}>
        <div style={{ width: 34, height: 34, borderRadius: 9, background: '#0EA5E920', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Activity size={18} color="#38BDF8" />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ color: T.txt, fontWeight: 800, fontSize: 15 }}>파생시장 데이터</div>
          <div style={{ color: T.muted, fontSize: 11 }}>펀딩비 + 미결제약정 (5v5 파생 축)</div>
        </div>
        <button onClick={load} disabled={loading}
          style={{ minHeight: 34, padding: '0 12px', background: T.alt, color: T.sub, border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 11, fontWeight: 700, cursor: loading ? 'wait' : 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}>
          <RefreshCw size={12} /> {loading ? '조회중' : '새로고침'}
        </button>
      </div>
      <div style={{ color: T.muted, fontSize: 10, marginBottom: 12, lineHeight: 1.45 }}>
        OI와 가격의 조합은 각각 다른 의미를 갖습니다. 이 축은 방향을 결정하지 않고 다른 축의 판단을 지지·반박하는 확인 지표로만 쓰입니다.
      </div>

      {error && (
        <div style={{ display: 'flex', gap: 7, alignItems: 'flex-start', background: A(T.ylw,'12'), borderRadius: 9, padding: '9px 11px', marginBottom: 10 }}>
          <AlertCircle size={13} color={T.ylw} style={{ flexShrink: 0, marginTop: 1 }} />
          <span style={{ color: T.sub, fontSize: 10.5, lineHeight: 1.4 }}>{error}</span>
        </div>
      )}

      {rows?.map(r => {
        const c = PATTERN_COLOR[r.signal.pattern] || T.muted;
        const open = expanded === r.symbol;
        const longWins = r.signal.longConfirmation > r.signal.shortConfirmation;
        return (
          <div key={r.symbol} style={{ background: T.alt, borderRadius: 12, padding: '12px', marginBottom: 8, border: `1px solid ${c}25` }}>
            <button onClick={() => setExpanded(open ? null : r.symbol)}
              style={{ width: '100%', background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 9 }}>
                <span style={{ color: T.txt, fontSize: 13.5, fontWeight: 800 }}>{r.symbol.replace('USDT', '')}</span>
                <span style={{ background: c + '20', color: c, fontSize: 10, fontWeight: 800, padding: '3px 8px', borderRadius: 5 }}>
                  {r.signal.patternLabel}
                </span>
                <span style={{ marginLeft: 'auto', color: T.muted, fontSize: 9.5 }}>신뢰도 {r.signal.reliability}%</span>
              </div>

              {/* 확인 지표 바 */}
              <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', marginBottom: 6 }}>
                <div style={{ width: `${r.signal.longConfirmation}%`, background: T.grn }} />
                <div style={{ width: `${r.signal.shortConfirmation}%`, background: T.red }} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, marginBottom: 9 }}>
                <span style={{ color: longWins ? T.grn : T.muted, fontWeight: longWins ? 700 : 400 }}>
                  LONG 지지 {r.signal.longConfirmation.toFixed(0)}
                </span>
                <span style={{ color: !longWins ? T.red : T.muted, fontWeight: !longWins ? 700 : 400 }}>
                  SHORT 지지 {r.signal.shortConfirmation.toFixed(0)}
                </span>
              </div>

              {/* 핵심 수치 */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
                {[
                  ['펀딩비', r.data.fundingRate != null ? `${r.data.fundingRate >= 0 ? '+' : ''}${r.data.fundingRate.toFixed(4)}%` : '—',
                    r.data.fundingRate == null ? T.muted : Math.abs(r.data.fundingRate) > 0.05 ? T.red : T.sub],
                  ['OI 24h', r.data.oiChangePct24h != null ? `${r.data.oiChangePct24h >= 0 ? '+' : ''}${r.data.oiChangePct24h.toFixed(1)}%` : '—',
                    r.data.oiChangePct24h == null ? T.muted : r.data.oiChangePct24h > 0 ? T.grn : T.red],
                  ['가격 24h', r.data.priceChangePct24h != null ? `${r.data.priceChangePct24h >= 0 ? '+' : ''}${r.data.priceChangePct24h.toFixed(1)}%` : '—',
                    r.data.priceChangePct24h == null ? T.muted : r.data.priceChangePct24h > 0 ? T.grn : T.red],
                ].map(([l, v, col]) => (
                  <div key={l as string} style={{ background: T.card, borderRadius: 7, padding: '6px 8px' }}>
                    <div style={{ color: T.muted, fontSize: 8.5 }}>{l}</div>
                    <div style={{ color: col as string, fontSize: 12, fontWeight: 800 }}>{v}</div>
                  </div>
                ))}
              </div>
            </button>

            {open && (
              <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${T.border}` }}>
                <div style={{ color: T.sub, fontSize: 11, lineHeight: 1.5, marginBottom: 7 }}>{r.signal.patternMeaning}</div>
                <div style={{ color: T.muted, fontSize: 10.5, marginBottom: 7 }}>{r.signal.crowdingNote}</div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: T.muted }}>
                  <span>미결제약정 {fmtOi(r.data.openInterestValue)}</span>
                  <span>출처 {r.data.source}</span>
                </div>
                {r.signal.notes.map((n, i) => (
                  <div key={i} style={{ display: 'flex', gap: 5, marginTop: 5 }}>
                    <span style={{ width: 3, height: 3, borderRadius: '50%', background: T.muted, flexShrink: 0, marginTop: 6 }} />
                    <span style={{ color: T.muted, fontSize: 10, lineHeight: 1.4 }}>{n}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {!rows && !loading && (
        <div style={{ color: T.muted, fontSize: 11.5, textAlign: 'center', padding: '14px 0' }}>
          데이터를 불러오는 중입니다…
        </div>
      )}

      <div style={{ background: T.alt, borderRadius: 9, padding: '10px 12px', marginTop: 4 }}>
        <div style={{ color: T.muted, fontSize: 9.5, lineHeight: 1.6 }}>
          <b style={{ color: T.sub }}>가격↑ OI↑</b> 신규 롱 유입 — 건전한 상승 ·
          <b style={{ color: T.sub }}> 가격↑ OI↓</b> 숏 커버링 — 연료 소진<br />
          <b style={{ color: T.sub }}>가격↓ OI↑</b> 신규 숏 유입 — 하락 지속 ·
          <b style={{ color: T.sub }}> 가격↓ OI↓</b> 롱 청산 — 바닥 가능성
        </div>
      </div>
    </div>
  );
}
