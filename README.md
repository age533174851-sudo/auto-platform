# 🚀 TRAIGO v6 — 글로벌 투자 운영 시스템

> Next.js 14 · TypeScript · Supabase-ready · 38 컴포넌트 · 3,910 줄

## ⚡ 빠른 시작

```bash
npm install
cp .env.example .env.local
npm run dev    # → http://localhost:3000
npm run build  # 빌드 테스트
npx vercel --prod  # 배포
```

## 📁 파일 구조

```
src/
├── app/
│   ├── page.tsx              ← 메인 앱 (3,910줄, 38 컴포넌트)
│   ├── layout.tsx            ← SEO + PWA
│   ├── globals.css
│   ├── auth/page.tsx         ← Supabase 로그인
│   ├── admin/page.tsx        ← 관리자 대시보드
│   ├── terms/page.tsx        ← 이용약관
│   ├── privacy/page.tsx      ← 개인정보처리방침
│   └── api/
│       ├── prices/route.ts   ← Binance → mock
│       ├── news/route.ts     ← 뉴스 API
│       └── search/route.ts   ← 전체 시장 검색
├── data/
│   └── assets.ts             ← Featured 80개 (슬림)
├── lib/
│   ├── constants.ts          ← 테마, I18N, 로고, 뉴스
│   ├── utils.ts              ← cvt, fmt, tr, gS, sS
│   ├── assetSearch.ts        ← 다중 제공사 검색 엔진
│   ├── assetCache.ts         ← 3계층 캐시 시스템
│   └── assetTypes.ts         ← 타입 + Provider 설정
└── types/
    └── index.ts
```

## 🗺️ 네비게이션 맵

### 하단 탭 (BTABS)
| 탭 | 기능 |
|----|------|
| 🏠 홈 | 헤지펀드 대시보드 |
| ⭐ 왓치 | 왓치리스트 |
| 📊 시장 | 전체 시장 + 글로벌 검색 |
| ⚡ 매매 | 프로 트레이딩 터미널 |
| 🤖 자동 | 자동매매 전략 |

### 더보기 메뉴 (MTABS)
| 탭 | 기능 |
|----|------|
| 💼 포트폴리오 | 장투/단타/현금 분리 |
| 📝 매매일지 | AI 리뷰 포함 |
| 🧪 백테스트 | 전략 백테스팅 |
| 💬 AI채팅 | AI 인사이트 + 신호 + 채팅 |
| 📚 아카데미 | 트레이딩 교육 |
| 📰 뉴스 | 뉴스 + 경제 캘린더 |
| 🔔 알림 | 알림 센터 |
| 👥 소셜 | 리더보드 + 피드 + 카피 |
| 🔗 계좌연결 | 멀티 API 연결 + 일괄매매 |
| 💸 입출금 | 오픈뱅킹 + 환전 + 가이드 |
| 📊 TradFi | 코인거래소 CFD + 글로벌 자산 |
| 📡 실시간 | 데이터 엔진 + 알림 채널 |
| 📈 분석 | 고급 분석 + 클라우드 동기화 |
| 🌈 히트맵 | 자산 히트맵 |
| 🔍 스캐너 | 급등/급락 스캐너 |
| 🌐 세계시장 | 세계 시장 시계 |
| ⚙️ 설정 | 언어/통화/보안/Pro |

## ✨ 주요 기능

### 📊 자산 시스템 (확장 가능)
- Featured 80개 (즉시 로드)
- 전체 시장 검색: Binance → CoinGecko → Polygon → Mock
- 3계층 캐시: 메모리 → localStorage → Supabase
- 170+ 종목 검색 DB (오프라인 포함)

### 💼 장투/단타 분리 포트폴리오
- 장투: DCA 계획, 목표가, 손절가, 리밸런싱
- 단타: 활성 포지션, 일일 리스크, 전략 현황
- 배분 프리셋: 안정형/균형형/공격형/자동매매형

### ⚡ 프로 매매 터미널
- AI 레버리지 추천 (변동성·위험성향 기반)
- 청산가 실시간 계산 (LiquidationCalc)
- 자동 포지션 사이징 (PositionSizer)
- 리스크 대시보드 (스트레스 테스트)
- 매매 탭 3개: 매매 / 사이징 / 리스크

### 📊 TradFi/CFD
- 주식 CFD: AAPL, TSLA, NVDA, MSFT, AMZN, GOOGL, META
- 지수: NAS100, SPX500, US30
- 원자재: XAUUSD, XAGUSD, XTIUSD, XBRUSD
- 환율: EURUSD, GBPUSD, USDJPY, USDKRW
- 제공사: Gate TradFi, Bybit MT5, Binance, Bitget

### 🔗 멀티 계좌 시스템
- 거래소 API 연결 (Binance/Gate.io/Upbit/Bithumb)
- 4단계 API 연결 가이드 (출금 권한 경고 포함)
- 일괄 매매: 균등/잔고비례/퍼센트/직접 배분
- 전체 긴급 정지 / 계좌별 안전 설정

### 💸 입출금 허브
- 은행→거래소 이체 UI
- 오픈뱅킹 플레이스홀더 (가상계좌 입금)
- 환전 계산기 (6개 통화쌍)
- 거래소별 입금 가이드

### 🤖 AI 시스템
- AI 인사이트 (변동성/펀딩비/포지션 경고)
- AI 매매 신호 (TradingView Webhook 연동)
- AI 채팅 (RSI/레버리지/DCA 등 8개 주제)

## 🌐 배포

```bash
# Vercel 배포
npx vercel --prod

# 환경변수 (선택 — 없어도 mock으로 작동)
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
POLYGON_API_KEY=...    # 미국주식 검색
```

## ⚠️ 법적 고지

TRAIGO는 교육·시뮬레이션 목적이며, 실제 거래를 실행하지 않습니다.
수익을 보장하지 않으며, 모든 투자 손실은 투자자 본인의 책임입니다.
CFD/TradFi 상품은 파생상품이며 레버리지·청산 위험이 있습니다.
