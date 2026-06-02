'use client';
import React, { useState, useEffect, useCallback } from 'react';
import { T } from '@/lib/constants';
import { Card } from './SharedUI';

interface DiagResult {
  id:        string;
  name:      string;
  category:  string;
  hasKey:    boolean;
  status:    'live' | 'mock' | 'error' | 'disabled';
  latencyMs: number;
  testedAt:  string;
  error?:    string;
  sample?:   string;
}

interface DiagResponse {
  summary: { total:number; live:number; disabled:number; error:number; avgLatencyMs:number };
  providers: DiagResult[];
  testedAt: string;
}

const STATUS_COLOR: Record<string,string> = {
  live:     '#10B981',
  mock:     '#F59E0B',
  error:    '#EF4444',
  disabled: '#64748B',
};

const STATUS_LABEL: Record<string,string> = {
  live:     '✅ 연결됨',
  mock:     '🔶 MOCK',
  error:    '❌ 오류',
  disabled: '비활성',
};

const CATEGORY_ICON: Record<string,string> = {
  market: '📈', news: '📰', fx: '💱', ai: '🤖', misc: '🗄️', database: '🗄️',
};

export default function DiagnosticsPage() {
  const [data, setData]       = useState<DiagResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [toast, setToast]     = useState('');

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 2500);
  }, []);

  useEffect(() => {
    setLoading(true);
    fetch('/api/diagnostics')
      .then(r => r.json())
      .then((d: DiagResponse) => { setData(d); })
      .catch(e => {
        console.error('[Diagnostics]', e);
        setData(null);
        showToast('진단 호출 실패');
      })
      .finally(() => setLoading(false));
  }, [refreshKey, showToast]);

  const refresh = useCallback(() => {
    setRefreshKey(k => k + 1);
    showToast('진단 재실행 중…');
  }, [showToast]);

  const testOne = useCallback(async (provider: DiagResult) => {
    showToast(`${provider.name} 테스트 중…`);
    // Re-run full diagnostics (simpler than per-provider endpoint)
    setTimeout(refresh, 300);
  }, [refresh, showToast]);

  const providers = Array.isArray(data?.providers) ? data!.providers : [];
  const summary   = data?.summary;

  return (
    <div style={{ paddingBottom: 100 }}>
      {/* Toast */}
      {toast && (
        <div style={{ position:'fixed', top: 16, left:'50%', transform:'translateX(-50%)',
          background: T.acl, color:'#fff', padding:'10px 18px', borderRadius: 12,
          fontSize: 13, fontWeight: 700, zIndex: 999 }}>
          {toast}
        </div>
      )}

      {/* Header */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom: 14 }}>
        <div>
          <div style={{ fontWeight: 900, fontSize: 17, color: T.txt }}>API 진단</div>
          <div style={{ color: T.muted, fontSize: 10 }}>외부 데이터 제공사 연결 상태</div>
        </div>
        <button type="button" onClick={refresh} disabled={loading}
          style={{ padding:'8px 14px', minHeight: 36, background: T.acg,
            border:`1px solid ${T.acl}40`, borderRadius: 10, color: T.acl,
            fontWeight: 700, fontSize: 12, cursor: loading ? 'wait' : 'pointer',
            opacity: loading ? 0.6 : 1 }}>
          {loading ? '⏳' : '🔄'} 재실행
        </button>
      </div>

      {/* Summary */}
      {summary && (
        <Card style={{ marginBottom: 10 }}>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap: 8 }}>
            {[
              { label:'전체',  value: String(summary.total),    color: T.txt },
              { label:'LIVE',  value: String(summary.live),     color: STATUS_COLOR.live },
              { label:'오류',  value: String(summary.error),    color: STATUS_COLOR.error },
              { label:'비활성',value: String(summary.disabled), color: STATUS_COLOR.disabled },
            ].map(s => (
              <div key={s.label} style={{ textAlign:'center', padding:'8px 4px',
                background: T.alt, borderRadius: 10 }}>
                <div style={{ color: T.muted, fontSize: 9, marginBottom: 2 }}>{s.label}</div>
                <div style={{ color: s.color, fontSize: 20, fontWeight: 900 }}>{s.value}</div>
              </div>
            ))}
          </div>
          <div style={{ color: T.muted, fontSize: 10, marginTop: 10, textAlign:'center' }}>
            평균 응답 속도: <strong style={{ color: T.txt }}>{summary.avgLatencyMs}ms</strong>
            {data?.testedAt && (
              <span style={{ marginLeft: 8 }}>
                · 마지막 테스트: {new Date(data.testedAt).toLocaleString('ko-KR', { hour:'2-digit', minute:'2-digit', second:'2-digit' })}
              </span>
            )}
          </div>
        </Card>
      )}

      {/* Loading state */}
      {loading && providers.length === 0 && (
        <Card>
          <div style={{ textAlign:'center', color: T.muted, padding:'30px 0', fontSize: 13 }}>
            ⏳ API 연결 상태 확인 중…
          </div>
        </Card>
      )}

      {/* Provider cards */}
      {providers.map(p => {
        const color = STATUS_COLOR[p.status] || T.muted;
        return (
          <Card key={p.id} style={{ marginBottom: 8, borderLeft: `3px solid ${color}` }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display:'flex', alignItems:'center', gap: 6, marginBottom: 3 }}>
                  <span style={{ fontSize: 16 }}>{CATEGORY_ICON[p.category] || '📡'}</span>
                  <span style={{ color: T.txt, fontWeight: 700, fontSize: 13 }}>{p.name}</span>
                </div>
                <div style={{ display:'flex', gap: 6, marginBottom: 4 }}>
                  <span style={{
                    background: color + '20', color, borderRadius: 5,
                    padding:'2px 7px', fontSize: 9, fontWeight: 700,
                  }}>
                    {STATUS_LABEL[p.status]}
                  </span>
                  <span style={{ color: T.muted, fontSize: 9 }}>
                    {p.hasKey ? '키 등록됨' : '🔓 키 없음'}
                  </span>
                </div>
                {p.sample && (
                  <div style={{ color: T.acl, fontSize: 11, fontFamily:'monospace', marginTop: 2 }}>
                    {p.sample}
                  </div>
                )}
                {p.error && (
                  <div style={{ color: T.red, fontSize: 10, marginTop: 4,
                    background: T.red+'10', padding:'4px 8px', borderRadius: 6 }}>
                    ⚠️ {p.error}
                  </div>
                )}
              </div>
              <div style={{ textAlign:'right', flexShrink: 0 }}>
                <div style={{ color: T.txt, fontSize: 13, fontWeight: 700, fontFamily:'monospace' }}>
                  {p.latencyMs > 0 ? `${p.latencyMs}ms` : '-'}
                </div>
                <div style={{ color: T.muted, fontSize: 8, marginTop: 2 }}>
                  응답속도
                </div>
              </div>
            </div>

            {/* Test button */}
            <button type="button" onClick={() => testOne(p)}
              style={{ width:'100%', padding:'8px', background: T.alt,
                border:`1px solid ${T.border}`, borderRadius: 8,
                color: T.muted, fontWeight: 700, fontSize: 11,
                cursor:'pointer', minHeight: 36 }}>
              🔬 테스트 호출
            </button>
          </Card>
        );
      })}

      {/* Help */}
      <Card style={{ marginTop: 10, background: T.alt, border:'none' }}>
        <div style={{ color: T.txt, fontWeight: 700, fontSize: 12, marginBottom: 6 }}>💡 안내</div>
        <ul style={{ color: T.muted, fontSize: 10, lineHeight: 1.7,
          paddingLeft: 18, margin: 0 }}>
          <li>비활성 표시: Vercel Environment Variables에 해당 키를 추가하면 활성화됩니다</li>
          <li>응답 속도가 1000ms 이상이면 네트워크/지역 이슈일 수 있습니다</li>
          <li>오류 상태가 지속되면 키가 만료되었거나 호출 한도 초과일 수 있습니다</li>
          <li>Binance와 ExchangeRate-API는 무료/공개 API라 키 없이도 작동합니다</li>
        </ul>
      </Card>
    </div>
  );
}
