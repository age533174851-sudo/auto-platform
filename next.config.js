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
      // **콘텐츠 해시가 파일명에 있다.** 내용이 바뀌면 URL이 바뀌므로
      // 낡은 파일을 받을 수가 없다. 그런데 여기에 no-store가 걸려 있어서
      // 매 진입마다 JS 전체를 다시 받고 있었다.
      //
      // 서비스 워커도 같은 경로를 network-first로 잡고 있어서, **캐시를
      // 끈 채로 더 복잡한 캐시를 하나 더 돌리는** 모양이었다. 서비스
      // 워커 쪽은 개입을 없앴고(public/sw.js), 여기는 원래대로 되돌린다.
      source: '/_next/static/:path*',
      headers: [
        { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
      ],
    },
    {
      // HTML은 반대다. 해시가 없으므로 매번 확인해야 새 배포가 반영된다.
      source: '/:path((?!_next/static).*)',
      headers: [
        { key: 'Cache-Control', value: 'no-cache' },
      ],
    },
  ],
};
module.exports = nextConfig;
