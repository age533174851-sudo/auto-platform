'use client';
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { T, CURRENCIES, LANGS, I18N, WORLD_MARKETS, MOCK_NEWS, ECON_EVENTS } from '@/lib/constants';
import { cvt, fmt, fmtPct, clamp, tr, gS, sS, uid } from '@/lib/utils';
import { ASSETS, TYPE_LABEL, TYPE_COLOR } from '@/data/assets';
import type { Asset } from '@/types';
import { Card, Dot, Spark, Pill, Bdg, Logo, getBgColor } from './SharedUI';

function AcademyPage() {
  const lessons = [
    { id: 1, title: '투자 기초: 주식 vs 코인', desc: '두 자산의 핵심 차이점', duration: '15분', level: '입문', done: true },
    { id: 2, title: '기술적 분석 기초', desc: '차트 읽는 법, 지지/저항', duration: '25분', level: '초급', done: true },
    { id: 3, title: '이동평균선(MA) 완전정복', desc: 'SMA, EMA, MACD 활용법', duration: '20분', level: '초급', done: false },
    { id: 4, title: '레버리지와 청산 이해', desc: '마진 거래의 위험성', duration: '30분', level: '중급', done: false },
    { id: 5, title: '포트폴리오 분산 투자', desc: '위험 관리와 자산 배분', duration: '20분', level: '중급', done: false },
    { id: 6, title: '스윙 트레이딩 전략', desc: '단기 추세 매매 방법', duration: '35분', level: '고급', done: false },
  ];
  const levelColor: Record<string, string> = { '입문': T.grn, '초급': T.acl, '중급': T.ylw, '고급': T.red };
  return (
    <div>
      <div style={{ fontWeight: 800, fontSize: 15, color: T.txt, marginBottom: 4 }}>📚 투자 아카데미</div>
      <div style={{ color: T.muted, fontSize: 10, marginBottom: 14 }}>기초부터 고급까지 단계별 학습</div>
      {lessons.map(l => (
        <Card key={l.id} style={{ padding: '12px 14px', marginBottom: 8, opacity: l.done ? 0.7 : 1 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                {l.done && <span style={{ color: T.grn, fontSize: 12 }}>✓</span>}
                <span style={{ color: T.txt, fontSize: 12, fontWeight: 700 }}>{l.title}</span>
              </div>
              <div style={{ color: T.muted, fontSize: 10 }}>{l.desc}</div>
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <span style={{ color: T.muted, fontSize: 9 }}>⏱ {l.duration}</span>
                <span style={{ color: levelColor[l.level] || T.muted, fontSize: 9, fontWeight: 700 }}>{l.level}</span>
              </div>
            </div>
            <button style={{ background: l.done ? T.alt : T.acg, border: `1px solid ${l.done ? T.border : T.acl}`, borderRadius: 8, color: l.done ? T.muted : T.acl, padding: '6px 14px', fontSize: 10, fontWeight: 700, cursor: 'pointer', flexShrink: 0 }}>
              {l.done ? '복습' : '시작'}
            </button>
          </div>
        </Card>
      ))}
    </div>
  );
}

export default AcademyPage;
