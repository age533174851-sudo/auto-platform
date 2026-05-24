'use client';
import React, { useState, useEffect } from 'react';
import { T, I18N, ECON_EVENTS } from '@/lib/constants';
import { tr } from '@/lib/utils';
import { Card } from './SharedUI';

// ── 경제 이벤트 다언어 번역 맵 ─────────────────────────────────
const ECO_TRANS: Record<string, Record<string, string>> = {
  'CPI':           { ko:'소비자물가지수', en:'Consumer Price Index',      ja:'消費者物価指数',     zh:'消费者价格指数' },
  'FOMC':          { ko:'FOMC 금리 결정', en:'FOMC Rate Decision',        ja:'FOMC金利決定',       zh:'FOMC利率决议' },
  'NFP':           { ko:'비농업고용지수', en:'Non-Farm Payrolls',          ja:'非農業部門雇用者数', zh:'非农就业人数' },
  'GDP':           { ko:'국내총생산',     en:'Gross Domestic Product',     ja:'国内総生産',         zh:'国内生产总值' },
  'PPI':           { ko:'생산자물가지수', en:'Producer Price Index',       ja:'生産者物価指数',     zh:'生产者价格指数' },
  'PMI':           { ko:'구매관리자지수', en:'Purchasing Managers Index',  ja:'購買担当者景気指数', zh:'采购经理人指数' },
  'ECB':           { ko:'ECB 금리 결정', en:'ECB Rate Decision',           ja:'ECB金利決定',        zh:'欧央行利率决议' },
  '금통위':        { ko:'한국은행 금통위', en:'Bank of Korea Rate',        ja:'韓国銀行金融政策',   zh:'韩国央行利率' },
  'Unemployment':  { ko:'실업률',        en:'Unemployment Rate',          ja:'失業率',             zh:'失业率' },
  'Retail Sales':  { ko:'소매판매',      en:'Retail Sales',               ja:'小売売上高',         zh:'零售销售' },
  'ISM':           { ko:'ISM 제조업',    en:'ISM Manufacturing',          ja:'ISM製造業',          zh:'ISM制造业' },
  'Trade Balance': { ko:'무역수지',      en:'Trade Balance',              ja:'貿易収支',           zh:'贸易差额' },
  'Inflation':     { ko:'인플레이션',    en:'Inflation Rate',             ja:'インフレ率',         zh:'通胀率' },
  'Interest Rate': { ko:'기준금리',      en:'Interest Rate',              ja:'政策金利',           zh:'基准利率' },
  'Housing':       { ko:'주택지표',      en:'Housing Data',               ja:'住宅指標',           zh:'住房数据' },
  'Consumer Conf': { ko:'소비자신뢰지수',en:'Consumer Confidence',        ja:'消費者信頼感',       zh:'消费者信心' },
  'Durable Goods': { ko:'내구재주문',    en:'Durable Goods Orders',       ja:'耐久財受注',         zh:'耐用品订单' },
  'Industrial Prod':{ ko:'산업생산',     en:'Industrial Production',      ja:'鉱工業生産',         zh:'工业产出' },
};

function tEco(lang: string, title: string): string {
  const langKey = lang === 'ko' ? 'ko' : lang === 'ja' ? 'ja' : lang === 'zh' ? 'zh' : 'en';
  for (const [key, map] of Object.entries(ECO_TRANS)) {
    if (title.includes(key)) {
      return (map[langKey] || map['en']) + (title.replace(key, '').trim() ? ' ' + title.replace(key, '').trim() : '');
    }
  }
  return title; // fallback: original
}

