'use client';
// LoginModal — 어디서든 뜨는 로그인 바텀시트. Google/이메일/MOCK 체험.
import React, { useState } from 'react';
import { T } from '@/lib/constants';
import { X, Mail, ArrowRight, Loader2 } from 'lucide-react';
import { sbSignInWithOAuth, sbSignIn } from '@/lib/supabase';
import { notifyError } from '@/lib/notify/center';

export default function LoginModal({
  open, reason, onClose, onSuccess, onGoEmail,
}: {
  open: boolean;
  reason?: string;               // "포트폴리오 저장" 등 — 로그인 필요 사유
  onClose: () => void;
  onSuccess?: () => void;        // 로그인 성공 후 원래 동작 복귀
  onGoEmail?: () => void;        // 이메일 로그인 화면으로
}) {
  const [loading, setLoading] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [showEmail, setShowEmail] = useState(false);
  const [err, setErr] = useState('');

  if (!open) return null;

  const google = async () => {
    setLoading('google'); setErr('');
    const { error } = await sbSignInWithOAuth('google');
    if (error) { setErr(error); setLoading(null); notifyError('Google 로그인 실패', error); }
    // 성공 시 OAuth 리다이렉트로 페이지 이동됨
  };

  const emailLogin = async () => {
    if (!email || !pw) { setErr('이메일과 비밀번호를 입력하세요.'); return; }
    setLoading('email'); setErr('');
    try {
      const { error } = await sbSignIn(email, pw);
      if (error) { setErr(typeof error === 'string' ? error : '로그인 실패 — 이메일/비밀번호를 확인하세요.'); setLoading(null); return; }
      setLoading(null); onClose(); onSuccess && onSuccess();
    } catch (e: any) { setErr(e?.message || '로그인 중 오류'); setLoading(null); }
  };

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', zIndex: 10070, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} role="dialog" aria-modal="true"
        style={{ width: '100%', maxWidth: 460, background: T.bg, borderTopLeftRadius: 24, borderTopRightRadius: 24, borderTop: `1px solid ${T.border2}`, padding: '10px 20px 28px', animation: 'tg-login-up .24s ease-out', maxHeight: '92vh', overflowY: 'auto' }}>
        <style>{`@keyframes tg-login-up{from{transform:translateY(100%)}to{transform:translateY(0)}}@keyframes tg-spin{to{transform:rotate(360deg)}}`}</style>

        <div style={{ display: 'flex', justifyContent: 'center', padding: '4px 0 14px', position: 'relative' }}>
          <div style={{ width: 40, height: 4, borderRadius: 2, background: T.border }} />
          <button onClick={onClose} aria-label="닫기" style={{ position: 'absolute', right: 0, top: 0, background: 'none', border: 'none', cursor: 'pointer', padding: 6 }}><X size={20} color={T.muted} /></button>
        </div>

        <div style={{ textAlign: 'center', marginBottom: 6 }}>
          <div style={{ width: 44, height: 44, borderRadius: 12, background: `linear-gradient(135deg,${T.acc},${T.prp})`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 900, fontSize: 20, color: '#fff', margin: '0 auto 12px' }}>T</div>
          <div style={{ color: T.txt, fontWeight: 900, fontSize: 20 }}>TRAIGO 시작하기</div>
          <div style={{ color: T.muted, fontSize: 12.5, marginTop: 6, lineHeight: 1.5 }}>
            {reason ? `${reason}에는 로그인이 필요해요.` : '로그인하고 모든 기능을 이용하세요.'}
          </div>
        </div>

        {err && <div style={{ background: T.red + '15', border: `1px solid ${T.red}30`, borderRadius: 10, padding: '10px 12px', color: T.red, fontSize: 12, margin: '14px 0 4px', textAlign: 'center' }}>{err}</div>}

        <div style={{ marginTop: 18 }}>
          {/* Google */}
          <button onClick={google} disabled={!!loading}
            style={{ width: '100%', minHeight: 52, background: '#fff', color: '#1F1F1F', border: 'none', borderRadius: 13, fontWeight: 700, fontSize: 15, cursor: loading ? 'default' : 'pointer', marginBottom: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9 }}>
            {loading === 'google' ? <Loader2 size={18} style={{ animation: 'tg-spin .8s linear infinite' }} /> : (
              <svg width="19" height="19" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.8-6.8C35.6 2.4 30.1 0 24 0 14.6 0 6.4 5.4 2.5 13.3l7.9 6.1C12.2 13.7 17.6 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.6c0-1.6-.1-3.1-.4-4.6H24v9.1h12.4c-.5 2.9-2.1 5.3-4.6 7l7.1 5.5c4.2-3.9 6.6-9.6 6.6-16z"/><path fill="#FBBC05" d="M10.4 28.6c-.5-1.4-.8-2.9-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C.9 16.5 0 20.1 0 24s.9 7.5 2.5 10.7l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.1 0 11.3-2 15-5.5l-7.1-5.5c-2 1.4-4.6 2.2-7.9 2.2-6.4 0-11.8-4.2-13.6-9.9l-7.9 6.1C6.4 42.6 14.6 48 24 48z"/></svg>
            )}
            Google로 계속하기
          </button>

          {/* 이메일 토글 */}
          {!showEmail ? (
            <button onClick={() => setShowEmail(true)} disabled={!!loading}
              style={{ width: '100%', minHeight: 52, background: T.card, color: T.txt, border: `1px solid ${T.border}`, borderRadius: 13, fontWeight: 700, fontSize: 15, cursor: 'pointer', marginBottom: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9 }}>
              <Mail size={18} color={T.acl} /> 이메일로 로그인
            </button>
          ) : (
            <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 13, padding: '14px', marginBottom: 10 }}>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="이메일" autoComplete="email"
                style={{ width: '100%', minHeight: 44, background: T.alt, border: `1px solid ${T.border}`, borderRadius: 10, padding: '0 12px', color: T.txt, fontSize: 14, marginBottom: 8, boxSizing: 'border-box' }} />
              <input type="password" value={pw} onChange={e => setPw(e.target.value)} placeholder="비밀번호" autoComplete="current-password"
                onKeyDown={e => { if (e.key === 'Enter') emailLogin(); }}
                style={{ width: '100%', minHeight: 44, background: T.alt, border: `1px solid ${T.border}`, borderRadius: 10, padding: '0 12px', color: T.txt, fontSize: 14, marginBottom: 10, boxSizing: 'border-box' }} />
              <button onClick={emailLogin} disabled={!!loading}
                style={{ width: '100%', minHeight: 46, background: `linear-gradient(135deg,${T.acc},${T.prp})`, color: '#fff', border: 'none', borderRadius: 10, fontWeight: 800, fontSize: 14, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7 }}>
                {loading === 'email' ? <Loader2 size={17} style={{ animation: 'tg-spin .8s linear infinite' }} /> : <>로그인 <ArrowRight size={16} /></>}
              </button>
              {onGoEmail && (
                <button onClick={() => { onClose(); onGoEmail(); }}
                  style={{ width: '100%', background: 'none', border: 'none', color: T.muted, fontSize: 11.5, cursor: 'pointer', marginTop: 10, padding: 6 }}>
                  비밀번호 찾기 · 회원가입
                </button>
              )}
            </div>
          )}

          {/* MOCK 체험 */}
          <button onClick={onClose}
            style={{ width: '100%', minHeight: 48, background: 'transparent', color: T.acl, border: `1px solid ${T.border}`, borderRadius: 13, fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>
            로그인 없이 둘러보기 (모의투자 체험)
          </button>
        </div>

        <div style={{ color: T.muted, fontSize: 11, textAlign: 'center', marginTop: 14, lineHeight: 1.5 }}>
          시장 보기·아카데미·모의투자는 로그인 없이 가능해요.<br />실전 거래·API 연결·자산 저장은 로그인 후 이용할 수 있어요.
        </div>
      </div>
    </div>
  );
}
