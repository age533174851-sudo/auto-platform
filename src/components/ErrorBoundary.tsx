
'use client';
import React from 'react';

interface State { hasError: boolean; error: Error | null; info: string; }

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback?: React.ReactNode },
  State
> {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false, error: null, info: '' };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, info: '' };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[TRAIGO ErrorBoundary] ERROR:', error.message);
    console.error('[TRAIGO ErrorBoundary] STACK:', error.stack);
    console.error('[TRAIGO ErrorBoundary] COMPONENT:', info.componentStack);
    this.setState({ info: info.componentStack || '' });
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      const msg = this.state.error?.message || '알 수 없는 오류';
      const stack = this.state.error?.stack?.split('\n').slice(0,4).join('\n') || '';
      return (
        <div style={{
          minHeight: '100vh', display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          background: '#060B14', color: '#E2E8F0',
          padding: 24, textAlign: 'center', fontFamily: 'monospace',
        }}>
          <div style={{fontSize: 40, marginBottom: 12}}>⚠️</div>
          <div style={{fontWeight: 800, fontSize: 16, color: '#EF4444', marginBottom: 8}}>
            Client-side Exception
          </div>
          <div style={{
            background: '#0F1924', border: '1px solid #EF4444',
            borderRadius: 10, padding: 16, maxWidth: 360, width: '100%',
            textAlign: 'left', marginBottom: 16,
          }}>
            <div style={{color: '#F59E0B', fontSize: 13, fontWeight: 700, marginBottom: 6}}>
              Error:
            </div>
            <div style={{color: '#E2E8F0', fontSize: 12, wordBreak: 'break-word', lineHeight: 1.5}}>
              {msg}
            </div>
            {stack && (
              <>
                <div style={{color: '#F59E0B', fontSize: 11, fontWeight: 700, marginTop: 10, marginBottom: 4}}>
                  Stack:
                </div>
                <div style={{color: '#94A3B8', fontSize: 10, whiteSpace: 'pre-wrap', lineHeight: 1.4}}>
                  {stack}
                </div>
              </>
            )}
          </div>
          <button
            onClick={() => { this.setState({ hasError: false, error: null, info: '' }); if (typeof window !== 'undefined') window.location.reload(); }}
            style={{
              padding: '10px 24px', background: '#2563EB',
              color: '#fff', border: 'none', borderRadius: 12,
              fontWeight: 700, fontSize: 14, cursor: 'pointer',
            }}
          >
            🔄 새로고침
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