// ── Mock data fallback ─────────────────────────────────────────
const MOCK_EVENTS = [
  { id:'1', event:'CPI', country:'US', date:'2025-01-15', time:'08:30', impact:'high',   forecast:'3.2%', previous:'3.1%', actual:'3.4%', unit:'%' },
  { id:'2', event:'FOMC', country:'US', date:'2025-01-29', time:'14:00', impact:'high',  forecast:'5.25%', previous:'5.50%', actual:null, unit:'%' },
  { id:'3', event:'NFP', country:'US', date:'2025-02-07', time:'08:30', impact:'high',   forecast:'180K',  previous:'216K', actual:null, unit:'K' },
  { id:'4', event:'GDP', country:'US', date:'2025-01-30', time:'08:30', impact:'medium', forecast:'2.5%',  previous:'2.8%', actual:null, unit:'%' },
  { id:'5', event:'PMI', country:'EU', date:'2025-01-22', time:'04:00', impact:'medium', forecast:'44.2',  previous:'44.4', actual:'44.1', unit:'' },
  { id:'6', event:'금통위', country:'KR', date:'2025-01-16', time:'10:00', impact:'high', forecast:'3.0%', previous:'3.25%', actual:'3.0%', unit:'%' },
  { id:'7', event:'ECB', country:'EU', date:'2025-01-23', time:'08:15', impact:'high',   forecast:'3.5%',  previous:'3.75%', actual:null, unit:'%' },
  { id:'8', event:'PPI', country:'US', date:'2025-01-14', time:'08:30', impact:'medium', forecast:'1.8%',  previous:'1.7%', actual:'2.0%', unit:'%' },
  { id:'9', event:'Retail Sales', country:'US', date:'2025-01-17', time:'08:30', impact:'medium', forecast:'-0.1%', previous:'0.3%', actual:null, unit:'%' },
  { id:'10', event:'ISM', country:'US', date:'2025-02-03', time:'10:00', impact:'medium', forecast:'48.5', previous:'47.4', actual:null, unit:'' },
  { id:'11', event:'Unemployment', country:'KR', date:'2025-01-15', time:'08:00', impact:'low', forecast:'2.9%', previous:'2.8%', actual:'2.9%', unit:'%' },
  { id:'12', event:'Consumer Conf', country:'EU', date:'2025-01-24', time:'10:00', impact:'low', forecast:'-14', previous:'-15', actual:null, unit:'' },
];

const impactLabel: Record<string, Record<string, string>> = {
  high:   { ko:'🔴 고영향', en:'🔴 High', ja:'🔴 高影響', zh:'🔴 高影响' },
  medium: { ko:'🟡 중영향', en:'🟡 Medium', ja:'🟡 中影響', zh:'🟡 中影响' },
  low:    { ko:'🟢 저영향', en:'🟢 Low',  ja:'🟢 低影響', zh:'🟢 低影响' },
};

