'use client';
// src/components/auto/KillSwitchSheet.tsx
//
// **전체 정지는 버튼 모양의 문제가 아니다.**
//
// 두 가지를 동시에 지켜야 한다:
//
//   1. 실수로 눌리지 않을 것 — 급하지 않을 때 잘못 누르면 멀쩡한
//      포지션이 나간다
//   2. 정말 정지됐는지 확인할 것 — 급할 때 누른 사람은 응답 문구를
//      읽고 손을 뗀다
//
// 그래서 누르면 바로 실행되지 않고, 밀어야 나간다. 그리고 **서버가
// 확인해 준 것만** 완료라고 적는다.
//
// 여기서 서버 로직을 새로 만들지 않는다
// ─────────────────────────────────────
// 취소·종료·잔여 확인은 전부 `/api/risk/kill-switch/trigger`가 한다.
// 이 판은 그 응답을 그리기만 한다 — 화면이 자기 판단으로 "정지됨"을
// 적으면, 서버가 절반만 했을 때 그 사실이 사라진다.
import React, { useState } from 'react';
import { T } from '@/lib/constants';
import { A } from '@/lib/theme/colors';
import AutoSheet from './AutoSheet';

/** 밀어서 확정. 슬라이더가 끝까지 가야 나간다 */
function SlideToStop(props: { disabled: boolean; onConfirm: () => void }) {
  const [v, setV] = useState(0);
  return (
    <div style={{ marginTop: 14 }}>
      <input
        type="range" min={0} max={100} value={v} disabled={props.disabled}
        onChange={e => {
          const n = Number(e.target.value);
          setV(n);
          if (n >= 100) { setV(0); props.onConfirm(); }
        }}
        // 끝까지 안 갔으면 되돌린다 — 반쯤 밀어 놓고 손을 떼는 것은
        // 확정이 아니다.
        onPointerUp={() => { if (v < 100) setV(0); }}
        onKeyUp={() => { if (v < 100) setV(0); }}
        aria-label="밀어서 전체 정지"
        style={{ width: '100%', minHeight: 44, accentColor: T.red, cursor: props.disabled ? 'default' : 'pointer' }}
      />
      <div style={{ color: T.red, fontSize: 11, fontWeight: 800, textAlign: 'center' }}>
        {props.disabled ? '정지 요청 중…' : '━━━━━ 밀어서 전체 정지 ━━━━━'}
      </div>
    </div>
  );
}

export default function KillSwitchSheet(props: {
  open: boolean;
  auth: string;
  connectionId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<any>(null);

  const fire = async () => {
    if (!props.connectionId) {
      setRes({ ok: false, message: '거래소 연결을 먼저 고르세요 — 어느 계좌를 정지할지 알 수 없습니다' });
      return;
    }
    setBusy(true); setRes(null);
    try {
      const r = await fetch('/api/risk/kill-switch/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: props.auth },
        body: JSON.stringify({ connectionId: props.connectionId, reason: '사용자 전체 정지' }),
      });
      const j = await r.json().catch(() => null);
      // **HTTP 200만으로 성공이라고 적지 않는다.** 서버가 `ok`로 말한다.
      setRes(j ?? { ok: false, message: `응답을 읽지 못했습니다 (${r.status})` });
      props.onDone();
    } catch (e: any) {
      setRes({ ok: false, message: `요청이 닿지 않았습니다 — ${e?.message || e}` });
    } finally { setBusy(false); }
  };

  const missing: string[] = Array.isArray(res?.missing) ? res.missing : [];

  return (
    <AutoSheet open={props.open} title="전체 자동매매 정지" onClose={props.onClose}>
      {!res && (
        <>
          <div style={{ color: T.txt, fontWeight: 800, fontSize: 13, marginBottom: 10 }}>
            전체 자동매매를 정지할까요?
          </div>
          {/* **무엇이 일어나는지 먼저 말한다.** 단계별 정의는 서버의
              emergencyLevel이 갖고 있고, 이 판은 기본 동작만 적는다 —
              화면이 없는 동작을 약속하지 않는다. */}
          <ul style={{ color: T.muted, fontSize: 11.5, lineHeight: 1.85, paddingLeft: 18, margin: 0 }}>
            <li>신규 주문을 막습니다</li>
            <li>실행 중인 예약을 멈춥니다</li>
            <li>거래소의 미체결 주문을 취소합니다</li>
            <li>
              열린 포지션 처리는 <b style={{ color: T.txt }}>저장된 단계 설정</b>을 따릅니다 —
              기본 설정은 포지션을 닫지 않습니다
            </li>
          </ul>
          <div style={{
            marginTop: 12, padding: '9px 11px', borderRadius: 10,
            background: A(T.ylw, '12'), border: `1px solid ${A(T.ylw, '35')}`,
            color: T.ylw, fontSize: 11, fontWeight: 700, lineHeight: 1.6,
          }}>
            정지 결과는 <b>거래소에 다시 물어서</b> 확인합니다. 확인되지 않으면
            완료라고 적지 않습니다.
          </div>
          <SlideToStop disabled={busy} onConfirm={fire} />
          <button
            onClick={props.onClose}
            style={{
              width: '100%', minHeight: 44, marginTop: 10, cursor: 'pointer',
              background: 'transparent', color: T.muted,
              border: `1px solid ${T.border}`, borderRadius: 10, fontSize: 12, fontWeight: 700,
            }}
          >취소</button>
        </>
      )}

      {res && (
        <div>
          <div style={{
            padding: '11px 12px', borderRadius: 10,
            background: A(res.ok ? T.grn : T.red, '12'),
            border: `1px solid ${A(res.ok ? T.grn : T.red, '38')}`,
            color: res.ok ? T.grn : T.red, fontSize: 12.5, fontWeight: 800, lineHeight: 1.6,
          }}>
            {/* **서버가 ok라고 했을 때만 완료다.** */}
            {res.ok ? '✓ ' : '⚠ '}{String(res.message || (res.ok ? '정지 완료' : '정지가 완료되지 않았습니다'))}
          </div>

          {missing.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div style={{ color: T.muted, fontSize: 10.5, fontWeight: 800, marginBottom: 4 }}>
                아직 확인되지 않은 것
              </div>
              {missing.map((m, i) => (
                <div key={i} style={{ color: T.txt, fontSize: 11, lineHeight: 1.6 }}>· {m}</div>
              ))}
            </div>
          )}

          {res.leftover && (
            <div style={{ marginTop: 10, color: T.muted, fontSize: 10.5, lineHeight: 1.6 }}>
              거래소 잔여: {String(res.leftover.reason || '확인 결과 없음')}
            </div>
          )}

          <button
            onClick={props.onClose}
            style={{
              width: '100%', minHeight: 44, marginTop: 14, cursor: 'pointer',
              background: 'transparent', color: T.muted,
              border: `1px solid ${T.border}`, borderRadius: 10, fontSize: 12, fontWeight: 700,
            }}
          >닫기</button>
        </div>
      )}
    </AutoSheet>
  );
}
