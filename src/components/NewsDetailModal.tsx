'use client';
import React from 'react';
import { T } from '@/lib/constants';
import { formatNewsDate } from '@/lib/format';

export interface NewsLike {
  id?:        string;
  title:      string;
  source?:    string;
  publishedAt?: string;
  time?:      string;          // legacy
  category?:  string;
  sentiment?: 'bullish' | 'bearish' | 'neutral' | string;
  tags?:      string[];
  tickers?:   string[];        // related assets
  summary?:   string;
  content?:   string;
  url?:       string;
  reason?:    string;          // bullish/bearish reasoning
  reasons?:   string[];        // 3-line reason list
}

const SENTI_COLOR: Record<string,string> = {
  bullish:'#10B981', bearish:'#EF4444', neutral:'#64748B',
};

const SENTI_LABEL: Record<string,string> = {
  bullish:'Bullish (강세)',
  bearish:'Bearish (약세)',
  neutral:'Neutral (중립)',
};

export default function NewsDetailModal({
  news,
  onClose,
  onTickerClick,
}: {
  news: NewsLike | null;
  onClose: () => void;
  onTickerClick?: (ticker: string) => void;
}) {
  if (!news) return null;

  const safeTags    = Array.isArray(news.tags)    ? news.tags    : [];
  const safeTickers = Array.isArray(news.tickers) ? news.tickers : [];
  const [newsTab, setNewsTab] = React.useState<'summary' | 'full'>('summary');
  const [translated, setTranslated] = React.useState<{ title?: string; summary?: string; content?: string; reason?: string; reasons?: string[] } | null>(null);
  const [translating, setTranslating] = React.useState(false);
  const [showOriginal, setShowOriginal] = React.useState(false);
  const safeReasons = (!showOriginal && translated?.reasons) ? translated.reasons : (Array.isArray(news.reasons) ? news.reasons : []);

  const translateNews = React.useCallback(async () => {
    if (translated || translating) return;
    let appLang = 'ko'; try { appLang = localStorage.getItem('tg_lang') || 'ko'; } catch {}
    if (appLang === 'en') return;  // 영어면 원문
    // 캐시 키 (뉴스 id + 언어)
    const cacheKey = `tg_trans_${(news as any).id || (news as any).url || (news.title || '').slice(0, 40)}_${appLang}`;
    // localStorage 캐시 확인 (재번역 방지)
    try {
      const cached = localStorage.getItem(cacheKey);
      if (cached) { setTranslated(JSON.parse(cached)); return; }
    } catch {}
    setTranslating(true);
    try {
      const fields = ['title', 'summary', 'content', 'reason'] as const;
      const results: any = {};
      for (const f of fields) {
        const txt = (news as any)[f];
        if (!txt) continue;
        const r = await fetch('/api/translate', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: txt, target: appLang }),
        });
        const d = await r.json();
        results[f] = d.translated || txt;
      }
      // reasons 배열 번역
      if (Array.isArray((news as any).reasons) && (news as any).reasons.length > 0) {
        try {
          const joined = (news as any).reasons.join('\n');
          const r = await fetch('/api/translate', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: joined, target: appLang }),
          });
          const d = await r.json();
          results.reasons = (d.translated || joined).split('\n');
        } catch {}
      }
      setTranslated(results);
      try { localStorage.setItem(cacheKey, JSON.stringify(results)); } catch {}
    } catch {} finally { setTranslating(false); }
  }, [news, translated, translating]);

  // 앱 언어가 한국어면 자동 번역 시도
  React.useEffect(() => {
    let lang = 'ko';
    try { lang = localStorage.getItem('tg_lang') || 'ko'; } catch {}
    if (lang !== 'en') translateNews();
  }, [translateNews]);

  // 표시할 텍스트 (번역 우선, showOriginal이면 원문)
  const disp = (field: 'title' | 'summary' | 'content') => {
    if (showOriginal || !translated) return (news as any)[field];
    return translated[field] || (news as any)[field];
  };
  const dateStr     = formatNewsDate(news.publishedAt || news.time);
  const senti       = news.sentiment || 'neutral';
  const sentiColor  = SENTI_COLOR[senti] || T.muted;

  return (
    <>
      {/* Overlay */}
      <div onClick={onClose}
        style={{ position:'fixed', inset: 0, background:'rgba(0,0,0,.7)', zIndex: 200 }}/>
      {/* Sheet */}
      <div onClick={(e) => e.stopPropagation()}
        style={{
          position:'fixed', zIndex: 201, inset:'auto 0 0 0',
          background: T.bg, borderRadius:'20px 20px 0 0',
          maxHeight:'92dvh', overflowY:'auto',
          padding:`18px 16px calc(env(safe-area-inset-bottom, 20px) + 24px)`,
          maxWidth: 520, margin:'0 auto',
        }}>
        {/* Top: close */}
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom: 12 }}>
          <div style={{ display:'flex', gap: 6, flexWrap:'wrap', flex: 1 }}>
            <span style={{ background: sentiColor + '20', color: sentiColor,
              borderRadius: 6, padding:'3px 10px', fontSize: 10, fontWeight: 700 }}>
              {SENTI_LABEL[senti] || senti}
            </span>
            {news.category && (
              <span style={{ background: T.alt, color: T.muted,
                borderRadius: 6, padding:'3px 10px', fontSize: 10, fontWeight: 700 }}>
                {news.category}
              </span>
            )}
          </div>
          <button type="button" onClick={onClose}
            style={{ background:'transparent', border:`1px solid ${T.border}`,
              borderRadius: 8, color: T.muted, padding:'5px 12px',
              fontSize: 12, cursor:'pointer', flexShrink: 0, minHeight: 36 }}>
            닫기
          </button>
        </div>

        {/* Title */}
        <h2 style={{ color: T.txt, fontWeight: 800, fontSize: 16,
          lineHeight: 1.45, marginBottom: 10 }}>
          {disp('title')}
        </h2>

        {/* Source + Date */}
        <div style={{ display:'flex', gap: 8, marginBottom: 14, fontSize: 11, color: T.muted, alignItems:'center' }}>
          {news.source && <span>{news.source}</span>}
          <span>· {dateStr}</span>
          {translating && <span style={{ color: T.acl, fontSize: 10 }}>· AI 번역 중…</span>}
          {translated && !showOriginal && (
            <span style={{ background: T.acl + '20', color: T.acl, fontSize: 8, fontWeight: 800, padding: '2px 6px', borderRadius: 4 }}>AI 번역</span>
          )}
          {translated && (
            <button onClick={() => setShowOriginal(!showOriginal)}
              style={{ marginLeft:'auto', background: T.alt, border:`1px solid ${T.border}`, borderRadius: 6, padding:'3px 9px', color: T.acl, fontSize: 9, fontWeight: 700, cursor:'pointer' }}>
              {showOriginal ? '번역 보기' : '원문 보기'}
            </button>
          )}
        </div>

        {/* 탭: 요약 / 전체 내용 */}
        {(news.summary || news.content) && (
          <>
            <div style={{ display:'flex', gap: 6, marginBottom: 12, background: T.alt, padding: 4, borderRadius: 10 }}>
              {([
                { v: 'summary' as const, l: 'AI 요약' },
                { v: 'full' as const, l: '전체 내용' },
              ]).map(t => {
                const active = newsTab === t.v;
                const disabled = t.v === 'full' && !news.content;
                return (
                  <button key={t.v} onClick={() => !disabled && setNewsTab(t.v)} disabled={disabled}
                    style={{ flex: 1, padding: '8px', borderRadius: 7, border: 'none',
                      background: active ? T.acc : 'transparent',
                      color: active ? '#fff' : disabled ? T.muted : T.sub,
                      fontSize: 12, fontWeight: 700, cursor: disabled ? 'not-allowed' : 'pointer',
                      opacity: disabled ? 0.4 : 1 }}>
                    {t.l}
                  </button>
                );
              })}
            </div>

            {newsTab === 'summary' && news.summary && (
              <div style={{ background: T.alt, borderLeft:`3px solid ${T.acl}`,
                padding:'12px 14px', borderRadius: 8, marginBottom: 12,
                color: T.txt, fontSize: 13, fontWeight: 500, lineHeight: 1.7 }}>
                {disp('summary')}
              </div>
            )}
            {newsTab === 'summary' && !news.summary && (
              <div style={{ color: T.muted, fontSize: 12, marginBottom: 12, padding: '12px 0' }}>요약 데이터 없음</div>
            )}

            {newsTab === 'full' && news.content && (
              <div style={{ color: T.sub, fontSize: 13, lineHeight: 1.8,
                marginBottom: 14, whiteSpace:'pre-wrap', maxHeight: 360, overflowY: 'auto' }}>
                {disp('content')}
                <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${T.border}`, color: T.muted, fontSize: 10, lineHeight: 1.5 }}>
                  이 내용은 AI가 정리한 요약본입니다. 전체 원문은 아래 출처에서 확인하세요.
                </div>
              </div>
            )}
          </>
        )}

        {/* Reasons */}
        {(safeReasons.length > 0 || news.reason) && (
          <div style={{ background: sentiColor + '10', borderRadius: 10,
            padding:'12px 14px', marginBottom: 12, border:`1px solid ${sentiColor}30` }}>
            <div style={{ color: sentiColor, fontSize: 11, fontWeight: 700, marginBottom: 6 }}>
              분석 근거
            </div>
            {safeReasons.length > 0 ? (
              safeReasons.slice(0, 3).map((r, i) => (
                <div key={i} style={{ color: T.txt, fontSize: 12, lineHeight: 1.6, marginBottom: 4 }}>
                  · {r}
                </div>
              ))
            ) : (
              <div style={{ color: T.txt, fontSize: 12, lineHeight: 1.6 }}>
                {(!showOriginal && translated?.reason) ? translated.reason : news.reason}
              </div>
            )}
          </div>
        )}

        {/* Tags */}
        {safeTags.length > 0 && (
          <div style={{ display:'flex', gap: 6, flexWrap:'wrap', marginBottom: 12 }}>
            {safeTags.map(t => (
              <span key={t} style={{ background: T.alt, color: T.muted,
                fontSize: 10, padding:'3px 8px', borderRadius: 12 }}>
                #{t}
              </span>
            ))}
          </div>
        )}

        {/* Related tickers — clickable */}
        {safeTickers.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ color: T.muted, fontSize: 10, marginBottom: 6 }}>관련 종목</div>
            <div style={{ display:'flex', gap: 6, flexWrap:'wrap' }}>
              {safeTickers.map(t => (
                <button key={t} type="button"
                  onClick={() => onTickerClick?.(t)}
                  disabled={!onTickerClick}
                  style={{ background: T.acg, color: T.acl,
                    border:`1px solid ${T.acl}40`, borderRadius: 8,
                    padding:'6px 12px', fontSize: 11, fontWeight: 700,
                    cursor: onTickerClick ? 'pointer' : 'default',
                    minHeight: 36 }}>
                  {t} →
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Original link */}
        {news.url && news.url !== '#' && (
          <a href={news.url} target="_blank" rel="noopener noreferrer"
            style={{ display:'flex', alignItems:'center', justifyContent:'center', gap: 8, padding:'13px',
              background: T.acg, color: T.acl,
              border:`1px solid ${T.acl}40`, borderRadius: 12,
              textDecoration:'none', fontWeight: 700, fontSize: 13, marginTop: 4 }}>
            <span>{news.source ? `${news.source} 원문 보기` : '원문 사이트 방문'}</span>
            <span style={{ fontSize: 14 }}>↗</span>
          </a>
        )}
        {(!news.url || news.url === '#') && news.source && (
          <div style={{ textAlign: 'center', padding: '12px', color: T.muted, fontSize: 11 }}>
            출처: {news.source} · 원문 링크 없음
          </div>
        )}
      </div>
    </>
  );
}
