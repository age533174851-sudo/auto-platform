'use client';
import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  Search as SearchIc, X as XIcon, Newspaper, ExternalLink,
  TrendingUp, TrendingDown, Minus, Brain, Sparkles, AlertCircle,
  ChevronRight, RefreshCw, ArrowLeft,
} from 'lucide-react';
import { T } from '@/lib/constants';
import { formatNewsDate } from '@/lib/format';
import { ErrorBoundary } from '@/components/pages/ErrorBoundary';
import { IconBox, IC_SIZE, IC_STROKE } from '@/components/ui/Icon';
import { cardStyle, buttonStyle, F, SP, R, PAGE_STYLE } from '@/components/ui/tokens';
import { analyzeNewsBatch, loadCachedAnalysis } from '@/lib/news/analyzer';
import type { AnalyzedNews, NewsAnalysis, NewsPrediction, RawNews } from '@/lib/news/types';
import { PREDICTION_LABEL } from '@/lib/news/types';
import { calculateImpact, impactLevel, getSourceInfo, TIER_COLOR, TIER_LABEL } from '@/lib/news/sources';
import { batchMatchNews, triggerNotification, markSeen } from '@/lib/news/matcher';

const CATS = ['전체','코인','주식','ETF','매크로','국내','AI/테크','에너지'];
const CAT_TO_API: Record<string, string> = {
  '전체': 'general',
  '코인': 'crypto',
  '주식': 'stocks',
  'ETF': 'etf',
  '매크로': 'macro',
  '국내': 'korea',
  'AI/테크': 'tech',
  '에너지': 'energy',
};

// 예측별 색상 매핑
const predColor = (p: NewsPrediction): string =>
  p === 'up' ? T.grn : p === 'down' ? T.red : T.ylw;

function PredictionBadge({ prediction, confidence, compact }: { prediction: NewsPrediction; confidence: number; compact?: boolean }) {
  const color = predColor(prediction);
  const Icon = prediction === 'up' ? TrendingUp : prediction === 'down' ? TrendingDown : Minus;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: compact ? '3px 8px' : '5px 10px',
      background: color + '22',
      border: `1px solid ${color}55`,
      borderRadius: R.pill,
      color, fontWeight: 800,
      fontSize: compact ? 10 : 11,
      whiteSpace: 'nowrap',
    }}>
      <Icon size={compact ? 11 : 13} strokeWidth={IC_STROKE} />
      {PREDICTION_LABEL[prediction]} {confidence}%
    </span>
  );
}

function ConfidenceBar({ value, color }: { value: number; color: string }) {
  return (
    <div style={{ height: 4, background: T.bg, borderRadius: 2, overflow: 'hidden' }}>
      <div style={{ width: `${value}%`, height: '100%', background: color, transition: 'width .3s' }} />
    </div>
  );
}

function AssetTag({ symbol, direction, onClick }: { symbol: string; direction: NewsPrediction; onClick?: () => void }) {
  const color = predColor(direction);
  const Icon = direction === 'up' ? TrendingUp : direction === 'down' ? TrendingDown : Minus;
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick?.(); }}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: '6px 10px',
        background: T.alt,
        border: `1px solid ${color}55`,
        borderRadius: R.pill,
        color: T.txt,
        fontSize: 11, fontWeight: 700,
        cursor: 'pointer',
        minHeight: 32,
        touchAction: 'manipulation',
      }}
    >
      <Icon size={11} strokeWidth={IC_STROKE} color={color} />
      {symbol}
    </button>
  );
}

