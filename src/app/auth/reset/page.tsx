'use client';
// ─────────────────────────────────────────────────────────────
// /auth/reset — 비밀번호 재설정 메일이 **착지하는** 화면
// ─────────────────────────────────────────────────────────────
//
// 이 파일이 없어서 난 고장
// ────────────────────────
// `sbResetPassword`는 오래전부터 메일을 `${origin}/auth/reset`으로 보내고
// 있었다(`lib/supabase.ts`). 그런데 `src/app/auth/`에는 `page.tsx`와
// `callback/page.tsx`뿐이었다 — **착지 페이지가 없었다.** 사용자는 메일을
// 정상으로 받고, 링크를 누르고, Next.js 404를 봤다. 메일 발송 문제가
// 아니었다.
//
// 이 저장소가 이름 붙인 1번 고장이다: 만들어 놓고 배선을 안 함. 요청
// 쪽(`sbResetPassword`)과 변경 쪽(`sbUpdatePassword`)은 둘 다 있었고
// 그 사이만 비어 있었다. `sbUpdatePassword`는 "보안 설정" 화면에서만
// 불렸는데, 그 화면은 **이미 로그인한 사람**만 닿을 수 있다 — 비밀번호를
// 잊은 사람은 정의상 거기 갈 수 없다.
//
// implicit flow다 (확인하고 적는다)
// ─────────────────────────────────
// `getSupabaseClient()`가 `flowType`을 지정하지 않고 auth-js 2.108.2의
// 기본값이 `'implicit'`이다. 복구 토큰은 **URL 해시**로 오고
// `detectSessionInUrl: true`가 그것을 소비해 세션을 만든다.
// `?code=` + `exchangeCodeForSession`(PKCE) 예제를 붙이면 안 된다.
//
// 해시를 **렌더 중에** 잡는다
// ───────────────────────────
// SDK는 클라이언트를 만들 때 해시를 읽고 **주소창에서 지운다.** 루트
// 레이아웃의 `SessionCookieSync`도 같은 클라이언트를 만든다. effect는
// 자식이 먼저 돌지만 거기 기대지 않는다 — `useState` 초기화는 어떤
// effect보다 먼저 돌므로 거기서 잡는다. 그리고 `onAuthStateChange`의
// `PASSWORD_RECOVERY`도 같이 듣는다(둘 중 하나만 늦어도 살아남게).
//
// 판단은 여기 없다
// ────────────────
// 착지 판정·저장 판정·복귀 경로는 `lib/auth/recoveryLink.ts`에 있고 시험이
// 붙어 있다. 만료 링크를 화면으로 확인하려면 한 시간을 기다려야 한다.
import React, { useEffect, useRef, useState } from 'react';
import { T } from '@/lib/constants';
import { checkPasswordStrength, getKoreanError, isValidEmail } from '@/lib/auth';
import {
  readRecoveryLink, judgeNewPassword, safeReturnPath, recoveryPhaseOf,
  type RecoveryLinkVerdict,
} from '@/lib/auth/recoveryLink';

// 'saving'·'done'만 이 화면의 것이고, 나머지 셋은 `recoveryPhaseOf`가 정한다.
// 단계 계산을 여기 두면 시험이 닿지 못한다 — 실제로 뮤테이션 2건이 그 자리로
// 새 나갔다(MUT-AR18 · MUT-AR21).
type Phase = 'checking' | 'ready' | 'saving' | 'done' | 'blocked';

/** 세션이 생기기를 기다리는 한도. 넘으면 "확인 못 함"으로 끝낸다 */
const SESSION_WAIT_MS = 6000;

