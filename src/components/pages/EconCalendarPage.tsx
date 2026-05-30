'use client';
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  CalendarDays, Star, Globe2, Info, TriangleAlert, ArrowLeft,
  CheckCheck, XCircle, Filter,
} from 'lucide-react';
import { T } from '@/lib/constants';
import { ErrorBoundary } from './ErrorBoundary';
import { IconBox, IC_SIZE, IC_STROKE } from '@/components/ui/Icon';
import { cardStyle, buttonStyle, F, SP, R, PAGE_STYLE } from '@/components/ui/tokens';

// ── 경제 이벤트 다언어 번역 맵 ─────────────────────────────────
const ECO_TRANS: Record<string, Record<string, string>> = {
  'CPI':            { ko:'소비자물가지수',    en:'Consumer Price Index',      ja:'消費者物価指数',     zh:'消费者价格指数' },
  'Core CPI':       { ko:'근원 소비자물가',  en:'Core CPI',                   ja:'コア消費者物価',     zh:'核心CPI' },
  'FOMC':           { ko:'FOMC 금리 결정',  en:'FOMC Rate Decision',        ja:'FOMC金利決定',       zh:'FOMC利率决议' },
  'NFP':            { ko:'비농업고용지수',   en:'Non-Farm Payrolls',          ja:'非農業部門雇用者数', zh:'非农就业人数' },
  'Nonfarm Payrolls':{ ko:'비농업고용지수',  en:'Non-Farm Payrolls',          ja:'非農業部門雇用者数', zh:'非农就业人数' },
  'GDP':            { ko:'국내총생산',       en:'Gross Domestic Product',     ja:'国内総生産',         zh:'国内生产总值' },
  'PPI':            { ko:'생산자물가지수',   en:'Producer Price Index',       ja:'生産者物価指数',     zh:'生产者价格指数' },
  'PMI':            { ko:'구매관리자지수',   en:'Purchasing Managers Index',  ja:'購買担当者景気指数', zh:'采购经理人指数' },
  'ECB':            { ko:'ECB 금리 결정',   en:'ECB Rate Decision',          ja:'ECB金利決定',        zh:'欧央行利率决议' },
  'BOJ':            { ko:'일본은행 금리',   en:'BOJ Rate Decision',          ja:'日銀金利決定',       zh:'日本央行利率' },
  'BOE':            { ko:'영란은행 금리',   en:'BOE Rate Decision',          ja:'BOE金利決定',        zh:'英国央行利率' },
  '금통위':         { ko:'한국은행 금통위', en:'Bank of Korea Rate',         ja:'韓国銀行金融政策',   zh:'韩国央行利率' },
  'Unemployment':   { ko:'실업률',         en:'Unemployment Rate',          ja:'失業率',             zh:'失业率' },
  'Retail Sales':   { ko:'소매판매',       en:'Retail Sales',               ja:'小売売上高',         zh:'零售销售' },
  'ISM':            { ko:'ISM 제조업',     en:'ISM Manufacturing',          ja:'ISM製造業',          zh:'ISM制造业' },
  'Trade Balance':  { ko:'무역수지',       en:'Trade Balance',              ja:'貿易収支',           zh:'贸易差额' },
  'Inflation':      { ko:'인플레이션',     en:'Inflation Rate',             ja:'インフレ率',         zh:'通胀率' },
  'Interest Rate':  { ko:'기준금리',       en:'Interest Rate',              ja:'政策金利',           zh:'基准利率' },
  'Housing':        { ko:'주택지표',       en:'Housing Data',               ja:'住宅指標',           zh:'住房数据' },
  'Consumer Conf':  { ko:'소비자신뢰지수', en:'Consumer Confidence',        ja:'消費者信頼感',       zh:'消费者信心' },
  'Durable Goods':  { ko:'내구재주문',     en:'Durable Goods Orders',       ja:'耐久財受注',         zh:'耐用品订单' },
  'Industrial Prod':{ ko:'산업생산',       en:'Industrial Production',      ja:'鉱工業生産',         zh:'工业产出' },
};

