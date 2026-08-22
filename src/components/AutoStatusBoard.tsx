'use client';
// AutoStatusBoard — 자동매매가 실제로 무엇이 도는지 한눈에.
//
// **이 판이 거짓말을 하고 있었다.**
//
// 2026-08-19 실측: main = Vercel = Fly = 3c46151, deployment MATCHED,
// Fly Worker alive. 그런데 이 화면은 이렇게 말했다:
//
//   "Worker (Railway) · 없음"
//   "지금은 쓰지 않습니다 — 자동매매는 Vercel 크론이 돌립니다"
//   "Railway 워커는 Binance 지역 차단으로 쓰지 않습니다"
//
// 셋 다 예전에는 사실이었고 지금은 아니다. 그래서 더 위험하다 —
// 화면이 자신 있게 틀린 말을 하고, 사용자는 살아 있는 워커를 없다고
// 읽는다. 디자인 문제가 아니라 **제품이 거짓 상태를 표시한 오류**다.
//
// 그래서 이제 이 파일은 운영 사실을 **한 글자도 직접 쓰지 않는다.**
// 공급자 이름도, 판정도, 문장도 전부 서버 값에서 `autoRuntimeView`가
// 만든다. 화면은 그리기만 한다.
import React, { useState, useEffect, useCallback } from 'react';
import { T } from '@/lib/constants';
import { Bot, Server, Sparkles, RefreshCw } from 'lucide-react';
import { readMockHeartbeat } from '@/lib/engineStatus';
import { autoRuntimeView, runtimeContradictions, type Tone } from '@/lib/engine/autoRuntimeView';

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
  // 배포가 어긋나면 워커가 살아 있어도 **다른 코드**가 돈다. 그건
  // '정상'이라고 적을 수 있는 상태가 아니라서 같이 읽는다.
  const [deploy, setDeploy] = useState<any>(null);
  const [refreshing, setRefreshing] = useState(false);

  const fetchWorker = useCallback(async () => {
    setRefreshing(true);
    try {
      const r = await fetch('/api/worker/status', { headers: authHeader ? { Authorization: authHeader } : {}, cache: 'no-store' });
      const d = await r.json();
      setWorker(d.present ? d : { ...d, status: d.status || 'absent', present: false });
    } catch {
      // **조회 실패는 '없음'이 아니다.** 없다고 적으면 사람이 엉뚱한
      // 곳(워커 배포)을 고치러 간다.
      setWorker({ status: 'unknown', readFailed: true, present: false });
    }
    try {
      const dr = await fetch('/api/system/deployment', { cache: 'no-store' });
      const dj = await dr.json();
      setDeploy({
        code: dj?.verdict?.code ?? dj?.skew?.code ?? null,
        webSha: dj?.vercel?.sha ?? null, workerSha: dj?.fly?.sha ?? null,
        // **어느 배포에서 보고 있는가.** Preview에 운영 Worker가 없는 것을
        // 장애로 그리지 않으려면 이 값이 필요하다.
        env: dj?.deployEnv ?? null,
      });
    } catch { setDeploy(null); }
    setRefreshing(false);
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

  // **여기가 이 파일의 전부다.** 판정도 문장도 서버 값에서 나온다.
  const rt = autoRuntimeView({ worker, deployment: deploy, deployEnv: deploy?.env ?? null });
  const contradictions = runtimeContradictions({
    autoRunning: null, scheduleEnabled: null, worker, deployment: deploy,
    deployEnv: deploy?.env ?? null,
  });
  const TONE_COLOR: Record<Tone, string> = {
    GREEN: '#22C55E', YELLOW: '#F59E0B', RED: '#EF4444', GRAY: '#64748B',
  };

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

      {/* 실행기 — 이름·판정·문장 전부 서버 값에서 온다 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 4px', borderBottom: `1px solid ${T.border}` }}>
        <div style={{ width: 38, height: 38, borderRadius: 10, background: TONE_COLOR[rt.tone] + '1A', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <Server size={19} color={TONE_COLOR[rt.tone]} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
            <span style={{ color: T.txt, fontWeight: 700, fontSize: 13 }}>{rt.title}</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: TONE_COLOR[rt.tone] + '20', color: TONE_COLOR[rt.tone], fontSize: 10, fontWeight: 800, padding: '2px 7px', borderRadius: 5 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: TONE_COLOR[rt.tone] }} />
              {rt.canRun ? '실행 가능' : '실행 불가'}
            </span>
          </div>
          <div style={{ color: T.muted, fontSize: 11, marginTop: 3, overflowWrap: 'anywhere' }}>{rt.detail}</div>
          {rt.sub && <div style={{ color: T.muted, fontSize: 10, marginTop: 2, overflowWrap: 'anywhere' }}>{rt.sub}</div>}
          {rt.action && (
            <div style={{ color: TONE_COLOR[rt.tone], fontSize: 10, marginTop: 3, fontWeight: 700, overflowWrap: 'anywhere' }}>{rt.action}</div>
          )}
        </div>
      </div>

      {/* AI 판단 */}
      <Row icon={Sparkles} iconColor="#F59E0B" title="AI 판단 엔진"
        health={mockFresh ? 'running' : 'stopped'}
        detail={mock.lastDecision ? `${mock.marketState || '-'} · 신뢰도 ${mock.confidence ?? '-'}%` : '대기 · 자동매매 시작 시 판단 표시'}
        sub={mock.openPositions != null ? `활성 포지션 ${mock.openPositions}개` : undefined} />

      {/* **모순은 숨기지 않고 그대로 보여준다.**
          위에는 '실행 중'인데 아래는 '워커 없음' 같은 화면이 실제로 나왔다.
          사람이 무엇을 믿어야 할지 모르게 두는 것보다, 서로 안 맞는다는
          사실을 화면이 먼저 말하는 편이 낫다. */}
      {contradictions.length > 0 && (
        <div style={{ marginTop: 10, padding: '8px 10px', borderRadius: 8,
          border: `1px solid ${TONE_COLOR.YELLOW}55`, background: TONE_COLOR.YELLOW + '12' }}>
          {contradictions.map(c => (
            <div key={c.code} style={{ color: TONE_COLOR.YELLOW, fontSize: 10.5, lineHeight: 1.55, overflowWrap: 'anywhere' }}>
              {c.message}
            </div>
          ))}
        </div>
      )}

      <div style={{ color: T.muted, fontSize: 10, marginTop: 10, lineHeight: 1.5 }}>
        위 <b style={{ color: T.txt }}>MOCK 엔진</b>은 이 브라우저에서 도는 모의 판이고,
        <b style={{ color: T.txt }}> 실행기</b>는 브라우저를 닫아도 도는 서버 쪽입니다 —
        실제 자동매매·예약 청산·손절 감시가 거기서 돕니다.
      </div>
    </div>
  );
}
