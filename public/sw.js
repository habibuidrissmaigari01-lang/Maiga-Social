const CACHE_NAME = 'maiga-offline-v1';
const OFFLINE_URL = '/offline.html';

// List of essential assets to pre-cache
const ASSETS_TO_CACHE = [
  OFFLINE_URL,
  '/', // Main entry point for Maiga
  '/index.html', // Assuming this is the main entry point for Maiga
  '/ysu.html', // YSU login page
  '/maiga.js',
  '/alpine.js', // Alpine.js library
  '/sw.js', // Cache the service worker itself for updates
  '/manifest-maiga.json',
  '/manifest-ysu.json',
  '/img/logo.png',
  '/img/ysu-logo.jpg',
  'https://cdn.tailwindcss.com',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap',
];

// 1. Install Event: Cache the offline page
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[Service Worker] Pre-caching offline page and essential assets');
      // Use Promise.all to ensure all assets are attempted to be cached
      return Promise.all(
        ASSETS_TO_CACHE.map(url => {
          return cache.add(new Request(url, { cache: 'reload' })).catch(err => {
            console.warn(`[Service Worker] Failed to cache ${url}: ${err}`);
            return Promise.resolve(); // Don't fail the whole install if one asset fails
          });
        })
      );
    })
  );
  self.skipWaiting();
});

// 2. Fetch Event: Serve offline page on network failure
// This now includes a cache-first strategy for other static assets
self.addEventListener('fetch', (event) => {
  console.log(`[Service Worker] Fetching: ${event.request.url}`);
  const isNavigate = event.request.mode === 'navigate';
  const isLocalAsset = event.request.url.startsWith(self.location.origin) ||
                       event.request.url.startsWith('https://cdn.tailwindcss.com') ||
                       event.request.url.startsWith('https://cdnjs.cloudflare.com') ||
                       event.request.url.startsWith('https://fonts.googleapis.com');

  if (isNavigate) {
    event.respondWith(
      fetch(event.request).catch(() => {
        console.log('[Service Worker] Network failed for navigation, serving offline page.');
        return caches.open(CACHE_NAME).then((cache) => {
          return cache.match(OFFLINE_URL);
        });
      })
    );
  } else if (isLocalAsset) {
    event.respondWith(
      caches.match(event.request).then((response) => {
        if (response) {
          console.log(`[Service Worker] Serving from cache: ${event.request.url}`);
          return response;
        }
        console.log(`[Service Worker] Fetching from network and caching: ${event.request.url}`);
        return fetch(event.request).then((fetchResponse) => {
          return caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, fetchResponse.clone());
            return fetchResponse;
          });
        }).catch((error) => {
          console.error(`[Service Worker] Fetch failed for ${event.request.url}: ${error}`);
          // For non-navigate requests, if network fails and not in cache, return a generic error response
          return new Response(null, { status: 503, statusText: 'Service Unavailable' });
        });
      })
    );
  }
  // For other requests (e.g., API calls, external images not in ASSETS_TO_CACHE),
  // let the browser handle them normally (network-only or default caching)
});

// 3. Push Notification Implementation
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : { title: 'New Message', body: 'You have a new update.' };

  const options = {
    body: data.body,
    icon: data.icon || '/img/logo.png',
    badge: '/img/logo.png', // Small icon for status bar
    vibrate: [100, 50, 100],
    data: {
      url: data.url || '/'
    }
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// 4. Handle Notification Click
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow(event.notification.data.url)
  );
});