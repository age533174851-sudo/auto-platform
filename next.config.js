/** @type {import('next').NextConfig} */
const nextConfig = {
  // 서비스워커 캐시 버전의 근거. Vercel은 커밋 SHA를 주고, 로컬에서는
  // 빌드 시각을 쓴다. 이 값이 바뀌어야 옛 캐시가 지워진다.
  env: {
    NEXT_PUBLIC_BUILD_ID:
      (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 8) || String(Date.now()),
  },
  reactStrictMode: false,
  productionBrowserSourceMaps: false, // disabled for security
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'logo.clearbit.com' },
      { protocol: 'https', hostname: 'cryptologos.cc' },
      { protocol: 'https', hostname: 'financialmodelingprep.com' },
      { protocol: 'https', hostname: 'site.financialmodelingprep.com' },
      { protocol: 'https', hostname: 'static.finnhub.io' },
      { protocol: 'https', hostname: 'img.icons8.com' },
      { protocol: 'https', hostname: 'cdn.jsdelivr.net' },
      { protocol: 'https', hostname: 'upload.wikimedia.org' },
      { protocol: 'https', hostname: 'eodhd.com' },
      { protocol: 'https', hostname: 'assets.coingecko.com' },
      // 국내 주식 로고 (6자리 종목코드로 조회) — src/lib/logoResolver.ts
      { protocol: 'https', hostname: 'static.toss.im' },
    ],
    unoptimized: true,
  },
  // chunk 7850 같은 stale chunk 문제 방지 — 클라이언트가 항상 최신 청크를 받도록
  headers: async () => [
    {
      source: '/_next/static/:path*',
      headers: [
        { key: 'Cache-Control', value: 'no-store' },
      ],
    },
  ],
};
module.exports = nextConfig;
