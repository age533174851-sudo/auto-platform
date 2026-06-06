'use client';
import React, { useState, useMemo } from 'react';
import { T } from '@/lib/constants';
import { Search } from 'lucide-react';

interface MenuItem { id: string; label: string; desc: string; cat: string; kw?: string; }
const MENU: MenuItem[] = [
  { id:'trading', label:'매매', desc:'직접 사고팔아요 (수동 매매)', cat:'거래', kw:'롱숏 매수매도 주문' },
  { id:'auto', label:'자동매매', desc:'AI가 대신 자동으로 거래해요', cat:'거래', kw:'봇 자동 bot' },
  { id:'strategies', label:'전략빌더', desc:'나만의 매매 규칙을 만들어요', cat:'거래', kw:'전략' },
  { id:'fear_dca', label:'공포 DCA', desc:'공포일 때 분할 매수하는 전략', cat:'거래', kw:'공포탐욕 분할매수' },
  { id:'season', label:'시즌전략', desc:'계절·시즌 전략으로 투자해요', cat:'거래' },
  { id:'dca', label:'자동적립', desc:'정기적으로 자동 매수해요', cat:'거래', kw:'적립 정기' },
  { id:'paper', label:'모의매매', desc:'가짜 돈으로 연습해요', cat:'거래', kw:'연습 데모' },
  { id:'market', label:'시장', desc:'실시간 코인·주식 시세를 봐요', cat:'분석', kw:'시세 가격' },
  { id:'backtest', label:'백테스트', desc:'과거 데이터로 전략을 테스트해요', cat:'분석', kw:'검증 테스트' },
  { id:'pine_guide', label:'Pine 가이드', desc:'트레이딩뷰 전략 가져오는 법', cat:'분석', kw:'파인 트레이딩뷰' },
  { id:'seasonality', label:'계절성 분석', desc:'계절·시기별 시장 흐름을 봐요', cat:'분석' },
  { id:'news', label:'뉴스', desc:'최신 코인·주식 뉴스를 봐요', cat:'분석' },
  { id:'analysis', label:'분석허브', desc:'AI 시장 분석을 봐요', cat:'분석', kw:'ai' },
  { id:'briefing', label:'AI브리핑', desc:'오늘의 시장 요약을 받아요', cat:'분석', kw:'ai' },
  { id:'calendar', label:'경제캘린더', desc:'경제 일정·이벤트를 봐요', cat:'분석', kw:'fomc cpi 일정' },
  { id:'scanner', label:'스캐너', desc:'급등·급락 종목을 찾아요', cat:'분석', kw:'급등' },
  { id:'heatmap', label:'히트맵', desc:'시장 전체를 색으로 봐요', cat:'분석' },
  { id:'chart', label:'차트', desc:'캔들 차트를 봐요', cat:'분석' },
  { id:'portfolio', label:'포트폴리오', desc:'내 보유 자산을 관리해요', cat:'관리', kw:'자산' },
  { id:'risk_settings', label:'리스크관리', desc:'손실 한도·레버리지를 설정해요', cat:'관리', kw:'리스크 레버리지 손절 손실한도' },
  { id:'history', label:'매매일지', desc:'지난 매매 기록을 봐요', cat:'관리', kw:'기록' },
  { id:'accounts', label:'거래소연결', desc:'바이낸스 등 API를 연결해요', cat:'관리', kw:'api 바이낸스' },
  { id:'manual_accounts', label:'수동자산등록', desc:'수동으로 자산을 기록해요', cat:'관리' },
  { id:'alerts', label:'알림', desc:'가격·신호 알림을 받아요', cat:'관리', kw:'알람' },
  { id:'pnl', label:'수익계산', desc:'손익을 계산해요', cat:'관리', kw:'계산기' },
  { id:'tax', label:'손익·세금', desc:'세금·손익을 정리해요', cat:'관리', kw:'세금' },
  { id:'dividends', label:'배당캘린더', desc:'배당 일정을 봐요', cat:'관리', kw:'배당' },
  { id:'funding', label:'입출금', desc:'입출금 내역을 봐요', cat:'관리' },
  { id:'watchlist', label:'관심종목', desc:'관심 종목을 모아봐요', cat:'관리', kw:'왓치' },
  { id:'academy', label:'아카데미', desc:'투자 기초를 배워요', cat:'학습', kw:'교육' },
  { id:'ai', label:'AI채팅', desc:'AI에게 투자 질문을 해요', cat:'학습', kw:'챗봇' },
  { id:'review', label:'AI 복기', desc:'지난 매매를 AI가 분석해요', cat:'학습' },
  { id:'social', label:'소셜', desc:'다른 투자자와 소통해요', cat:'학습', kw:'커뮤니티' },
  { id:'settings', label:'설정', desc:'앱 설정을 바꿔요', cat:'기타' },
  { id:'diagnostics', label:'API 진단', desc:'연결 상태를 점검해요', cat:'기타', kw:'진단' },
];
const CATS = ['거래','분석','관리','학습','기타'];