export default function ResetPasswordPage() {
  // ★ 렌더 중에 잡는다. effect로 미루면 SDK가 먼저 지울 수 있다.
  const [landed] = useState<{ hash: string; query: string }>(() => {
    if (typeof window === 'undefined') return { hash: '', query: '' };
    return { hash: window.location.hash || '', query: window.location.search || '' };
  });
  const [verdict] = useState<RecoveryLinkVerdict>(() => readRecoveryLink(landed));

  /** 세션이 생겼는가 · 기다리다 말았는가 — 이 둘만 화면이 관찰한다 */
  const [sessionUser, setSessionUser] = useState(false);
  const [waitedOut, setWaitedOut] = useState(false);
  /** 저장·완료는 화면의 단계다. null이면 아래 계산값을 쓴다 */
  const [localPhase, setLocalPhase] = useState<'saving' | 'done' | null>(null);

  // ★ 단계와 "저장해도 되는가"가 **같은 곳에서 나온다.**
  //   두 곳에 두면 한쪽만 바뀌고, 그때 세션 없이 저장이 열린다.
  const computed = recoveryPhaseOf({
    linkCode: verdict.code,
    awaitsSession: verdict.awaitsSession,
    hasSessionUser: sessionUser,
    waitedOut,
  });
  const phase: Phase = localPhase ?? computed.phase;
  const [message, setMessage] = useState<string>(verdict.message);
  const [email, setEmail] = useState<string | null>(null);

  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [show, setShow] = useState(false);

  // 링크를 다시 받기
  const [resendTo, setResendTo] = useState('');
  const [resending, setResending] = useState(false);
  const [resendNote, setResendNote] = useState<string | null>(null);

  const strength = checkPasswordStrength(pw);
  const mounted = useRef(true);

  // ── 주소창에서 토큰을 지운다 ──
  //
  // 해시는 서버로 가지 않지만 화면 캡처·공유·브라우저 기록에는 남는다.
  // 값은 이미 위에서 잡았으므로 주소창에 둘 이유가 없다.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!window.location.hash && !window.location.search) return;
    try {
      window.history.replaceState(null, '', window.location.pathname);
    } catch { /* 지우지 못해도 흐름은 계속된다 */ }
  }, []);

  // ── 복구 세션을 기다린다 ──
  useEffect(() => {
    mounted.current = true;
    if (!verdict.awaitsSession) return;

    let settled = false;
    let unsub: (() => void) | null = null;
    let timer: any = null;

    const succeed = (mail: string | null) => {
      if (settled || !mounted.current) return;
      settled = true;
      setEmail(mail);
      // **'ready'를 직접 쓰지 않는다.** 세션을 봤다는 사실만 적고, 단계는
      // `recoveryPhaseOf`가 정한다.
      setSessionUser(true);
      setMessage('새 비밀번호를 입력해 주세요.');
    };
    const give_up = (msg: string) => {
      if (settled || !mounted.current) return;
      settled = true;
      setWaitedOut(true);
      setMessage(msg);
    };

    (async () => {
      try {
        const { getSupabaseClient } = await import('@/lib/supabase/client');
        const sb = getSupabaseClient();
        if (!sb) { give_up('Supabase가 구성되지 않았습니다.'); return; }

        // ① 늦게 도착하는 경우를 위해 먼저 듣는다.
        const { data } = sb.auth.onAuthStateChange((event: string, session: any) => {
          if (event === 'PASSWORD_RECOVERY' || session?.user) {
            succeed(session?.user?.email ?? null);
          }
        });
        unsub = () => { try { data?.subscription?.unsubscribe(); } catch {} };

        // ② PKCE로 바뀐 배포를 위해 코드가 있으면 교환한다.
        //    지금 이 프로젝트는 implicit이라 보통 여기 안 들어온다.
        if (verdict.exchangeCode) {
          try {
            const r = await (sb.auth as any).exchangeCodeForSession(verdict.exchangeCode);
            // **오류 내용을 그대로 적지 않는다** — 코드 조각이 섞여 나올 수 있다.
            if (r?.error) { give_up('재설정 링크를 확인하지 못했습니다. 새 링크를 받아 주세요.'); return; }
          } catch {
            give_up('재설정 링크를 확인하지 못했습니다. 새 링크를 받아 주세요.');
            return;
          }
        }

        // ③ 이미 처리됐을 수도 있다.
        const { data: got } = await sb.auth.getSession();
        if (got?.session?.user) { succeed(got.session.user.email ?? null); return; }

        // ④ 한도까지 기다린다. **못 기다린 것을 "성공"으로 적지 않는다.**
        timer = setTimeout(() => {
          give_up('재설정 세션이 만들어지지 않았습니다. 링크가 만료되었을 수 있습니다 — '
            + '아래에서 새 링크를 받아 주세요.');
        }, SESSION_WAIT_MS);
      } catch {
        give_up('재설정 링크 처리 중 오류가 발생했습니다.');
      }
    })();

    return () => {
      mounted.current = false;
      if (timer) clearTimeout(timer);
      if (unsub) unsub();
    };
  }, [verdict.awaitsSession, verdict.exchangeCode]);

  // ── 저장 ──
  const save = async () => {
    const v = judgeNewPassword({
      password: pw, confirm: pw2,
      // ★ 화면이 다시 판단하지 않는다. 단계와 같은 계산에서 나온 값이다.
      hasRecoverySession: computed.canSave,
      strengthOk: strength.isValid,
    });
    if (!v.ok) { setMessage(v.message); return; }

    setLocalPhase('saving');
    setMessage('저장하고 있습니다...');
    try {
      const { getSupabaseClient } = await import('@/lib/supabase/client');
      const sb = getSupabaseClient();
      if (!sb) { setLocalPhase(null); setMessage('Supabase가 구성되지 않았습니다.'); return; }

      const { error } = await sb.auth.updateUser({ password: pw });
      if (error) {
        setLocalPhase(null);
        setMessage(getKoreanError(error.message));
        return;
      }

      // ★ 복구 세션을 남기지 않는다.
      //
      //   `updateUser`가 성공해도 복구 세션은 살아 있다. 그대로 두면
      //   "메일 링크로 들어온 상태"가 평소 로그인과 섞인다. 새 비밀번호로
      //   다시 로그인하게 하는 편이 경계가 분명하다.
      try { await sb.auth.signOut(); } catch { /* 실패해도 아래로 간다 */ }

      setPw(''); setPw2('');
      setLocalPhase('done');
      setMessage('비밀번호가 변경되었습니다. 새 비밀번호로 로그인해 주세요.');
    } catch {
      setLocalPhase(null);
      setMessage('저장 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.');
    }
  };

  // ── 링크 다시 받기 ──
  const resend = async () => {
    if (!isValidEmail(resendTo)) { setResendNote('올바른 이메일을 입력해 주세요.'); return; }
    setResending(true);
    setResendNote(null);
    try {
      const { sbResetPassword } = await import('@/lib/supabase');
      const { error } = await sbResetPassword(resendTo);
      setResendNote(error
        ? getKoreanError(error)
        : '재설정 메일을 다시 보냈습니다. 메일함을 확인해 주세요.');
    } catch {
      setResendNote('메일을 보내지 못했습니다. 잠시 후 다시 시도해 주세요.');
    } finally { setResending(false); }
  };

  const backTo = safeReturnPath(
    typeof window !== 'undefined'
      ? new URLSearchParams(landed.query).get('next')
      : null);

  const accent =
    phase === 'done' ? T.grn :
    phase === 'blocked' ? T.red :
    T.acl;

  const title =
    phase === 'done' ? '✓ 변경 완료' :
    phase === 'blocked' ? '링크를 사용할 수 없습니다' :
    phase === 'checking' ? '확인 중...' :
    '새 비밀번호 설정';

  return (
    <div style={{
      minHeight: '100vh', background: T.bg, color: T.txt,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 16, fontFamily: "'Sora', sans-serif",
    }}>
      <div data-testid="auth-reset-card" style={{
        background: T.card, border: `1px solid ${T.border}`,
        borderRadius: 20, padding: 24, maxWidth: 420, width: '100%',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 12, flexShrink: 0,
            background: accent + '22', border: `1px solid ${accent}55`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: accent, fontWeight: 900, fontSize: 18,
          }}>
            {phase === 'done' ? '✓' : phase === 'blocked' ? '!' : '🔑'}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ color: T.txt, fontWeight: 800, fontSize: 16 }}>{title}</div>
            {email && (
              <div style={{ color: T.muted, fontSize: 11, overflow: 'hidden',
                textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{email}</div>
            )}
          </div>
        </div>

        <div data-testid="auth-reset-message" style={{
          color: phase === 'blocked' ? T.red : T.muted,
          fontSize: 12.5, lineHeight: 1.65, marginBottom: 16,
        }}>{message}</div>

        {/* ── 새 비밀번호 ── */}
        {(phase === 'ready' || phase === 'saving') && (
          <div data-testid="auth-reset-form">
            <div style={{ marginBottom: 12 }}>
              <div style={{ color: T.muted, fontSize: 11, fontWeight: 700, marginBottom: 5 }}>
                새 비밀번호
              </div>
              <div style={{ position: 'relative' }}>
                <input
                  type={show ? 'text' : 'password'}
                  value={pw}
                  onChange={e => setPw(e.target.value)}
                  autoComplete="new-password"
                  placeholder="새 비밀번호"
                  style={{
                    width: '100%', background: T.bg, border: `1px solid ${T.border}`,
                    borderRadius: 10, padding: '12px 52px 12px 14px', color: T.txt,
                    fontSize: 16, outline: 'none',
                  }}/>
                <button
                  type="button"
                  onClick={() => setShow(s => !s)}
                  style={{
                    position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
                    minHeight: 36, padding: '0 10px', background: 'transparent',
                    border: 'none', color: T.muted, fontSize: 11, fontWeight: 700,
                    cursor: 'pointer',
                  }}>{show ? '숨기기' : '보기'}</button>
              </div>
            </div>

            <div style={{ marginBottom: 12 }}>
              <div style={{ color: T.muted, fontSize: 11, fontWeight: 700, marginBottom: 5 }}>
                새 비밀번호 확인
              </div>
              <input
                type={show ? 'text' : 'password'}
                value={pw2}
                onChange={e => setPw2(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void save(); }}
                autoComplete="new-password"
                placeholder="한 번 더 입력"
                style={{
                  width: '100%', background: T.bg, border: `1px solid ${T.border}`,
                  borderRadius: 10, padding: '12px 14px', color: T.txt,
                  fontSize: 16, outline: 'none',
                }}/>
            </div>

            {/* 조건을 **미리** 보여 준다. 저장을 눌러야 알 수 있게 두지 않는다 */}
            {pw.length > 0 && strength.hints.length > 0 && (
              <ul style={{ margin: '0 0 12px', paddingLeft: 18, color: T.muted, fontSize: 11 }}>
                {strength.hints.map(h => <li key={h} style={{ marginBottom: 2 }}>{h}</li>)}
              </ul>
            )}
            {pw2.length > 0 && pw !== pw2 && (
              <div style={{ color: T.red, fontSize: 11, marginBottom: 12 }}>
                두 비밀번호가 서로 다릅니다.
              </div>
            )}

            <button
              data-testid="auth-reset-submit"
              onClick={() => void save()}
              disabled={phase === 'saving' || !strength.isValid || pw !== pw2 || !pw}
              style={{
                width: '100%', minHeight: 48, padding: '14px',
                background: (strength.isValid && pw === pw2 && pw && phase !== 'saving')
                  ? `linear-gradient(135deg,${T.acc},${T.prp})` : 'var(--t-border2)',
                color: '#fff', border: 'none', borderRadius: 12,
                fontWeight: 800, fontSize: 14, cursor: 'pointer',
              }}>
              {phase === 'saving' ? '저장 중...' : '비밀번호 변경'}
            </button>
          </div>
        )}

        {/* ── 링크를 쓸 수 없을 때: 빈 화면도 404도 보여주지 않는다 ── */}
        {phase === 'blocked' && verdict.offerResend && (
          <div data-testid="auth-reset-resend" style={{
            borderTop: `1px solid ${T.border}`, paddingTop: 16, marginTop: 4,
          }}>
            <div style={{ color: T.txt, fontSize: 12.5, fontWeight: 700, marginBottom: 8 }}>
              재설정 링크 다시 받기
            </div>
            <input
              type="email"
              value={resendTo}
              onChange={e => setResendTo(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void resend(); }}
              placeholder="가입한 이메일"
              autoComplete="email"
              style={{
                width: '100%', background: T.bg, border: `1px solid ${T.border}`,
                borderRadius: 10, padding: '12px 14px', color: T.txt,
                fontSize: 16, outline: 'none', marginBottom: 10,
              }}/>
            <button
              onClick={() => void resend()}
              disabled={resending || !isValidEmail(resendTo)}
              style={{
                width: '100%', minHeight: 48, padding: '13px',
                background: isValidEmail(resendTo) && !resending ? T.acc : 'var(--t-border2)',
                color: '#fff', border: 'none', borderRadius: 12,
                fontWeight: 800, fontSize: 13.5, cursor: 'pointer',
              }}>
              {resending ? '보내는 중...' : '새 링크 보내기'}
            </button>
            {resendNote && (
              <div style={{ color: T.muted, fontSize: 11.5, marginTop: 10, lineHeight: 1.6 }}>
                {resendNote}
              </div>
            )}
          </div>
        )}

        {/* ── 어디로든 나갈 길을 남긴다 ── */}
        <div style={{
          display: 'flex', gap: 8, marginTop: 16,
          borderTop: phase === 'blocked' && verdict.offerResend ? 'none' : `1px solid ${T.border}`,
          paddingTop: phase === 'blocked' && verdict.offerResend ? 0 : 16,
        }}>
          <a href={backTo} style={{
            flex: 1, minHeight: 44, padding: '11px 14px',
            background: phase === 'done' ? T.acc : 'transparent',
            color: phase === 'done' ? '#fff' : T.muted,
            border: phase === 'done' ? 'none' : `1px solid ${T.border}`,
            borderRadius: 10, fontWeight: 700, fontSize: 12.5,
            textDecoration: 'none', display: 'inline-flex',
            alignItems: 'center', justifyContent: 'center',
          }}>로그인 화면으로</a>
          <a href="/" style={{
            flex: 1, minHeight: 44, padding: '11px 14px',
            background: 'transparent', color: T.muted,
            border: `1px solid ${T.border}`, borderRadius: 10,
            fontWeight: 700, fontSize: 12.5, textDecoration: 'none',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          }}>홈으로</a>
        </div>
      </div>
    </div>
  );
}
