'use client';
// src/components/terminal/SafetyLogPanel.tsx
//
// **안전장치가 실제로 발동한 적이 있는가.**
//
// 왜 이 화면이 필요한가
// ─────────────────────
// 다른 화면들은 설정값을 보여준다 — "오늘 손실 한도 5%", "AI 거부권 켜짐".
// 설정값만 보이면 사람은 그것이 **돌고 있다고 믿는다.**
//
// 그런데 하루에만 켜져 있다고 믿었는데 한 번도 안 돈 안전장치를 여섯 개
// 찾았다(지표 회피·실전 분류·연결 테스트·선물 잔고·백테스트 청산·캘린더
// 크론). 전부 에러가 안 나고 화면이 멀쩡했다. 유닛 테스트 1200개도 안
// 잡았다 — 코드가 아니라 배선이 틀린 종류였기 때문이다.
//
// 그래서 이 화면은 설정값을 **안 보여준다.** 발동 이력만 본다.
// "한 번도 발동한 적 없음"이 눈에 띄어야 하기 때문이다.
//
// 세 가지를 구분한다
// ──────────────────
//   발동함        시각과 이유를 적는다
//   한 번도 없음  회색으로, 그러나 지우지 않는다
//   확인 불가     이력을 못 읽었다 — **0이 아니다**
//
// 마지막 것이 핵심이다. 못 읽은 것을 0으로 그리면 "안전장치가 조용히
// 죽었다"와 "아직 걸릴 일이 없었다"가 화면에서 같아진다.
import React, { useCallback, useEffect, useState } from 'react';
import { errorTextOf } from '@/lib/http/errorText';
import { C, FS, NUM, ghostBtn } from './theme';
import { useTerminal } from './TerminalContext';

// 발동 기록의 세 가지 뜻. 'waived'를 '한도 걸림'으로 뭉뚱그리면 **막힌 것과
// 사용자가 넘긴 것이 같아 보인다** — 뒤쪽은 주문이 실제로 나갔다.
function statusMark(s: string | null | undefined): { text: string; tone: string } {
  const v = String(s || '');
  if (v === 'unknown') return { text: '확인 못 함', tone: C.warn };
  if (v === 'waived')  return { text: '사용자가 넘김', tone: C.accent };
  return { text: '한도 걸림', tone: C.down };
}

function ago(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return '';
  const d = Date.now() - ms;
  if (d < 0) return '방금';
  const m = d / 60_000, h = m / 60, day = h / 24;
  if (day >= 1) return `${Math.floor(day)}일 전`;
  if (h >= 1) return `${Math.floor(h)}시간 전`;
  if (m >= 1) return `${Math.floor(m)}분 전`;
  return '방금';
}

