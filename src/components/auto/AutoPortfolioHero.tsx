'use client';
// src/components/auto/AutoPortfolioHero.tsx
//
// **첫 시선은 시스템 상태가 아니라 돈이어야 한다.**
//
// 예전 화면은 맨 위가 Worker·Cron·마이그레이션이었다. 그건 만든 사람이
// 궁금한 것이지 쓰는 사람이 궁금한 것이 아니다.
//
// 그런데 여기서 제일 조심할 것이 하나 있다:
// **큰 글씨로 적힌 0은 작은 글씨로 적힌 0보다 나쁘다.**
// 모르는 값을 0으로 그리면 화면이 "오늘 안 벌었다"고 말하는데
// 실제로는 아직 세는 곳이 없는 것이다. 사람은 큰 숫자를 안 의심한다.
//
// 그래서 이 판은 **값을 만들지 않는다.** `autoHome.ts`가 아는 것과
// 모르는 것을 갈라 주고, 모르는 칸에는 숫자 대신 이유가 온다.
import React from 'react';
import { T } from '@/lib/constants';
import { A } from '@/lib/theme/colors';
import { statCell, type AutoHomeView } from '@/lib/ui/autoHome';
import { ENV_LABEL, ENV_TONE } from '@/lib/ui/autoOverview';

const usd = (v: number) =>
  `$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const signedUsd = (v: number) => `${v >= 0 ? '+' : '−'}${usd(v)}`;

export default function AutoPortfolioHero(props: {
  view: AutoHomeView;
  /** 환경 배지 색 */
  toneColor: (t: any) => string;
}) {
  const v = props.view;
  const envTone = props.toneColor(ENV_TONE[v.env]);

  const equity = statCell('자동매매 자산', v.equity, usd);
  const pnl = statCell('오늘 손익', v.todayPnl, signedUsd, { signed: true });
  const stats = [
    statCell('실행 중', v.running, n => `${n}`),
    statCell('오늘 거래', v.todayTrades, n => `${n}회`),
    statCell('승률', v.winRate, n => `${Math.round(n * 100)}%`),
  ];

  return (
    <div style={{
      background: A(envTone, '0A'), border: `1px solid ${T.border}`,
      borderRadius: 14, padding: '14px 14px 12px', marginBottom: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 12 }}>
        <span style={{ color: T.muted, fontSize: 11, fontWeight: 800 }}>자동매매</span>
        <span style={{
          background: A(envTone, '18'), color: envTone,
          border: `1px solid ${A(envTone, '40')}`,
          borderRadius: 6, padding: '2px 7px', fontSize: 9.5, fontWeight: 900, marginLeft: 'auto',
        }}>{ENV_LABEL[v.env]}</span>
      </div>

      {/* ── 자산 ── 화면에서 가장 큰 글씨다 */}
      <div style={{ color: T.muted, fontSize: 10.5, fontWeight: 700 }}>{equity.label}</div>
      {equity.known ? (
        <div style={{
          color: T.txt, fontSize: 28, fontWeight: 900, lineHeight: 1.15, marginTop: 2,
          // 자릿수가 흔들리지 않게 한다 — 숫자가 춤추면 못 믿는다.
          fontVariantNumeric: 'tabular-nums',
        }}>{equity.text}</div>
      ) : (
        <div style={{ color: T.muted, fontSize: 12, fontWeight: 700, marginTop: 4, lineHeight: 1.5 }}>
          {equity.emptyText}
        </div>
      )}

      {/* ── 오늘 손익 ── */}
      <div style={{ marginTop: 8 }}>
        <span style={{ color: T.muted, fontSize: 10.5, fontWeight: 700 }}>{pnl.label} </span>
        {pnl.known ? (
          <span style={{
            color: pnl.tone === 'good' ? T.grn : pnl.tone === 'bad' ? T.red : T.txt,
            fontSize: 15, fontWeight: 900, fontVariantNumeric: 'tabular-nums',
          }}>{pnl.text}</span>
        ) : (
          <span style={{ color: T.muted, fontSize: 11, fontWeight: 700 }}>{pnl.emptyText}</span>
        )}
      </div>

      {/* ── 세 칸 ── 모르는 칸은 이유가 온다 */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8,
        marginTop: 12, paddingTop: 10, borderTop: `1px solid ${T.border}`,
      }}>
        {stats.map(s => (
          <div key={s.label} style={{ minWidth: 0 }}>
            <div style={{ color: T.muted, fontSize: 9.5, fontWeight: 700 }}>{s.label}</div>
            {s.known ? (
              <div style={{
                color: T.txt, fontSize: 15, fontWeight: 900, marginTop: 2,
                fontVariantNumeric: 'tabular-nums',
              }}>{s.text}</div>
            ) : (
              // **'0'도 '—'도 쓰지 않는다.** 왜 모르는지가 그 자리에 있어야 한다.
              <div style={{ color: T.muted, fontSize: 9.5, marginTop: 3, lineHeight: 1.4 }}>
                {s.emptyText}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
