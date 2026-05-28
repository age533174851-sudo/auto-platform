'use client';
import React, { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[TRAIGO Root Error]', error);
  }, [error]);

  return (
    <html lang="ko">
      <body style={{ background: '#060B14', margin: 0, fontFamily: 'monospace', color: '#E2E8F0' }}>
        <div style={{ minHeight:'100vh', display:'flex', flexDirection:'column',
          alignItems:'center', justifyContent:'center', padding:24 }}>
          <div style={{ fontSize:40, marginBottom:12 }}>⚠️</div>
          <div style={{ color:'#EF4444', fontWeight:900, fontSize:18, marginBottom:8 }}>
            Root Error
          </div>
          <div style={{ background:'#0F1924', border:'1px solid #EF4444', borderRadius:10,
            padding:16, maxWidth:380, width:'100%', marginBottom:16 }}>
            <div style={{ color:'#E2E8F0', fontSize:12, wordBreak:'break-word', lineHeight:1.6 }}>
              {error.message}
            </div>
            <div style={{ color:'#94A3B8', fontSize:10, marginTop:8, whiteSpace:'pre-wrap' }}>
              {error.stack?.split('\n').slice(0,5).join('\n')}
            </div>
          </div>
          <button onClick={reset}
            style={{ padding:'10px 24px', background:'#2563EB', color:'#fff',
              border:'none', borderRadius:10, fontWeight:700, cursor:'pointer' }}>
            다시 시도
          </button>
        </div>
      </body>
    </html>
  );
}
