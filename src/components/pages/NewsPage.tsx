'use client';
import { ConsensusPanel } from '@/components/news/ConsensusPanel';
import { AiVerdict, type AiVerdictData } from '@/components/news/AiVerdict';
import { A } from '@/lib/theme/colors';
import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  Search as SearchIc, X as XIcon, Newspaper, ExternalLink,
  TrendingUp, TrendingDown, Minus, Brain, Sparkles, AlertCircle,
  ChevronRight, RefreshCw, ArrowLeft, Star,
} from 'lucide-react';
import { T } from '@/lib/constants';
import { formatNewsDate } from '@/lib/format';
import { ErrorBoundary } from '@/components/pages/ErrorBoundary';
import { IconBox, IC_SIZE, IC_STROKE } from '@/components/ui/Icon';
import { cardStyle, buttonStyle, F, SP, R, PAGE_STYLE } from '@/components/ui/tokens';
import type { AnalyzedNews, RawNews } from '@/lib/news/types';
import { calculateImpact, impactLevel, getSourceInfo, TIER_COLOR, TIER_LABEL } from '@/lib/news/sources';
import { batchMatchNews, triggerNotification, markSeen } from '@/lib/news/matcher';
import { provenanceOf, type NewsProvenance } from '@/lib/news/feed';

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

// 저장된 분석의 방향별 색상. **정본과 같은 네 값을 쓴다** —
// bullish · bearish · neutral · uncertain. 화면에서 uncertain을 빼고 셋으로
// 그리면 모델이 "모르겠다"고 한 것이 "보합 전망"으로 둔갑한다.
const dirColor = (d: string | null | undefined): string =>
  d === 'bullish' ? T.grn : d === 'bearish' ? T.red : d === 'uncertain' ? T.ylw : T.sub;

// ── 중요도 별점 (AI 분석 없이도 출처·최신성·감성·영향종목수로 산출) ──
function newsImportance(n: any, impactTotal?: number): number {
  if (typeof impactTotal === 'number' && impactTotal > 0) {
    return Math.max(1, Math.min(5, Math.round(impactTotal / 20)));
  }
  let score = 0;
  try { const src = getSourceInfo(n.source); score += (src.reliability / 100) * 2; } catch {}
  if (n.sentiment === 'bullish' || n.sentiment === 'bearish') score += 1.2; else score += 0.4;
  const t = typeof n.time === 'number' ? n.time : (n.publishedAt ? new Date(n.publishedAt).getTime() : (n.time ? new Date(n.time).getTime() : 0));
  if (t) { const h = (Date.now() - t) / 3600000; score += h < 6 ? 1 : h < 24 ? 0.7 : h < 72 ? 0.4 : 0.1; }
  const tk = Array.isArray(n.tickers) ? n.tickers.length : 0;
  score += Math.min(0.8, tk * 0.25);
  return Math.max(1, Math.min(5, Math.round(score)));
}

function StarRow({ n: count, size = 11 }: { n: number; size?: number }) {
  const color = count >= 4 ? '#EF4444' : count >= 3 ? '#F59E0B' : '#64748B';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 1 }} title={`중요도 ${count}/5`}>
      {[1, 2, 3, 4, 5].map(i => (
        <Star key={i} size={size} color={color} fill={i <= count ? color : 'none'} strokeWidth={2} />
      ))}
    </span>
  );
}

// PredictionBadge와 ConfidenceBar는 없앴다.
//
// 둘 다 `confidence`를 "상승 예상 73%" · 채워진 막대로 그렸다. 그 숫자는
// **모델이 스스로 매긴 값**이고 과거 적중률로 보정된 적이 없다 — 상승 확률이
// 아니다. 그런데 %와 막대로 그리면 사람은 확률로 읽는다. 방향·근거·위험·
// 분석 모델만 적는 `AiVerdict`가 그 자리를 대신한다.

/**
 * 영향 자산 칩. 탭하면 매매 화면으로 간다.
 *
 * 방향은 **저장된 분석이 자산별로 말한 경우에만** 그린다. 예전에는 기사
 * 전체의 예측을 자산마다 복사해 붙였는데, 그러면 "이 뉴스는 상승"이
 * "BTC 상승·ETH 상승·SOL 상승"이라는 세 개의 판단으로 불어난다.
 */
