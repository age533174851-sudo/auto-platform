'use client';
// AutoStatusBoard — 자동매매가 실제로 무엇이 도는지 한눈에.
// MOCK(브라우저 로컬) / Worker(Railway) / AI 판단 상태를 표시.
import React, { useState, useEffect, useCallback } from 'react';
import { T } from '@/lib/constants';
import { Bot, Server, Sparkles, RefreshCw } from 'lucide-react';
import { readMockHeartbeat } from '@/lib/engineStatus';

type Health = 'running' | 'degraded' | 'stopped' | 'absent' | 'loading';

const COLOR: Record<Health, string> = {
  running: '#22C55E', degraded: '#F59E0B', stopped: '#EF4444', absent: '#64748B', loading: '#64748B',
};
const LABEL: Record<Health, string> = {
  running: '정상', degraded: '지연', stopped: '중단', absent: '없음', loading: '확인 중',
};

function ago(ms: number): string {
  if (!ms) return '-';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}초 전`;
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  return `${Math.floor(s / 3600)}시간 전`;
}

export default function AutoStatusBoard({ authHeader }: { authHeader?: string }) {
  const [mock, setMock] = useState(readMockHeartbeat());
  const [worker, setWorker] = useState<any>({ status: 'loading', label: '확인 중' });
  const [refreshing, setRefreshing] = useState(false);

  const fetchWorker = useCallback(async () => {
    setRefreshing(true);
    try {
      const r = await fetch('/api/worker/status', { headers: authHeader ? { Authorization: authHeader } : {}, cache: 'no-store' });
      const d = await r.json();
      setWorker(d.present ? d : { status: d.status || 'absent', label: d.label || '워커 없음', present: false });
    } catch {
      setWorker({ status: 'absent', label: '조회 실패', present: false });
    } finally { setRefreshing(false); }
  }, [authHeader]);

  useEffect(() => {
    const tick = () => setMock(readMockHeartbeat());
    tick(); fetchWorker();
    const t1 = setInterval(tick, 2000);
    const t2 = setInterval(fetchWorker, 15000);
    return () => { clearInterval(t1); clearInterval(t2); };
  }, [fetchWorker]);

  // MOCK 엔진 상태 판정: 최근 10초 내 heartbeat 있으면 running
  const mockFresh = mock.running && mock.at > 0 && Date.now() - mock.at < 12000;
  const mockHealth: Health = mockFresh ? 'running' : mock.running ? 'degraded' : 'stopped';
  const workerHealth: Health = (worker.status as Health) || 'absent';

  const Row = ({ icon: Icon, iconColor, title, health, detail, sub }: any) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 4px', borderBottom: `1px solid ${T.border}` }}>
      <div style={{ width: 38, height: 38, borderRadius: 10, background: iconColor + '1A', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <Icon size={19} color={iconColor} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{ color: T.txt, fontWeight: 700, fontSize: 13 }}>{title}</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: COLOR[health] + '20', color: COLOR[health], fontSize: 10, fontWeight: 800, padding: '2px 7px', borderRadius: 5 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: COLOR[health] }} />{LABEL[health]}
          </span>
        </div>
        <div style={{ color: T.muted, fontSize: 11, marginTop: 3 }}>{detail}</div>
        {sub && <div style={{ color: T.muted, fontSize: 10, marginTop: 2 }}>{sub}</div>}
      </div>
    </div>
  );

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 16, padding: '14px 16px', marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ color: T.txt, fontWeight: 800, fontSize: 14 }}>자동매매 시스템 상태</span>
        <button onClick={fetchWorker} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, display: 'flex' }}>
          <RefreshCw size={15} color={T.muted} style={refreshing ? { animation: 'tg-spin 0.8s linear infinite' } : undefined} />
        </button>
      </div>
      <style>{`@keyframes tg-spin{to{transform:rotate(360deg)}}`}</style>

      {/* MOCK 엔진 (브라우저 로컬) */}
      <Row icon={Bot} iconColor="#8B5CF6" title="MOCK 엔진 (브라우저)" health={mockHealth}
        detail={mockFresh ? `실행 중 · ${mock.intervalSec}초 주기 · 마지막 체크 ${ago(mock.at)}` : mock.running ? '백그라운드 지연 (탭 비활성 가능)' : '정지 · 모의투자 화면에서 시작'}
        sub={mockFresh && mock.lastDecision ? `판단: ${mock.lastDecision}` : undefined} />

      {/* Worker (Railway) */}
      <Row icon={Server} iconColor="#0EA5E9" title="Worker (Railway)" health={workerHealth}
        detail={worker.present ? `${worker.task || '-'} · 최근 ${worker.ageSec != null ? worker.ageSec + '초 전' : '-'}` : (worker.label || '연결 없음')}
        sub={worker.present && worker.errorCount != null ? `오류 ${worker.errorCount}건 · ${worker.workerId || ''}` : '실전/테스트넷 상시 실행은 Worker 필요'} />

      {/* AI 판단 */}
      <Row icon={Sparkles} iconColor="#F59E0B" title="AI 판단 엔진"
        health={mockFresh ? 'running' : 'stopped'}
        detail={mock.lastDecision ? `${mock.marketState || '-'} · 신뢰도 ${mock.confidence ?? '-'}%` : '대기 · 자동매매 시작 시 판단 표시'}
        sub={mock.openPositions != null ? `활성 포지션 ${mock.openPositions}개` : undefined} />

      <div style={{ color: T.muted, fontSize: 10, marginTop: 10, lineHeight: 1.5 }}>
        MOCK은 브라우저에서 즉시 동작하고, 실전/테스트넷 상시 자동매매는 Railway Worker가 담당합니다.
      </div>
    </div>
  );
}
