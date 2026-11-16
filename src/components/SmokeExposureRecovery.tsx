'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { T } from '@/lib/constants';

type Candidate = { id: string; symbol: string; canObserve: boolean; attested: boolean; firstObservedAt: string | null };

export default function SmokeExposureRecovery({ auth, connectionId }: { auth: string; connectionId: string }) {
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const generation = useRef(0);
  const load = useCallback(async (signal: AbortSignal, epoch = generation.current) => {
    const response = await fetch(`/api/autotrade/smoke-test/attest-exposure?connectionId=${encodeURIComponent(connectionId)}`,
      { headers: { Authorization: auth }, signal, cache: 'no-store' });
    const data = await response.json();
    if (signal.aborted || epoch !== generation.current) return;
    if (!response.ok || data.ok !== true || !Array.isArray(data.candidates)) throw new Error(data.code || '목록 조회 실패');
    setCandidates(data.candidates);
    if (data.truncated) setMessage('기록이 많아 일부만 표시됩니다. 추가 확인이 필요합니다.');
  }, [auth, connectionId]);

  useEffect(() => {
    generation.current += 1;
    const controller = new AbortController();
    setCandidates(null); setMessage(''); setBusy(false);
    if (auth && connectionId) void load(controller.signal).catch(error => {
      if (!controller.signal.aborted) setMessage(`확인 목록을 읽지 못했습니다: ${error.message}`);
    });
    return () => { generation.current += 1; controller.abort(); };
  }, [auth, connectionId, load]);

  const observe = async (id: string) => {
    const epoch = generation.current;
    setBusy(true); setMessage('거래소 잔여 노출 확인 중…');
    try {
      const response = await fetch('/api/autotrade/smoke-test/attest-exposure', {
        method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ testId: id }),
      });
      const data = await response.json();
      if (epoch !== generation.current) return;
      if (!response.ok || data.ok !== true) throw new Error(data.reason || data.code || '확인 실패');
      setMessage(data.phase === 'COMPLETED'
        ? '두 번의 잔여 노출 확인이 저장됐습니다. 새 테스트는 진입 전 다시 점검합니다.'
        : data.phase === 'FIRST' || data.phase === 'WAITING'
          ? `첫 확인이 저장됐습니다. ${Math.max(1, Math.ceil(Number(data.nextCheckInMs) / 60000))}분 후 한 번 더 확인해 주세요.`
          : `잔여 노출을 확인하지 못했습니다: ${data.reason}`);
      await load(new AbortController().signal, epoch);
    } catch (error) {
      if (epoch === generation.current) setMessage(`확인 실패: ${error instanceof Error ? error.message : String(error)}`);
    } finally { if (epoch === generation.current) setBusy(false); }
  };

  if (!auth || !connectionId) return null;
  return <section data-testid="smoke-exposure-recovery" aria-label="이전 테스트 잔여 노출 확인"
    style={{ marginTop: 12, padding: 12, border: `1px solid ${T.border}`, borderRadius: 10, color: T.txt }}>
    <h3 style={{ fontSize: 14, margin: '0 0 8px' }}>이전 테스트 잔여 노출 확인</h3>
    <p style={{ fontSize: 12, color: T.muted }}>포지션·일반 주문·조건부 주문을 두 번 확인합니다. 첫 확인 후 10분이 지나면 한 번 더 눌러 주세요. 확인 기록은 화면을 닫아도 보관됩니다.</p>
    {candidates === null && !message && <p>확인 목록을 읽는 중…</p>}
    {candidates?.length === 0 && !message && <p>확인이 필요한 미확인 기록이 없습니다.</p>}
    {candidates?.map(candidate => <div key={candidate.id} style={{ marginTop: 8 }}>
      <span>{candidate.symbol} · {candidate.attested ? '두 번 확인 완료' : candidate.firstObservedAt ? '첫 확인 기록 있음' : '미확인'}</span>
      {candidate.canObserve ? <button type="button" disabled={busy} onClick={() => void observe(candidate.id)}
        style={{ minHeight: 44, marginLeft: 8, padding: '8px 12px', borderRadius: 8 }}>
        {busy ? '확인 중…' : candidate.attested ? '다시 확인' : '잔여 노출 확인'}
      </button> : <p>실패가 기록되어 별도 복구가 필요합니다.</p>}
    </div>)}
    {message && <p role="status" style={{ fontSize: 12 }}>{message}</p>}
  </section>;
}
