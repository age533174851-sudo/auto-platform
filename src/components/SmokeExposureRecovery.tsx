'use client';

// src/components/SmokeExposureRecovery.tsx
//
// **사용자는 한 번만 누른다.**
//
// 사후 확인은 간격을 둔 관측 두 번이 필요하다. 전에는 두 번째를 사람이
// 눌러야 했고, 화면이 그렇게 적고 있었다 — "첫 확인 후 10분이 지나면 한 번
// 더 눌러 주세요." 그런데 서버는 처음부터 **자동**을 전제로 설계돼 있었다
// (`exposureAttestation.ts`: "확인은 자동이므로 사람이 할 일은 늘지
// 않는다"). 계획기는 있고 화면에 배선이 없던 것이다.
//
// 그 사이에 테스트넷 실주문 검증은 2026-08-15부터 막혀 있었다. 첫 관측은
// 6시간 뒤 만료되므로, 잊고 다음 날 누르면 처음부터 다시였다.
//
// 보내는 판단은 `lib/smoke/attestSchedule.ts` 한 곳에 있다 — 여기에 두면
// 시험을 붙일 수 없고, 되풀이 금지 같은 규칙이 조용히 깨진다.
import { useCallback, useEffect, useRef, useState } from 'react';
import { T } from '@/lib/constants';
import { planAutoAttest, type AttestCandidate } from '@/lib/smoke/attestSchedule';

type Candidate = AttestCandidate & { symbol: string; canObserve: boolean; attested: boolean; firstObservedAt: string | null };

export default function SmokeExposureRecovery({ auth, connectionId }: { auth: string; connectionId: string }) {
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  /** 다음 관측 예정 안내. 사람이 기다릴 것이 없다는 것을 그대로 적는다 */
  const [schedule, setSchedule] = useState('');
  const generation = useRef(0);
  /** 자동으로 이미 보낸 열쇠. **한 첫 관측에 한 번**을 이것이 지킨다 */
  const tried = useRef<Set<string>>(new Set());
  const [nudge, setNudge] = useState(0);

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
    setCandidates(null); setMessage(''); setSchedule(''); setBusy(false);
    // 연결이 바뀌면 다른 계좌다 — 자동 관측 기록도 비운다.
    tried.current = new Set();
    if (auth && connectionId) void load(controller.signal).catch(error => {
      if (!controller.signal.aborted) setMessage(`확인 목록을 읽지 못했습니다: ${error.message}`);
    });
    return () => { generation.current += 1; controller.abort(); };
  }, [auth, connectionId, load]);

  const observe = useCallback(async (id: string, auto = false) => {
    const epoch = generation.current;
    setBusy(true);
    setMessage(auto ? '간격이 찼습니다 — 두 번째 확인을 보내는 중…' : '거래소 잔여 노출 확인 중…');
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
          // **"눌러 주세요"를 적지 않는다.** 이 화면이 보낸다.
          ? `첫 확인이 저장됐습니다. ${Math.max(1, Math.ceil(Number(data.nextCheckInMs) / 60000))}분 뒤에 두 번째 확인을 자동으로 보냅니다.`
          : `잔여 노출을 확인하지 못했습니다: ${data.reason}`);
      await load(new AbortController().signal, epoch);
    } catch (error) {
      if (epoch === generation.current) setMessage(`확인 실패: ${error instanceof Error ? error.message : String(error)}`);
    } finally { if (epoch === generation.current) setBusy(false); }
  }, [auth, load]);

  // ── 두 번째 관측을 스스로 보낸다 ──
  //
  // 판단은 `planAutoAttest`가 한다. 여기는 그 결과를 실행하기만 한다.
  // 첫 관측이 없는 줄은 `IDLE`이므로 **사용자가 시키지 않은 조회가 계좌에
  // 나가지 않는다.**
  useEffect(() => {
    if (!candidates) { setSchedule(''); return; }
    const plan = planAutoAttest({
      nowMs: Date.now(), candidates, tried: tried.current, busy,
    });
    if (plan.action === 'OBSERVE') {
      // 기다리지 않고 먼저 적는다 — 다시 그려지며 두 번 쏘는 것을 막는다.
      tried.current.add(plan.key);
      setSchedule('');
      void observe(plan.testId, true);
      return;
    }
    if (plan.action === 'WAIT') {
      setSchedule(`${plan.reason} 이 화면을 닫아도 기록은 남고, 다시 열면 바로 확인합니다.`);
      const epoch = generation.current;
      const timer = setTimeout(() => {
        if (epoch === generation.current) setNudge(n => n + 1);
      }, plan.delayMs);
      return () => clearTimeout(timer);
    }
    setSchedule('');
  }, [candidates, busy, nudge, observe]);

  if (!auth || !connectionId) return null;
  return <section data-testid="smoke-exposure-recovery" aria-label="이전 테스트 잔여 노출 확인"
    style={{ marginTop: 12, padding: 12, border: `1px solid ${T.border}`, borderRadius: 10, color: T.txt }}>
    <h3 style={{ fontSize: 14, margin: '0 0 8px' }}>이전 테스트 잔여 노출 확인</h3>
    <p style={{ fontSize: 12, color: T.muted }}>포지션·일반 주문·조건부 주문을 간격을 두고 두 번 확인합니다. <b>한 번만 누르면 두 번째는 이 화면이 보냅니다.</b> 확인 기록은 화면을 닫아도 보관됩니다.</p>
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
    {schedule && <p role="status" style={{ fontSize: 12, color: T.muted }}>{schedule}</p>}
  </section>;
}
