'use client';

// ─────────────────────────────────────────────────────────────
// /auth/callback
// Supabase 이메일 인증 링크가 떨어지는 페이지.
// detectSessionInUrl=true(client 옵션)이라 SDK가 URL 해시를 자동 처리하지만,
// 사용자에게 진행 상태를 보여주고 인증 직후 /api/auth/me를 호출해
// ADMIN_EMAILS 자동 승급을 발동시킨다.
// ─────────────────────────────────────────────────────────────
import React, { useEffect, useState } from 'react';

const T = {
  bg: '#060B14', card: '#0A1628', border: '#1A2D4A',
  txt: '#E2E8F0', muted: '#94A3B8', acl: '#60A5FA', acc: '#2563EB',
  grn: '#10B981', red: '#EF4444',
};

type Phase = 'verifying' | 'success' | 'no_session' | 'error';

export default function AuthCallbackPage() {
  const [phase, setPhase] = useState<Phase>('verifying');
  const [message, setMessage] = useState<string>('이메일 인증을 확인하고 있습니다...');
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const { getSupabaseClient } = await import('@/lib/supabase/client');
        const sb = getSupabaseClient();
        if (!sb) {
          if (!cancelled) {
            setPhase('error');
            setMessage('Supabase가 구성되지 않았습니다.');
          }
          return;
        }

        // SDK가 URL의 access_token을 처리할 시간을 잠시 줌
        await new Promise(r => setTimeout(r, 400));

        const { data: { session } } = await sb.auth.getSession();
        if (cancelled) return;

        if (!session?.access_token) {
          setPhase('no_session');
          setMessage('세션이 만들어지지 않았습니다. 이메일 링크를 다시 확인해주세요.');
          return;
        }

        setEmail(session.user?.email ?? null);

        // /api/auth/me 호출 → ADMIN_EMAILS 자동 승급 + 프로필 동기화
        try {
          await fetch('/api/auth/me', {
            headers: { Authorization: `Bearer ${session.access_token}` },
          });
        } catch (e) {
          // 실패해도 세션은 정상이라 사용자에겐 성공으로 표시
          console.warn('[auth/callback] /api/auth/me failed', e);
        }

        if (cancelled) return;
        setPhase('success');
        setMessage('인증이 완료되었습니다. 잠시 후 메인 페이지로 이동합니다...');

        // 3초 후 메인으로
        setTimeout(() => {
          try { window.location.href = '/'; } catch {}
        }, 2500);
      } catch (e) {
        if (cancelled) return;
        console.error('[auth/callback] error', e);
        setPhase('error');
        setMessage('인증 처리 중 오류가 발생했습니다.');
      }
    })();

    return () => { cancelled = true; };
  }, []);

  const color =
    phase === 'success' ? T.grn :
    phase === 'error'   ? T.red :
    phase === 'no_session' ? T.red :
    T.acl;

  const title =
    phase === 'success'    ? '✓ 인증 완료' :
    phase === 'error'      ? '오류 발생' :
    phase === 'no_session' ? '세션 없음' :
    '확인 중...';

  return (
    <div style={{
      minHeight: '100vh', background: T.bg, color: T.txt,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 20, fontFamily: "'Sora', sans-serif",
    }}>
      <div style={{
        background: T.card, border: `1px solid ${T.border}`,
        borderRadius: 16, padding: 28, maxWidth: 420, width: '100%',
        textAlign: 'center',
      }}>
        <div style={{
          width: 64, height: 64, borderRadius: '50%',
          background: color + '22', border: `2px solid ${color}55`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          margin: '0 auto 16px',
        }}>
          {phase === 'verifying' ? (
            <div style={{
              width: 28, height: 28, border: `3px solid ${color}33`,
              borderTopColor: color, borderRadius: '50%',
              animation: 'spin 0.9s linear infinite',
            }} />
          ) : (
            <div style={{ color, fontSize: 28, fontWeight: 900 }}>
              {phase === 'success' ? '✓' : phase === 'error' ? '!' : '?'}
            </div>
          )}
        </div>

        <div style={{ color: T.txt, fontWeight: 800, fontSize: 18, marginBottom: 6 }}>
          {title}
        </div>
        {email && (
          <div style={{ color: T.muted, fontSize: 12, marginBottom: 8 }}>
            {email}
          </div>
        )}
        <div style={{ color: T.muted, fontSize: 13, lineHeight: 1.6, marginBottom: 20 }}>
          {message}
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
          {phase === 'success' && (
            <a href="/" style={{
              padding: '11px 20px', minHeight: 44,
              background: T.acc, color: '#fff', borderRadius: 10,
              fontWeight: 700, fontSize: 13, textDecoration: 'none',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            }}>지금 이동</a>
          )}
          {(phase === 'error' || phase === 'no_session') && (
            <>
              <a href="/auth" style={{
                padding: '11px 20px', minHeight: 44,
                background: T.acc, color: '#fff', borderRadius: 10,
                fontWeight: 700, fontSize: 13, textDecoration: 'none',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              }}>로그인 페이지로</a>
              <a href="/" style={{
                padding: '11px 20px', minHeight: 44,
                background: 'transparent', color: T.muted,
                border: `1px solid ${T.border}`, borderRadius: 10,
                fontWeight: 700, fontSize: 13, textDecoration: 'none',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              }}>홈으로</a>
            </>
          )}
        </div>
      </div>

      <style jsx>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
