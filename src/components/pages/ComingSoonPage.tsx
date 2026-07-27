'use client';
import React from 'react';
import { T } from '@/lib/constants';

export default function ComingSoonPage({
  featureName = '이 기능',
  onHome,
  onBack,
}: {
  featureName?: string;
  onHome?: () => void;
  onBack?: () => void;
}) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      minHeight: '60vh', padding: '32px 20px', textAlign: 'center',
    }}>
      <div style={{ fontSize: 56, marginBottom: 16 }}>🚧</div>
      <div style={{ color: T.txt, fontWeight: 900, fontSize: 20, marginBottom: 8 }}>
        준비중입니다
      </div>
      <div style={{ color: T.muted, fontSize: 14, lineHeight: 1.7, marginBottom: 28 }}>
        <strong style={{ color: T.acl }}>{featureName}</strong> 기능은 현재 업데이트 중입니다.<br />
        곧 멋진 모습으로 찾아올게요!
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            style={{
              padding: '11px 22px', borderRadius: 12, cursor: 'pointer',
              background: 'transparent', color: T.muted,
              border: `1px solid ${T.border}`, fontWeight: 700, fontSize: 13,
            }}
          >
            ← 뒤로
          </button>
        )}
        {onHome && (
          <button
            type="button"
            onClick={onHome}
            style={{
              padding: '11px 22px', borderRadius: 12, cursor: 'pointer',
              background: T.acg, color: T.acl,
              border: `1px solid ${T.acl}40`, fontWeight: 700, fontSize: 13,
            }}
          >
            🏠 홈으로
          </button>
        )}
      </div>
    </div>
  );
}
