'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { checkPasswordStrength } from '@/lib/auth';
import { T } from '@/lib/constants';
import { getSupabaseClient } from '@/lib/supabase/client';

type Phase = 'checking' | 'ready' | 'saving' | 'success' | 'invalid' | 'error';

export default function AuthResetPage() {
  const [phase, setPhase] = useState<Phase>('checking');
  const [message, setMessage] = useState('비밀번호 재설정 링크를 확인하고 있습니다...');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');

  const strength = useMemo(() => checkPasswordStrength(password), [password]);
  const canSubmit =
    phase === 'ready' &&
    !!password &&
    password === confirm &&
    strength.isValid;

  useEffect(() => {
    let cancelled = false;
    let unsubscribe = () => {};

    (async () => {
      try {
        const sb = getSupabaseClient();
        if (!sb) {
          if (!cancelled) {
            setPhase('error');
            setMessage('Supabase가 구성되지 않았습니다.');
          }
          return;
        }

        // auth-js의 기본 implicit flow + detectSessionInUrl=true가
        // 복구 메일의 URL hash를 처리해 recovery session을 만든다.
        // PKCE code 교환(exchangeCodeForSession)은 여기서 하지 않는다.
        const { data: listener } = sb.auth.onAuthStateChange((event, session) => {
          if (cancelled) return;
          if (event === 'PASSWORD_RECOVERY' && session?.user) {
            setPhase('ready');
            setMessage('새 비밀번호를 입력해주세요.');
          }
        });

        unsubscribe = () => listener.subscription.unsubscribe();

        // INITIAL_SESSION이 먼저 끝난 경우도 허용한다. 이 페이지는
        // password-reset 메일의 redirectTo 전용 착지점이다.
        const { data: { session } } = await sb.auth.getSession();
        if (!cancelled && session?.user) {
          setPhase('ready');
          setMessage('새 비밀번호를 입력해주세요.');
        }

        // 해시 처리가 비동기라 session이 즉시 없을 수 있다.
        if (!session?.user) {
          await new Promise(resolve => setTimeout(resolve, 500));
          const retry = await sb.auth.getSession();
          if (!cancelled && retry.data.session?.user) {
            setPhase('ready');
            setMessage('새 비밀번호를 입력해주세요.');
          } else if (!cancelled) {
            setPhase('invalid');
            setMessage('유효한 복구 세션이 없습니다. 링크가 만료됐거나 이미 사용됐을 수 있습니다.');
          }
        }

      } catch (error) {
        console.error('[auth/reset] session check failed', error);
        if (!cancelled) {
          setPhase('error');
          setMessage('복구 링크를 확인하는 중 오류가 발생했습니다.');
        }
      }
    })();

    return () => { cancelled = true; unsubscribe(); };
  }, []);

  async function submit() {
    if (!canSubmit) return;
    setPhase('saving');
    setMessage('비밀번호를 변경하고 있습니다...');

    try {
      const sb = getSupabaseClient();
      if (!sb) {
        setPhase('error');
        setMessage('Supabase가 구성되지 않았습니다.');
        return;
      }

      const { error } = await sb.auth.updateUser({ password });
      if (error) {
        setPhase('ready');
        setMessage(error.message || '비밀번호 변경에 실패했습니다.');
        return;
      }

      setPhase('success');
      setMessage('비밀번호가 변경되었습니다. 새 비밀번호로 로그인해주세요.');
    } catch (error) {
      console.error('[auth/reset] password update failed', error);
      setPhase('ready');
      setMessage('비밀번호 변경 중 오류가 발생했습니다. 다시 시도해주세요.');
    }
  }

  const statusColor =
    phase === 'success' ? T.grn :
    phase === 'invalid' || phase === 'error' ? T.red :
    T.acl;

  return (
    <div style={{
      minHeight: '100vh',
      background: T.bg,
      color: T.txt,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 20,
      fontFamily: "'Sora', sans-serif",
    }}>
      <div style={{
        width: '100%',
        maxWidth: 420,
        background: T.card,
        border: `1px solid ${T.border}`,
        borderRadius: 18,
        padding: 24,
      }}>
        <div style={{ fontSize: 20, fontWeight: 900, marginBottom: 8 }}>
          비밀번호 재설정
        </div>
        <div style={{ color: statusColor, fontSize: 12, lineHeight: 1.6, marginBottom: 18 }}>
          {message}
        </div>

        {(phase === 'ready' || phase === 'saving') && (
          <>
            <label style={{ display: 'block', marginBottom: 12 }}>
              <div style={{ color: T.muted, fontSize: 11, fontWeight: 700, marginBottom: 5 }}>
                새 비밀번호
              </div>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                autoComplete="new-password"
                disabled={phase === 'saving'}
                style={{
                  width: '100%',
                  background: T.bg,
                  border: `1px solid ${T.border}`,
                  borderRadius: 10,
                  padding: '12px 14px',
                  color: T.txt,
                  fontSize: 14,
                  outline: 'none',
                }}
              />
            </label>

            {password && (
              <div style={{ color: strength.color, fontSize: 10, marginTop: -6, marginBottom: 12 }}>
                {strength.label}
                {strength.hints?.length ? ` · ${strength.hints.slice(0, 2).join(' · ')}` : ''}
              </div>
            )}

            <label style={{ display: 'block', marginBottom: 14 }}>
              <div style={{ color: T.muted, fontSize: 11, fontWeight: 700, marginBottom: 5 }}>
                새 비밀번호 확인
              </div>
              <input
                type="password"
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && submit()}
                autoComplete="new-password"
                disabled={phase === 'saving'}
                style={{
                  width: '100%',
                  background: T.bg,
                  border: `1px solid ${T.border}`,
                  borderRadius: 10,
                  padding: '12px 14px',
                  color: T.txt,
                  fontSize: 14,
                  outline: 'none',
                }}
              />
              {confirm && confirm !== password && (
                <div style={{ color: T.red, fontSize: 10, marginTop: 5 }}>
                  비밀번호가 일치하지 않습니다.
                </div>
              )}
            </label>

            <button
              type="button"
              onClick={submit}
              disabled={!canSubmit || phase === 'saving'}
              style={{
                width: '100%',
                minHeight: 44,
                padding: '12px 14px',
                background: canSubmit ? T.acc : 'var(--t-border2)',
                color: '#fff',
                border: 'none',
                borderRadius: 10,
                fontWeight: 800,
                cursor: canSubmit ? 'pointer' : 'not-allowed',
              }}
            >
              {phase === 'saving' ? '변경 중...' : '비밀번호 변경'}
            </button>
          </>
        )}

        {phase === 'checking' && (
          <div style={{ color: T.muted, fontSize: 12 }}>
            복구 세션을 확인하는 중입니다...
          </div>
        )}

        {phase === 'success' && (
          <a
            href="/auth"
            style={{
              minHeight: 44,
              padding: '12px 16px',
              background: T.acc,
              color: '#fff',
              borderRadius: 10,
              textDecoration: 'none',
              fontWeight: 800,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            로그인으로 이동
          </a>
        )}

        {(phase === 'invalid' || phase === 'error') && (
          <div style={{ display: 'flex', gap: 8 }}>
            <a
              href="/auth"
              style={{
                flex: 1,
                minHeight: 44,
                padding: '12px 14px',
                background: T.acc,
                color: '#fff',
                borderRadius: 10,
                textDecoration: 'none',
                fontWeight: 800,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              재설정 메일 다시 받기
            </a>
            <a
              href="/"
              style={{
                minHeight: 44,
                padding: '12px 14px',
                border: `1px solid ${T.border}`,
                color: T.muted,
                borderRadius: 10,
                textDecoration: 'none',
                fontWeight: 700,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              홈
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
