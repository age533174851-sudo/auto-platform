'use client';
// src/components/ui/SettingField.tsx
//
// 설정 한 줄 — **기본값이 무엇이었는지 항상 보인다.**
//
// 왜 필요한가
// ───────────
// 슬라이더를 몇 번 만지면 지금 값이 원래 값인지 내가 바꾼 값인지 알 수 없다.
// "최대 투입비율 85"만 적혀 있으면
//   · 이게 이 전략의 권장값인지
//   · 내가 언제 85로 올려놓고 잊은 것인지
// 구분할 방법이 없다. 그런데 이 화면의 값들은 **돈이 얼마나 들어가는지**를
// 정한다. 기본이 50인데 85로 올려놓은 것을 모르고 돌리면, 알고 한 결정이
// 아니다.
//
// 그래서 세 가지를 같이 보여준다:
//   1. 지금 값
//   2. 기본값 (항상 — 같을 때도 적는다. '안 적혀 있음'과 '같음'은 다르다)
//   3. 바뀌었다는 표시 (색 + 글자. 색만 쓰면 색약인 사람에게는 없는 정보다)
//
// 되돌리기를 같이 두는 이유
// ─────────────────────────
// 기본값을 알려주고 되돌릴 방법을 안 주면, 사용자는 숫자를 기억해서 손으로
// 맞춰야 한다. 그러다 한 칸 어긋나면 그건 기본값도 아니고 의도한 값도 아닌
// 값이 된다.
import React from 'react';
import { T } from '@/lib/constants';
import { A } from '@/lib/theme/colors';

/** 값 두 개가 '같은 설정'인가. 숫자는 오차를 감안한다 */
export function sameValue(a: any, b: any): boolean {
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) < 1e-9;
  }
  if (typeof a === 'boolean' || typeof b === 'boolean') return !!a === !!b;
  return String(a ?? '') === String(b ?? '');
}

function show(v: any, unit?: string): string {
  if (v === true) return '켜짐';
  if (v === false) return '꺼짐';
  if (v == null || v === '') return '—';
  // 1000000은 읽는 데 시간이 걸린다. 자릿수를 세다 틀리면 100만과 1000만을
  // 헷갈리는데, 이 화면에서 그건 10배 차이다.
  if (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) >= 10000) {
    return `${v.toLocaleString('ko-KR')}${unit ?? ''}`;
  }
  return `${v}${unit ?? ''}`;
}

/**
 * 기본값 꼬리표.
 *
 * 같으면 조용한 회색, 다르면 노란색 + '바뀜'. 조용한 쪽을 지우지 않는
 * 이유는 위 주석과 같다 — 안 적혀 있는 것과 같은 것은 다르다.
 */
export function DefaultHint({ now, base, unit, onReset }: {
  now: any;
  base: any;
  unit?: string;
  /** 주면 '되돌리기'가 붙는다 */
  onReset?: () => void;
}) {
  const changed = !sameValue(now, base);
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      fontSize: 9, fontWeight: 700, whiteSpace: 'nowrap',
      color: changed ? T.ylw : T.muted,
    }}>
      <span>기본 {show(base, unit)}</span>
      {changed && (
        <>
          {/* 색만으로 말하지 않는다 */}
          <span style={{
            background: A(T.ylw, '20'), borderRadius: 4, padding: '1px 4px',
          }}>바뀜</span>
          {onReset && (
            <button type="button" onClick={onReset} title={`기본값(${show(base, unit)})으로`}
              style={{
                background: 'none', border: 'none', padding: 0, minHeight: 0,
                color: T.acl, fontSize: 9, fontWeight: 700, cursor: 'pointer',
                textDecoration: 'underline',
              }}>되돌리기</button>
          )}
        </>
      )}
    </span>
  );
}

/**
 * 라벨 + 지금 값 + 기본값 한 줄, 그 아래 입력.
 *
 * 입력 칸은 **내용에 맞는 크기**로 둔다. 숫자 다섯 자리를 받는 칸을
 * 화면 전체 너비로 그리면 한 화면에 서너 개밖에 안 들어가고, 스크롤이
 * 길어질수록 "내가 뭘 바꿨더라"가 더 안 보인다. `grow`를 주면 늘어난다.
 */
export function SettingField({
  label, value, base, unit, onReset, children, grow, hint,
}: {
  label: string;
  /** 지금 값. 라벨 옆에 적는다 */
  value?: any;
  /** 기본값. 주지 않으면 꼬리표를 안 붙인다 */
  base?: any;
  unit?: string;
  onReset?: () => void;
  children: React.ReactNode;
  /** 입력을 가로로 꽉 채운다 (텍스트·슬라이더) */
  grow?: boolean;
  hint?: string;
}) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
        gap: 8, marginBottom: 4, flexWrap: 'wrap',
      }}>
        <span style={{ color: T.sub, fontSize: 11, fontWeight: 700 }}>
          {label}
          {value !== undefined && (
            <b style={{ color: T.txt, marginLeft: 6 }}>{show(value, unit)}</b>
          )}
        </span>
        {base !== undefined && (
          <DefaultHint now={value} base={base} unit={unit} onReset={onReset}/>
        )}
      </div>
      <div style={grow ? undefined : { display: 'inline-block' }}>{children}</div>
      {hint && (
        <div style={{ color: T.muted, fontSize: 9, marginTop: 3, lineHeight: 1.5 }}>{hint}</div>
      )}
    </div>
  );
}

/**
 * 설정 입력 칸.
 *
 * `ch`는 받을 글자 수다. 다섯 자리 숫자에 화면 전체 너비를 주지 않는다 —
 * 칸이 크다고 더 정확해지지 않고, 한 화면에 보이는 설정만 줄어든다.
 */
export function settingInput(ch = 10): React.CSSProperties {
  return {
    width: `${Math.max(6, ch)}ch`, minWidth: 72, maxWidth: '100%',
    background: T.alt, border: `1px solid ${T.border}`, borderRadius: 8,
    padding: '7px 10px', color: T.txt, fontSize: 13, outline: 'none',
    fontVariantNumeric: 'tabular-nums',
  };
}

/** 전체를 기본값으로. 바뀐 것이 없으면 눌러도 할 일이 없으므로 숨긴다 */
export function ResetAll({ changed, onReset }: { changed: number; onReset: () => void }) {
  if (changed <= 0) return null;
  return (
    <button type="button" onClick={onReset} style={{
      width: '100%', minHeight: 34, marginTop: 4,
      background: A(T.ylw, '12'), color: T.ylw,
      border: `1px solid ${A(T.ylw, '35')}`, borderRadius: 9,
      fontSize: 11, fontWeight: 700, cursor: 'pointer',
    }}>
      {changed}개 항목이 기본값과 다릅니다 — 전부 되돌리기
    </button>
  );
}

/** 기본값과 다른 항목 수. 화면이 스스로 세지 않게 여기 둔다 */
export function countChanged<T extends Record<string, any>>(
  now: T, base: T, keys: (keyof T)[],
): number {
  return keys.reduce((n, k) => n + (sameValue(now[k], base[k]) ? 0 : 1), 0);
}
