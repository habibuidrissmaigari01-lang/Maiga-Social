const ASSETS_TO_CACHE = [
  '/offline.html',
  '/', // Main entry point for Maiga
  '/index.html', 
  '/ysu.html',
  '/maiga.js',
  '/alpine.js',
  '/sw.js',
  '/manifest-maiga.json',
  '/manifest-ysu.json',
  '/img/logo.png',
  '/img/ysu.png',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
  '/fonts/inter-regular.woff2',
  '/fonts/IntelOneMono-Regular.woff2',
  '/fonts/IntelOneMono-Bold.woff2',
  '/fonts/IntelOneMono-Italic.woff2',
  '/fonts/IntelOneMono-BoldItalic.woff2',
];

// Extract the app type from the registration URL (e.g., /sw.js?app=ysu)
const urlParams = new URL(self.location).searchParams;
const APP_TYPE = urlParams.get('app') || 'maiga'; 

const CACHE_NAME = `${APP_TYPE}-offline-v5`;
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
    }
  }
}

// 7. Handle manual update skipping
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// 1. Install Event: Cache the offline page
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Use Promise.all to ensure all assets are attempted to be cached
      return Promise.all(
        ASSETS_TO_CACHE.map(url => {
          return cache.add(new Request(url, { cache: 'reload' })).catch(err => {
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
  // Only attempt to cache GET requests. POST/PUT/DELETE are not supported by Cache API.
  if (event.request.method !== 'GET') return;

  const isNavigate = event.request.mode === 'navigate';
  const isApi = event.request.url.includes('/api/');
  // Fix: Explicitly ignore Tailwind CDN to avoid CORS fetch errors in SW
  if (event.request.url.includes('cdn.tailwindcss.com')) return;

  const isLocalAsset = event.request.url.startsWith(self.location.origin) ||
                       (event.request.url.startsWith('https://cdnjs.cloudflare.com') && !isApi) ||
                       event.request.url.startsWith('https://fonts.googleapis.com') ||
                       event.request.url.startsWith('https://fonts.gstatic.com') ||
                       event.request.url.startsWith('https://api.dicebear.com');

  if (isNavigate || (isLocalAsset && !isApi)) {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) => {
        return cache.match(event.request).then((cachedResponse) => {
          const fetchPromise = fetch(event.request).then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              cache.put(event.request, networkResponse.clone());
            }
            return networkResponse;
          });
          
          // Serve cached response immediately if found, but update it in the background.
          // This provides an "instant" feel on reload while keeping the app current.
          return cachedResponse || fetchPromise;
        }).catch(() => {
          if (isNavigate) return cache.match(OFFLINE_URL);
          return new Response(null, { status: 503 });
        });
      })
    );
  }
  // For other requests (e.g., API calls, external images not in ASSETS_TO_CACHE),
  // let the browser handle them normally (network-only or default caching)
});

// 4. Push Notification Implementation
self.addEventListener('push', (event) => {
  let data = { title: 'New Message', body: 'You have a new update.' };
  if (event.data) {
    try {
      data = event.data.json();
    } catch (err) {
      const text = event.data.text();
      data = { title: 'New Message', body: text || 'You have a new update.' };
    }
  }

  const options = {
    body: data.body,
    icon: data.icon || (APP_TYPE === 'ysu' ? '/img/ysu-logo.jpg' : '/img/logo.png'),
    badge: APP_TYPE === 'ysu' ? '/img/ysu-logo.jpg' : '/img/logo.png', // Small icon for status bar
    vibrate: data.vibrate || [200, 100, 200],
    tag: data.tag || 'maiga-notification',
    renotify: true, // Buzz the phone even if a notification with this tag is already visible
    requireInteraction: data.requireInteraction || false,
    actions: data.actions || [],
    data: {
      url: data.data?.url || data.url || '/',
      type: data.data?.type || 'message',
      callId: data.data?.callId,
      callerId: data.data?.callerId
    }
  };

  // If it's a call, signal open tabs to play the ringtone
  if (options.data.type === 'call') {
    event.waitUntil(
      self.clients.matchAll({ type: 'window' }).then(clients => {
        clients.forEach(client => client.postMessage({ type: 'PLAY_CALL_RINGTONE' }));
      })
    );
  }

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// 5. Handle Notification Click
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const notificationData = event.notification.data;

  if (event.action === 'decline') {
    event.waitUntil(
      fetch('/api/reject_call_background', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callId: notificationData.callId, callerId: notificationData.callerId })
      })
    );
    return;
  }

  let targetUrl = notificationData.url;
  if (event.action === 'answer') {
    targetUrl += '&autoAnswer=true';
  }

  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(windowClients => {
      // Try to focus an existing window first
      for (var i = 0; i < windowClients.length; i++) {
        var client = windowClients[i];
        if (client.url.includes('/home') && 'focus' in client) {
          return client.focus().then(c => c.navigate(targetUrl));
        }
      }
      // If no window is open, open a new one
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});

// 6. Periodic Background Sync: Refresh data in the background
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'refresh-feed') {
    event.waitUntil(async function() {
      const cache = await caches.open(CACHE_NAME);
      try {
        // Fetch fresh posts and update the cache
        const response = await fetch('/api/get_posts?page=1');
        if (response.ok) {
          await cache.put('/api/get_posts?page=1', response.clone());
        }
      } catch (err) { }
    }());
  }
});