import React from 'react';
import type { Metadata, Viewport } from 'next';
import './globals.css';
import KeyboardInsetProvider from '@/components/KeyboardInsetProvider';
import NotifyHost from '@/components/notify/NotifyHost';
import SessionCookieSync from '@/components/auth/SessionCookieSync';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: dark)',  color: 'var(--t-bg)' },
    { media: '(prefers-color-scheme: light)', color: 'var(--t-bg)' },
  ],
};

export const metadata: Metadata = {
  metadataBase: new URL('https://auto-platform-zeta.vercel.app'),
  title: 'TRAIGO — 글로벌 투자 시뮬레이션',
  description: '290+ 글로벌 종목 모의투자 · AI 분석 · TradingView 차트 · 완전 무료',
  keywords: ['모의투자','주식','코인','투자','paper trading','트레이딩뷰','자동매매'],
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'TRAIGO',
    startupImage: [
      {
        url: '/icon-512.png',
        media: '(device-width: 390px) and (device-height: 844px) and (-webkit-device-pixel-ratio: 3)',
      },
    ],
  },
  openGraph: {
    title: 'TRAIGO — 투자 시뮬레이션',
    description: '290+ 종목 모의투자 · AI 분석 · 완전 무료',
    type: 'website',
    images: [{ url: '/icon-512.png', width: 512, height: 512, alt: 'TRAIGO' }],
  },
  twitter: {
    card: 'summary',
    title: 'TRAIGO',
    description: '글로벌 투자 시뮬레이션 플랫폼',
    images: ['/icon-512.png'],
  },
  icons: {
    icon: [
      { url: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/icon.svg',        type: 'image/svg+xml' },
    ],
    apple: [
      { url: '/apple-touch-icon.png', sizes: '180x180' },
      { url: '/icon-192.png',          sizes: '192x192' },
    ],
    shortcut: '/icon-192.png',
  },
  other: {
    'mobile-web-app-capable': 'yes',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" suppressHydrationWarning>
      <head>
        {/*
          테마를 그리기 전에 정한다.

          리액트가 붙은 뒤에 바꾸면 첫 프레임이 항상 어두운 화면으로
          나왔다가 밝은 테마로 튄다. 밝은 테마를 쓰는 사람은 앱을 열
          때마다 검은 화면이 한 번 번쩍인다. 그래서 파싱을 막는 인라인
          스크립트로 <html>에 먼저 표시해 둔다. 여기서 하는 일은
          속성 하나 붙이는 것뿐이라 렌더를 지연시키지 않는다.
        */}
        {/*
          따옴표가 전부 빠져 있었다 — `localStorage.getItem(tg_theme_mode)`.
          첫 줄에서 ReferenceError로 던지고, catch 안의 `data-theme`도 같은
          이유로 던져서 결국 data-theme이 **아예 안 붙었다.** 위 주석이
          막겠다고 적어 둔 그 검은 화면 번쩍임이 그대로 나고 있었다.
          문법 오류라 타입체크·빌드·테스트 어디에도 걸리지 않는다 —
          문자열 안이니까.
        */}
        <script dangerouslySetInnerHTML={{ __html: `(function(){try{
var m=localStorage.getItem('tg_theme_mode');
if(m!=='dark'&&m!=='light'&&m!=='auto')m='auto';
var t=m;
if(m==='auto'){var h=new Date().getHours();t=(h>=7&&h<19)?'light':'dark';}
document.documentElement.setAttribute('data-theme',t);
}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();` }}/>
        <meta name="theme-color" content="#0A0B0D"/>
        {/* Fonts */}
        <link rel="preconnect" href="https://fonts.googleapis.com"/>
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous"/>
        <link
          href="https://fonts.googleapis.com/css2?family=Sora:wght@400;600;700;800;900&display=swap"
          rel="stylesheet"
        />
        {/* Apple PWA */}
        <meta name="apple-mobile-web-app-capable" content="yes"/>
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"/>
        <meta name="apple-mobile-web-app-title" content="TRAIGO"/>
        {/* Prevent iOS phone/date detection */}
        <meta name="format-detection" content="telephone=no,date=no,email=no,address=no"/>
        {/* Prevent iOS text size adjustment */}
        <meta name="HandheldFriendly" content="true"/>
        {/* Windows tile */}
        <meta name="msapplication-TileColor" content="#0A0B0D"/>
        <meta name="msapplication-TileImage" content="/icon-192.png"/>
        {/* Preload critical font */}
        <link
          rel="preload"
          href="https://fonts.gstatic.com/s/sora/v12/xMQOuFFYT72X5wkB_18qmnndmSe6f8I.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
      </head>
      <body style={{ background: 'var(--t-bg)', margin: 0, padding: 0 }}>
        <KeyboardInsetProvider />
        <NotifyHost />
        {/*
          미들웨어가 /admin·/developer를 막을 수 있도록 세션 토큰을 쿠키로
          복사한다. 앱 전체에 있어야 한다 — 관리자 화면에만 두면 그 화면에
          들어가야 쿠키가 생기고, 들어가려면 쿠키가 있어야 한다.
        */}
        <SessionCookieSync />
        {children}
      </body>
    </html>
  );
}
