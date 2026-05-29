'use client';
import { useEffect, useRef, useState } from 'react';

// 자동 API 헬스체크 — 주기적으로 provider 상태 확인 + 죽으면 상단 알림
const CHECK_INTERVAL_MS = 3 * 60 * 1000;   // 3분

interface DownProvider { nameKr: string; detail: string; status: string; }

export default function ApiHealthMonitor() {
  const [down, setDown] = useState<DownProvider[]>([]);
  const [dismissed, setDismissed] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const check = async () => {
    try {
      const r = await fetch('/api/providers/healthcheck');
      const d = await r.json();
      const providers = Array.isArray(d.providers) ? d.providers : [];
      // error 상태이면서 미설정(unconfigured)이 아닌 것만 = 실제 장애
      const broken = providers
        .filter((p: any) => p.status === 'error')
        .map((p: any) => ({ nameKr: p.nameKr || p.name, detail: p.detail, status: p.status }));
      setDown(broken);
      if (broken.length > 0) setDismissed(false);   // 새 장애 발생 시 다시 표시
    } catch { /* 무시 */ }
  };

  useEffect(() => {
    // 첫 체크는 10초 후 (초기 로딩 방해 안 함)
    const initial = setTimeout(check, 10_000);
    timer.current = setInterval(check, CHECK_INTERVAL_MS);
    return () => { clearTimeout(initial); if (timer.current) clearInterval(timer.current); };
  }, []);

  if (down.length === 0 || dismissed) return null;

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, zIndex: 2000,
      background: '#7F1D1D', borderBottom: '1px solid #EF4444',
      padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 8,
      boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
    }}>
      <span style={{ fontSize: 14 }}>⚠️</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ color: '#FCA5A5', fontSize: 11, fontWeight: 800 }}>
          {down.length === 1 ? `${down[0].nameKr} 연결 실패` : `${down.length}개 데이터 제공사 연결 실패`}
        </div>
        <div style={{ color: '#FECACA', fontSize: 9, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {down.map(d => d.nameKr).join(', ')} · 일부 데이터가 백업 소스로 전환됩니다
        </div>
      </div>
      <button onClick={check}
        style={{ background: 'rgba(255,255,255,0.15)', color: '#fff', border: 'none', borderRadius: 6, padding: '4px 10px', minHeight: 28, fontSize: 9, fontWeight: 700, cursor: 'pointer', flexShrink: 0 }}>
        재확인
      </button>
      <button onClick={() => setDismissed(true)}
        style={{ background: 'transparent', color: '#FCA5A5', border: 'none', fontSize: 16, cursor: 'pointer', flexShrink: 0, lineHeight: 1, padding: '0 4px' }}>
        ✕
      </button>
    </div>
  );
}
