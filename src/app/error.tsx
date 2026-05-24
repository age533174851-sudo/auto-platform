'use client';
import React, { useEffect } from 'react';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[TRAIGO Error]', error.message);
    console.error('[TRAIGO Stack]', error.stack);
  }, [error]);

  const msg   = error?.message || '알 수 없는 오류가 발생했습니다';
  const stack = error?.stack?.split('\n').slice(0, 5).join('\n') || '';
  const digest= error?.digest || '';

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#060B14',
      color: '#E2E8F0',
      padding: '24px',
      fontFamily: 'system-ui, -apple-system, sans-serif',
    }}>
      <div style={{ fontSize: 48, marginBottom: 16 }}>⚠️</div>
      <div style={{ fontWeight: 900, fontSize: 18, color: '#EF4444', marginBottom: 8 }}>
        오류가 발생했습니다
      </div>
      <div style={{
        background: '#0A1628',
        border: '2px solid #EF4444',
        borderRadius: 12,
        padding: 20,
        maxWidth: 400,
        width: '100%',
        marginBottom: 16,
        fontFamily: 'monospace',
      }}>
        <div style={{ color: '#F59E0B', fontSize: 11, fontWeight: 700, marginBottom: 6 }}>
          ERROR MESSAGE:
        </div>
        <div style={{ color: '#FCA5A5', fontSize: 13, wordBreak: 'break-word', lineHeight: 1.6, marginBottom: 12 }}>
          {msg}
        </div>
        {stack && (
          <>
            <div style={{ color: '#F59E0B', fontSize: 10, fontWeight: 700, marginBottom: 4 }}>
              STACK TRACE:
            </div>
            <div style={{ color: '#94A3B8', fontSize: 9, whiteSpace: 'pre-wrap', lineHeight: 1.5, maxHeight: 150, overflow: 'auto' }}>
              {stack}
            </div>
          </>
        )}
        {digest && (
          <div style={{ color: '#475569', fontSize: 9, marginTop: 8 }}>Digest: {digest}</div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <button
          onClick={reset}
          style={{
            padding: '12px 28px',
            background: 'linear-gradient(135deg, #2563EB, #7C3AED)',
            color: '#fff',
            border: 'none',
            borderRadius: 12,
            fontWeight: 700,
            fontSize: 14,
            cursor: 'pointer',
          }}
        >
          🔄 다시 시도
        </button>
        <button
          onClick={() => { if (typeof window !== 'undefined') window.location.href = '/'; }}
          style={{
            padding: '12px 28px',
            background: 'transparent',
            color: '#94A3B8',
            border: '1px solid #1A2D4A',
            borderRadius: 12,
            fontWeight: 700,
            fontSize: 14,
            cursor: 'pointer',
          }}
        >
          🏠 홈으로
        </button>
      </div>
      <div style={{ marginTop: 16, color: '#475569', fontSize: 10, textAlign: 'center', maxWidth: 300 }}>
        이 화면이 반복된다면 위 오류 메시지를 캡처하여 개발팀에 전달해 주세요.
      </div>
    </div>
  );
}
