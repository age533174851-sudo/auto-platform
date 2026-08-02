'use client';
// src/components/terminal/SystemStatusPanel.tsx
//
// **지금 무엇이 실제로 돌고 있는가.**
//
// 다른 화면들은 설정값을 보여준다 — "오늘 손실 한도 5%", "크론 등록됨".
// 설정값만 보이면 사람은 그것이 돌고 있다고 믿는다.
//
// 이 화면은 설정을 안 보여준다. **마지막으로 실제로 일어난 일**만 본다.
//
// 네 가지를 색이 아니라 모양으로도 구분한다. 색만 다르면 빠르게 훑을 때
// 안 보이고, 색맹인 사용자에게는 아예 구분이 없다.
//
//   ● 정상   ▲ 알아둘 것   ✕ 문제   ? 확인 못 함
import React, { useCallback, useEffect, useState } from 'react';
import { C, FS, ghostBtn } from './theme';
import { useTerminal } from './TerminalContext';

const MARK: Record<string, { glyph: string; color: string; label: string }> = {
  ok:      { glyph: '●', color: C.up,   label: '정상' },
  warn:    { glyph: '▲', color: C.warn, label: '알아둘 것' },
  bad:     { glyph: '✕', color: C.down, label: '문제' },
  // 회색이다. 확인 못 한 것을 노랑으로 그리면 '문제가 있다'로 읽히고,
  // 초록으로 그리면 '괜찮다'로 읽힌다. 둘 다 아니라 '모른다'다.
  unknown: { glyph: '?', color: C.faint, label: '확인 못 함' },
};

export function SystemStatusPanel() {
  const { auth } = useTerminal();
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!auth) { setErr('로그인이 필요합니다'); return; }
    setBusy(true);
    try {
      const r = await fetch('/api/system/status', { headers: { Authorization: auth } });
      const j = await r.json();
      if (!r.ok || !j?.ok) {
        setData(null);
        setErr(j?.error || `조회 실패 (${r.status})`);
        return;
      }
      setErr('');
      setData(j);
    } catch (e: any) {
      setData(null);
      // **못 읽은 것을 '이상 없음'으로 그리지 않는다.** 이 화면이 그러면
      // 이 화면 자체가 없애려는 문제가 된다.
      setErr(`상태를 읽지 못했습니다 — 이상 없다는 뜻이 아닙니다 (${e?.message || e})`);
    } finally { setBusy(false); }
  }, [auth]);

  useEffect(() => { load(); }, [load]);

  if (err) {
    return (
      <div style={{ padding: 14 }}>
        <div style={{
          padding: '10px 12px', borderRadius: 8,
          background: C.warnBg, color: C.warn, fontSize: FS.small, lineHeight: 1.55,
        }}>{err}</div>
        <button onClick={load} style={{ ...ghostBtn(), marginTop: 10, minHeight: 32 }}>다시 시도</button>
      </div>
    );
  }
  if (!data) {
    return <div style={{ padding: 20, textAlign: 'center', color: C.faint, fontSize: FS.small }}>
      {busy ? '확인 중…' : '—'}
    </div>;
  }

  const overall = data.overall || {};
  const items: any[] = Array.isArray(data.items) ? data.items : [];
  const om = MARK[overall.health] ?? MARK.unknown;

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* 한 줄 요약 */}
      <div style={{
        background: C.raised, borderRadius: 9, padding: '12px 13px',
        border: `1px solid ${overall.health === 'ok' ? C.hair : `${om.color}55`}`,
        display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <span style={{ color: om.color, fontSize: 18, fontWeight: 900, lineHeight: 1 }}>{om.glyph}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: C.text, fontSize: FS.body, fontWeight: 800 }}>{overall.text}</div>
          <div style={{ color: C.faint, fontSize: FS.micro, marginTop: 3 }}>
            {data.checkedAt ? `${new Date(data.checkedAt).toLocaleTimeString('ko-KR')} 확인` : ''}
          </div>
        </div>
      </div>

      {/* 항목 */}
      <div>
        {items.map((it: any) => {
          const m = MARK[it.health] ?? MARK.unknown;
          return (
            <div key={it.id} style={{
              display: 'flex', gap: 9, padding: '10px 0',
              borderBottom: `1px solid ${C.hair}`, alignItems: 'flex-start',
            }}>
              <span aria-label={m.label} title={m.label}
                style={{
                  color: m.color, fontWeight: 900, fontSize: FS.body,
                  width: 14, textAlign: 'center', flexShrink: 0, lineHeight: 1.5,
                }}>{m.glyph}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: C.text, fontSize: FS.small, fontWeight: 700 }}>{it.label}</div>
                <div style={{ color: C.faint, fontSize: FS.micro, marginTop: 3, lineHeight: 1.55 }}>
                  {it.detail}
                </div>
                {/* **무엇을 해야 하는지 적는다.** 빨간 표시만 두면
                    사용자가 할 수 있는 일이 없다. */}
                {it.action && (
                  <div style={{ color: C.accent, fontSize: FS.micro, marginTop: 4, lineHeight: 1.55 }}>
                    → {it.action}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ color: C.faint, fontSize: FS.micro, lineHeight: 1.6 }}>
        이 화면은 설정을 보여주지 않습니다 — <b style={{ color: C.dim }}>마지막으로 실제로 일어난 일</b>만 봅니다.
        설정값만 보면 그것이 돌고 있다고 믿게 되기 때문입니다.
      </div>

      <button onClick={load} disabled={busy}
        style={{ ...ghostBtn(), minHeight: 32, opacity: busy ? 0.5 : 1 }}>
        {busy ? '확인 중…' : '다시 확인'}
      </button>
    </div>
  );
}
