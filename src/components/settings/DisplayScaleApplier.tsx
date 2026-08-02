'use client';
// src/components/settings/DisplayScaleApplier.tsx
//
// 저장된 화면 배율을 앱이 뜰 때 적용한다.
//
// 설정 화면에서만 적용하면, 앱을 다시 열었을 때 설정 화면에 들어가기
// 전까지는 원래 크기로 보인다. 크게 해 둔 사람에게는 그 사이가 못 읽는
// 화면이다. 그래서 루트에 둔다.
//
// 아무것도 그리지 않는다.
import { useEffect } from 'react';
import { applyScale, readScale } from '@/lib/ui/displayScale';

export default function DisplayScaleApplier() {
  useEffect(() => {
    applyScale(readScale());
  }, []);
  return null;
}
