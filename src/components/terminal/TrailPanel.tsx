'use client';
// src/components/terminal/TrailPanel.tsx
//
// **트레일링이 지금 무엇을 하고 있는가.**
//
// 왜 필요한가
// ───────────
// 트레일링·본전 이동은 이미 돌고 있다. 크론이 주기마다 손절을 옮긴다.
// 그런데 화면 어디에도 그 설정도, 그 결과도 없었다.
//
// 오늘 고친 여섯 개는 "켜졌다고 믿는데 안 도는" 것이었다. 이건 반대다 —
// **도는데 사용자가 모른다.** 손절이 자기도 모르게 움직이면, 그 손절에
// 걸려 나갔을 때 왜 나갔는지 알 수 없다.
//
// 이 화면은 아무것도 실행하지 않는다. 서버도 판정만 하고 돌려준다.
import React, { useCallback, useEffect, useState } from 'react';
import { C, FS, NUM, ghostBtn, fmtPrice } from './theme';
import { useTerminal } from './TerminalContext';

const ACTION_LABEL: Record<string, string> = {
  NONE: '그대로', MOVE_STOP: '손절 옮김', CLOSE: '청산',
};
const ACTION_TONE: Record<string, string> = {
  NONE: C.dim, MOVE_STOP: C.accent, CLOSE: C.down,
};

