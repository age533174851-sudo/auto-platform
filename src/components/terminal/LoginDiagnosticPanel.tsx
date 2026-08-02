'use client';
// src/components/terminal/LoginDiagnosticPanel.tsx
//
// **로그인이 왜 풀리는지 화면에서 바로 본다.**
//
// "로그인이 계속 풀린다"는 증상이고 원인은 넷인데, 넷 다 화면에는
// 똑같이 "로그인이 필요합니다"로 보인다. 그래서 고칠 때마다 "이번엔
// 됐나?"를 몇 시간씩 기다려야 했다.
//
// 이 화면은 **지금 이 순간의 사실**만 보여준다. 어느 주소로 들어왔는지,
// 저장소를 쓸 수 있는지, 토큰이 언제 만료되는지.
import React, { useCallback, useEffect, useState } from 'react';
import { C, FS, NUM, ghostBtn } from './theme';
import { diagnose, type Finding } from '@/lib/auth/loginDiagnostic';

const MARK: Record<string, { glyph: string; color: string }> = {
  ok:      { glyph: '●', color: C.up },
  warn:    { glyph: '▲', color: C.warn },
  bad:     { glyph: '✕', color: C.down },
  unknown: { glyph: '?', color: C.faint },
};

const PROBE_KEY = 'tg_storage_probe';

export function LoginDiagnosticPanel() {
  const [res, setRes] = useState<{ findings: Finding[]; headline: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async () => {
    setBusy(true);
    try {
      // 저장소가 실제로 되는지 **써 보고 읽어 본다.** 있는지만 확인하면
      // 시크릿 모드에서 쓰기가 조용히 실패하는 것을 못 잡는다.
      let storageOk: boolean | null = null;
      try {
        window.localStorage.setItem(PROBE_KEY, '1');
        storageOk = window.localStorage.getItem(PROBE_KEY) === '1';
        window.localStorage.removeItem(PROBE_KEY);
      } catch { storageOk = false; }

      let hasSession: boolean | null = null;
      let expiresAtMs: number | null = null;
      let hasRefreshToken: boolean | null = null;
      try {
        const { getSupabaseClient } = await import('@/lib/supabase/client');
        const sb = getSupabaseClient();
        if (sb) {
          const { data, error } = await sb.auth.getSession();
          if (error) {
            // 못 읽은 것이다. **로그아웃으로 치지 않는다.**
            hasSession = null;
          } else {
            const s = data?.session ?? null;
            hasSession = !!s;
            expiresAtMs = s?.expires_at ? s.expires_at * 1000 : null;
            hasRefreshToken = s ? !!s.refresh_token : null;
          }
        }
      } catch { hasSession = null; }

      setRes(diagnose({
        hostname: typeof location !== 'undefined' ? location.hostname : null,
        storageOk, hasSession, expiresAtMs, hasRefreshToken, nowMs: Date.now(),
      }));
    } finally { setBusy(false); }
  }, []);

  useEffect(() => { run(); }, [run]);

  if (!res) {
    return <div style={{ padding: 20, textAlign: 'center', color: C.faint, fontSize: FS.small }}>
      {busy ? '확인 중…' : '—'}
    </div>;
  }

  const worst = res.findings.some(f => f.level === 'bad') ? 'bad'
              : res.findings.some(f => f.level === 'unknown') ? 'unknown'
              : res.findings.some(f => f.level === 'warn') ? 'warn' : 'ok';
  const m = MARK[worst];

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>

      <div style={{
        background: C.raised, borderRadius: 9, padding: '12px 13px',
        border: `1px solid ${worst === 'ok' ? C.hair : `${m.color}55`}`,
        display: 'flex', alignItems: 'flex-start', gap: 10,
      }}>
        <span style={{ color: m.color, fontSize: 18, fontWeight: 900, lineHeight: 1.2 }}>{m.glyph}</span>
        <div style={{ color: C.text, fontSize: FS.small, fontWeight: 700, lineHeight: 1.5 }}>
          {res.headline}
        </div>
      </div>

      <div>
        {res.findings.map(f => {
          const k = MARK[f.level] ?? MARK.unknown;
          return (
            <div key={f.id} style={{
              display: 'flex', gap: 9, padding: '10px 0',
              borderBottom: `1px solid ${C.hair}`, alignItems: 'flex-start',
            }}>
              <span style={{ color: k.color, fontWeight: 900, fontSize: FS.body,
                             width: 14, textAlign: 'center', flexShrink: 0, lineHeight: 1.5 }}>
                {k.glyph}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: C.text, fontSize: FS.small, fontWeight: 700 }}>{f.label}</div>
                <div style={{ ...NUM, color: C.faint, fontSize: FS.micro, marginTop: 3,
                              lineHeight: 1.55, wordBreak: 'break-all' }}>
                  {f.detail}
                </div>
                {f.action && (
                  <div style={{ color: C.accent, fontSize: FS.micro, marginTop: 4, lineHeight: 1.55 }}>
                    → {f.action}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ color: C.faint, fontSize: FS.micro, lineHeight: 1.6 }}>
        주소가 <b style={{ color: C.dim }}>바뀌는 주소</b>로 나오면 그게 원인입니다.
        브라우저는 주소가 다르면 로그인 정보를 따로 저장하기 때문에, 그건 코드로 못 고칩니다 —
        고정 주소로 들어오셔야 합니다.
      </div>

      <button onClick={run} disabled={busy}
        style={{ ...ghostBtn(), minHeight: 32, opacity: busy ? 0.5 : 1 }}>
        {busy ? '확인 중…' : '다시 확인'}
      </button>
    </div>
  );
}
