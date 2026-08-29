'use client';
// src/components/ui/Status.tsx
//
// **상태를 그리는 방법은 한 곳에만 있다.**
//
// 판정은 `lib/ui/status.ts`(순수 함수)가 하고 여기서는 그리기만 한다.
// 규칙이 화면 코드 안에 들어가면 화면마다 다르게 판정한다 — 지갑 한
// 화면에만 빨강·노랑 색 지정이 23곳, '확인 불가' 문구가 15곳 있었다.
//
// 모양 규칙
// ─────────
//   ● 정상          읽었다. 잔고 0도 여기다
//   ▲ 주의          돌아가지만 봐야 한다
//   ✕ 실패          지금 막혔다. **이것만 빨갛다**
//   ? 확인 불가      못 읽었다. 0도 아니고 없음도 아니다
//   − 사용 안 함     아직 만들지 않았거나 꺼져 있다
//
// **색만으로 구분하지 않는다.** 색약이거나 화면을 빠르게 훑을 때
// 빨강과 노랑은 구분되지 않는다. 기호가 먼저다.
import React, { useState } from 'react';
import { T } from '@/lib/constants';
import type { Tone } from '@/lib/ui/display';
import {
  STATUS_TONE, STATUS_LABEL, envView, splitDiagnostics,
  type StatusKind, type EnvView,
} from '@/lib/ui/status';
import type { RunEnv } from '@/lib/ui/autoOverview';

/** 의미 → 색. **화면만 색을 안다** */
export function toneColor(tone: Tone): string {
  return tone === 'good' ? T.grn
    : tone === 'warn' ? T.ylw
      : tone === 'bad' ? T.red
        : tone === 'live' ? T.red
          : T.sub;
}

const MARK: Record<StatusKind, string> = {
  SUCCESS: '●', WARNING: '▲', ERROR: '✕', UNKNOWN: '?', DISABLED: '−',
};

/** 상태 점 하나 + 이름. 표 안에 들어가는 가장 작은 단위 */
export function StatusDot({ kind, label }: { kind: StatusKind; label?: string }) {
  const c = toneColor(STATUS_TONE[kind]);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: c, fontSize: 11 }}>
      <span aria-hidden style={{ fontSize: 10, lineHeight: 1 }}>{MARK[kind]}</span>
      <span>{label ?? STATUS_LABEL[kind]}</span>
    </span>
  );
}

/**
 * 접어 두는 상세.
 *
 * 긴 설명과 개발자용 원문이 본문에 있으면, 사용자는 첫 줄도 안 읽는다.
 * 기본은 접혀 있고, 열어야 보인다.
 */
export function Details({ summary, children }: {
  summary?: string; children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (!children) return null;
  return (
    <div style={{ marginTop: 6 }}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        style={{
          background: 'none', border: 'none', padding: 0, cursor: 'pointer',
          color: T.sub, fontSize: 10.5, textDecoration: 'underline',
          // 손가락으로 누를 수 있어야 한다 — 모바일이 먼저다
          minHeight: 32, display: 'inline-flex', alignItems: 'center',
        }}
      >
        {open ? '접기' : (summary ?? '자세히')}
      </button>
      {open && (
        <div style={{
          marginTop: 4, color: T.sub, fontSize: 10.5, lineHeight: 1.65,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }}>
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * 상태 카드 하나.
 *
 * **첫 줄은 짧다.** 긴 설명은 `detail`, 개발자용 원문은 `diagnostics`로
 * 접힌다. 사용자 본문에 DB 오류가 그대로 뜨던 것을 여기서 막는다.
 */
export function StatusCard({ kind, headline, detail, diagnostics, action, compact }: {
  kind: StatusKind;
  headline: string;
  detail?: string;
  /** 개발자용 원문. 사용자 본문에 절대 섞지 않는다 */
  diagnostics?: string;
  action?: React.ReactNode;
  compact?: boolean;
}) {
  const tone = STATUS_TONE[kind];
  const c = toneColor(tone);
  // **막힌 것만 배경을 칠한다.** 전부 칠하면 아무것도 눈에 안 띈다.
  const filled = kind === 'ERROR' || kind === 'WARNING';
  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      padding: compact ? '8px 10px' : '10px 12px',
      borderRadius: 10,
      background: filled ? `${c}14` : T.card,
      border: `1px solid ${filled ? `${c}44` : T.border}`,
      borderLeft: `3px solid ${c}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
        <span aria-hidden style={{ color: c, fontSize: 11, lineHeight: 1.5 }}>{MARK[kind]}</span>
        <span style={{ color: T.txt, fontSize: 12, fontWeight: 700, lineHeight: 1.5 }}>{headline}</span>
        {action && <span style={{ marginLeft: 'auto' }}>{action}</span>}
      </div>
      {(detail || diagnostics) && (
        <Details summary={diagnostics && !detail ? '진단 정보' : '자세히'}>
          {detail}
          {detail && diagnostics ? '\n\n' : null}
          {diagnostics ? `진단: ${diagnostics}` : null}
        </Details>
      )}
    </div>
  );
}

/**
 * 서버가 준 안내 한 줄.
 *
 * **원문을 그대로 그리지 않는다.** `column paper_accounts.started_at
 * does not exist`가 메인 화면에 그대로 떴던 자리가 정확히 이런 곳이다.
 * 사람이 쓴 부분만 본문에 남기고, 개발자용 원문은 접는다.
 *
 * 원문을 버리지는 않는다 — 버리면 진짜 고장 났을 때 아무도 원인을
 * 못 찾는다. 자리를 옮길 뿐이다.
 */
export function SafeNote({ text, tone, style }: {
  text: any; tone?: Tone; style?: React.CSSProperties;
}) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  const { body, diagnostics } = splitDiagnostics(s);
  const c = tone ? toneColor(tone) : T.sub;
  return (
    <div style={{ color: c, fontSize: 10, lineHeight: 1.6, ...style }}>
      {body}
      {diagnostics && <Details summary="진단 정보">{diagnostics}</Details>}
    </div>
  );
}

/**
 * 환경 배지.
 *
 * 실전·테스트넷·모의는 **색과 글자 둘 다** 달라야 한다. 색만 다르면
 * 실전 화면과 테스트넷 화면을 헷갈린 채로 주문을 누른다.
 */
export function EnvBadge({ env, withMeaning }: { env: RunEnv; withMeaning?: boolean }) {
  const v: EnvView = envView(env);
  const c = toneColor(v.tone);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
      <span style={{
        color: c, background: `${c}18`, border: `1px solid ${c}55`,
        borderRadius: 6, padding: '2px 7px', fontSize: 10, fontWeight: 800,
        letterSpacing: 0.3, whiteSpace: 'nowrap',
      }}>
        {v.label}
        {v.realMoney ? ' · 실제 자금' : ''}
      </span>
      {withMeaning && (
        <span style={{ color: T.sub, fontSize: 10, lineHeight: 1.5 }}>{v.meaning}</span>
      )}
    </span>
  );
}