export function TrailPanel() {
  const { auth } = useTerminal();
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!auth) { setErr('로그인이 필요합니다'); return; }
    setBusy(true);
    try {
      const r = await fetch('/api/autotrade/trail-status', { headers: { Authorization: auth } });
      const j = await r.json();
      if (!r.ok) {
        setData(null);
        setErr(j?.error || `조회 실패 (${r.status})`);
        return;
      }
      setErr('');
      setData(j);
    } catch (e: any) {
      setData(null);
      setErr(`트레일링 상태를 읽지 못했습니다 (${e?.message || e})`);
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
        <button onClick={load} style={{ ...ghostBtn(), marginTop: 10, minHeight: 30 }}>다시 시도</button>
      </div>
    );
  }
  if (!data) {
    return <div style={{ padding: 20, textAlign: 'center', color: C.faint, fontSize: FS.small }}>
      {busy ? '읽는 중…' : '—'}
    </div>;
  }

  const cfg = data.config || {};
  const positions: any[] = Array.isArray(data.positions) ? data.positions : [];
  const on = cfg.useTrailing || cfg.useBreakEven;

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* 켜져 있는가. 안전장치는 상태가 먼저 보여야 한다 */}
      <div style={{
        background: C.raised, borderRadius: 9, padding: '11px 13px',
        border: `1px solid ${on ? C.hair : `${C.warn}55`}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
          <span style={{ color: C.text, fontSize: FS.body, fontWeight: 800 }}>
            {on ? '손절 자동 이동 켜짐' : '손절 자동 이동 꺼짐'}
          </span>
          <span style={{ ...NUM, color: C.dim, fontSize: FS.micro }}>
            {cfg.useTrailing ? '트레일링' : ''}{cfg.useTrailing && cfg.useBreakEven ? ' · ' : ''}
            {cfg.useBreakEven ? '본전 이동' : ''}
          </span>
        </div>
        <div style={{ color: C.faint, fontSize: FS.micro, marginTop: 6, lineHeight: 1.6 }}>
          {cfg.useBreakEven && <>이익이 <b style={{ color: C.dim }}>{cfg.breakEvenR}R</b>에 닿으면 손절을 본전으로. </>}
          {cfg.useTrailing && <>
            <b style={{ color: C.dim }}>{cfg.trailStartR}R</b>을 넘으면 최고점에서{' '}
            <b style={{ color: C.dim }}>{cfg.trailDistanceR}R</b> 물러난 자리로 손절을 따라 올립니다.
          </>}
          {!on && '지금은 손절이 진입 시점 값 그대로 유지됩니다.'}
        </div>
        {/* R이 뭔지 모르면 위 문장이 아무 뜻도 아니다 */}
        <div style={{ color: C.faint, fontSize: FS.micro, marginTop: 5, lineHeight: 1.5 }}>
          1R = 진입가와 진입 손절가의 거리. 종목·배율이 달라도 같은 규칙을 쓰려고 가격 대신 R로 셉니다.
        </div>
        {data.configNote && (
          <div style={{ color: C.warn, fontSize: FS.micro, marginTop: 6, lineHeight: 1.5 }}>{data.configNote}</div>
        )}
        {/* 화면에서 못 바꾸는 값을 바꿀 수 있는 것처럼 두지 않는다 */}
        {data.envOnly && (
          <div style={{ color: C.faint, fontSize: FS.micro, marginTop: 6, lineHeight: 1.5 }}>
            이 값은 환경변수로만 바꿉니다 — TRAIL_START_R · TRAIL_DISTANCE_R · BREAK_EVEN_R.
            다른 안전장치(손실 한도 등)와 같은 방식입니다.
          </div>
        )}
      </div>

      {/* 지금 열린 것들이 어떤 상태인가 */}
      <div>
        <div style={{ color: C.faint, fontSize: FS.micro, fontWeight: 700, marginBottom: 2 }}>
          열린 포지션 ({positions.length})
        </div>
        {positions.length === 0 ? (
          <div style={{ padding: '12px 0', color: C.faint, fontSize: FS.micro, lineHeight: 1.6 }}>
            자동매매로 열린 포지션이 없습니다. 손으로 낸 주문은 여기 안 나옵니다 —
            트레일링은 사다리 전략이 연 포지션에만 걸립니다.
          </div>
        ) : positions.map((p, i) => (
          <div key={i} style={{ padding: '9px 0', borderBottom: `1px solid ${C.hair}` }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ color: C.text, fontSize: FS.small, fontWeight: 700 }}>{p.symbol}</span>
              <span style={{
                fontSize: FS.micro, fontWeight: 800,
                color: ACTION_TONE[p.action] ?? C.dim, whiteSpace: 'nowrap',
              }}>{ACTION_LABEL[p.action] ?? p.action}</span>
            </div>
            <div style={{ display: 'flex', gap: 12, marginTop: 5, ...NUM, fontSize: FS.micro, flexWrap: 'wrap' }}>
              <span style={{ color: C.faint }}>
                최고 <b style={{ color: C.dim }}>{p.highWaterR == null ? '—' : `${p.highWaterR}R`}</b>
              </span>
              <span style={{ color: C.faint }}>
                지금 손절 <b style={{ color: C.dim }}>{p.currentStop == null ? '—' : fmtPrice(p.currentStop)}</b>
              </span>
              {p.newStop != null && (
                <span style={{ color: C.accent }}>
                  → <b>{fmtPrice(p.newStop)}</b>
                </span>
              )}
            </div>
            <div style={{ color: C.faint, fontSize: FS.micro, marginTop: 4, lineHeight: 1.5 }}>{p.reason}</div>
          </div>
        ))}
      </div>

      {/* 이 화면이 무엇을 보고 판단했는지 적는다. 거래소를 안 부른다는
          사실을 감추면 "지금 걸린 손절"이 실제 값인 줄 알게 된다. */}
      <div style={{ color: C.faint, fontSize: FS.micro, lineHeight: 1.6 }}>
        이 화면은 아무것도 실행하지 않습니다 — 판정만 보여줍니다.
        {data.liveStopKnown === false && ' 거래소에 지금 걸린 손절가는 조회하지 않았습니다(화면을 여는 것만으로 요청이 나가지 않게). 위 손절가는 진입 시점 값 기준입니다.'}
        {' '}실제 이동은 청산 감시 크론이 합니다.
      </div>

      <button onClick={load} disabled={busy}
        style={{ ...ghostBtn(), minHeight: 32, opacity: busy ? 0.5 : 1 }}>
        {busy ? '읽는 중…' : '새로고침'}
      </button>
    </div>
  );
}