function tEco(lang: string, title: string): string {
  const safeTitle = String(title || '');
  const langKey = lang === 'ko' ? 'ko' : lang === 'ja' ? 'ja' : lang === 'zh' ? 'zh' : 'en';
  if (!safeTitle) return '';
  // 더 긴 키를 먼저 매칭 (Core CPI > CPI 등)
  const keys = Object.keys(ECO_TRANS).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (safeTitle.includes(key)) {
      const trans = ECO_TRANS[key][langKey] || ECO_TRANS[key]['en'];
      const rest = safeTitle.replace(key, '').trim();
      return rest ? `${trans} ${rest}` : trans;
    }
  }
  return safeTitle;
}

// ── 이벤트 short code 추출 (FOMC, CPI 등) ────────────────────
function getEventCode(event: string): string {
  const codes = ['FOMC','CPI','NFP','GDP','PPI','PMI','ECB','BOJ','BOE','ISM','금통위'];
  for (const c of codes) {
    if (event.includes(c)) return c;
  }
  // 첫 단어를 코드로
  const first = event.split(/[\s·,]/)[0];
  return first.slice(0, 6).toUpperCase();
}

// ── Mock data fallback ─────────────────────────────────────────
const MOCK_EVENTS = [
  { id:'1',  event:'CPI',            country:'US', date:'2025-01-15', time:'08:30', impact:'high',   forecast:'3.2%',  previous:'3.1%',  actual:'3.4%',  unit:'%' },
  { id:'2',  event:'FOMC',           country:'US', date:'2025-01-29', time:'14:00', impact:'high',   forecast:'5.25%', previous:'5.50%', actual:null,    unit:'%' },
  { id:'3',  event:'Nonfarm Payrolls',country:'US',date:'2025-02-07', time:'08:30', impact:'high',   forecast:'180K',  previous:'216K',  actual:null,    unit:'K' },
  { id:'4',  event:'GDP',            country:'US', date:'2025-01-30', time:'08:30', impact:'medium', forecast:'2.5%',  previous:'2.8%',  actual:null,    unit:'%' },
  { id:'5',  event:'PMI',            country:'EU', date:'2025-01-22', time:'04:00', impact:'medium', forecast:'44.2',  previous:'44.4',  actual:'44.1',  unit:''  },
  { id:'6',  event:'금통위',          country:'KR', date:'2025-01-16', time:'10:00', impact:'high',   forecast:'3.0%',  previous:'3.25%', actual:'3.0%',  unit:'%' },
  { id:'7',  event:'ECB',            country:'EU', date:'2025-01-23', time:'08:15', impact:'high',   forecast:'3.5%',  previous:'3.75%', actual:null,    unit:'%' },
  { id:'8',  event:'PPI',            country:'US', date:'2025-01-14', time:'08:30', impact:'medium', forecast:'1.8%',  previous:'1.7%',  actual:'2.0%',  unit:'%' },
  { id:'9',  event:'Retail Sales',   country:'US', date:'2025-01-17', time:'08:30', impact:'medium', forecast:'-0.1%', previous:'0.3%',  actual:null,    unit:'%' },
  { id:'10', event:'ISM',            country:'US', date:'2025-02-03', time:'10:00', impact:'medium', forecast:'48.5',  previous:'47.4',  actual:null,    unit:''  },
  { id:'11', event:'Unemployment',   country:'KR', date:'2025-01-15', time:'08:00', impact:'low',    forecast:'2.9%',  previous:'2.8%',  actual:'2.9%',  unit:'%' },
  { id:'12', event:'Consumer Conf',  country:'EU', date:'2025-01-24', time:'10:00', impact:'low',    forecast:'-14',   previous:'-15',   actual:null,    unit:''  },
  { id:'13', event:'BOJ',            country:'JP', date:'2025-01-24', time:'12:00', impact:'high',   forecast:'0.25%', previous:'0.25%', actual:null,    unit:'%' },
  { id:'14', event:'GDP',            country:'JP', date:'2025-02-14', time:'08:50', impact:'medium', forecast:'0.3%',  previous:'0.1%',  actual:null,    unit:'%' },
  { id:'15', event:'CPI',            country:'UK', date:'2025-01-15', time:'07:00', impact:'high',   forecast:'2.6%',  previous:'2.3%',  actual:null,    unit:'%' },
  { id:'16', event:'BOE',            country:'UK', date:'2025-02-06', time:'12:00', impact:'high',   forecast:'4.50%', previous:'4.75%', actual:null,    unit:'%' },
  { id:'17', event:'CPI',            country:'CN', date:'2025-01-09', time:'01:30', impact:'medium', forecast:'0.3%',  previous:'0.2%',  actual:null,    unit:'%' },
  { id:'18', event:'GDP',            country:'CA', date:'2025-02-28', time:'08:30', impact:'medium', forecast:'1.8%',  previous:'1.0%',  actual:null,    unit:'%' },
  { id:'19', event:'Unemployment',   country:'AU', date:'2025-02-13', time:'00:30', impact:'high',   forecast:'4.1%',  previous:'4.0%',  actual:null,    unit:'%' },
];

