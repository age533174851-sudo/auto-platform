// src/lib/menuItems.tsx
// 홈(즐겨찾기)과 더보기(MenuHubPage)가 공유하는 메뉴 메타데이터.
import type { LucideIcon } from 'lucide-react';
import {
  TrendingUp, Blocks, Activity, FlaskConical, Beaker,
  Bot, Cpu, ScrollText, ShieldAlert, LineChart, Newspaper, Sparkles,
  Snowflake, FileText, CalendarDays, Radar, PieChart, Sprout, Coins,
  Scale, GraduationCap, BookOpen, ClipboardCheck, Users, Link2, Settings,
  Stethoscope, Bell, ShieldCheck,
} from 'lucide-react';

export interface MenuItem { id: string; label: string; desc: string; cat: string; kw?: string; Icon: LucideIcon; color: string }

export const MENU: MenuItem[] = [
  { id:'trading',   label:'매매하기',  desc:'직접 사고팔기 (수동 매매)', cat:'거래', kw:'롱숏 매수매도 주문', Icon:TrendingUp,  color:'#3B82F6' },
  { id:'strategies',label:'전략빌더',  desc:'나만의 매매 규칙 만들기',   cat:'거래', kw:'전략',            Icon:Blocks,      color:'#8B5CF6' },
  { id:'fear_dca',  label:'공포 DCA',  desc:'공포일 때 분할 매수',       cat:'거래', kw:'공포탐욕 분할매수', Icon:Activity,    color:'#EF4444' },
  { id:'backtest',  label:'백테스트',  desc:'과거 데이터로 전략 검증',   cat:'거래', kw:'검증 테스트',      Icon:FlaskConical,color:'#10B981' },
  { id:'paper',     label:'모의매매',  desc:'가짜 돈으로 연습',         cat:'거래', kw:'연습 데모 mock',   Icon:Beaker,      color:'#A855F7' },

  { id:'auto',      label:'자동매매',  desc:'AI가 대신 자동 거래',      cat:'자동화', kw:'봇 자동 bot',    Icon:Bot,         color:'#8B5CF6' },
  { id:'autobot',   label:'봇 목록',   desc:'실행 중인 봇 관리',        cat:'자동화', kw:'bot lab',        Icon:Cpu,         color:'#0891B2' },
  { id:'history',   label:'실행기록',  desc:'자동매매 체결 내역',       cat:'자동화', kw:'로그 기록',      Icon:ScrollText,  color:'#64748B' },
  { id:'risk_settings',label:'리스크 관리',desc:'손실 한도·킬스위치',   cat:'자동화', kw:'킬스위치 한도',  Icon:ShieldAlert, color:'#EF4444' },

  { id:'market',    label:'시장 보기', desc:'실시간 코인·주식 시세',    cat:'투자정보', kw:'시세 가격',     Icon:LineChart,   color:'#3B82F6' },
  { id:'news',      label:'뉴스',      desc:'최신 코인·주식 뉴스',      cat:'투자정보', kw:'news',          Icon:Newspaper,   color:'#F59E0B' },
  { id:'analysis',  label:'AI 분석',   desc:'AI 시장 분석 허브',        cat:'투자정보', kw:'ai 분석',       Icon:Sparkles,    color:'#8B5CF6' },
  { id:'season',    label:'시즌전략',  desc:'계절·시즌 전략',           cat:'투자정보', kw:'시즌',          Icon:Snowflake,   color:'#0EA5E9' },
  { id:'briefing',  label:'AI 브리핑', desc:'오늘의 시장 요약',         cat:'투자정보', kw:'ai briefing',   Icon:FileText,    color:'#10B981' },
  { id:'calendar',  label:'경제캘린더',desc:'FOMC·CPI 등 일정',        cat:'투자정보', kw:'fomc cpi 일정', Icon:CalendarDays,color:'#F59E0B' },
  { id:'scanner',   label:'스캐너',    desc:'급등·급락 종목 탐색',      cat:'투자정보', kw:'급등 급락',     Icon:Radar,       color:'#EF4444' },

  { id:'portfolio', label:'포트폴리오',desc:'내 자산 현황',            cat:'자산관리', kw:'자산 평가',     Icon:PieChart,    color:'#10B981' },
  { id:'growth',    label:'장기투자',  desc:'장기 적립·성장 자산',      cat:'자산관리', kw:'장기 적립',     Icon:Sprout,      color:'#22C55E' },
  { id:'dividends', label:'배당/이자', desc:'배당·이자 일정',           cat:'자산관리', kw:'배당 이자',     Icon:Coins,       color:'#F59E0B' },
  { id:'ai_portfolio',label:'리밸런싱',desc:'AI 자동 자산 배분',        cat:'자산관리', kw:'리밸런싱 배분', Icon:Scale,       color:'#8B5CF6' },

  { id:'academy',   label:'아카데미',  desc:'투자 기초부터 차근차근',   cat:'학습', kw:'교육 강의',      Icon:GraduationCap,color:'#3B82F6' },
  { id:'posters',   label:'투자기초',  desc:'그림으로 배우는 투자',     cat:'학습', kw:'기초 용어',      Icon:BookOpen,    color:'#0891B2' },
  { id:'review',    label:'AI 복기',   desc:'지난 매매 AI 분석',        cat:'학습', kw:'복기 리뷰',      Icon:ClipboardCheck,color:'#10B981' },
  { id:'social',    label:'소셜',      desc:'다른 투자자와 소통',       cat:'학습', kw:'커뮤니티',       Icon:Users,       color:'#F59E0B' },

  { id:'accounts',  label:'API 연결',  desc:'거래소 API 연결',          cat:'설정', kw:'거래소 연결 api',Icon:Link2,       color:'#3B82F6' },
  { id:'settings',  label:'설정',      desc:'통화·언어·알림',           cat:'설정', kw:'통화 언어 알림', Icon:Settings,    color:'#64748B' },
  { id:'alerts',    label:'알림',      desc:'가격·체결 알림 설정',      cat:'설정', kw:'알림 notification',Icon:Bell,      color:'#F59E0B' },
  { id:'diagnostics',label:'API 진단', desc:'연결 상태 점검',           cat:'설정', kw:'진단 상태',      Icon:Stethoscope, color:'#0891B2' },
  { id:'safety',    label:'보안',      desc:'계정 보안·안전장치',       cat:'설정', kw:'보안 안전',      Icon:ShieldCheck, color:'#22C55E' },
];

export const MENU_CATS = ['거래', '자동화', '투자정보', '자산관리', '학습', '설정'];

export function menuById(id: string): MenuItem | undefined {
  return MENU.find(m => m.id === id);
}
