'use client';
import React from 'react';

interface Props {
  children: React.ReactNode;
  fallback?: React.ReactNode;
  onHome?: () => void;
}
interface State { hasError: boolean; error?: Error }

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error.message, info.componentStack?.slice(0, 200));
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    if (this.props.fallback) return this.props.fallback;
    return (
      <PageErrorFallback
        message={this.state.error?.message}
        onRetry={() => this.setState({ hasError: false })}
        onHome={this.props.onHome}
      />
    );
  }
}

export function PageErrorFallback({
  message,
  onRetry,
  onHome,
}: {
  message?: string;
  onRetry?: () => void;
  onHome?: () => void;
}) {
  const T = { bg:'#060B14', card:'#0F1924', border:'#1A2D4A', txt:'#F0F6FF',
               muted:'#475569', red:'#EF4444', acl:'#3B82F6', acg:'rgba(37,99,235,.15)' };
  return (
    <div style={{ padding:'32px 20px', textAlign:'center',
      display:'flex', flexDirection:'column', alignItems:'center', gap:16 }}>
      <div style={{ fontSize:40 }}>⚠️</div>
      <div style={{ color:T.txt, fontWeight:800, fontSize:16 }}>페이지 로딩 오류</div>
      <div style={{ color:T.muted, fontSize:13, lineHeight:1.7, maxWidth:300 }}>
        이 화면을 불러오는 중 문제가 발생했습니다.<br/>
        {message && <span style={{ fontSize:11, color:T.red }}>{message}</span>}
      </div>
      <div style={{ display:'flex', gap:10 }}>
        {onRetry && (
          <button type="button" onClick={onRetry}
            style={{ padding:'10px 20px', borderRadius:10, cursor:'pointer',
              background:T.acg, color:T.acl, border:`1px solid ${T.acl}40`,
              fontWeight:700, fontSize:13 }}>
            🔄 다시 시도
          </button>
        )}
        {onHome && (
          <button type="button" onClick={onHome}
            style={{ padding:'10px 20px', borderRadius:10, cursor:'pointer',
              background:'transparent', color:T.muted, border:`1px solid ${T.border}`,
              fontWeight:700, fontSize:13 }}>
            🏠 홈으로
          </button>
        )}
        {!onRetry && !onHome && (
          <button type="button" onClick={() => window.location.reload()}
            style={{ padding:'10px 20px', borderRadius:10, cursor:'pointer',
              background:T.acg, color:T.acl, border:`1px solid ${T.acl}40`,
              fontWeight:700, fontSize:13 }}>
            🔄 새로고침
          </button>
        )}
      </div>
    </div>
  );
}
