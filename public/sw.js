// ═══════════════════════════════════════════════════════════
// TRAIGO Service Worker — PWA offline support + smart caching
// IMPORTANT: bump CACHE_VERSION on each deploy to invalidate old chunks
// ═══════════════════════════════════════════════════════════

const CACHE_VERSION   = 'traigo-v10-2026-05-28';  // bump per deploy
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
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET and network-only patterns
  if (request.method !== 'GET') return;
  if (NETWORK_ONLY.some(p => p.test(url.href))) return;
  if (!url.protocol.startsWith('http')) return;

  // ── Strategy 1: _next/static/ — Network First (CRITICAL: prevents stale chunks)
  // We MUST hit network first for JS chunks because hashes change on every deploy.
  if (url.pathname.includes('/_next/static/') || url.pathname.includes('/_next/data/')) {
    event.respondWith(
      fetch(request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(STATIC_CACHE).then(c => c.put(request, clone));
        }
        return response;
      }).catch(() => caches.match(request).then(cached => cached || new Response('', { status: 504 })))
    );
    return;
  }

  // ── Strategy 2: App shell (navigation) — Network First with offline fallback
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(DYNAMIC_CACHE).then(c => c.put(request, clone));
          }
          return response;
        })
        .catch(() =>
          caches.match(request).then(cached =>
            cached || caches.match('/offline.html') || caches.match('/')
          )
        )
    );
    return;
  }

  // ── Strategy 3: API prices/market — Stale-While-Revalidate
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

  // ── Strategy 5: Everything else — Network First
  event.respondWith(
    fetch(request)
      .then(response => {
        if (response.ok && request.method === 'GET') {
          const clone = response.clone();
          caches.open(DYNAMIC_CACHE).then(c => c.put(request, clone));
        }
        return response;
      })
      .catch(() => caches.match(request).then(cached => cached || new Response('', { status: 504 })))
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
