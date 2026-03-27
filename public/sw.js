// Extract the app type from the registration URL (e.g., /sw.js?app=ysu)
const urlParams = new URL(self.location).searchParams;
const APP_TYPE = urlParams.get('app') || 'maiga'; 

const CACHE_NAME = `${APP_TYPE}-offline-v1`;
const OFFLINE_URL = '/offline.html';
const DB_NAME = 'maiga_crypto';
const STORE_NAME = 'pending_messages';

// List of essential assets to pre-cache

// 6. Background Sync: Send messages when connection is restored
self.addEventListener('sync', (event) => {
  if (event.tag === 'send-pending-messages') {
    event.waitUntil(sendPendingMessages());
  }
});

async function sendPendingMessages() {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  const tx = db.transaction(STORE_NAME, 'readonly');
  const store = tx.objectStore(STORE_NAME);
  const messages = await new Promise(res => {
    const req = store.getAll();
    req.onsuccess = () => res(req.result);
  });

  for (const msg of messages) {
    const formData = new FormData();
    formData.append('content', msg.content);
    formData.append('media_type', msg.media_type);
    if (msg.is_group) formData.append('group_id', msg.chat_id);
    else formData.append('receiver_id', msg.chat_id);
    if (msg.reply_to_id) formData.append('reply_to_id', msg.reply_to_id);

    try {
      const response = await fetch('/api/send_message', {
        method: 'POST',
        body: formData
      });
      if (response.ok) {
        const delTx = db.transaction(STORE_NAME, 'readwrite');
        delTx.objectStore(STORE_NAME).delete(msg.id);
      }
    } catch (err) {
      console.error('[SW] Sync failed for message', msg.id, err);
    }
  }
}

// 7. Handle manual update skipping
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
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

// 2. Activate Event: Clean up old caches and take control immediately
self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      // Take control of all open tabs/clients immediately
      self.clients.claim(),
      // Delete any caches that don't match the current CACHE_NAME
      caches.keys().then((cacheNames) => {
        return Promise.all(
          cacheNames.map((cacheName) => {
            if (cacheName !== CACHE_NAME) {
              console.log('[Service Worker] Deleting old cache:', cacheName);
              return caches.delete(cacheName);
            }
          })
        );
      })
    ])
  );
});

// 3. Fetch Event: Serve offline page on network failure
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

// 4. Push Notification Implementation
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : { title: 'New Message', body: 'You have a new update.' };

  const options = {
    body: data.body,
    icon: data.icon || (APP_TYPE === 'ysu' ? '/img/ysu-logo.jpg' : '/img/logo.png'),
    badge: APP_TYPE === 'ysu' ? '/img/ysu-logo.jpg' : '/img/logo.png', // Small icon for status bar
    vibrate: [100, 50, 100],
    data: {
      url: data.url || '/'
    }
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// 5. Handle Notification Click
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow(event.notification.data.url)
  );
});