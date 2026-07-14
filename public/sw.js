// Construction Clock — минимальный service worker (установка как приложение, кэш оболочки)
const CACHE = 'cclock-shell-v1'
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/'])))
  self.skipWaiting()
})
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))))
})
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET' || url.pathname.startsWith('/rest') || url.pathname.startsWith('/functions')) return
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request).then((r) => r || caches.match('/'))))
})

// Web-push: render the incoming payload as a notification.
self.addEventListener('push', (e) => {
  const d = e.data?.json() ?? {}
  e.waitUntil(
    self.registration.showNotification(d.title || 'Construction Clock', {
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
