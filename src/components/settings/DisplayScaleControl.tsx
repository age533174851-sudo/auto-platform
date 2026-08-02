'use client';
// src/components/settings/DisplayScaleControl.tsx
//
// 화면 크기 조절.
//
// 이 앱의 글씨는 9~13px이다. 정보를 많이 넣으려고 그렇게 잡았는데,
// 폰에서는 읽기 힘든 크기다. 그리고 이건 취향 문제가 아니다 —
// **잘 안 보이는 화면에서 사람은 숫자를 잘못 읽는다.** 63,093을
// 68,093으로 읽고 주문을 낸다.
//
// 미리보기를 같이 둔다. 눌러 보기 전에 얼마나 커지는지 알 수 없으면
// 사용자는 하나씩 눌러 보며 화면이 요동치는 것을 겪는다.
import React, { useEffect, useState } from 'react';
import { T } from '@/lib/constants';
import { SCALE_STEPS, readScale, writeScale } from '@/lib/ui/displayScale';

export default function DisplayScaleControl() {
  const [scale, setScale] = useState(1);

  // 저장된 값을 읽어 상태를 맞춘다. 적용 자체는 앱 시작 시
  // DisplayScaleApplier가 이미 했다 — 여기서 또 적용하면 설정 화면을
  // 열 때마다 화면이 한 번 깜빡인다.
  useEffect(() => { setScale(readScale()); }, []);

  const pick = (v: number) => setScale(writeScale(v));

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 6 }}>
        {SCALE_STEPS.map(s => {
          const active = Math.abs(scale - s.value) < 0.001;
          return (
            <button key={s.value} onClick={() => pick(s.value)}
              style={{
                background: active ? T.acg : 'transparent',
                color: active ? T.acl : T.txt,
                border: `1px solid ${active ? T.acl : T.border}`,
                borderRadius: 10,
                // 최소 46px. 크기 조절 버튼이 정작 누르기 어려우면 안 된다.
                padding: '10px', minHeight: 46, cursor: 'pointer',
                textAlign: 'left', fontWeight: 700, fontSize: 12,
              }}>
              <div>{s.label}</div>
              <div style={{ color: T.muted, fontSize: 10, fontWeight: 500, marginTop: 2 }}>
                {s.note}
              </div>
            </button>
          );
        })}
      </div>

      {/* 무엇이 바뀌는지 먼저 보여준다 */}
      <div style={{
        marginTop: 12, padding: 12, borderRadius: 10,
        border: `1px solid ${T.border}`, background: T.card,
      }}>
        <div style={{ color: T.muted, fontSize: 10, marginBottom: 6 }}>미리보기</div>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
          <span style={{ color: T.txt, fontSize: 11 * scale, fontWeight: 700 }}>BTC/USDT</span>
          <span style={{
            color: T.grn, fontSize: 15 * scale, fontWeight: 800,
            fontFamily: 'Inter,monospace', fontVariantNumeric: 'tabular-nums',
          }}>63,093.05</span>
        </div>
        <div style={{ color: T.muted, fontSize: 10 * scale, marginTop: 4 }}>
          손절 2% · 비용 1,250.00 USDT
        </div>
      </div>

      <div style={{ color: T.muted, fontSize: 10, lineHeight: 1.6, marginTop: 10 }}>
        글씨만이 아니라 화면 전체가 커집니다. 브라우저 확대와 같은 방식이라
        글자가 잘리지 않습니다. 바로 적용되고 다음에 열 때도 유지됩니다.
      </div>
    </div>
  );
}
