// ═══════════════════════════════════════════════════════════
// TRAIGO Service Worker — PWA offline support + smart caching
//
// 캐시 버전은 **자동이다.** 손으로 올리지 않는다.
// ─────────────────────────────────────────────
// 예전에는 여기 `const CACHE_VERSION = 'traigo-v10-2026-05-28'`가 박혀 있고
// 바로 위에 "bump per deploy"라고 적혀 있었다. 그런데 두 달 넘게 아무도
// 안 올렸다. 배포할 때마다 사람이 기억해야 하는 안전 절차는 결국 잊힌다.
//
// 안 올리면 무슨 일이 생기나:
//   · activate에서 옛 캐시를 지우는 조건이 "CACHE_VERSION으로 시작하지
//     않는 것"인데, 버전이 안 바뀌니 **아무것도 지워지지 않는다.**
//     캐시가 계속 쌓이고 오프라인 폴백은 두 달 전 화면 그대로다.
//   · 미리 캐시한 app shell(manifest·아이콘·offline.html)도 그때 것이다.
//
// 그래서 등록할 때 `/sw.js?v=<빌드 id>`로 부르고, 여기서 그 값을 읽는다.
// 배포마다 빌드 id가 달라지므로 캐시 이름이 자동으로 갈리고, 옛 캐시는
// activate가 지운다. 사람이 기억할 것이 없다.
const SW_VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const CACHE_VERSION   = `traigo-${SW_VERSION}`;
const STATIC_CACHE    = `${CACHE_VERSION}-static`;
const DYNAMIC_CACHE   = `${CACHE_VERSION}-dynamic`;
const API_CACHE       = `${CACHE_VERSION}-api`;

// Assets to pre-cache on install (app shell only — NO JS chunks)
const PRECACHE_URLS = [
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
  '/favicon-32.png',
  '/fallback-logo.svg',
];

// API routes to cache with stale-while-revalidate
const API_CACHE_PATTERNS = [
  /\/api\/prices/,
  /\/api\/market/,
];

// External domains that can be cached
const CACHEABLE_ORIGINS = [
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com',
];

// Never cache these (always network)
const NETWORK_ONLY = [
  /\/api\/webhook/,
  /\/api\/health/,
  /\/api\/diagnostics/,
  /\/api\/backtest/,
  /\/api\/daily-briefing/,
  /\/api\/news\//,
  /\/api\/logo/,
  /\/_next\/webpack-hmr/,
  /supabase\.co/,
];

// ── Install ──────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(cache => {
      return Promise.allSettled(
        PRECACHE_URLS.map(url =>
          cache.add(url).catch(err => console.warn(`[SW] Precache miss: ${url}`, err))
        )
      );
    }).then(() => self.skipWaiting())
  );
});

// ── Activate: delete all previous-version caches ─────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k.startsWith('traigo-') && !k.startsWith(CACHE_VERSION))
          .map(k => {
            console.log(`[SW] Deleting old cache: ${k}`);
            return caches.delete(k);
          })
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch Strategy ───────────────────────────────────────────
//
// **차단 목록에서 허용 목록으로 뒤집었다.**
//
// 예전에는 마지막 분기가 "그 밖의 모든 GET"을 DYNAMIC_CACHE에 저장했고,
// 제외는 손으로 적은 일곱 개 경로뿐이었다. 그래서 이런 것들이 전부
// 브라우저 Cache Storage에 남았다:
//
//   /api/auth/me          ← 지금 로그인한 사람이 누구인가
//   /api/ai/keys          ← API 키 정보
//   /api/admin            ← 관리자 데이터
//   /api/wallets          ← 지갑
//   /api/risk/*           ← 한도·킬스위치 상태
//
// 캐시 키는 **URL뿐이다.** 사용자 토큰은 헤더에 있어서 키에 안 들어간다.
// 그래서 같은 브라우저에서 사람이 바뀌어도 같은 항목을 가리킨다:
//
//   A 로그인 → 계좌 조회(캐시됨) → A 로그아웃 → B 로그인
//   → 네트워크 실패 → **B가 A의 계좌를 본다**
//
// 새 API를 추가할 때마다 제외 목록에 적어야 하는 구조는 언젠가 반드시
// 빠뜨린다. 기본을 '캐시 안 함'으로 두고, 공개 데이터만 명시적으로 연다.

