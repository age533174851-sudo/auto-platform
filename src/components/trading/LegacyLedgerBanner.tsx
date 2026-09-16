'use client';
// src/components/trading/LegacyLedgerBanner.tsx
//
// **이 화면의 숫자가 정본이 아니라는 것을 화면이 스스로 말한다.**
//
// 브라우저에만 있는 옛 장부를 그냥 숨기지 않는 이유: 사용자가 몇 달 동안
// 적어 온 기록일 수 있다. 지우지도 옮기지도 않고 **읽을 수 있게 두되**,
// 이것이 서버 모의투자·챌린지와 다른 장부라는 사실을 같은 화면에서 읽게
// 한다. 배지를 아래 작은 글씨로 붙이면 사람은 큰 숫자를 먼저 보고 작은
// 글씨는 나중에 본다 — 그래서 위에 둔다.
import React from 'react';
import { legacyLedgerInfo, legacyLedgerNotice, type LegacyLedgerId } from '@/lib/trading/legacyLedger';

export function LegacyLedgerBanner({ id, onGoCanonical }: {
  id: LegacyLedgerId;
  /** 정본 화면으로 보내는 손잡이. 없으면 버튼을 그리지 않는다 */
  onGoCanonical?: () => void;
}) {
  const info = legacyLedgerInfo(id);
  if (!info) return null;
  return (
    <div style={{
      border: '1px solid rgba(245,158,11,0.35)', background: 'rgba(245,158,11,0.08)',
      borderRadius: 10, padding: '10px 12px', marginBottom: 12,
      display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      <div style={{ fontSize: 12, fontWeight: 800, color: '#F59E0B' }}>
        읽기 전용 · {info.label}
      </div>
      <div style={{ fontSize: 11, lineHeight: 1.6, color: 'var(--t-muted)' }}>
        {legacyLedgerNotice(id)}
      </div>
      <div style={{ fontSize: 10, color: 'var(--t-muted)' }}>
        여기서는 새 주문을 낼 수 없습니다. 기존 기록은 지우지 않고 그대로 둡니다.
      </div>
      {onGoCanonical && (
        <button onClick={onGoCanonical} style={{
          alignSelf: 'flex-start', marginTop: 2, padding: '6px 12px', borderRadius: 8,
          border: '1px solid rgba(245,158,11,0.45)', background: 'transparent',
          color: '#F59E0B', fontSize: 11, fontWeight: 700, cursor: 'pointer',
        }}>모의투자 화면으로 이동</button>
      )}
    </div>
  );
}

export default LegacyLedgerBanner;