function EconCalendarPage({ lang = 'ko' }: { lang?: string }) {
  const [filter,  setFilter]  = useState<'all'|'high'|'medium'|'low'>('all');
  const [country, setCountry] = useState('전체');
  const [selected, setSelected] = useState<any>(null);
  const [events, setEvents]   = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const impactC: Record<string, string> = { high: T.red, medium: T.ylw, low: T.grn };
  const COUNTRIES = ['전체','US','EU','KR','JP','CN','UK'];
  const langKey = lang === 'ko' ? 'ko' : lang === 'ja' ? 'ja' : lang === 'zh' ? 'zh' : 'en';

  useEffect(() => {
    setLoading(true);
    fetch(`/api/calendar?lang=${lang}&country=all`)
      .then(r => r.json())
      .then(d => { const evts = Array.isArray(d.data) ? d.data : (Array.isArray(d.events) ? d.events : []); setEvents(evts.length > 0 ? evts : MOCK_EVENTS); })
      .catch(() => setEvents(MOCK_EVENTS))
      .finally(() => setLoading(false));
  }, []);

  const filtered = events.filter(e => {
    const matchImpact  = filter === 'all' || e.impact === filter;
    const matchCountry = country === '전체' || e.country === country;
    return matchImpact && matchCountry;
  });

  const eventDesc: Record<string, Record<string, string>> = {
    CPI:   { ko:'소비자물가지수 — 인플레이션의 핵심 지표. 예상 상회 시 긴축 가능성 ↑', en:'Consumer Price Index — Core inflation indicator. Beat → tightening risk.' },
    FOMC:  { ko:'연방공개시장위원회 — Fed 금리 결정. 시장 방향성에 가장 큰 영향', en:'FOMC — Fed rate decision. Biggest single market-moving event.' },
    NFP:   { ko:'비농업고용 — 고용시장 강도 지표. 강한 고용 → 금리 인상 우려', en:'Non-Farm Payrolls — Strength of US labor market. Strong = rate hike risk.' },
    GDP:   { ko:'국내총생산 성장률 — 경기 상태 척도', en:'GDP growth rate — Broad measure of economic health.' },
    PMI:   { ko:'구매관리자지수 — 50 이상 경기 확장, 50 이하 수축', en:'PMI — Above 50 = expansion, below 50 = contraction.' },
    ECB:   { ko:'유럽중앙은행 금리 결정', en:'European Central Bank rate decision.' },
    '금통위':{ ko:'한국은행 기준금리 결정', en:'Bank of Korea benchmark rate decision.' },
  };

  // ── Detail View ──────────────────────────────────────────────
  if (selected) {
    const desc = (() => {
      for (const [k, m] of Object.entries(eventDesc)) {
        if (selected.event?.includes(k)) return m[langKey] || m['en'];
      }
      return null;
    })();

    return (
      <div>
        <button onClick={() => setSelected(null)} style={{ background:'transparent', border:`1px solid ${T.border}`, borderRadius:8, color:T.muted, padding:'5px 12px', fontSize:12, cursor:'pointer', marginBottom:12, minHeight:36 }}>
          ← {lang === 'ko' ? '목록으로' : lang === 'ja' ? '一覧に戻る' : '返回列表'}
        </button>
        <div style={{ color:T.txt, fontWeight:800, fontSize:15, marginBottom:6 }}>
          {tEco(lang, selected.event)}
        </div>
        <div style={{ display:'flex', gap:8, marginBottom:10, flexWrap:'wrap' }}>
          <span style={{ background:impactC[selected.impact]+'20', color:impactC[selected.impact], fontSize:10, fontWeight:700, padding:'3px 8px', borderRadius:6 }}>
            {impactLabel[selected.impact]?.[langKey] || impactLabel[selected.impact]?.['en'] || selected.impact}
          </span>
          <span style={{ color:T.muted, fontSize:10 }}>{selected.country} · {selected.date} {selected.time}</span>
        </div>
        {desc && (
          <Card style={{ padding:'12px 14px', marginBottom:8, background:T.acl+'08', border:`1px solid ${T.acl}20` }}>
            <div style={{ color:T.acl, fontSize:10, fontWeight:700, marginBottom:4 }}>📘 {lang==='ko'?'이벤트 설명':lang==='ja'?'イベント説明':'Event Info'}</div>
            <div style={{ color:T.sub, fontSize:12, lineHeight:1.65 }}>{desc}</div>
          </Card>
        )}
        <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:8, marginBottom:10 }}>
          {[
            { l: lang==='ko'?'예측':lang==='ja'?'予測':'Forecast', v: selected.forecast },
            { l: lang==='ko'?'이전':lang==='ja'?'前回':'Previous', v: selected.previous },
            { l: lang==='ko'?'실제':lang==='ja'?'実績':'Actual',   v: selected.actual },
          ].map(d => d.v && (
            <Card key={d.l} style={{ padding:'10px 8px', textAlign:'center' }}>
              <div style={{ color:T.muted, fontSize:9 }}>{d.l}</div>
              <div style={{ color:T.txt, fontWeight:700, fontSize:14, marginTop:3 }}>{d.v}{selected.unit||''}</div>
            </Card>
          ))}
        </div>
        <Card style={{ padding:'12px 14px', background:'#0A1628', border:`1px solid ${T.red}30` }}>
          <div style={{ color:T.red, fontWeight:700, fontSize:10, marginBottom:4 }}>⚠️ {lang==='ko'?'트레이딩 주의':lang==='ja'?'トレーディング注意':'Trading Alert'}</div>
          <div style={{ color:T.muted, fontSize:11, lineHeight:1.6 }}>
            {lang==='ko'
              ? '고영향 이벤트 발표 30분 전후에는 변동성이 급격히 증가합니다. 기존 포지션 리스크를 점검하고 무리한 레버리지 사용을 피하세요.'
              : lang==='ja'
              ? '高影響イベントの前後30分は急激な変動があります。既存ポジションのリスクを確認し、過度なレバレッジを避けてください。'
              : 'High-impact events cause extreme volatility ±30min. Review open positions and avoid excessive leverage.'}
          </div>
        </Card>
      </div>
    );
  }

  // ── List View ─────────────────────────────────────────────────
  const filterLabels = [
    ['all',    lang==='ko'?'전체':lang==='ja'?'全て':'All'    ],
    ['high',   lang==='ko'?'고영향':lang==='ja'?'高影響':'High'  ],
    ['medium', lang==='ko'?'중영향':lang==='ja'?'中影響':'Medium'],
    ['low',    lang==='ko'?'저영향':lang==='ja'?'低影響':'Low'   ],
  ] as const;

  return (
    <div>
      <div style={{ display:'flex', gap:5, marginBottom:8, flexWrap:'wrap' }}>
        {filterLabels.map(([id, l]) => (
          <button key={id} onClick={() => setFilter(id as any)} style={{ flex:1, minWidth:60, padding:'6px', background:filter===id?impactC[id==='all'?'high':id]+'20':T.alt, color:filter===id?(id==='all'?T.acl:impactC[id]):T.muted, border:`1px solid ${filter===id?(id==='all'?T.acl:impactC[id]):T.border}`, borderRadius:8, fontSize:10, fontWeight:700, cursor:'pointer', minHeight:36 }}>
            {l}
          </button>
        ))}
      </div>
      <div className="scroll-x" style={{ display:'flex', gap:5, paddingBottom:4, marginBottom:10 }}>
        {COUNTRIES.map(c => (
          <button key={c} onClick={() => setCountry(c)} style={{ flexShrink:0, padding:'4px 10px', background:country===c?T.acg:'transparent', color:country===c?T.acl:T.muted, border:`1px solid ${country===c?T.acl:T.border}`, borderRadius:16, fontSize:10, fontWeight:700, cursor:'pointer', minHeight:32 }}>{c}</button>
        ))}
      </div>

      {loading ? (
        <div>{[0,1,2,3].map(i => (
          <div key={i} style={{ background:T.card, borderRadius:12, padding:'14px', marginBottom:8 }}>
            <div className="skeleton" style={{ height:12, marginBottom:6, width:'70%', borderRadius:4 }}/>
            <div className="skeleton" style={{ height:10, width:'40%', borderRadius:4 }}/>
          </div>
        ))}</div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign:'center', padding:'40px 0' }}>
          <div style={{ fontSize:32, marginBottom:8 }}>📅</div>
          <div style={{ color:T.muted, fontSize:13 }}>
            {lang==='ko'?'해당 조건의 경제 이벤트가 없습니다':lang==='ja'?'該当イベントはありません':'No events found for selected filters'}
          </div>
        </div>
      ) : filtered.map(e => (
        <Card key={e.id} style={{ padding:'12px 14px', marginBottom:8, cursor:'pointer', borderLeft:`3px solid ${impactC[e.impact]||T.border}` }} onClick={() => setSelected(e)}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:8 }}>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ color:T.txt, fontWeight:700, fontSize:12, marginBottom:3, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                {tEco(lang, e.event)}
              </div>
              <div style={{ display:'flex', gap:8, color:T.muted, fontSize:10, flexWrap:'wrap' }}>
                <span>{e.country}</span><span>{e.date}</span><span>{e.time}</span>
              </div>
            </div>
            <div style={{ textAlign:'right', flexShrink:0 }}>
              <div style={{ color:impactC[e.impact], fontWeight:700, fontSize:10 }}>
                {impactLabel[e.impact]?.[langKey] || e.impact}
              </div>
              {e.forecast && <div style={{ color:T.muted, fontSize:9, marginTop:2 }}>{lang==='ko'?'예측':lang==='ja'?'予測':'F'}: {e.forecast}{e.unit||''}</div>}
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}

export default EconCalendarPage;
