'use client';
import React from 'react';

interface Props {
  children: React.ReactNode;
  fallback?: React.ReactNode;
  onHome?: () => void;
}
interface State {
  hasError: boolean;
  error?:   Error;
  isChunk:  boolean;
  reloadAttempted: boolean;
}

/* Detect "Loading chunk N failed" or webpack chunk errors */
function isChunkError(error: any): boolean {
  if (!error) return false;
  const msg = String(error?.message || error || '');
  const name = String(error?.name || '');
  return (
    name === 'ChunkLoadError' ||
    /Loading chunk\s+\S+\s+failed/i.test(msg) ||
    /Loading CSS chunk/i.test(msg) ||
    /failed to fetch dynamically imported module/i.test(msg)
  );
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, isChunk: false, reloadAttempted: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      error,
      isChunk: isChunkError(error),
      reloadAttempted: false,
    };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error.message, info.componentStack?.slice(0, 200));
    // Auto-recover from chunk errors: clear SW cache + hard reload once.
    if (isChunkError(error) && typeof window !== 'undefined') {
      try {
        const key = 'tg_chunk_reload_v1';
        const last = Number(sessionStorage.getItem(key) || '0');
        const now  = Date.now();
        // Only auto-reload if we haven't tried in last 30s (prevent infinite loop)
        if (now - last > 30_000) {
          sessionStorage.setItem(key, String(now));
          // Tell SW to wipe caches, then hard reload
          const reload = () => window.location.reload();
          if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
            // Listen for cache-cleared ack
            const onMsg = (e: MessageEvent) => {
              if (e.data?.type === 'CACHE_CLEARED') {
                navigator.serviceWorker.removeEventListener('message', onMsg);
                reload();
              }
            };
            navigator.serviceWorker.addEventListener('message', onMsg);
            navigator.serviceWorker.controller.postMessage({ type: 'CLEAR_CACHE' });
            // Fallback: reload even if no ack within 1.2s
            setTimeout(reload, 1200);
          } else {
            setTimeout(reload, 600);
          }
        }
      } catch {}
    }
  }

  retry = () => {
    this.setState({ hasError: false, error: undefined, isChunk: false });
  };

  hardReload = () => {
    try { sessionStorage.removeItem('tg_chunk_reload_v1'); } catch {}
    if (typeof window !== 'undefined') window.location.reload();
  };

  render() {
    if (!this.state.hasError) return this.props.children;
    if (this.props.fallback) return this.props.fallback;
    return (
      <PageErrorFallback
        message={this.state.error?.message}
        isChunk={this.state.isChunk}
        onRetry={this.retry}
        onReload={this.hardReload}
        onHome={this.props.onHome}
      />
    );
  }
}

export function PageErrorFallback({
  message,
  isChunk,
  onRetry,
  onReload,
  onHome,
}: {
  message?: string;
  isChunk?: boolean;
  onRetry?: () => void;
  onReload?: () => void;
  onHome?: () => void;
}) {
  const T = {
    bg:'#060B14', card:'#0F1924', border:'#1A2D4A', txt:'#F0F6FF',
    muted:'#475569', red:'#EF4444', ylw:'#F59E0B',
    acl:'#3B82F6', acg:'rgba(37,99,235,.15)',
  };
  return (
    <div style={{ padding:'32px 20px', textAlign:'center',
      display:'flex', flexDirection:'column', alignItems:'center', gap:16,
      minHeight:'60vh', justifyContent:'center' }}>
      <div style={{ fontSize:40 }}>{isChunk ? '' : '⚠️'}</div>
      <div style={{ color:T.txt, fontWeight:800, fontSize:16 }}>
        {isChunk ? '새 버전이 배포되었습니다' : '페이지 로딩 오류'}
      </div>
      <div style={{ color:T.muted, fontSize:13, lineHeight:1.7, maxWidth:320 }}>
        {isChunk
          ? '잠시 후 자동으로 새로고침됩니다. 안되면 아래 버튼을 누르세요.'
          : '이 화면을 불러오는 중 문제가 발생했습니다. 다시 시도하거나 홈으로 돌아가세요.'}
        {message && <div style={{ fontSize:10, color:T.red, marginTop:8,
          fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums', wordBreak:'break-word' }}>{message}</div>}
      </div>
      <div style={{ display:'flex', gap:10, flexWrap:'wrap', justifyContent:'center' }}>
        {isChunk && onReload && (
          <button type="button" onClick={onReload}
            style={{ padding:'10px 20px', borderRadius:10, cursor:'pointer',
              background:T.acg, color:T.acl, border:`1px solid ${T.acl}40`,
              fontWeight:700, fontSize:13, minHeight:44 }}>
            새로고침
          </button>
        )}
        {!isChunk && onRetry && (
          <button type="button" onClick={onRetry}
            style={{ padding:'10px 20px', borderRadius:10, cursor:'pointer',
              background:T.acg, color:T.acl, border:`1px solid ${T.acl}40`,
              fontWeight:700, fontSize:13, minHeight:44 }}>
            다시 시도
          </button>
        )}
        {onHome && (
          <button type="button" onClick={onHome}
            style={{ padding:'10px 20px', borderRadius:10, cursor:'pointer',
              background:T.card, color:T.txt, border:`1px solid ${T.border}`,
              fontWeight:700, fontSize:13, minHeight:44 }}>
            홈으로
          </button>
        )}
      </div>
    </div>
  );
}

export default ErrorBoundary;
