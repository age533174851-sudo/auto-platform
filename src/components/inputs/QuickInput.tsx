'use client';
import React from 'react';
import { T } from '@/lib/constants';

// 빠른 선택 + 직접 입력 혼합 컴포넌트
// 레버리지/금액/쿨타임/퍼센트 등에 공용 사용
export function QuickSelectInput({
  label, value, onChange, presets, unit, min = 0, max = 999999, step = 1, mode = 'number',
}: {
  label?: string;
  value: number;
  onChange: (v: number) => void;
  presets: number[];
  unit?: string;
  min?: number; max?: number; step?: number;
  mode?: 'number' | 'percent' | 'money' | 'leverage';
}) {
  const fmtPreset = (p: number) => {
    if (mode === 'leverage') return `${p}x`;
    if (mode === 'percent') return `${p}%`;
    if (mode === 'money') return p >= 10000 ? `${p / 10000}만` : `${p.toLocaleString()}`;
    return `${p}${unit || ''}`;
  };
  const clamp = (v: number) => Math.max(min, Math.min(max, v));

  return (
    <div>
      {label && <div style={{ color: T.muted, fontSize: 11, fontWeight: 700, marginBottom: 6 }}>{label}</div>}
      <div style={{ display: 'flex', gap: 5, marginBottom: 8, flexWrap: 'wrap' }}>
        {presets.map(p => {
          const active = value === p;
          return (
            <button key={p} onClick={() => onChange(p)}
              style={{ flex: '1 0 auto', minWidth: 48, padding: '8px 6px', borderRadius: 8, cursor: 'pointer',
                background: active ? T.acc + '25' : T.alt,
                color: active ? T.acl : T.sub,
                border: `1px solid ${active ? T.acl : T.border}`,
                fontSize: 11, fontWeight: active ? 800 : 600 }}>
              {fmtPreset(p)}
            </button>
          );
        })}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: T.alt, border: `1px solid ${T.border}`, borderRadius: 9, padding: '0 12px' }}>
        <input
          type="text" inputMode="numeric"
          value={value || ''}
          onChange={e => {
            const n = parseFloat(e.target.value.replace(/[^0-9.]/g, ''));
            onChange(isNaN(n) ? 0 : clamp(n));
          }}
          placeholder="직접 입력"
          style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: T.txt, fontSize: 14, fontWeight: 700, padding: '11px 0', minWidth: 0 }}
        />
        {(unit || mode === 'leverage' || mode === 'percent') && (
          <span style={{ color: T.muted, fontSize: 12, flexShrink: 0 }}>
            {mode === 'leverage' ? 'x' : mode === 'percent' ? '%' : unit}
          </span>
        )}
      </div>
      {(value < min || value > max) && (
        <div style={{ color: T.red, fontSize: 9, marginTop: 4 }}>범위: {min} ~ {max}</div>
      )}
    </div>
  );
}

// 기간 선택 (빠른 선택 + 직접 입력)
export function DurationPicker({
  value, onChange, presets = [7, 30, 90, 180, 365, 1095],
}: {
  value: number; onChange: (days: number) => void; presets?: number[];
}) {
  const fmt = (d: number) => d >= 365 ? `${Math.round(d / 365)}년` : d >= 30 ? `${Math.round(d / 30)}개월` : `${d}일`;
  return (
    <div>
      <div style={{ display: 'flex', gap: 5, marginBottom: 8, flexWrap: 'wrap' }}>
        {presets.map(p => {
          const active = value === p;
          return (
            <button key={p} onClick={() => onChange(p)}
              style={{ flex: '1 0 auto', minWidth: 44, padding: '8px 6px', borderRadius: 8, cursor: 'pointer',
                background: active ? T.acc + '25' : T.alt, color: active ? T.acl : T.sub,
                border: `1px solid ${active ? T.acl : T.border}`, fontSize: 11, fontWeight: active ? 800 : 600 }}>
              {fmt(p)}
            </button>
          );
        })}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: T.alt, border: `1px solid ${T.border}`, borderRadius: 9, padding: '0 12px' }}>
        <input type="text" inputMode="numeric" value={value || ''}
          onChange={e => { const n = parseInt(e.target.value.replace(/[^0-9]/g, '')); onChange(isNaN(n) ? 0 : n); }}
          placeholder="직접 입력 (일)"
          style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: T.txt, fontSize: 14, fontWeight: 700, padding: '11px 0' }} />
        <span style={{ color: T.muted, fontSize: 12 }}>일</span>
      </div>
    </div>
  );
}