/** 캐시해도 되는 API — 공개 시세뿐. 사람마다 다른 값이 아니어야 한다. */
const PUBLIC_API_ALLOWLIST = [
  /^\/api\/prices(\/|$)/,
  /^\/api\/market(\/|$)/,
];

/** 시세 캐시를 신선하다고 볼 수 있는 시간. 금융 화면에서 오래된 값은 위험하다. */
const PRICE_MAX_AGE_MS = 60_000;
const FETCHED_AT_HEADER = 'x-sw-cached-at';

function isCacheableApi(url, request) {
  if (!url.pathname.startsWith('/api/')) return false;
  // **인증이 실린 요청은 무조건 캐시하지 않는다.** 경로 목록보다 강한 규칙이다.
  if (request.headers.has('authorization')) return false;
  return PUBLIC_API_ALLOWLIST.some(p => p.test(url.pathname));
}

/** 캐시된 응답이 얼마나 오래됐나. 모르면 null (모르는 것을 신선하다고 하지 않는다) */
function cachedAgeMs(response) {
  const at = response && response.headers.get(FETCHED_AT_HEADER);
  const t = at ? Number(at) : NaN;
  return Number.isFinite(t) ? Date.now() - t : null;
}

/** 저장 시각을 헤더에 심어 둔다. 안 심으면 나중에 신선도를 알 수 없다. */
async function withStamp(response) {
  const body = await response.clone().blob();
  const headers = new Headers(response.headers);
  headers.set(FETCHED_AT_HEADER, String(Date.now()));
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;
  if (!url.protocol.startsWith('http')) return;
  if (NETWORK_ONLY.some(p => p.test(url.href))) return;

  // ── 1. 인증이 실린 요청은 손대지 않는다 ──
  // 경로를 일일이 적는 것보다 확실하다. 새 API가 생겨도 자동으로 보호된다.
  if (request.headers.has('authorization')) return;

  // ── 2. /_next/static — 서비스 워커가 개입하지 않는다 ──
  //
  // 파일명에 콘텐츠 해시가 박혀 있어서 **낡을 수가 없다.** 해시가 바뀌면
  // URL이 바뀐다. 그런데 여기서 network-first로 잡고 있었다 —
  // 캐시가 있어도 매번 네트워크를 먼저 치므로 캐시의 이점이 0이고,
  // 느린 망에서는 청크마다 대기한다.
  //
  // 브라우저와 CDN의 immutable 캐시가 이 일을 훨씬 잘한다. 비켜 준다.
  if (url.pathname.startsWith('/_next/')) return;

  // ── 3. HTML(navigation) — **저장하지 않는다** ──
  //
  // 예전에는 모든 navigation 응답을 DYNAMIC_CACHE에 넣었다. 로그인한
  // 상태로 /admin·/developer·/accounts를 열면 그 HTML이 그대로 남는다.
  // 미들웨어가 Cache-Control: no-store를 붙여도 cache.put()은 그것과
  // 무관하게 저장한다.
  //
  // 어느 페이지가 민감한지 서비스 워커가 추측하게 두지 않는다 —
  // 목록은 언젠가 낡는다. HTML은 아예 저장하지 않고, 오프라인일 때는
  // 미리 캐시해 둔 offline.html만 보여준다.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match('/offline.html').then(r => r || new Response(
          '<!doctype html><meta charset="utf-8"><title>오프라인</title>'
          + '<body style="font-family:sans-serif;padding:2rem">'
          + '<h1>오프라인입니다</h1><p>연결되면 다시 시도해 주세요.</p>',
          { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } })))
    );
    return;
  }

  // ── 4. 공개 시세 API — Stale-While-Revalidate + 유효기간 ──
  //
  // 유효기간이 없으면 며칠 전 값을 즉시 돌려줄 수 있다. 일반 콘텐츠라면
  // 몰라도 **시세는 오래된 값이 틀린 값이다.**
  if (isCacheableApi(url, request)) {
    event.respondWith((async () => {
      const cache = await caches.open(API_CACHE);
      const cached = await cache.match(request);
      const age = cached ? cachedAgeMs(cached) : null;
      const fresh = age !== null && age < PRICE_MAX_AGE_MS;

      const network = fetch(request).then(async (res) => {
        if (res.ok) await cache.put(request, await withStamp(res.clone()));
        return res;
      });

      // 신선하면 즉시 주고 뒤에서 갱신한다. 낡았거나 나이를 모르면 기다린다.
      if (fresh) { network.catch(() => {}); return cached; }
      try { return await network; }
      catch {
        // **네트워크가 죽었을 때 가짜 200을 만들지 않는다.**
        // 예전에는 `{status:'mock', data:[], prices:{}}`를 200으로
        // 돌려줬다. 그건 "값이 없다"로 읽히고, 이 저장소가 반복해서
        // 밟은 바로 그 모양이다 — 실패가 성공처럼 보이는 것.
        if (cached) return cached;   // 낡았지만 진짜 값. 나이 헤더가 함께 간다
        return new Response(
          JSON.stringify({ ok: false, error: 'offline', message: '오프라인이라 시세를 가져오지 못했습니다' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } });
      }
    })());
    return;
  }

  // ── 5. 그 밖의 /api/* — 네트워크 전용 ──
  // 허용 목록에 없으면 캐시하지 않는다. 기본이 '안 함'이다.
  if (url.pathname.startsWith('/api/')) return;

  // ── 6. 폰트 등 외부 정적 자원 — Cache First ──
  if (CACHEABLE_ORIGINS.some(o => url.href.startsWith(o))) {
    event.respondWith(
      caches.match(request).then(cached => cached || fetch(request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(STATIC_CACHE).then(c => c.put(request, clone));
        }
        return response;
      }).catch(() => new Response('', { status: 408 })))
    );
    return;
  }

  // ── 7. 나머지 같은 출처 정적 파일(아이콘·manifest 등) ──
  // 사람마다 다른 값이 아니다. 여기까지 온 것은 API도 HTML도 아니다.
  event.respondWith(
    fetch(request)
      .then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(STATIC_CACHE).then(c => c.put(request, clone));
        }
        return response;
      })
      .catch(() => caches.match(request).then(cached => cached || new Response('', { status: 504 })))
  );
});