// ── 국가 정보 ─────────────────────────────────────────────────
interface CountryInfo { code: string; ko: string; en: string; }
const COUNTRIES_INFO: CountryInfo[] = [
  { code: 'US', ko: '미국',   en: 'United States' },
  { code: 'KR', ko: '한국',   en: 'South Korea' },
  { code: 'JP', ko: '일본',   en: 'Japan' },
  { code: 'CN', ko: '중국',   en: 'China' },
  { code: 'EU', ko: '유럽',   en: 'Eurozone' },
  { code: 'UK', ko: '영국',   en: 'United Kingdom' },
  { code: 'CA', ko: '캐나다', en: 'Canada' },
  { code: 'AU', ko: '호주',   en: 'Australia' },
];

function countryLabel(code: string, lang: string): string {
  const info = COUNTRIES_INFO.find(c => c.code === code);
  if (!info) return code;
  return lang === 'ko' ? info.ko : info.en;
}

// ── 별점 컴포넌트 (lucide Star) ───────────────────────────────
function ImpactStars({ impact, size = 12 }: { impact: string; size?: number }) {
  const count = impact === 'high' ? 3 : impact === 'medium' ? 2 : 1;
  const color = impact === 'high' ? T.red : impact === 'medium' ? T.ylw : T.acl;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}>
      {[1, 2, 3].map(i => (
        <Star
          key={i}
          size={size}
          strokeWidth={2}
          color={i <= count ? color : T.border}
          fill={i <= count ? color : 'transparent'}
        />
      ))}
    </span>
  );
}

// ── localStorage 필터 키 ──────────────────────────────────────
const FILTER_KEY = 'tg_calendar_filters_v2';
interface SavedFilters {
  impact: 'all' | 'high' | 'medium' | 'low';
  countries: string[]; // 빈 배열이면 전체
}

function loadFilters(): SavedFilters {
  const defaults: SavedFilters = { impact: 'all', countries: [] };
  if (typeof window === 'undefined') return defaults;
  try {
    const raw = window.localStorage.getItem(FILTER_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return defaults;
    return {
      impact: ['all','high','medium','low'].includes(parsed.impact) ? parsed.impact : 'all',
      countries: Array.isArray(parsed.countries) ? parsed.countries.filter((c: unknown) => typeof c === 'string') : [],
    };
  } catch { return defaults; }
}

function saveFilters(f: SavedFilters): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(FILTER_KEY, JSON.stringify(f)); } catch {}
}