export function SafetyLogPanel() {
  const { auth } = useTerminal();
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!auth) { setErr('로그인이 필요합니다'); return; }
    setBusy(true);
    try {
      const r = await fetch('/api/safety/events?days=30', { headers: { Authorization: auth } });
      const j = await r.json();
      if (!r.ok || !j?.ok) {
        setData(null);
        setErr(errorTextOf(j, `조회 실패 (${r.status})`));
        return;
      }
      setErr('');
      setData(j);
    } catch (e: any) {
      setData(null);
      setErr(`발동 이력을 읽지 못했습니다 (${e?.message || e})`);
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

  const items: any[] = Array.isArray(data.items) ? data.items : [];
  const fired = items.filter(i => i.count > 0);
  const never = items.filter(i => i.count === 0);
  const recent: any[] = Array.isArray(data.recent) ? data.recent : [];

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* 이력을 못 읽었으면 그 사실이 맨 위에 온다.
          아래 숫자가 전부 0으로 보이는데 그게 '발동 안 함'이 아니기 때문이다. */}
      {!data.known && (
        <div style={{
          padding: '10px 12px', borderRadius: 8,
          background: C.warnBg, color: C.warn, fontSize: FS.micro, lineHeight: 1.6,
        }}>{data.note}</div>
      )}

      <div style={{ color: C.faint, fontSize: FS.micro, lineHeight: 1.6 }}>
        최근 {data.days}일. <b style={{ color: C.dim }}>설정값이 아니라 실제로 주문을 막은 기록</b>입니다 —
        한 번도 발동한 적 없는 안전장치는 작동한다고 말할 수 없습니다.
      </div>

      {/* 발동한 것 */}
      <Section title={`발동함 (${fired.length})`}>
        {fired.length === 0
          ? <Empty t={data.known
              ? '최근 30일간 주문을 막은 안전장치가 없습니다'
              : '확인 불가 — 위 안내를 보세요'}/>
          : fired.map(i => (
            <div key={i.kind} style={{ padding: '9px 0', borderBottom: `1px solid ${C.hair}` }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ color: C.text, fontSize: FS.small, fontWeight: 700 }}>{i.label || i.kind}</span>
                <span style={{ ...NUM, fontSize: FS.micro, color: C.dim, whiteSpace: 'nowrap' }}>
                  {ago(i.lastAtMs)} · {i.count}회
                </span>
              </div>
              {i.lastReason && (
                <div style={{ color: C.faint, fontSize: FS.micro, marginTop: 4, lineHeight: 1.5 }}>
                  {/* 'fail'·'unknown'·'waived'를 다른 색으로. 한도에 걸린 것,
                      확인을 못 한 것, 사용자가 넘긴 것 — 대응이 전부 다르다. */}
                  <span style={{ color: statusMark(i.lastStatus).tone, fontWeight: 700 }}>
                    {statusMark(i.lastStatus).text}
                  </span>
                  {' · '}{i.lastReason}
                </div>
              )}
            </div>
          ))}
      </Section>

      {/* 한 번도 없는 것 — 지우지 않는다. 이 목록이 이 화면의 핵심이다 */}
      <Section title={`한 번도 발동 안 함 (${never.length})`}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, paddingTop: 4 }}>
          {never.map(i => (
            <span key={i.kind} style={{
              padding: '4px 8px', borderRadius: 6,
              background: C.raised, border: `1px solid ${C.hair}`,
              color: data.known ? C.faint : C.warn, fontSize: FS.micro,
            }}>{i.label || i.kind}</span>
          ))}
        </div>
        <div style={{ color: C.faint, fontSize: FS.micro, marginTop: 8, lineHeight: 1.6 }}>
          {data.known
            ? '아직 걸릴 일이 없었을 수도 있고, 연결이 끊겨 안 도는 것일 수도 있습니다. 소액 실거래로 한 번씩 발동시켜 보는 것이 유일한 확인 방법입니다.'
            : '이력을 못 읽어서 전부 여기 있는 것입니다 — 발동 안 했다는 뜻이 아닙니다.'}
        </div>
      </Section>

      {/* 최근 기록 원본 — 요약만 있으면 무엇 때문에 막혔는지 못 되짚는다 */}
      {recent.length > 0 && (
        <Section title={`최근 기록 (${recent.length})`}>
          {recent.map((r, i) => (
            <div key={i} style={{ padding: '7px 0', borderBottom: `1px solid ${C.hair}` }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <span style={{ color: statusMark(r.status).tone, fontSize: FS.micro, fontWeight: 700 }}>
                  {r.label || r.kind}
                </span>
                <span style={{ color: statusMark(r.status).tone, fontSize: FS.micro, fontWeight: 700 }}>
                  {statusMark(r.status).text}
                </span>
                <span style={{ ...NUM, color: C.faint, fontSize: FS.micro }}>
                  {r.market || ''} {r.symbol || ''}
                </span>
                <span style={{ ...NUM, color: C.faint, fontSize: FS.micro, marginLeft: 'auto' }}>
                  {ago(Date.parse(String(r.occurred_at)))}
                </span>
              </div>
              {r.reason && (
                <div style={{ color: C.faint, fontSize: FS.micro, marginTop: 3, lineHeight: 1.5 }}>{r.reason}</div>
              )}
            </div>
          ))}
        </Section>
      )}

      <button onClick={load} disabled={busy}
        style={{ ...ghostBtn(), minHeight: 32, opacity: busy ? 0.5 : 1 }}>
        {busy ? '읽는 중…' : '새로고침'}
      </button>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ color: C.faint, fontSize: FS.micro, fontWeight: 700, marginBottom: 2 }}>{title}</div>
      {children}
    </div>
  );
}

function Empty({ t }: { t: string }) {
  return <div style={{ padding: '12px 0', color: C.faint, fontSize: FS.micro, lineHeight: 1.6 }}>{t}</div>;
}