export default function MenuHubPage({ onNav }: { onNav: (id: string) => void }) {
  const [q, setQ] = useState('');
  const filtered = useMemo(() => {
    if (!q.trim()) return MENU;
    const lq = q.toLowerCase();
    return MENU.filter(m => m.label.toLowerCase().includes(lq) || m.desc.toLowerCase().includes(lq) || (m.kw||'').toLowerCase().includes(lq));
  }, [q]);
  return (
    <div style={{ padding: '0 0 24px' }}>
      <div style={{ color: T.txt, fontWeight: 900, fontSize: 20, marginBottom: 4 }}>전체 메뉴</div>
      <div style={{ color: T.muted, fontSize: 12, marginBottom: 14 }}>모든 기능을 한 곳에서 · 검색으로 빠르게 찾기</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: T.alt, border: `1px solid ${T.border}`, borderRadius: 12, padding: '0 14px', marginBottom: 18 }}>
        <Search size={16} color={T.muted} />
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="기능 검색 (예: 레버리지, 백테스트, 알림)"
          style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: T.txt, fontSize: 14, padding: '13px 0' }} />
        {q && <button onClick={() => setQ('')} style={{ background: 'none', border: 'none', color: T.muted, fontSize: 16, cursor: 'pointer' }}>✕</button>}
      </div>
      {q.trim() ? (
        <div>
          <div style={{ color: T.muted, fontSize: 11, marginBottom: 10 }}>검색 결과 {filtered.length}개</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 8 }}>
            {filtered.map(m => <Card key={m.id} m={m} onNav={onNav} />)}
          </div>
          {filtered.length === 0 && <div style={{ color: T.muted, fontSize: 13, textAlign: 'center', padding: '30px 0' }}>"{q}"에 맞는 기능이 없어요</div>}
        </div>
      ) : (
        CATS.map(cat => {
          const items = MENU.filter(m => m.cat === cat);
          return (
            <div key={cat} style={{ marginBottom: 20 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <span style={{ color: T.acl, fontSize: 12, fontWeight: 800, letterSpacing: 1 }}>{cat}</span>
                <div style={{ flex: 1, height: 1, background: T.border }} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 8 }}>
                {items.map(m => <Card key={m.id} m={m} onNav={onNav} />)}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
function Card({ m, onNav }: { m: MenuItem; onNav: (id: string) => void }) {
  return (
    <button onClick={() => onNav(m.id)} style={{ background: T.alt, border: `1px solid ${T.border}`, borderRadius: 12, padding: '13px 14px', cursor: 'pointer', textAlign: 'left', width: '100%' }}>
      <div style={{ color: T.txt, fontSize: 13, fontWeight: 700, marginBottom: 3 }}>{m.label}</div>
      <div style={{ color: T.muted, fontSize: 10, lineHeight: 1.4 }}>{m.desc}</div>
    </button>
  );
}