// ── 로그아웃 등에서 캐시를 비운다 ────────────────────────────
//
// 위 규칙대로면 사용자 데이터는 캐시에 안 들어가지만, 예전 버전이
// 남겨 둔 것이 있을 수 있다. 사람이 바뀌는 순간 그것부터 지운다.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'CLEAR_USER_CACHES') {
    event.waitUntil(
      caches.keys().then(keys => Promise.all(
        keys.filter(k => k.includes('-dynamic') || k.includes('-api'))
            .map(k => caches.delete(k))
      ))
    );
  }
});

// ── Push Notifications ────────────────────────────────────────
self.addEventListener('push', (event) => {
  if (!event.data) return;
  try {
    const data = event.data.json();
    event.waitUntil(
      self.registration.showNotification(data.title || 'TRAIGO', {
        body:  data.body  || '새 알림이 있습니다.',
        icon:  '/icon-192.png',
        badge: '/icon-192.png',
        tag:   data.tag   || 'traigo-notification',
        data:  { url: data.url || '/' },
        vibrate: [200, 100, 200],
        requireInteraction: data.critical || false,
        actions: data.actions || [],
      })
    );
  } catch (e) {
    event.waitUntil(
      self.registration.showNotification('TRAIGO', {
        body: event.data.text() || '새 알림',
        icon: '/icon-192.png',
      })
    );
  }
});

// ── Notification click ────────────────────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url === url && 'focus' in client) return client.focus();
      }
      return clients.openWindow(url);
    })
  );
});

// ── Message from app ──────────────────────────────────────────
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data?.type === 'CLEAR_CACHE') {
    event.waitUntil(
      caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))
        .then(() => {
          // Reply to client so it can reload
          event.source?.postMessage({ type: 'CACHE_CLEARED' });
        })
    );
  }
});

console.log('[TRAIGO SW] Service Worker loaded — version:', CACHE_VERSION);
