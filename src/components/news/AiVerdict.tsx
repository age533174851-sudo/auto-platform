'use client';
// src/components/news/AiVerdict.tsx
//
// 뉴스 카드에 붙는 AI 분석 띠.
//
// 네 번째 값을 화면에서 지우지 않는다
// ────────────────────────────────────
// direction은 상승·보합·하락·**판단 보류** 넷이다. 화면에서 보류를 빼고
// 셋으로 그리면 모델이 "모르겠다"고 한 것이 "보합 전망"으로 둔갑한다.
// 그 둘은 완전히 다른 말이고, 사용자는 화면만 보고는 구분할 수 없다.
//
// 확신도 %를 화면에서 뺀 이유
// ───────────────────────────
// 72%는 정밀해 보이지만 **모델이 스스로 매긴 값**이다. 과거 적중률로
// 보정된 값이 아니라서 "상승 확률 72%"가 아니다. 그런데 화면에 %로 적으면
// 사람은 그것을 확률로 읽는다. 작게 붙이는 것으로는 그 오해가 줄지 않아서,
// 표시 자체를 없앴다. 값은 데이터에 남아 있고(내부 metadata) 화면에는
// 방향 · 근거 · 위험 · 분석 모델만 적는다.
//
// 세 상태를 구분한다
// ──────────────────
//   분석 대기      아직 크론이 분석하지 않았다
//   분석 사용 불가  분석을 할 수 없다(키 없음·저장소 못 읽음). 비워 두면
//                  사용자는 "AI가 할 말이 없다"로 읽는다 — 다른 말이다
//   분석함         방향과 근거가 있다
import React from 'react';
import { T } from '@/lib/constants';
import { A } from '@/lib/theme/colors';

export interface AiVerdictData {
  /** 한국어 제목. 카드가 원문 제목 대신 쓴다 */
  titleKo?: string | null;
  url?: string;
  direction: string | null;
  directionKo: string | null;
  /** 모델이 스스로 매긴 값. **화면에 %로 적지 않는다** — 확률이 아니다 */
  confidence: number | null;
  horizonKo?: string | null;
  summary?: string | null;
  reasons?: string[];
  risks?: string[];
  affectedAssets?: string[];
  aiProvider?: string | null;
  aiModel?: string | null;
  analyzed: boolean;
  /** 분석 자체를 할 수 없는 상태의 사유. 있으면 '대기'가 아니라 '사용 불가'다 */
  unavailableReason?: string | null;
}

const TONE: Record<string, string> = {
  bullish: T.grn, bearish: T.red, neutral: T.sub, uncertain: T.ylw,
};

export function AiVerdict({ a, compact }: { a: AiVerdictData; compact?: boolean }) {
  // 아직 분석 전인 것과 분석했는데 판단을 보류한 것은 다르다.
  // 둘 다 비워 두면 사용자는 AI가 왜 답을 안 했는지 알 수 없다.
  if (!a.analyzed) {
    const unavailable = !!a.unavailableReason;
    return (
      <span
        title={a.unavailableReason || undefined}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '2px 7px', borderRadius: 5,
          background: T.alt, color: unavailable ? T.ylw : T.muted,
          fontSize: 10, fontWeight: 600,
        }}
      >{unavailable ? 'AI 분석 사용 불가' : 'AI 분석 대기'}</span>
    );
  }

  const tone = TONE[String(a.direction)] ?? T.sub;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? 3 : 5 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '2px 8px', borderRadius: 5,
          background: A(tone, '20'), color: tone, fontSize: 10, fontWeight: 800,
        }}>{a.directionKo ?? '판단 보류'}</span>

        {a.horizonKo && (
          <span style={{ color: T.muted, fontSize: 10 }}>· {a.horizonKo}</span>
        )}
        {/* 예측이라는 것을 매번 적는다. 한 번만 적으면 스크롤하면 사라진다 */}
        <span style={{ color: T.muted, fontSize: 9, opacity: 0.85 }}>예측</span>
      </div>

      {!compact && a.summary && (
        <div style={{ color: T.sub, fontSize: 11, lineHeight: 1.55 }}>{a.summary}</div>
      )}

      {!compact && (a.affectedAssets?.length ?? 0) > 0 && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {a.affectedAssets!.slice(0, 6).map(s => (
            <span key={s} style={{
              padding: '1px 6px', borderRadius: 4, background: T.alt,
              color: T.sub, fontSize: 10, fontWeight: 700,
            }}>{s}</span>
          ))}
        </div>
      )}

      {!compact && (a.reasons?.length ?? 0) > 0 && (
        <ul style={{ margin: 0, paddingLeft: 15, color: T.sub, fontSize: 11, lineHeight: 1.6 }}>
          {a.reasons!.slice(0, 3).map((r, i) => <li key={i}>{r}</li>)}
        </ul>
      )}

      {/* 위험은 근거와 색을 다르게 둔다. 같이 두면 둘 다 '설명'으로 읽힌다 */}
      {!compact && (a.risks?.length ?? 0) > 0 && (
        <div style={{ color: T.ylw, fontSize: 10, lineHeight: 1.55 }}>
          유의: {a.risks!.slice(0, 2).join(' · ')}
        </div>
      )}

      {!compact && a.aiProvider && (
        <div style={{ color: T.muted, fontSize: 9 }}>
          {a.aiProvider}{a.aiModel ? ` · ${a.aiModel}` : ''} 분석 · 투자 조언이 아닙니다
        </div>
      )}
    </div>
  );
}