function NewsPageInner({ onOpenAsset }: { currency?: string; onOpenAsset?: (a: { id: string; sym: string; nameKr: string; name: string; p: number; c: number; v: string; t: string; clr: string }, dest?: string) => void }) {
  const [cat,        setCat]        = useState('전체');
  const [search,     setSearch]     = useState('');
  const [news,       setNews]       = useState<AnalyzedNews[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState<string | null>(null);
  const [selected,   setSelected]   = useState<AnalyzedNews | null>(null);
  const [analyses,   setAnalyses]   = useState<Record<string, NewsAnalysis>>({});
  const [analyzingIds, setAnalyzingIds] = useState<Set<string>>(new Set());
  const [transCache, setTransCache] = useState<Record<string, { title?: string; summary?: string }>>({});
  const transReqRef = useRef<Set<string>>(new Set());
  const fetchSeqRef = useRef(0);

  // ── 뉴스 불러오기 ──
  const fetchNews = useCallback(async (category: string) => {
    setLoading(true);
    setError(null);
    const seq = ++fetchSeqRef.current;
    try {
      const apiCat = CAT_TO_API[category] || 'general';
      const r = await fetch(`/api/news?action=latest&cat=${encodeURIComponent(apiCat)}`, {
        signal: AbortSignal.timeout(15000),
      });
      if (seq !== fetchSeqRef.current) return; // stale
      const d = await r.json();
      const raw: RawNews[] = Array.isArray(d.news) ? d.news : (Array.isArray(d) ? d : []);
      // id 보강
      const normalized: AnalyzedNews[] = raw.map((n, i) => ({
        ...n,
        id: n.id || `${n.source || 'src'}_${n.time || i}_${(n.title || '').slice(0, 20)}`,
      }));
      setNews(normalized);

      // 캐시에서 즉시 채울 수 있는 것
      const fromCache: Record<string, NewsAnalysis> = {};
      for (const n of normalized) {
        const c = loadCachedAnalysis(n.id || '');
        if (c) fromCache[n.id || ''] = c;
      }
      if (Object.keys(fromCache).length > 0) setAnalyses(p => ({ ...p, ...fromCache }));
    } catch (e) {
      if (seq !== fetchSeqRef.current) return;
      console.warn('[news] fetch failed', e);
      setError('뉴스를 불러오지 못했습니다.');
      setNews([]);
    } finally {
      if (seq === fetchSeqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => { fetchNews(cat); }, [cat, fetchNews]);

  // ── 보이는 뉴스(상위 5개)는 자동 백그라운드 분석 ──
  const filtered: AnalyzedNews[] = useMemo(() => {
    if (!Array.isArray(news)) return [];
    const s = search.trim().toLowerCase();
    if (!s) return news;
    return news.filter(n => {
      const title = (n.title || '').toLowerCase();
      const summary = (n.summary || '').toLowerCase();
      if (title.includes(s) || summary.includes(s)) return true;
      const tickers = Array.isArray(n.tickers) ? n.tickers : [];
      return tickers.some(t => t.toLowerCase().includes(s));
    });
  }, [news, search]);

  // 앱 언어 → 보이는 뉴스 번역 (제목/요약), 언어별 캐싱
  useEffect(() => {
    let lang = 'ko';
    try { lang = localStorage.getItem('tg_lang') || 'ko'; } catch {}
    if (lang === 'en' || filtered.length === 0) return;  // 영어면 원문 그대로

    const toTranslate = filtered.slice(0, 12).filter(n => {
      const id = n.id || '';
      const ck = `${id}_${lang}`;
      return id && !transCache[ck] && !transReqRef.current.has(ck) && (n.title || '');
    });
    if (toTranslate.length === 0) return;

    toTranslate.forEach(async n => {
      const id = n.id || '';
      const ck = `${id}_${lang}`;
      transReqRef.current.add(ck);
      try {
        const cached = localStorage.getItem(`tg_ntrans_${ck}`);
        if (cached) { setTransCache(p => ({ ...p, [ck]: JSON.parse(cached) })); return; }
      } catch {}
      try {
        const out: { title?: string; summary?: string } = {};
        if (n.title) {
          const r = await fetch('/api/translate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: n.title, target: lang }) });
          const d = await r.json(); out.title = d.translated || n.title;
        }
        if (n.summary) {
          const r = await fetch('/api/translate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: n.summary, target: lang }) });
          const d = await r.json(); out.summary = d.translated || n.summary;
        }
        setTransCache(p => ({ ...p, [ck]: out }));
        try { localStorage.setItem(`tg_ntrans_${ck}`, JSON.stringify(out)); } catch {}
      } catch {}
    });
  }, [filtered, transCache]);

  // 화면에 보이는 상위 5개 자동 분석
  useEffect(() => {
    if (filtered.length === 0) return;
    const needAnalyze = filtered
      .slice(0, 5)
      .filter(n => n.id && !analyses[n.id] && !analyzingIds.has(n.id));
    if (needAnalyze.length === 0) return;

    const ids = needAnalyze.map(n => n.id!).filter(Boolean);
    setAnalyzingIds(prev => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });

    (async () => {
      const results = await analyzeNewsBatch(needAnalyze.map(n => ({
        id:       n.id!,
        title:    n.title || '',
        summary:  n.summary || n.content || '',
        tickers:  Array.isArray(n.tickers) ? n.tickers : [],
        category: n.category,
      })));
      setAnalyses(prev => ({ ...prev, ...results }));
      setAnalyzingIds(prev => {
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
    })().catch(e => {
      console.warn('[news] analyze batch failed', e);
      setAnalyzingIds(prev => {
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
    });
  }, [filtered, analyses, analyzingIds]);

  // 관심종목 매칭 + 영향도 높은 뉴스 자동 알림
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (Object.keys(analyses).length === 0) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;

    const items = filtered
      .filter(n => n.id && analyses[n.id])
      .map(n => ({
        id: n.id!,
        sourceName: n.source,
        publishedAt: typeof n.time === 'number' ? n.time : (n.time ? new Date(n.time).getTime() : undefined),
        analysis: analyses[n.id!],
      }));

    const { notifications } = batchMatchNews(items);
    // 최대 2개까지만 알림 (스팸 방지)
    for (const m of notifications.slice(0, 2)) {
      const news = filtered.find(n => n.id === m.newsId);
      if (news) triggerNotification(m, news.title || '뉴스 알림');
    }
  }, [analyses, filtered]);

  // 선택된 뉴스가 아직 분석 안 됐으면 즉시 분석
  useEffect(() => {
    if (!selected || !selected.id) return;
    if (analyses[selected.id] || analyzingIds.has(selected.id)) return;
    const id = selected.id;
    setAnalyzingIds(p => { const n = new Set(p); n.add(id); return n; });
    analyzeNewsBatch([{
      id, title: selected.title || '',
      summary: selected.summary || selected.content || '',
      tickers: Array.isArray(selected.tickers) ? selected.tickers : [],
      category: selected.category,
    }]).then(results => {
      setAnalyses(prev => ({ ...prev, ...results }));
    }).finally(() => {
      setAnalyzingIds(p => { const n = new Set(p); n.delete(id); return n; });
    });
  }, [selected, analyses, analyzingIds]);

  // ── 자산 태그 클릭 → 매매 페이지 ──
  const openAssetTag = (symbol: string) => {
    onOpenAsset?.({ id: symbol, sym: symbol, nameKr: symbol, name: symbol, p: 0, c: 0, v: '-', t: 'coin', clr: T.acl }, 'trading');
  };

  // ── 원문 열기 ──
  const openOriginal = (url?: string) => {
    if (!url) return;
    try { window.open(url, '_blank', 'noopener,noreferrer'); } catch {}
  };

  // ─────────────────────────────────────────────────
  // 상세 화면
  // ─────────────────────────────────────────────────
  if (selected) {
    const an = selected.id ? analyses[selected.id] : undefined;
    const isAnalyzing = selected.id ? analyzingIds.has(selected.id) : false;
    return (
      <div style={PAGE_STYLE}>
        <button onClick={() => setSelected(null)}
          style={{ ...buttonStyle('ghost', 'sm'), gap: 6, marginBottom: SP.md }}>
          <ArrowLeft size={14} strokeWidth={IC_STROKE} /> 목록으로
        </button>

        {selected.image && (
          <img src={selected.image} alt=""
            style={{ width: '100%', borderRadius: R.lg, marginBottom: SP.md, objectFit: 'cover', maxHeight: 220 }}
            onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
        )}

        {/* 한글 제목 + 원본 */}
        <div style={cardStyle({ marginBottom: SP.md })}>
          <div style={{ ...F.title, lineHeight: 1.4, marginBottom: 6 }}>
            {an?.titleKo || selected.title}
          </div>
          {an?.titleKo && an.titleKo !== selected.title && (
            <div style={{ ...F.muted, lineHeight: 1.4, marginBottom: 8 }}>
              {selected.title}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={F.caption}>{selected.source || '-'}</span>
            {selected.time && <span style={F.caption}>· {formatNewsDate(selected.time)}</span>}
            {selected.category && (
              <span style={{ background: T.alt, color: T.muted, fontSize: 10, padding: '3px 8px', borderRadius: R.pill, fontWeight: 700 }}>
                {selected.category}
              </span>
            )}
          </div>
        </div>

        {/* AI 분석 카드 */}
        <div style={{
          ...cardStyle({ marginBottom: SP.md }),
          background: an ? `linear-gradient(135deg, ${T.card}, ${predColor(an.prediction)}08)` : T.card,
          border: an ? `1px solid ${predColor(an.prediction)}33` : `1px solid ${T.border}`,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: SP.sm, marginBottom: SP.md }}>
            <IconBox tone="purple" size="sm">
              <Brain size={IC_SIZE.sm} strokeWidth={IC_STROKE} />
            </IconBox>
            <div style={{ flex: 1 }}>
              <div style={F.section}>AI 분석</div>
              <div style={F.muted}>
                {an?.source === 'openai' ? 'OpenAI 분석' :
                 an?.source === 'cache'  ? '캐시된 분석' :
                 an?.source === 'mock'   ? '키워드 기반 분석' : '분석 중...'}
              </div>
            </div>
            {isAnalyzing && <RefreshCw size={14} strokeWidth={IC_STROKE} color={T.acl}
              style={{ animation: 'spin 1s linear infinite' }} />}
          </div>

          {!an && !isAnalyzing && (
            <div style={F.muted}>분석을 사용할 수 없습니다.</div>
          )}

          {isAnalyzing && !an && (
            <div style={{ ...F.muted, padding: '8px 0' }}>분석 중입니다... (몇 초 걸려요)</div>
          )}

          {an && (
            <>
              {/* 한글 요약 */}
              {an.summaryKo && an.summaryKo !== an.titleKo && (
                <div style={{ ...F.body, lineHeight: 1.7, color: T.sub, marginBottom: SP.md }}>
                  {an.summaryKo}
                </div>
              )}

              {/* 예측 + 신뢰도 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: SP.sm, marginBottom: 6 }}>
                <PredictionBadge prediction={an.prediction} confidence={an.confidence} />
                <span style={{ ...F.caption, flex: 1 }}>AI 신뢰도</span>
              </div>
              <ConfidenceBar value={an.confidence} color={predColor(an.prediction)} />

              {/* 근거 */}
              {an.reasons.length > 0 && (
                <div style={{ marginTop: SP.md }}>
                  <div style={{ ...F.caption, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 4 }}>
                    <Sparkles size={12} strokeWidth={IC_STROKE} color={T.acl} />
                    예측 근거
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {an.reasons.map((r, i) => (
                      <div key={i} style={{
                        display: 'flex', alignItems: 'flex-start', gap: 8,
                        padding: '8px 12px', background: T.alt, borderRadius: R.md,
                      }}>
                        <span style={{ color: predColor(an.prediction), fontWeight: 800, marginTop: 1 }}>•</span>
                        <span style={{ ...F.body, lineHeight: 1.5 }}>{r}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 영향받을 자산 */}
              {an.affectedAssets.length > 0 && (
                <div style={{ marginTop: SP.md }}>
                  <div style={{ ...F.caption, marginBottom: 6 }}>영향 자산 (탭하면 매매로 이동)</div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {an.affectedAssets.map(a => (
                      <AssetTag key={a.symbol} symbol={a.symbol} direction={a.direction}
                        onClick={() => openAssetTag(a.symbol)} />
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* 본문 (원본 summary) */}
        {(selected.summary || selected.content) && (
          <div style={cardStyle({ marginBottom: SP.md })}>
            <div style={{ ...F.caption, marginBottom: 6 }}>원문 요약</div>
            <div style={{ ...F.body, lineHeight: 1.7, color: T.sub }}>
              {selected.summary || selected.content}
            </div>
          </div>
        )}

        {/* 명시 tickers (분석과 별개) */}
        {Array.isArray(selected.tickers) && selected.tickers.length > 0 && (
          <div style={cardStyle({ marginBottom: SP.md })}>
            <div style={{ ...F.caption, marginBottom: 6 }}>관련 종목</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {selected.tickers.map(t => (
                <button key={t}
                  onClick={() => openAssetTag(t)}
                  style={{
                    ...buttonStyle('ghost', 'sm'),
                    background: T.acg, color: T.acl, border: `1px solid ${T.acl}44`,
                    gap: 4,
                  }}>
                  {t} <ChevronRight size={11} strokeWidth={IC_STROKE} />
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 원문 열기 */}
        {selected.url && (
          <button onClick={() => openOriginal(selected.url)}
            style={{ ...buttonStyle('primary', 'lg'), width: '100%', gap: 8 }}>
            <ExternalLink size={16} strokeWidth={IC_STROKE} />
            원문 기사 열기
          </button>
        )}

        <style jsx>{`
          @keyframes spin {
            from { transform: rotate(0deg); }
            to   { transform: rotate(360deg); }
          }
        `}</style>
      </div>
    );
  }

  // ─────────────────────────────────────────────────
  // 목록 화면
  // ─────────────────────────────────────────────────
  return (
    <div style={PAGE_STYLE}>
      {/* 헤더 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: SP.sm, marginBottom: SP.md }}>
        <IconBox tone="blue" size="md"><Newspaper size={IC_SIZE.md} strokeWidth={IC_STROKE} /></IconBox>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={F.title}>뉴스</div>
          <div style={F.caption}>한글 번역 · AI 예측 · 영향 자산 분석</div>
        </div>
        <button onClick={() => fetchNews(cat)}
          style={{ ...buttonStyle('ghost', 'sm'), padding: '10px 12px' }}
          title="새로고침">
          <RefreshCw size={16} strokeWidth={IC_STROKE} />
        </button>
      </div>

      {/* 검색 */}
      <div style={{
        display: 'flex', gap: 8, alignItems: 'center',
        background: T.card, border: `1px solid ${T.border}`,
        borderRadius: R.md, padding: '10px 14px',
        marginBottom: SP.sm + 2, minHeight: 48,
      }}>
        <SearchIc size={16} strokeWidth={IC_STROKE} color={T.muted} />
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="뉴스 검색 (BTC, Fed, CPI…)"
          style={{ background: 'transparent', border: 'none', outline: 'none', color: T.txt, fontSize: 14, flex: 1 }} />
        {search && (
          <button onClick={() => setSearch('')}
            style={{ background: 'none', border: 'none', color: T.muted, cursor: 'pointer', padding: 6, minHeight: 32, minWidth: 32 }}>
            <XIcon size={16} strokeWidth={IC_STROKE} />
          </button>
        )}
      </div>

      {/* 카테고리 */}
      <div style={{ display: 'flex', gap: 6, overflowX: 'auto', WebkitOverflowScrolling: 'touch', paddingBottom: 4, marginBottom: SP.md }}>
        {CATS.map(c => {
          const active = cat === c;
          return (
            <button key={c} onClick={() => setCat(c)}
              style={{
                ...buttonStyle('ghost', 'sm'),
                flexShrink: 0,
                background: active ? T.acg : 'transparent',
                color: active ? T.acl : T.muted,
                border: `1px solid ${active ? T.acl : T.border}`,
              }}>
              {c}
            </button>
          );
        })}
      </div>

      {/* 본문 */}
      {loading && news.length === 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: SP.sm + 2 }}>
          {[0,1,2,3].map(i => (
            <div key={i} style={cardStyle()}>
              <div style={{ height: 14, background: `linear-gradient(90deg,${T.alt} 25%,${T.border} 50%,${T.alt} 75%)`, backgroundSize: '200% 100%', animation: 'shimmer 1.2s infinite', borderRadius: 4, marginBottom: 8, width: '80%' }} />
              <div style={{ height: 10, background: `linear-gradient(90deg,${T.alt} 25%,${T.border} 50%,${T.alt} 75%)`, backgroundSize: '200% 100%', animation: 'shimmer 1.2s infinite', borderRadius: 4, width: '60%' }} />
            </div>
          ))}
        </div>
      ) : error ? (
        <div style={cardStyle({ textAlign: 'center', padding: '36px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 })}>
          <AlertCircle size={28} strokeWidth={IC_STROKE} color={T.red} />
          <div style={{ ...F.body, color: T.red }}>{error}</div>
          <button onClick={() => fetchNews(cat)} style={{ ...buttonStyle('ghost', 'sm'), gap: 6, marginTop: 6 }}>
            <RefreshCw size={14} strokeWidth={IC_STROKE} /> 다시 시도
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <div style={cardStyle({ textAlign: 'center', padding: '40px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 })}>
          <Newspaper size={28} strokeWidth={IC_STROKE} color={T.muted} />
          <div style={F.muted}>{search ? `"${search}" 검색 결과 없음` : '뉴스가 없습니다'}</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: SP.sm + 2 }}>
          {filtered.map(n => {
            const id = n.id || '';
            const an = analyses[id];
            const isAnalyzing = analyzingIds.has(id);
            const _lang = (()=>{ try { return localStorage.getItem('tg_lang')||'ko'; } catch { return 'ko'; } })();
            const _tc = transCache[`${id}_${_lang}`];
            const displayTitle = an?.titleKo || _tc?.title || n.title;
            const displaySummary = an?.summaryKo || _tc?.summary;

            return (
              <div
                key={id}
                onClick={() => { setSelected(n); markSeen(id); }}
                style={{
                  ...cardStyle(),
                  cursor: 'pointer',
                  position: 'relative',
                  minHeight: 80,
                  borderLeft: an ? `3px solid ${predColor(an.prediction)}` : `3px solid ${T.border}`,
                  touchAction: 'manipulation',
                }}
              >
                <div style={{ display: 'flex', gap: SP.sm + 2, alignItems: 'flex-start' }}>
                  {n.image && (
                    <img src={n.image} alt=""
                      style={{ width: 64, height: 64, borderRadius: R.md, objectFit: 'cover', flexShrink: 0 }}
                      onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {/* 제목 (한글 번역) */}
                    <div style={{
                      ...F.body, fontWeight: 700, color: T.txt, lineHeight: 1.5,
                      overflow: 'hidden', display: '-webkit-box',
                      WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const,
                      marginBottom: 6,
                    }}>
                      {displayTitle}
                    </div>

                    {/* 한글 요약 (있을 때만) */}
                    {displaySummary && displaySummary !== displayTitle && (
                      <div style={{
                        ...F.muted, lineHeight: 1.5, color: T.sub,
                        overflow: 'hidden', display: '-webkit-box',
                        WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const,
                        marginBottom: 8,
                      }}>
                        {displaySummary}
                      </div>
                    )}

                    {/* 메타 + 출처 신뢰도 */}
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 }}>
                      {(() => {
                        const src = getSourceInfo(n.source);
                        return (
                          <span style={{
                            display: 'inline-flex', alignItems: 'center', gap: 3,
                            padding: '1px 6px', borderRadius: 4,
                            background: TIER_COLOR[src.tier] + '20',
                            color: TIER_COLOR[src.tier],
                            fontSize: 9, fontWeight: 800,
                          }} title={`${TIER_LABEL[src.tier]} · 신뢰도 ${src.reliability}점`}>
                            {src.label}
                          </span>
                        );
                      })()}
                      {n.time && <span style={F.muted}>· {formatNewsDate(n.time)}</span>}
                    </div>

                    {/* 영향도 게이지 (AI 분석 완료 시) */}
                    {an && (() => {
                      const t = typeof n.time === 'number' ? n.time : (n.time ? new Date(n.time).getTime() : undefined);
                      const imp = calculateImpact({
                        sourceName: n.source,
                        prediction: an.prediction,
                        confidence: an.confidence,
                        publishedAt: t,
                        numAffectedAssets: an.affectedAssets?.length || 0,
                      });
                      const lvl = impactLevel(imp.total);
                      return (
                        <div style={{ marginBottom: 6 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 2 }}>
                            <span style={{ color: T.muted, fontSize: 9, fontWeight: 700 }}>영향도</span>
                            <span style={{ color: lvl.color, fontSize: 10, fontWeight: 900 }}>
                              {imp.total} · {lvl.label}
                            </span>
                          </div>
                          <div style={{ height: 4, background: T.alt, borderRadius: 2, overflow: 'hidden' }}>
                            <div style={{
                              height: '100%',
                              width: `${imp.total}%`,
                              background: lvl.color,
                              transition: 'width 300ms',
                            }} />
                          </div>
                        </div>
                      );
                    })()}

                    {/* 예측 + 자산 */}
                    {an ? (
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                        <PredictionBadge prediction={an.prediction} confidence={an.confidence} compact />
                        {an.affectedAssets.slice(0, 3).map(a => (
                          <span key={a.symbol} style={{
                            display: 'inline-flex', alignItems: 'center', gap: 3,
                            padding: '3px 7px',
                            background: T.alt,
                            border: `1px solid ${predColor(a.direction)}44`,
                            borderRadius: R.pill,
                            color: T.sub,
                            fontSize: 9, fontWeight: 700,
                          }}>
                            {a.direction === 'up' ? <TrendingUp size={9} strokeWidth={IC_STROKE} color={T.grn} />
                              : a.direction === 'down' ? <TrendingDown size={9} strokeWidth={IC_STROKE} color={T.red} />
                              : <Minus size={9} strokeWidth={IC_STROKE} color={T.ylw} />}
                            {a.symbol}
                          </span>
                        ))}
                      </div>
                    ) : isAnalyzing ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: T.acl, fontSize: 10, fontWeight: 700 }}>
                        <RefreshCw size={11} strokeWidth={IC_STROKE} style={{ animation: 'spin 1s linear infinite' }} />
                        AI 분석 중...
                      </div>
                    ) : (
                      <div style={{ ...F.muted, fontSize: 10 }}>
                        탭하면 AI 분석을 시작합니다
                      </div>
                    )}
                  </div>
                  <ChevronRight size={16} strokeWidth={IC_STROKE} color={T.muted} style={{ flexShrink: 0, marginTop: 4 }} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      <style jsx>{`
        @keyframes shimmer { 0%{background-position:200% 0} 100%{background-position:-200% 0} }
        @keyframes spin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
      `}</style>
    </div>
  );
}

export default function NewsPage(props: { currency?: string; onOpenAsset?: (a: { id: string; sym: string; nameKr: string; name: string; p: number; c: number; v: string; t: string; clr: string }, dest?: string) => void }) {
  return (
    <ErrorBoundary>
      <NewsPageInner {...props} />
    </ErrorBoundary>
  );
}
