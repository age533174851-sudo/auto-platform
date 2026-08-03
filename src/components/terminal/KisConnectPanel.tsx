'use client';
// src/components/terminal/KisConnectPanel.tsx
//
// 한국투자증권 연결 화면.
//
// 이 화면이 지키는 것
// ───────────────────
// **확인 안 된 연결을 목록에 만들지 않는다.** 서버가 저장 전에 실제로
// 계좌를 읽어 보고, 실패하면 아무것도 저장하지 않는다. 그래야 여기 뜬
// 줄이 곧 "지금 되는 연결"이다.
//
// 그리고 모의가 기본이다. 실전은 명시적으로 켜야 하고, 켤 때 무슨
// 뜻인지 화면이 말한다.
import React, { useCallback, useEffect, useState } from 'react';
import { errorTextOf } from '@/lib/http/errorText';
import { C, FS, NUM, ghostBtn, primaryBtn, input } from './theme';
import { useTerminal } from './TerminalContext';

export function KisConnectPanel() {
  const { auth } = useTerminal();
  const [list, setList] = useState<any[] | null>(null);
  const [appKey, setAppKey] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [accountNo, setAccountNo] = useState('');
  const [isLive, setIsLive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; hint?: string } | null>(null);

  const load = useCallback(async () => {
    if (!auth) return;
    try {
      const r = await fetch('/api/exchange/kis', { headers: { Authorization: auth } });
      const j = await r.json();
      // 못 읽었으면 **빈 목록으로 그리지 않는다.** 빈 목록은 '연결 없음'인데
      // 실제로는 조회가 실패한 것이다 — 둘은 대응이 다르다.
      setList(r.ok && j?.ok ? (j.connections || []) : null);
    } catch { setList(null); }
  }, [auth]);

  useEffect(() => { load(); }, [load]);

  const submit = async () => {
    if (!auth) { setMsg({ ok: false, text: '로그인이 필요합니다' }); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/exchange/kis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({ action: 'connect', appKey, appSecret, accountNo, isLive }),
      });
      const j = await r.json();
      if (r.ok && j?.ok) {
        setMsg({ ok: true, text: j.message || '연결됨' });
        // 성공했으면 입력칸을 비운다. 시크릿이 화면에 계속 떠 있을 이유가 없다.
        setAppKey(''); setAppSecret(''); setAccountNo('');
        load();
      } else {
        setMsg({ ok: false, text: errorTextOf(j, `실패 (${r.status})`), hint: j?.hint });
      }
    } catch (e: any) {
      setMsg({ ok: false, text: `요청이 실패했습니다 (${e?.message || e})` });
    } finally { setBusy(false); }
  };

  const retest = async (id: string) => {
    if (!auth) return;
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/exchange/kis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({ action: 'test', connectionId: id }),
      });
      const j = await r.json();
      setMsg({ ok: !!j?.ok, text: j?.message || (j?.ok ? '연결됨' : '실패') });
      load();
    } catch (e: any) {
      setMsg({ ok: false, text: `요청이 실패했습니다 (${e?.message || e})` });
    } finally { setBusy(false); }
  };

  const field = (label: string, value: string, set: (v: string) => void,
                 placeholder: string, secret = false) => (
    <label style={{ display: 'block' }}>
      <div style={{ color: C.faint, fontSize: FS.micro, marginBottom: 4 }}>{label}</div>
      <input
        value={value} onChange={e => set(e.target.value)}
        placeholder={placeholder}
        type={secret ? 'password' : 'text'}
        autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false}
        style={{ ...input, width: '100%', padding: '10px 12px', fontSize: FS.small, ...NUM }}/>
    </label>
  );

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* 지금 연결된 것 */}
      <div>
        <div style={{ color: C.faint, fontSize: FS.micro, fontWeight: 700, marginBottom: 6 }}>
          연결된 계좌
        </div>
        {list == null ? (
          <div style={{ color: C.warn, fontSize: FS.micro, lineHeight: 1.6 }}>
            연결 목록을 읽지 못했습니다 — 연결이 없다는 뜻이 아닙니다.
          </div>
        ) : list.length === 0 ? (
          <div style={{ color: C.faint, fontSize: FS.micro, lineHeight: 1.6 }}>
            아직 없습니다. 아래에서 앱키를 넣으세요.
          </div>
        ) : list.map(c => (
          <div key={c.id} style={{ padding: '9px 0', borderBottom: `1px solid ${C.hair}` }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ color: C.text, fontSize: FS.small, fontWeight: 700 }}>{c.label}</span>
              <span style={{
                fontSize: FS.micro, fontWeight: 800,
                color: c.isLive ? C.down : C.dim,
              }}>{c.isLive ? '실전' : '모의투자'}</span>
            </div>
            <div style={{ ...NUM, color: C.faint, fontSize: FS.micro, marginTop: 4 }}>
              {c.apiKeyMasked} · 계좌 {c.accountMasked}
            </div>
            <div style={{ color: C.faint, fontSize: FS.micro, marginTop: 3 }}>
              {/* 마지막으로 **확인한** 시각을 적는다. 없으면 지금 되는지 모른다 */}
              {c.lastTestedAt
                ? `마지막 확인 ${new Date(c.lastTestedAt).toLocaleString('ko-KR')} · ${c.testStatus === 'ok' ? '정상' : '실패'}`
                : '한 번도 확인하지 않았습니다'}
            </div>
            <button onClick={() => retest(c.id)} disabled={busy}
              style={{ ...ghostBtn(), marginTop: 7, minHeight: 30, opacity: busy ? 0.5 : 1 }}>
              연결 확인
            </button>
          </div>
        ))}
      </div>

      {/* 새로 넣기 */}
      <div style={{
        background: C.raised, borderRadius: 9, padding: 12,
        display: 'flex', flexDirection: 'column', gap: 10,
      }}>
        <div style={{ color: C.text, fontSize: FS.body, fontWeight: 800 }}>앱키 넣기</div>

        {field('APP Key', appKey, setAppKey, '한국투자증권에서 발급받은 앱키')}
        {field('APP Secret', appSecret, setAppSecret, '아주 긴 문자열', true)}
        {field('계좌번호', accountNo, setAccountNo, '12345678-01')}

        {/* 모의가 기본이다. 실전은 명시적으로 켜야 한다 */}
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
          <input type="checkbox" checked={isLive} onChange={e => setIsLive(e.target.checked)}
                 style={{ marginTop: 2, width: 18, height: 18, accentColor: C.down }}/>
          <span style={{ fontSize: FS.micro, lineHeight: 1.55, color: isLive ? C.down : C.dim }}>
            <b>실전 계좌입니다</b>
            <span style={{ display: 'block', color: C.faint, marginTop: 2 }}>
              끄면 모의투자로 연결합니다. 앱키가 실전용인지 모의용인지는 발급받을 때 정해집니다 —
              섞으면 인증이 안 됩니다.
            </span>
          </span>
        </label>

        <button onClick={submit} disabled={busy || !appKey || !appSecret || !accountNo}
          style={{
            ...primaryBtn(isLive ? C.down : C.accent, busy),
            minHeight: 44,
            opacity: (busy || !appKey || !appSecret || !accountNo) ? 0.5 : 1,
          }}>
          {busy ? '확인 중…' : '연결하고 계좌 확인'}
        </button>

        {/* 무엇을 하는 버튼인지 적는다 */}
        <div style={{ color: C.faint, fontSize: FS.micro, lineHeight: 1.6 }}>
          누르면 실제로 계좌를 한 번 읽어봅니다. <b style={{ color: C.dim }}>성공했을 때만 저장</b>합니다 —
          확인 안 된 연결이 목록에 생기면 되는 줄 알게 되니까요.
        </div>
      </div>

      {msg && (
        <div style={{
          padding: '10px 12px', borderRadius: 8, fontSize: FS.micro, lineHeight: 1.55,
          color: msg.ok ? C.up : C.down, background: msg.ok ? C.upBg : C.downBg,
        }}>
          {msg.text}
          {msg.hint && <div style={{ color: C.faint, marginTop: 5 }}>{msg.hint}</div>}
        </div>
      )}

      <div style={{ color: C.faint, fontSize: FS.micro, lineHeight: 1.6 }}>
        앱키는 <b style={{ color: C.dim }}>apiportal.koreainvestment.com</b>에서 발급받습니다.
        모의투자용과 실전용이 따로입니다. 승인에 1~2일 걸릴 수 있습니다.
      </div>
    </div>
  );
}