function AssetTag({ symbol, direction, onClick }: { symbol: string; direction?: string | null; onClick?: () => void }) {
  const color = direction ? dirColor(direction) : T.border;
  const Icon = direction === 'bullish' ? TrendingUp : direction === 'bearish' ? TrendingDown : Minus;
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
  const [transCache, setTransCache] = useState<Record<string, { title?: string; summary?: string }>>({});
  // 이 목록이 실물인가 예시인가. **예시는 분석·알림에 넣지 않는다.**
  const [provenance, setProvenance] = useState<NewsProvenance>('LOADING');
  // 크론이 저장해 둔 AI 분석. 화면에서 다시 부르지 않는다 — 열 때마다
  // 분석하면 사람 수만큼 요금이 곱해진다.
  //
  // URL로 맞춘다. 실시간 피드와 저장본은 id 체계가 달라서 id로는 못 잇는다.
  const [aiByUrl, setAiByUrl] = useState<Record<string, AiVerdictData>>({});
  const [aiNote, setAiNote] = useState<string>('');
  /** 분석을 **할 수 없는** 상태의 사유. '아직 안 함'과 다른 말이다 */
  const [aiUnavailable, setAiUnavailable] = useState<string>('');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch('/api/news/stored?limit=100', { signal: AbortSignal.timeout(12000) });
        const j = await r.json();
        if (!alive) return;
        if (!r.ok || !j?.ok) {
          // 왜 분석이 안 붙는지 화면에 남긴다. 조용히 비워 두면
          // 사용자는 AI가 판단을 안 한 것으로 오해한다.
          const why = j?.needsMigration
            ? 'AI 분석 저장소가 아직 설정되지 않았습니다 (마이그레이션 019 필요)'
            : (j?.message || '저장된 AI 분석을 읽지 못했습니다');
          setAiNote(why);
          setAiUnavailable(why);
          return;
        }
        const map: Record<string, AiVerdictData> = {};
        for (const it of (j.items || [])) {
          if (it?.url) map[String(it.url)] = it as AiVerdictData;
        }
        setAiByUrl(map);
        setAiNote(j.analyzedCount === 0 && j.total > 0
          ? '수집은 됐지만 아직 분석 전입니다 — 분석 크론이 돌면 채워집니다' : '');
      } catch (e: any) {
        if (!alive) return;
        setAiNote('저장된 AI 분석을 읽지 못했습니다');
        setAiUnavailable('저장된 AI 분석을 읽지 못했습니다');
      }
    })();
    return () => { alive = false; };
  }, []);
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
      // **출처를 읽는다.** 이걸 안 읽어서 예시 기사가 분석·알림으로 흘렀다.
      setProvenance(provenanceOf(d?.source));
      const raw: RawNews[] = Array.isArray(d.news) ? d.news : (Array.isArray(d) ? d : []);
      // id 보강
      const normalized: AnalyzedNews[] = raw.map((n, i) => ({
        ...n,
        id: n.id || `${n.source || 'src'}_${n.time || i}_${(n.title || '').slice(0, 20)}`,
      }));
      setNews(normalized);
    } catch (e) {
      if (seq !== fetchSeqRef.current) return;
      console.warn('[news] fetch failed', e);
      setError('뉴스를 불러오지 못했습니다.');
      setNews([]);
      setProvenance('ERROR');
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

  // 화면에서 AI를 부르지 않는다
  // ───────────────────────────
  // 여기 있던 두 효과(상위 5개 자동 분석 · 기사 선택 시 즉시 분석)를 없앴다.
  //
  // 그 경로는 `/api/news/analyze`를 불렀고, 그 라우트와 브라우저 쪽
  // `analyzer.ts`는 **둘 다** 호출이 실패하거나 키가 없으면 `mockAnalyze()`로
  // 값을 채웠다. 그 값은 키워드 개수와 id 해시로 만든 것이라 관측이 아니다:
  //
  //     confidence = 50 + diff*8 + min(15, signals*2) + (hash(id) % 11 - 5)
  //
  // 그렇게 만든 confidence가 아래 알림 문턱(영향도 60점)을 넘기면 브라우저
  // 알림이 나갔다. 게다가 그 결과는 sessionStorage에 24시간 저장됐고,
  // 캐시에서 다시 읽을 때 `source`가 'cache'로 덮여 **지어낸 값이라는
  // 표시까지 사라졌다.**
  //
  // 저장된 분석(`/api/news/stored` ← `analyzeOne` ← `news_articles`)이 이미
  // 정본이고, 그쪽은 원문만 근거로 쓰고 실패하면 값을 만들지 않는다.
  // 화면은 그것을 읽기만 한다 — 열 때마다 분석하면 사람 수만큼 요금이
  // 곱해진다는 것도 같은 이유다.

  // 관심종목 매칭 + 영향도 높은 뉴스 자동 알림
  //
  // **저장된 분석만 쓴다.** 예시(SAMPLE) 기사로는 알리지 않는다.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (provenance !== 'LIVE') return;
    if (Object.keys(aiByUrl).length === 0) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;

    const items = filtered
      .map(n => ({ n, a: n.url ? aiByUrl[String(n.url)] : undefined }))
      .filter((x): x is { n: typeof x.n; a: AiVerdictData } => !!x.n.id && !!x.a && x.a.analyzed)
      .map(({ n, a }) => ({
        id: n.id!,
        sourceName: n.source,
        publishedAt: typeof n.time === 'number' ? n.time : (n.time ? new Date(n.time).getTime() : undefined),
        analysis: {
          direction: a.direction,
          confidence: a.confidence,
          affectedAssets: a.affectedAssets ?? [],
        },
      }));

    const { notifications } = batchMatchNews(items);
    // 최대 2개까지만 알림 (스팸 방지)
    for (const m of notifications.slice(0, 2)) {
      const news = filtered.find(n => n.id === m.newsId);
      if (news) triggerNotification(m, news.title || '뉴스 알림');
    }
  }, [aiByUrl, filtered, provenance]);

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
    // 저장된 분석 하나만 본다. 화면은 분석을 만들지 않는다.
    const an: AiVerdictData | undefined = selected.url ? aiByUrl[String(selected.url)] : undefined;
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

        {/* AI 분석 카드 — 저장된 정본 하나만 그린다 */}
        <div style={{
          ...cardStyle({ marginBottom: SP.md }),
          background: an?.analyzed ? `linear-gradient(135deg, ${T.card}, ${dirColor(an.direction)}08)` : T.card,
          border: an?.analyzed ? `1px solid ${dirColor(an.direction)}33` : `1px solid ${T.border}`,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: SP.sm, marginBottom: SP.md }}>
            <IconBox tone="purple" size="sm">
              <Brain size={IC_SIZE.sm} strokeWidth={IC_STROKE} />
            </IconBox>
            <div style={{ flex: 1 }}>
              <div style={F.section}>AI 분석</div>
              <div style={F.muted}>
                {an?.analyzed
                  ? `${an.aiProvider || '모델'}${an.aiModel ? ` · ${an.aiModel}` : ''} 분석`
                  : aiUnavailable ? 'AI 분석 사용 불가' : 'AI 분석 대기'}
              </div>
            </div>
          </div>

          {/* 없는 분석을 채우지 않는다. 왜 없는지만 적는다. */}
          {!an?.analyzed && (
            <div style={F.muted}>
              {aiUnavailable
                ? aiUnavailable
                : '수집은 됐지만 아직 분석 전입니다 — 분석이 끝나면 여기에 채워집니다.'}
            </div>
          )}

          {an?.analyzed && (
            <>
              <AiVerdict a={an} />

              {/* 영향 자산 — 탭하면 매매로 이동.
                  방향은 자산별로 따로 말한 적이 없으므로 붙이지 않는다. */}
              {(an.affectedAssets?.length ?? 0) > 0 && (
                <div style={{ marginTop: SP.md }}>
                  <div style={{ ...F.caption, marginBottom: 6 }}>영향 자산 (탭하면 매매로 이동)</div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {an.affectedAssets!.map(sym => (
                      <AssetTag key={sym} symbol={sym} onClick={() => openAssetTag(sym)} />
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
                    background: T.acg, color: T.acl, border: `1px solid ${A(T.acl,'44')}`,
                    gap: 4,
                  }}>
                  {t} <ChevronRight size={11} strokeWidth={IC_STROKE} />
                </button>
              ))}
            </div>
          </div>
        )}

        {/* AI별 의견 비교 — 원문 링크 바로 위.
            원문을 확인할 수 있는 기사에만 붙인다. 링크 없이 여러 AI에게
            물어봐야 대조할 방법이 없고 비용만 세 배로 나간다. */}
        {(() => {
          // time은 '5분 전' 같은 표시용 문자열이다. 실제 시각은 publishedAt에
          // 있다. time을 Date에 넣으면 toISOString()이 던져서 상세 화면이
          // 통째로 죽는다 — 실제로 그렇게 만들었다가 '페이지 로딩 오류'를 봤다.
          //
          // publishedAt은 문자열 그대로 넘긴다. 시간대 표기가 없는 값이
          // 섞여 있는데, 여기서 UTC라고 단정하면 없는 정보를 만들어내는 것이다.
          // 이 값은 기록·대조용이라 원문 그대로가 맞다.
          const pub = (selected as any).publishedAt;
          const at = typeof pub === 'string' && pub.trim() ? pub.trim() : null;
          if (!selected.url || !at) return null;
          return (
            <ConsensusPanel article={{
              title: selected.title,
              body: selected.content || selected.summary || undefined,
              url: String(selected.url),
              publishedAt: at,
              source: selected.source,
            }}/>
          );
        })()}

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
          {/* AI 분석이 왜 안 보이는지 화면에 남긴다. 조용히 비워 두면
              사용자는 AI가 판단을 안 한 것으로 오해한다 — 실제로는
              저장소가 없거나 아직 분석 전이다. */}
          {aiNote && (
            <div style={{
              padding: '9px 12px', borderRadius: R.md,
              background: A(T.ylw, '15'), border: `1px solid ${A(T.ylw, '30')}`,
              color: T.ylw, fontSize: 11, lineHeight: 1.55,
            }}>{aiNote}</div>
          )}
          {filtered.map(n => {
            const id = n.id || '';
            const _lang = (()=>{ try { return localStorage.getItem('tg_lang')||'ko'; } catch { return 'ko'; } })();
            const _tc = transCache[`${id}_${_lang}`];
            // 크론이 저장한 분석을 먼저 쓴다. 화면에서 즉석 분석한 것보다
            // 검증을 거친 값이다 — 근거 없는 단정이 걸러졌고 원문 URL도
            // 모델이 지어낸 것이 아니라 수집한 값으로 대조됐다.
            const stored = n.url ? aiByUrl[String(n.url)] : undefined;
            const displayTitle = stored?.titleKo || _tc?.title || n.title;
            const displaySummary = stored?.summary || _tc?.summary;
            // 영향도는 **저장된 분석이 있을 때만** 계산한다. 없으면 없는 것이다 —
            // 확신도를 50으로 가정해서 점수를 만들지 않는다.
            const storedImpact = stored?.analyzed
              ? calculateImpact({
                  sourceName: n.source,
                  prediction: stored.direction === 'bullish' ? 'up'
                    : stored.direction === 'bearish' ? 'down'
                    : stored.direction === 'neutral' ? 'flat' : undefined,
                  confidence: stored.confidence,
                  publishedAt: typeof n.time === 'number' ? n.time : (n.time ? new Date(n.time).getTime() : undefined),
                  numAffectedAssets: stored.affectedAssets?.length || 0,
                })
              : undefined;

            return (
              <div
                key={id}
                onClick={() => { setSelected(n); markSeen(id); }}
                style={{
                  ...cardStyle(),
                  cursor: 'pointer',
                  position: 'relative',
                  minHeight: 80,
                  borderLeft: `3px solid ${stored?.analyzed
                    ? (stored.direction === 'bullish' ? T.grn
                      : stored.direction === 'bearish' ? T.red
                      : stored.direction === 'uncertain' ? T.ylw : T.sub)
                    : T.border}`,
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

                    {/* AI 판정 — 저장된 분석이 있을 때만.
                        없으면 아무것도 안 그린다. '분석 대기'를 모든 카드에
                        붙이면 그게 배경 소음이 되어 진짜 분석도 안 읽힌다. */}
                    {stored && (
                      <div style={{ marginBottom: 8 }}>
                        <AiVerdict a={stored}/>
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
                      <span style={{ marginLeft: 'auto' }}><StarRow n={newsImportance(n, storedImpact?.total)} /></span>
                    </div>

                    {/* 영향도 게이지 — 저장된 분석이 있을 때만 */}
                    {storedImpact && (() => {
                      const lvl = impactLevel(storedImpact.total);
                      return (
                        <div style={{ marginBottom: 6 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 2 }}>
                            <span style={{ color: T.muted, fontSize: 9, fontWeight: 700 }}>영향도</span>
                            <span style={{ color: lvl.color, fontSize: 10, fontWeight: 900 }}>
                              {storedImpact.total} · {lvl.label}
                            </span>
                          </div>
                          <div style={{ height: 4, background: T.alt, borderRadius: 2, overflow: 'hidden' }}>
                            <div style={{
                              height: '100%',
                              width: `${storedImpact.total}%`,
                              background: lvl.color,
                              transition: 'width 300ms',
                            }} />
                          </div>
                        </div>
                      );
                    })()}

                    {/* 영향 종목 (항상 표시, AI 분석 없이도 n.tickers) */}
                    {Array.isArray(n.tickers) && n.tickers.length > 0 && (
                      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
                        <span style={{ color: T.muted, fontSize: 9, fontWeight: 700 }}>영향 종목</span>
                        {n.tickers.slice(0, 6).map((tk: string) => (
                          <span key={tk}
                            onClick={(e) => { e.stopPropagation(); onOpenAsset && onOpenAsset({ id: tk, sym: tk, nameKr: tk, name: tk, p: 0, c: 0, v: '-', t: 'coin', clr: '#3B82F6' }, 'trading'); }}
                            style={{ padding: '2px 8px', background: T.alt, border: `1px solid ${T.border}`, borderRadius: R.pill, color: T.sub, fontSize: 9.5, fontWeight: 700, cursor: 'pointer' }}>
                            {tk}
                          </span>
                        ))}
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
