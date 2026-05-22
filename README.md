# TRAIGO — AI 투자 운영 시스템

<div align="center">

```
████████╗██████╗  █████╗ ██╗ ██████╗  ██████╗
╚══██╔══╝██╔══██╗██╔══██╗██║██╔════╝ ██╔═══██╗
   ██║   ██████╔╝███████║██║██║  ███╗██║   ██║
   ██║   ██╔══██╗██╔══██║██║██║   ██║██║   ██║
   ██║   ██║  ██║██║  ██║██║╚██████╔╝╚██████╔╝
   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝ ╚═════╝  ╚═════╝
```

**Toss + Bloomberg + TradingView + AI Hedge Fund**

[![Next.js](https://img.shields.io/badge/Next.js-14.2.5-black?logo=next.js)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)](https://typescriptlang.org)
[![Supabase](https://img.shields.io/badge/Supabase-Auth+DB-green?logo=supabase)](https://supabase.com)
[![PWA](https://img.shields.io/badge/PWA-Installable-purple)](https://web.dev/pwa)

> **⚠️ 모의투자 전용 — 실제 자금 사용 없음 · 수익 보장 없음**

</div>

---

## 📖 프로젝트 개요

TRAIGO는 개인 투자자를 위한 **AI 기반 헤지펀드 운영 시스템**입니다.

- **290+ 글로벌 자산** 지원 (미국주식 207개, 코인 20개, ETF 25개, 한국주식, 원자재, 외환)
- **TradingView 스타일** 차트 · 드로잉 도구 · 19종 차트 타입
- **AI 인텔리전스** 시장 국면 분류 · 위험 관리 · 자금 배분
- **Hedge OS** 킬스위치 · 드로다운 보호 · 유니파이드 월렛
- **WUNDER 자동매매** Pine Script 통합 · WunderTrading 웹훅
- **Supabase Auth** 이메일/비밀번호 · 역할 시스템 · 초대 코드
- **PWA 지원** iOS / Android / macOS 홈 화면 설치
- **완전 무료** — 모의투자 전용, 실제 거래 불가

---

## ✨ 주요 기능 (32개 탭)

### 📊 시장 & 차트
| 탭 | 설명 |
|----|------|
| `market` | 글로벌 시장 개요 — 코인/주식/지수/원자재/환율 |
| `chart` | TradingView 위젯 · 4분할 레이아웃 · 290+ 종목 · 직접 심볼 입력 |
| `analysis` | Analysis Hub — 드로잉 · 인터벌 · 인디케이터 · 레이아웃 저장 |
| `heatmap` | 자산 히트맵 |
| `scanner` | 종목 스캐너 |
| `realtime` | 실시간 시세 엔진 |
| `tradfi` | TradFi 전통 금융 |

### 📈 포트폴리오 & 매매
| 탭 | 설명 |
|----|------|
| `portfolio` | 통합 포트폴리오 — 장투/단타/DCA/배분 |
| `trading` | 수동 매매 시뮬레이터 |
| `auto` | 자동매매 봇 관리 |
| `history` | 매매 일지 |
| `backtest` | 전략 백테스트 |
| `tax` | 손익 계산 · CSV 내보내기 |

### 🤖 AI & 자동화
| 탭 | 설명 |
|----|------|
| `intelligence` | AI 시장 국면 · 자금배분 · 온체인 · 고래 · 전략 점수 |
| `hedgeos` | Hedge OS — Kill Switch · 드로다운 · 월렛 · 마켓플레이스 |
| `wunder` | WUNDER 자동매매 — Pine Script · WunderTrading 웹훅 |
| `ai` | AI 채팅 어시스턴트 |
| `briefing` | AI 시장 브리핑 |

### 👤 사용자
| 탭 | 설명 |
|----|------|
| `accounts` | 거래소 API 연결 |
| `subscription` | 구독 관리 · 초대 코드 |
| `settings` | 언어 · 통화 · 테마 설정 |
| `growth` | XP · 업적 · 레벨업 |

### 기타
`watchlist` · `news` · `alerts` · `social` · `academy` · `funding` · `calendar` · `clock` · `analytics`

---

## 🚀 빠른 시작

### 요구사항
- **Node.js 18.17+**
- **npm 9+**
- (선택) Supabase 계정

### 1. 설치 및 실행

```bash
# 1. 압축 해제
unzip TRAIGO-v8.zip
cd traigo_final2

# 2. 패키지 설치
npm install

# 3. 환경변수 설정 (Supabase 없이도 Mock 모드로 실행 가능)
cp .env.example .env.local

# 4. 개발 서버 실행
npm run dev
# → http://localhost:3000

# 5. 프로덕션 빌드 (Vercel 배포 전 확인용)
npm run build
```

### 2. 브라우저 열기

```
http://localhost:3000
```

Supabase 환경변수가 없으면 **Mock 모드**로 자동 실행됩니다.  
모든 기능을 테스트할 수 있으며, 데이터는 localStorage에 저장됩니다.

---

## 🔑 환경변수

`.env.example`을 `.env.local`로 복사한 뒤 입력하세요.

### 필수 (Supabase Auth 사용 시)

```env
NEXT_PUBLIC_SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6...
```

> **없으면?** → Mock 모드로 자동 실행 (개발·테스트용)

### 선택 (마켓 데이터)

```env
# 미국 주식 실시간 (polygon.io — 무료 플랜 있음)
NEXT_PUBLIC_POLYGON_API_KEY=

# 암호화폐 — Binance/CoinGecko는 키 없이도 공개 API 사용
# COINGECKO_API_KEY=         # CoinGecko Pro (선택)

# 한국 주식 (KIS Open API — 키움증권 계열)
# KIS_APP_KEY=
# KIS_APP_SECRET=

# 향후 확장
# OPENAI_API_KEY=            # AI 기능 강화
# BINANCE_API_KEY=           # 실거래 (현재 비활성)
# GATE_API_KEY=              # Gate.io (현재 비활성)
```

---

## 🗄️ Supabase 설정

### 1. 프로젝트 생성

1. [supabase.com](https://supabase.com) → **New project** 클릭
2. 데이터베이스 비밀번호 저장 (나중에 사용)
3. **Settings → API** 에서 `URL`과 `anon key` 복사

### 2. 스키마 적용

```sql
-- Supabase 대시보드 → SQL Editor → New Query
-- supabase/schema.sql 파일 전체 붙여넣기 후 실행
```

### 3. 환경변수 등록

**.env.local (로컬):**
```env
NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
```

**Vercel (배포 시):**
```
Project → Settings → Environment Variables
```
같은 키를 Production / Preview / Development 모두 체크

### 4. 첫 관리자 계정 설정

```
1. http://localhost:3000/auth 에서 회원가입
2. Supabase 대시보드 → SQL Editor → 아래 쿼리 실행
```

```sql
-- 본인 이메일로 슈퍼관리자 권한 부여
UPDATE profiles
SET role      = 'super_admin',
    plan      = 'lifetime',
    status    = 'active'
WHERE email = 'your-email@example.com';
```

이후 `/admin` 페이지 접근 가능

---

## 📲 Vercel 배포

### 자동 배포 (권장)

```bash
# Vercel CLI 설치 (최초 1회)
npm install -g vercel

# 배포
vercel --prod
```

### 수동 배포

1. [vercel.com](https://vercel.com) → **New Project**
2. GitHub repo 또는 ZIP import
3. Framework: **Next.js** (자동 감지)
4. **Environment Variables** 추가 (위 참고)
5. **Deploy** 클릭

### vercel.json (이미 포함)

```json
{
  "framework": "nextjs",
  "buildCommand": "npm run build",
  "outputDirectory": ".next",
  "installCommand": "npm install"
}
```

---

## 📱 PWA 설치

### iPhone / iPad (iOS Safari)
1. Safari에서 사이트 접속
2. 하단 공유 버튼 (□↑) 탭
3. **"홈 화면에 추가"** → "추가"

### Android (Chrome)
1. Chrome에서 사이트 접속
2. 상단 배너 "앱 설치" 또는 메뉴 → "홈 화면에 추가"
3. 10초 후 헤더에 **📲 설치** 버튼 표시

### macOS (Chrome / Edge)
1. 주소창 오른쪽 설치 아이콘 클릭
2. "TRAIGO 설치" 확인

---

## 🏗️ 프로젝트 구조

```
traigo_final2/
├── src/
│   ├── app/
│   │   ├── page.tsx              ← 메인 앱 (18,636줄, 113개 함수, 32개 탭)
│   │   ├── layout.tsx            ← PWA 메타데이터 · Apple 지원
│   │   ├── globals.css           ← 반응형 CSS · safe-area · PWA
│   │   ├── auth/page.tsx         ← 로그인/회원가입/보안 (572줄)
│   │   ├── admin/page.tsx        ← 관리자 대시보드 (385줄)
│   │   ├── developer/page.tsx    ← 개발자 도구 (299줄)
│   │   ├── chart/page.tsx        ← 독립 차트 페이지 (4분할, 346줄)
│   │   └── api/
│   │       ├── prices/route.ts   ← Binance → CoinGecko → Mock (180줄)
│   │       ├── news/route.ts     ← 뉴스 API
│   │       ├── search/route.ts   ← 자산 검색
│   │       └── webhook/tradingview/route.ts  ← 웹훅 수신
│   ├── data/
│   │   └── assets.ts             ← 기본 자산 목록
│   └── lib/
│       ├── auth.ts               ← 인증 타입 · Mock 세션 · 역할 시스템
│       ├── supabase.ts           ← Supabase 클라이언트 · DB 함수
│       ├── assetSearch.ts        ← 다국어 검색 엔진 (한국어/영어/티커)
│       ├── assetCache.ts         ← 자산 캐시
│       ├── assetTypes.ts         ← 자산 타입 정의
│       ├── pwa.ts                ← PWA Hook (SW 등록 · 설치 프롬프트)
│       ├── constants.ts          ← 상수
│       └── utils.ts              ← 유틸리티
├── public/
│   ├── sw.js                     ← Service Worker (5가지 캐시 전략)
│   ├── manifest.json             ← PWA Manifest
│   ├── offline.html              ← 오프라인 폴백 페이지
│   ├── icon-192.png              ← Android 아이콘
│   ├── icon-512.png              ← 스플래시 아이콘
│   ├── apple-touch-icon.png      ← iOS 홈 화면 아이콘
│   └── icon.svg                  ← 벡터 아이콘
├── supabase/
│   └── schema.sql                ← DB 스키마 (테이블 · RLS · 함수)
├── next.config.js                ← ignoreBuildErrors: true
├── tsconfig.json                 ← skipLibCheck: true
├── vercel.json                   ← 배포 설정
└── .env.example                  ← 환경변수 템플릿
```

---

## 🔐 역할 시스템

| 역할 | 한국어 | 권한 |
|------|--------|------|
| `user` | 일반회원 | 기본 기능 |
| `vip` | VIP | 우선 지원 |
| `lifetime` | 평생회원 | 평생 Pro |
| `founder` | 창업멤버 | 특별 멤버 |
| `admin` | 관리자 | 사용자 관리 |
| `developer` | 개발자 | 개발자 도구 |
| `super_admin` | 슈퍼관리자 | 모든 권한 |

### 초대 코드 (Mock 모드)

| 코드 | 플랜 | 역할 |
|------|------|------|
| `FOUNDER-2026` | founder | founder |
| `FRIEND-LIFETIME` | lifetime | lifetime |
| `DEV-ACCESS-2025` | lifetime | developer |
| `PRO-FRIEND-XYZ` | pro | user |

---

## 🧪 Mock 모드 테스트 계정

Supabase 없이 개발 서버에서 사용 가능:

| 이메일 | 역할 | 용도 |
|--------|------|------|
| `super@traigo.app` | super_admin | 전체 관리자 |
| `dev@traigo.app` | developer | 개발자 도구 |
| `admin@traigo.app` | admin | 사용자 관리 |
| `founder@test.com` | founder | 창업멤버 |
| `vip@test.com` | vip | VIP 테스트 |

> `/auth` 페이지 하단 "개발용 테스트 계정" 버튼으로 빠른 로그인 가능

---

## 🌐 데이터 소스

### 암호화폐 가격 (자동 폴백)

```
1순위: Binance REST API (공개, 키 불필요)
2순위: CoinGecko API (공개, 키 불필요)
3순위: Mock 로컬 데이터
```

`GET /api/prices` 응답:
```json
{
  "source": "binance",
  "status": "live",
  "latency": 142,
  "data": [{ "symbol": "BTC", "price": 94230000, "change24h": 2.14 }]
}
```

### 차트 데이터

TradingView 위젯 (클라이언트 사이드)을 통해 실시간 차트 표시.  
광고 차단기가 활성화된 경우 차트가 로드되지 않을 수 있습니다.

### 다국어 검색

```
비트코인 → BTC    플래닛랩스 → PL    엔비디아 → NVDA
bitcoin  → BTC    planet labs → PL   nvidia   → NVDA
```

---

## 🔗 웹훅 API

### WunderTrading 연동

**엔드포인트:** `POST /api/webhook/tradingview`

```json
{
  "code": "BTCWUNDER",
  "orderType": "openLong",
  "amountPerTradeType": "percent",
  "amountPerTrade": 10,
  "leverage": 3,
  "stopLoss": 2.5,
  "reduceOnly": false,
  "pos": "{{strategy.position_size}}"
}
```

> **현재 모드:** 신호 수신 후 로그만 기록. 실제 거래 미실행.

**신호 조회:** `GET /api/webhook/tradingview`

---

## ⚠️ 안전 고지

```
┌─────────────────────────────────────────────────────────────────┐
│  🎮  이 플랫폼은 교육용 모의투자 시뮬레이터입니다              │
│                                                                 │
│  ✗  실제 자금이 사용되지 않습니다                              │
│  ✗  실제 거래가 실행되지 않습니다                              │
│  ✗  투자 수익을 보장하지 않습니다                              │
│  ✗  AI 분석은 투자 조언이 아닙니다                             │
│                                                                 │
│  ✓  모든 투자 결정은 사용자 본인의 책임입니다                  │
│  ✓  실제 투자 전 전문가 상담을 권장합니다                      │
│  ✓  과거 시뮬레이션 성과가 미래를 보장하지 않습니다            │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🛠️ 트러블슈팅

### ❌ "No Next.js version detected" (Vercel)

```bash
# package.json의 next 버전 확인
cat package.json | grep '"next"'
# → "next": "14.2.5"

# vercel.json 확인
cat vercel.json
# → { "framework": "nextjs" }

# Vercel 대시보드 → Project Settings → Framework Preset → Next.js 선택
```

---

### ❌ "Application error: a client-side exception"

**1. 포트폴리오 페이지 크래시 (가격 데이터 관련)**

→ `prices` prop이 `undefined`이거나 가격 나누기 0 발생

수정 방법:
```typescript
// PortfolioPage는 이미 safeDiv()로 보호됨
// 캐시 삭제 후 새로고침
localStorage.clear()
location.reload()
```

**2. 일반적인 클라이언트 크래시**

```bash
# 브라우저 캐시 강제 클리어
# Chrome DevTools → Application → Storage → Clear All

# 또는
localStorage.clear()
sessionStorage.clear()
```

---

### ❌ Supabase 환경변수 없음

```
TRAIGO Supabase not configured — using Mock mode
```

→ 정상입니다. Mock 모드로 동작합니다.

실제 Supabase 연동을 원하면:
```env
# .env.local
NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
```

---

### ❌ 로고가 안 보임 (Clearbit 차단)

Clearbit 로고 API는 광고 차단기나 방화벽에 의해 차단될 수 있습니다.  
→ 자동으로 티커 이니셜 폴백(예: `NV`)이 표시됩니다.

---

### ❌ TradingView 차트가 빈 화면

→ 광고 차단기 비활성화 후 새로고침

또는 다른 브라우저(Chrome, Safari)로 시도

---

### ❌ Vercel 빌드 실패

```bash
# 로컬에서 빌드 테스트
npm run build

# 에러가 있어도 배포 시도 (ignoreBuildErrors: true 설정됨)
# next.config.js 확인:
cat next.config.js
# typescript.ignoreBuildErrors: true
# eslint.ignoreDuringBuilds: true
```

---

### ❌ "포트폴리오 페이지 흰 화면"

```bash
# localStorage 초기화 후 재시도
localStorage.removeItem('tg_drawings_v2')
localStorage.removeItem('tg_layouts_v2')
localStorage.removeItem('tg_mock_session_v2')
location.reload()
```

---

### ❌ Vercel 재배포 필요 시

```bash
vercel --prod --force
```

또는 Vercel 대시보드 → Deployments → **Redeploy**

---

## 🔧 개발 커맨드

```bash
npm run dev      # 개발 서버 (localhost:3000, Hot Reload)
npm run build    # 프로덕션 빌드
npm run start    # 빌드 후 로컬 실행
npm run lint     # ESLint (경고만, 에러 미발생)
vercel --prod    # Vercel 배포
```

---

## 📋 기술 스택

| 분류 | 기술 |
|------|------|
| 프레임워크 | Next.js 14.2.5 (App Router) |
| 언어 | TypeScript 5 |
| 스타일 | Tailwind CSS + 인라인 스타일 |
| 인증/DB | Supabase (Auth + PostgreSQL) |
| 차트 | TradingView Widget |
| 가격 | Binance REST → CoinGecko → Mock |
| 배포 | Vercel |
| PWA | Custom Service Worker |
| 폰트 | Google Fonts (Sora) |

---

## 📊 현재 상태 (v8)

```
src/app/page.tsx    18,636줄   113개 함수   32개 탭
src/app/auth/       572줄     완전한 Auth UX
src/app/admin/      385줄     관리자 대시보드
src/app/chart/      346줄     독립 차트 페이지
public/sw.js        234줄     Service Worker
```

### 지원 자산

| 카테고리 | 수 |
|----------|--|
| 🇺🇸 미국 주식 | 207개 (8개 섹터) |
| 📦 ETF | 25개 |
| ₿ 암호화폐 | 20개 |
| 🇰🇷 한국 주식 | 14개 |
| 📊 지수 | 12개 |
| 🛢 원자재 / 환율 | 13개 |
| **합계** | **291개** |

---

## 📞 지원

- 관리자 이메일: 관리자 계정으로 `/admin` 접속
- Supabase 문서: [supabase.com/docs](https://supabase.com/docs)
- Next.js 문서: [nextjs.org/docs](https://nextjs.org/docs)
- TradingView 위젯: [tradingview.com/widget](https://tradingview.com/widget)

---

<div align="center">

**TRAIGO** · 모의투자 전용 · 실제 거래 불가 · 수익 보장 없음

Made with ❤️ for the Korean investing community

</div>
