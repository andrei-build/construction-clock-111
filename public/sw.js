// Construction Clock — service worker: install-as-app + offline app-shell cache.
// OFFLINE-1 (pass 1b remainder): the fetch handler now POPULATES a runtime cache on successful
// same-origin GETs, so after ONE successful load the whole shell (index.html + hashed Vite
// bundles under /assets + icon/manifest) is available with NO network at all — a cold start /
// airplane-mode open renders the app instead of white-screening. Vite hashes asset filenames, so
// we never hardcode them: they are cached at runtime as they are fetched. Supabase (/rest,
// /functions, /auth) and every cross-origin request bypass the cache so API calls always hit the
// network (the offline read-cache layer already handles read fallback).
const CACHE = 'cclock-shell-v2'
// Install-time precache: only the never-hashed entry + static icons/manifest. The hashed JS/CSS
// bundles are added to the same cache at runtime on first fetch (see the fetch handler).
const PRECACHE = ['/', '/index.html', '/icon.svg', '/manifest.webmanifest']

self.addEventListener('install', (e) => {
  // addAll is atomic — one missing file would reject the whole install — so tolerate a miss and
  // let the runtime cache fill the rest in from the first successful navigation/asset load.
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE).catch(() => {})))
  self.skipWaiting()
})

self.addEventListener('activate', (e) => {
  // Drop caches from older shell versions so a deploy can't be served stale bundles forever.
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))))
})

// Only same-origin app-shell / build assets are cacheable. Supabase API paths and any
// cross-origin request (CDN modules, fonts, Supabase host) always go to the network untouched.
function isCacheableAsset(url) {
  if (url.origin !== self.location.origin) return false
  if (url.pathname.startsWith('/rest') || url.pathname.startsWith('/functions') || url.pathname.startsWith('/auth')) return false
  return true
}

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)

  // SPA navigations: network-first (keep index.html fresh online), refresh the cached shell on
  // success, and fall back to the cached shell so a cold offline open still renders '/'.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put('/', copy)).catch(() => {})
          return res
        })
        .catch(() => caches.match('/').then((r) => r || caches.match('/index.html'))),
    )
    return
  }

  // Non-navigation cross-origin / Supabase GETs: leave to the network (no respondWith).
  if (!isCacheableAsset(url)) return

  // Static assets (hashed JS/CSS, icon, manifest): stale-while-revalidate. Serve the cache
  // immediately when present and refresh it in the background; on a cache miss go to network and
  // populate the cache so the NEXT (offline) load has it. Only ok responses are cached.
  e.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone()
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {})
          }
          return res
        })
        .catch(() => cached)
      return cached || network
    }),
  )
})

// Web-push: render the incoming payload as a notification.
self.addEventListener('push', (e) => {
  const d = e.data?.json() ?? {}
  e.waitUntil(
    self.registration.showNotification(d.title || 'Marvel Construction', {
      body: d.body || '',
      data: { url: d.url || '/' },
      icon: '/icon.svg',
      badge: '/icon.svg',
    }),
  )
})

// Focus an existing window (navigating it to the target url) or open a new one.
self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((ws) => {
      for (const w of ws) {
        if ('focus' in w) {
          w.navigate(e.notification.data?.url || '/')
          return w.focus()
        }
      }
      return clients.openWindow(e.notification.data?.url || '/')
    }),
  )
})
