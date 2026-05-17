// ═══════════════════════════════════════════════════════════
// TRAIGO Service Worker — PWA offline support + smart caching
// ═══════════════════════════════════════════════════════════

const CACHE_VERSION   = 'traigo-v1';
const STATIC_CACHE    = `${CACHE_VERSION}-static`;
const DYNAMIC_CACHE   = `${CACHE_VERSION}-dynamic`;
const API_CACHE       = `${CACHE_VERSION}-api`;

// Assets to pre-cache on install (app shell)
const PRECACHE_URLS = [
  '/',
  '/offline.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
  '/favicon-32.png',
];

// API routes to cache with stale-while-revalidate
const API_CACHE_PATTERNS = [
  /\/api\/prices/,
  /\/api\/news/,
];

// External domains that can be cached
const CACHEABLE_ORIGINS = [
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com',
  'https://logo.clearbit.com',
];

// Never cache these (always network)
const NETWORK_ONLY = [
  /\/api\/webhook/,
  /\/_next\/webpack-hmr/,
  /supabase\.co/,
];

// ── Install ──────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(cache => {
      // Don't fail install if some URLs miss
      return Promise.allSettled(
        PRECACHE_URLS.map(url =>
          cache.add(url).catch(err => console.warn(`[SW] Precache miss: ${url}`, err))
        )
      );
    }).then(() => self.skipWaiting())
  );
});

// ── Activate ─────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k.startsWith('traigo-') && k !== STATIC_CACHE && k !== DYNAMIC_CACHE && k !== API_CACHE)
          .map(k => {
            console.log(`[SW] Deleting old cache: ${k}`);
            return caches.delete(k);
          })
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch Strategy ───────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET and network-only patterns
  if (request.method !== 'GET') return;
  if (NETWORK_ONLY.some(p => p.test(url.href))) return;
  // Skip chrome-extension & non-http
  if (!url.protocol.startsWith('http')) return;

  // ── Strategy 1: App shell (navigation) — Cache First with offline fallback
  if (request.mode === 'navigate') {
    event.respondWith(
      caches.match('/').then(cached => {
        const networkFetch = fetch(request)
          .then(response => {
            if (response.ok) {
              const clone = response.clone();
              caches.open(DYNAMIC_CACHE).then(c => c.put(request, clone));
            }
            return response;
          })
          .catch(() => cached || caches.match('/offline.html'));
        // If we have cache, use it but update in background (SWR)
        return cached || networkFetch;
      })
    );
    return;
  }

  // ── Strategy 2: API prices/news — Stale-While-Revalidate
  if (API_CACHE_PATTERNS.some(p => p.test(url.pathname))) {
    event.respondWith(
      caches.open(API_CACHE).then(cache =>
        cache.match(request).then(cached => {
          const networkFetch = fetch(request)
            .then(response => {
              if (response.ok) cache.put(request, response.clone());
              return response;
            })
            .catch(() => cached || new Response(
              JSON.stringify({ status: 'mock', source: 'offline', data: [], prices: {} }),
              { headers: { 'Content-Type': 'application/json' } }
            ));
          return cached || networkFetch;
        })
      )
    );
    return;
  }

  // ── Strategy 3: Static assets (_next/static) — Cache First
  if (url.pathname.includes('/_next/static/') || url.pathname.includes('/static/')) {
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached;
        return fetch(request).then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(STATIC_CACHE).then(c => c.put(request, clone));
          }
          return response;
        }).catch(() => new Response('', { status: 408 }));
      })
    );
    return;
  }

  // ── Strategy 4: Fonts — Cache First (long TTL)
  if (CACHEABLE_ORIGINS.some(o => url.href.startsWith(o))) {
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached;
        return fetch(request).then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(STATIC_CACHE).then(c => c.put(request, clone));
          }
          return response;
        }).catch(() => new Response('', { status: 408 }));
      })
    );
    return;
  }

  // ── Strategy 5: Everything else — Network First with cache fallback
  event.respondWith(
    fetch(request)
      .then(response => {
        if (response.ok && request.method === 'GET') {
          const clone = response.clone();
          caches.open(DYNAMIC_CACHE).then(c => c.put(request, clone));
        }
        return response;
      })
      .catch(() => caches.match(request).then(cached => cached || caches.match('/offline.html')))
  );
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

// ── Background sync (placeholder) ────────────────────────────
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-portfolio') {
    event.waitUntil(
      // Placeholder: sync portfolio data when back online
      Promise.resolve()
    );
  }
});

// ── Message from app ──────────────────────────────────────────
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data?.type === 'CLEAR_CACHE') {
    event.waitUntil(
      caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))
    );
  }
});

console.log('[TRAIGO SW] Service Worker loaded — version:', CACHE_VERSION);