// ─────────────────────────────────────────────────────────────
function EconCalendarInner({ lang = 'ko' }: { lang?: string }) {
  const [filter,       setFilter]       = useState<'all'|'high'|'medium'|'low'>('all');
  const [countries,    setCountries]    = useState<string[]>([]); // 빈 배열 = 전체
  const [selected,     setSelected]     = useState<typeof MOCK_EVENTS[number] | null>(null);
  const [events,       setEvents]       = useState<typeof MOCK_EVENTS>([]);
  const [loading,      setLoading]      = useState(true);

  // 첫 마운트에 저장된 필터 복원
  useEffect(() => {
    const saved = loadFilters();
    setFilter(saved.impact);
    setCountries(saved.countries);
  }, []);

  // 필터 변경 시 저장
  useEffect(() => {
    saveFilters({ impact: filter, countries });
  }, [filter, countries]);

  // 이벤트 fetch
  useEffect(() => {
    setLoading(true);
    fetch(`/api/calendar?lang=${lang}&country=all`, { signal: AbortSignal.timeout(8000) })
      .then(r => r.json())
      .then(d => {
        const evts = Array.isArray(d.data) ? d.data : (Array.isArray(d.events) ? d.events : []);
        setEvents(evts.length > 0 ? evts : MOCK_EVENTS);
      })
      .catch(() => setEvents(MOCK_EVENTS))
      .finally(() => setLoading(false));
  }, [lang]);

  const filtered = useMemo(() => {
    if (!Array.isArray(events)) return [];
    return events.filter(e => {
      const matchImpact  = filter === 'all' || e.impact === filter;
      // countries 빈 배열이면 전체 (모두 통과), 아니면 포함 여부 체크
      const matchCountry = countries.length === 0 || countries.includes(e.country);
      return matchImpact && matchCountry;
    });
  }, [events, filter, countries]);

  const langKey = lang === 'ko' ? 'ko' : lang === 'ja' ? 'ja' : lang === 'zh' ? 'zh' : 'en';

  // 이벤트 설명 (상세 화면)
  const eventDesc: Record<string, Record<string, string>> = {
    CPI:   { ko:'소비자물가지수 — 인플레이션의 핵심 지표. 예상 상회 시 긴축 가능성 ↑', en:'Consumer Price Index — Core inflation indicator. Beat → tightening risk.' },
    FOMC:  { ko:'연방공개시장위원회 — Fed 금리 결정. 시장 방향성에 가장 큰 영향', en:'FOMC — Fed rate decision. Biggest single market-moving event.' },
    NFP:   { ko:'비농업고용 — 고용시장 강도 지표. 강한 고용 → 금리 인상 우려', en:'Non-Farm Payrolls — Strength of US labor market. Strong = rate hike risk.' },
    GDP:   { ko:'국내총생산 성장률 — 경기 상태 척도', en:'GDP growth rate — Broad measure of economic health.' },
    PMI:   { ko:'구매관리자지수 — 50 이상 경기 확장, 50 이하 수축', en:'PMI — Above 50 = expansion, below 50 = contraction.' },
    ECB:   { ko:'유럽중앙은행 금리 결정', en:'European Central Bank rate decision.' },
    BOJ:   { ko:'일본은행 금리 결정', en:'Bank of Japan rate decision.' },
    BOE:   { ko:'영란은행 금리 결정', en:'Bank of England rate decision.' },
    '금통위':{ ko:'한국은행 기준금리 결정', en:'Bank of Korea benchmark rate decision.' },
  };

  // 국가 토글
  const toggleCountry = (code: string) => {
    setCountries(prev => prev.includes(code) ? prev.filter(c => c !== code) : [...prev, code]);
  };
  const selectAll = () => setCountries([]);

  // ── Detail View ──────────────────────────────────────────────
  if (selected) {
    const code = getEventCode(selected.event || '');
    const desc = (() => {
      for (const [k, m] of Object.entries(eventDesc)) {
        if (String(selected.event || '').includes(k)) return m[langKey] || m['en'];
      }
      return null;
    })();

    const hasActual = selected.actual !== null && selected.actual !== undefined && selected.actual !== '';
    const stateColor = hasActual ? T.grn : T.muted;
    const stateLabel = hasActual
      ? (lang === 'ko' ? '발표 완료' : lang === 'ja' ? '発表済み' : 'Released')
      : (lang === 'ko' ? '발표 전' : lang === 'ja' ? '発表前' : 'Upcoming');

    return (
      <div style={PAGE_STYLE}>
        <button onClick={() => setSelected(null)} style={{ ...buttonStyle('ghost', 'sm'), gap: 6, marginBottom: SP.md }}>
          <ArrowLeft size={14} strokeWidth={IC_STROKE} />
          {lang === 'ko' ? '목록으로' : lang === 'ja' ? '一覧に戻る' : 'Back'}
        </button>

        {/* 헤더 카드 */}
        <div style={cardStyle({ marginBottom: SP.md })}>
          <div style={{ display: 'flex', alignItems: 'center', gap: SP.sm, marginBottom: SP.sm }}>
            <IconBox tone="blue" size="md"><CalendarDays size={IC_SIZE.md} strokeWidth={IC_STROKE} /></IconBox>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ ...F.title, lineHeight: 1.4 }}>{tEco(lang, selected.event)}</div>
              <div style={{ ...F.muted, marginTop: 2, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ background: T.alt, padding: '2px 6px', borderRadius: R.sm, color: T.sub, fontWeight: 700 }}>{code}</span>
                <Globe2 size={11} strokeWidth={IC_STROKE} />
                <span>{countryLabel(selected.country, lang)} ({selected.country})</span>
                <span>·</span>
                <span>{selected.date} {selected.time}</span>
              </div>
            </div>
          </div>

          {/* 영향도 + 상태 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: SP.sm, flexWrap: 'wrap' }}>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 10px', background: T.alt, borderRadius: R.pill }}>
              <ImpactStars impact={selected.impact} size={13} />
              <span style={{ color: selected.impact === 'high' ? T.red : selected.impact === 'medium' ? T.ylw : T.acl, fontWeight: 700, fontSize: 11 }}>
                {selected.impact === 'high'   ? (lang === 'ko' ? '고영향' : 'High')
                 : selected.impact === 'medium'? (lang === 'ko' ? '중영향' : 'Medium')
                 : (lang === 'ko' ? '저영향' : 'Low')}
              </span>
            </div>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 10px', background: stateColor + '22', borderRadius: R.pill, color: stateColor, fontWeight: 700, fontSize: 11 }}>
              {hasActual
                ? <CheckCheck size={12} strokeWidth={IC_STROKE} />
                : <XCircle size={12} strokeWidth={IC_STROKE} />}
              {stateLabel}
            </div>
          </div>
        </div>

        {/* 값 카드 — 예측 / 이전 / 실제 */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: SP.sm, marginBottom: SP.md }}>
          {[
            { l: lang === 'ko' ? '예측' : lang === 'ja' ? '予測' : 'Forecast', v: selected.forecast, color: T.acl },
            { l: lang === 'ko' ? '이전' : lang === 'ja' ? '前回' : 'Previous', v: selected.previous, color: T.muted },
            { l: lang === 'ko' ? '실제' : lang === 'ja' ? '実績' : 'Actual',   v: selected.actual,   color: hasActual ? T.grn : T.muted },
          ].map(d => (
            <div key={d.l} style={{ padding: '12px 8px', background: T.card, border: `1px solid ${T.border}`, borderRadius: R.md, textAlign: 'center' }}>
              <div style={F.muted}>{d.l}</div>
              <div style={{ ...F.numS, color: d.color, marginTop: 4, fontSize: 14 }}>
                {d.v !== null && d.v !== undefined && d.v !== '' ? `${d.v}${selected.unit || ''}` : '—'}
              </div>
            </div>
          ))}
        </div>

        {/* 이벤트 설명 */}
        {desc && (
          <div style={cardStyle({ marginBottom: SP.md, background: T.acl + '08', border: `1px solid ${T.acl}30` })}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
              <Info size={IC_SIZE.sm} strokeWidth={IC_STROKE} color={T.acl} />
              <span style={{ ...F.section, color: T.acl }}>{lang === 'ko' ? '이벤트 설명' : lang === 'ja' ? 'イベント説明' : 'Event Info'}</span>
            </div>
            <div style={{ ...F.body, color: T.sub, lineHeight: 1.7 }}>{desc}</div>
          </div>
        )}

        {/* 트레이딩 주의 */}
        {selected.impact === 'high' && (
          <div style={cardStyle({ background: T.red + '08', border: `1px solid ${T.red}40` })}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
              <TriangleAlert size={IC_SIZE.sm} strokeWidth={IC_STROKE} color={T.red} />
              <span style={{ ...F.section, color: T.red }}>
                {lang === 'ko' ? '트레이딩 주의' : lang === 'ja' ? 'トレーディング注意' : 'Trading Alert'}
              </span>
            </div>
            <div style={{ ...F.body, color: T.sub, lineHeight: 1.7 }}>
              {lang === 'ko'
                ? '고영향 이벤트 발표 30분 전후에는 변동성이 급격히 증가합니다. 기존 포지션 리스크를 점검하고 무리한 레버리지 사용을 피하세요.'
                : lang === 'ja'
                ? '高影響イベントの前後30分は急激な変動があります。既存ポジションのリスクを確認し、過度なレバレッジを避けてください。'
                : 'High-impact events cause extreme volatility ±30min. Review open positions and avoid excessive leverage.'}
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── List View ─────────────────────────────────────────────────
  const filterLabels: Array<{ id: 'all'|'high'|'medium'|'low'; label: string; stars: number }> = [
    { id: 'all',    label: lang === 'ko' ? '전체' : lang === 'ja' ? '全て'    : 'All',    stars: 0 },
    { id: 'high',   label: lang === 'ko' ? '★★★' : lang === 'ja' ? '★★★' : '★★★', stars: 3 },
    { id: 'medium', label: lang === 'ko' ? '★★'  : lang === 'ja' ? '★★'  : '★★',  stars: 2 },
    { id: 'low',    label: lang === 'ko' ? '★'   : lang === 'ja' ? '★'   : '★',   stars: 1 },
  ];

  const visibleCountryCount = countries.length;
  const allActive = visibleCountryCount === 0; // 빈 배열이면 전체

  return (
    <div style={PAGE_STYLE}>
      {/* 헤더 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: SP.sm, marginBottom: SP.md }}>
        <IconBox tone="blue" size="md"><CalendarDays size={IC_SIZE.md} strokeWidth={IC_STROKE} /></IconBox>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={F.title}>{lang === 'ko' ? '경제 캘린더' : lang === 'ja' ? '経済カレンダー' : 'Economic Calendar'}</div>
          <div style={F.caption}>
            {lang === 'ko' ? '주요 지표 · 발표 일정 · 영향도' : lang === 'ja' ? '主要指標・発表予定・影響度' : 'Key indicators · Schedule · Impact'}
          </div>
        </div>
      </div>

      {/* 영향도 필터 (별점) */}
      <div style={{ display: 'flex', gap: 5, marginBottom: SP.sm, flexWrap: 'wrap' }}>
        {filterLabels.map(({ id, label, stars }) => {
          const active = filter === id;
          const color = id === 'high' ? T.red : id === 'medium' ? T.ylw : id === 'low' ? T.acl : T.acl;
          return (
            <button key={id} onClick={() => setFilter(id)}
              style={{
                ...buttonStyle('ghost', 'sm'),
                flex: 1, minWidth: 60,
                background: active ? color + '22' : T.alt,
                color:      active ? color : T.muted,
                border:     `1px solid ${active ? color : T.border}`,
                gap: 4,
              }}>
              {stars > 0 ? (
                <span style={{ display: 'inline-flex', gap: 1 }}>
                  {Array.from({ length: stars }).map((_, i) => (
                    <Star key={i} size={11} strokeWidth={2} color={color} fill={color} />
                  ))}
                </span>
              ) : (
                <Filter size={12} strokeWidth={IC_STROKE} />
              )}
              {id === 'all' ? label : ''}
            </button>
          );
        })}
      </div>

      {/* 국가 필터 — 다중 선택 */}
      <div style={cardStyle({ padding: SP.sm + 2, marginBottom: SP.md })}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: SP.sm }}>
          <Globe2 size={13} strokeWidth={IC_STROKE} color={T.sub} />
          <span style={{ ...F.caption }}>{lang === 'ko' ? '국가 (다중 선택)' : lang === 'ja' ? '国・地域' : 'Countries'}</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
            <button onClick={selectAll}
              style={{ ...buttonStyle('ghost', 'sm'), padding: '6px 10px', minHeight: 32,
                background: allActive ? T.acg : 'transparent',
                color: allActive ? T.acl : T.muted, fontSize: 10 }}>
              {lang === 'ko' ? '전체' : 'All'}
            </button>
            {!allActive && (
              <button onClick={() => setCountries([])}
                style={{ ...buttonStyle('ghost', 'sm'), padding: '6px 10px', minHeight: 32, fontSize: 10 }}>
                {lang === 'ko' ? '해제' : 'Clear'}
              </button>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 5, overflowX: 'auto', WebkitOverflowScrolling: 'touch', paddingBottom: 2 }}>
          {COUNTRIES_INFO.map(c => {
            const active = countries.includes(c.code);
            return (
              <button key={c.code} onClick={() => toggleCountry(c.code)}
                style={{
                  flexShrink: 0, padding: '8px 12px', minHeight: 36,
                  background: active ? T.acg : T.alt,
                  color:      active ? T.acl : T.muted,
                  border:     `1px solid ${active ? T.acl : T.border}`,
                  borderRadius: R.pill,
                  fontSize: 11, fontWeight: 700,
                  cursor: 'pointer', touchAction: 'manipulation',
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  boxShadow: active ? `0 0 0 1px ${T.acl}55` : 'none',
                }}>
                {c.code} <span style={{ opacity: 0.7, fontWeight: 500 }}>{lang === 'ko' ? c.ko : c.en}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 본문 */}
      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: SP.sm }}>
          {[0,1,2,3].map(i => (
            <div key={i} style={cardStyle()}>
              <div className="skeleton" style={{ height: 14, marginBottom: 6, width: '70%', borderRadius: 4 }}/>
              <div className="skeleton" style={{ height: 10, width: '40%', borderRadius: 4 }}/>
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div style={cardStyle({ textAlign: 'center', padding: '40px 20px' })}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8 }}>
            <CalendarDays size={28} strokeWidth={IC_STROKE} color={T.muted} />
          </div>
          <div style={F.muted}>
            {lang === 'ko' ? '해당 조건의 경제 이벤트가 없습니다' :
             lang === 'ja' ? '該当イベントはありません' :
             'No events found'}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: SP.sm }}>
          {filtered.map(e => {
            const code = getEventCode(e.event || '');
            const hasActual = e.actual !== null && e.actual !== undefined && e.actual !== '';
            const impactColor = e.impact === 'high' ? T.red : e.impact === 'medium' ? T.ylw : T.acl;
            return (
              <div key={e.id}
                onClick={() => setSelected(e)}
                style={{
                  ...cardStyle({ padding: SP.md }),
                  cursor: 'pointer',
                  borderLeft: `3px solid ${impactColor}`,
                  touchAction: 'manipulation',
                  minHeight: 70,
                }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: SP.sm }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {/* 지표 코드 + 이름 */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, flexWrap: 'wrap' }}>
                      <span style={{ background: T.alt, padding: '2px 7px', borderRadius: R.sm, fontSize: 10, fontWeight: 800, color: T.acl, letterSpacing: 0.3 }}>
                        {code}
                      </span>
                      <span style={{ ...F.body, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {tEco(lang, e.event)}
                      </span>
                    </div>
                    {/* 국가 + 시간 + 상태 */}
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', ...F.muted, flexWrap: 'wrap' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                        <Globe2 size={10} strokeWidth={IC_STROKE} />
                        {countryLabel(e.country, lang)}
                      </span>
                      <span>{e.date}</span>
                      <span>{e.time}</span>
                      {hasActual ? (
                        <span style={{ color: T.grn, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                          <CheckCheck size={10} strokeWidth={IC_STROKE} />
                          {lang === 'ko' ? '발표' : 'Done'}
                        </span>
                      ) : (
                        <span style={{ color: T.muted, fontWeight: 600 }}>
                          {lang === 'ko' ? '발표 전' : 'Upcoming'}
                        </span>
                      )}
                    </div>
                    {/* 값 (예측 / 이전 / 실제) */}
                    <div style={{ display: 'flex', gap: 10, marginTop: 6, flexWrap: 'wrap', fontSize: 10 }}>
                      {e.forecast && (
                        <span style={{ color: T.muted }}>
                          {lang === 'ko' ? '예측 ' : 'F '}<span style={{ color: T.acl, fontWeight: 700 }}>{e.forecast}{e.unit || ''}</span>
                        </span>
                      )}
                      {e.previous && (
                        <span style={{ color: T.muted }}>
                          {lang === 'ko' ? '이전 ' : 'P '}<span style={{ color: T.sub, fontWeight: 700 }}>{e.previous}{e.unit || ''}</span>
                        </span>
                      )}
                      {hasActual && (
                        <span style={{ color: T.muted }}>
                          {lang === 'ko' ? '실제 ' : 'A '}<span style={{ color: T.grn, fontWeight: 700 }}>{e.actual}{e.unit || ''}</span>
                        </span>
                      )}
                    </div>
                  </div>
                  {/* 영향도 별점 */}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0 }}>
                    <ImpactStars impact={e.impact} size={11} />
                    <span style={{ fontSize: 9, fontWeight: 700, color: impactColor }}>
                      {e.impact === 'high'   ? (lang === 'ko' ? '고' : 'H')
                       : e.impact === 'medium'? (lang === 'ko' ? '중' : 'M')
                       : (lang === 'ko' ? '저' : 'L')}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function EconCalendarPage(props: { lang?: string }) {
  return <ErrorBoundary><EconCalendarInner {...props} /></ErrorBoundary>;
}
