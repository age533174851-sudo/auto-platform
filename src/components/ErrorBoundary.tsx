
'use client';
import React from 'react';

interface State { hasError: boolean; error: Error | null; }

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback?: React.ReactNode },
  State
> {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[TRAIGO ErrorBoundary]', error, info);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div style={{
          minHeight: '100vh', display: 'flex', alignItems: 'center',
          justifyContent: 'center', background: '#060B14', color: '#E2E8F0',
          flexDirection: 'column', gap: 16, padding: 24, textAlign: 'center',
        }}>
          <div style={{fontSize: 40}}>⚠️</div>
          <div style={{fontWeight: 800, fontSize: 18}}>오류가 발생했습니다</div>
          <div style={{color: '#94A3B8', fontSize: 13, maxWidth: 360, lineHeight: 1.6}}>
            {this.state.error?.message || '알 수 없는 오류'}
          </div>
          <button
            onClick={() => { this.setState({ hasError: false, error: null }); window.location.reload(); }}
            style={{
              marginTop: 8, padding: '10px 24px',
              background: 'linear-gradient(135deg,#2563EB,#7C3AED)',
              color: '#fff', border: 'none', borderRadius: 12,
              fontWeight: 700, fontSize: 14, cursor: 'pointer',
            }}
          >
            다시 시도
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
