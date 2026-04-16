const ASSETS_TO_CACHE = [
  '/offline.html',
  '/', // Main entry point for Maiga
  '/maiga.html',
  '/index.html',
  '/ysu.html',
  '/maiga.js',
  '/alpine.js',
  '/sw.js',
  '/manifest-maiga.json',
  '/manifest-ysu.json',
  '/img/logo.png',
  '/img/ysu.png',
  '/img/male.png',
  '/img/female.png',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
  '/fonts/Inter-Regular.woff2',
  '/font/Inter-Regular.woff2',
  '/fonts/Inter-Regular.woff2',
  '/fonts/IntelOneMono-Regular.woff2',
  '/fonts/IntelOneMono-Bold.woff2',
  '/fonts/IntelOneMono-Italic.woff2',
  '/fonts/IntelOneMono-BoldItalic.woff2',
];

const API_CACHE_NAME = 'maiga-api-cache-v1';
// Extract the app type from the registration URL (e.g., /sw.js?app=ysu)
const urlParams = new URL(self.location).searchParams;
const APP_TYPE = urlParams.get('app') || 'maiga'; 

const CACHE_NAME = `${APP_TYPE}-offline-v5`;
const OFFLINE_URL = '/offline.html';
const DB_NAME = 'maiga_crypto';
const STORE_NAME = 'pending_messages';

// Helper: Check IndexedDB for persistent session marker
async function isSessionPersistent() {
  return new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, 3);
    request.onsuccess = () => {
      const db = request.result;
      try {
        const tx = db.transaction('keys', 'readonly');
        const store = tx.objectStore('keys');
        const getReq = store.get('persistent_session');
        getReq.onsuccess = () => resolve(!!getReq.result?.value);
        getReq.onerror = () => resolve(false);
      } catch (e) { resolve(false); }
    };
    request.onerror = () => resolve(false);
  });
}

// List of essential assets to pre-cache

// 6. Background Sync: Send messages when connection is restored
self.addEventListener('sync', (event) => {
  if (event.tag === 'send-pending-messages') {
    event.waitUntil(sendPendingMessages());
  }
  if (event.tag === 'send-pending-posts') {
    event.waitUntil(sendPendingPosts());
  }
});

async function sendPendingMessages() {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 3);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  const tx = db.transaction(STORE_NAME, 'readonly');
  const store = tx.objectStore(STORE_NAME);
  const messages = await new Promise(res => {
    const req = store.getAll();
    req.onsuccess = () => res(req.result);
  });
  
  if (messages.length > 0) {
    self.clients.matchAll().then(clients => {
      clients.forEach(c => c.postMessage({ type: 'SYNC_START', total: messages.length, store: 'messages' }));
    });
  }

  let processed = 0;
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
        processed++;
        // Notify clients that this message is no longer pending
        self.clients.matchAll().then(clients => {
          clients.forEach(c => c.postMessage({ type: 'SYNC_PROGRESS', current: processed, total: messages.length, store: 'messages', id: msg.id }));
        });
      } else if (response.status === 401 || response.status === 403) {
        // Session expired or CSRF invalid - notify app to prompt re-login/refresh
        self.clients.matchAll().then(clients => {
          clients.forEach(c => c.postMessage({ type: 'SYNC_ERROR', status: response.status }));
        });
        return; // Stop trying to send further items this session
      }
    } catch (err) {
    }
  }
}

async function sendPendingPosts() {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 3);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  const tx = db.transaction('pending_posts', 'readonly');
  const store = tx.objectStore('pending_posts');
  const posts = await new Promise(res => {
    const req = store.getAll();
    req.onsuccess = () => res(req.result);
  });

  if (posts.length > 0) {
    self.clients.matchAll().then(clients => {
      clients.forEach(c => c.postMessage({ type: 'SYNC_START', total: posts.length, store: 'posts' }));
    });
  }

  let processed = 0;
  for (const post of posts) {
    const formData = new FormData();
    formData.append('content', post.content);
    formData.append('feeling', post.feeling);
    if (post.file) formData.append('media', post.file);

    try {
      const response = await fetch('/api/create_post', {
        method: 'POST',
        body: formData,
        headers: { 'X-CSRF-Token': post.csrfToken }
      });

      if (response.ok) {
        const delTx = db.transaction('pending_posts', 'readwrite');
        delTx.objectStore('pending_posts').delete(post.id);
        processed++;
        // Notify clients that this post is no longer pending
        self.clients.matchAll().then(clients => {
          clients.forEach(c => c.postMessage({ type: 'SYNC_PROGRESS', current: processed, total: posts.length, store: 'posts', id: post.id }));
        });
      } else if (response.status === 401 || response.status === 403) {
        self.clients.matchAll().then(clients => {
          clients.forEach(c => c.postMessage({ type: 'SYNC_ERROR', status: response.status }));
        });
        return;
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
  if (event.data && event.data.type === 'MANUAL_SYNC') {
    event.waitUntil(Promise.all([
      sendPendingMessages(),
      sendPendingPosts()
    ]));
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
             if (cacheName !== CACHE_NAME && cacheName !== API_CACHE_NAME) {
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
  
  // SPEED OPTIMIZATION: Bypass SW for Video/Audio streams (R2 URLs)
  // Service Workers often throttle large media chunks. Direct browser handling is faster.
  if (event.request.url.match(/\.(mp4|webm|ogg|mp3|wav)$/) || event.request.url.includes('r2.dev') || event.request.url.includes('public_url')) return;

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
        if (isNavigate) {
          return Promise.all([
            cache.match('/auth-session-active'),
            isSessionPersistent()
          ]).then(async ([sessionMarker, isPersistent]) => {
            if (sessionMarker || isPersistent) {
              // Custom Splash Timeout: Delay by 1s to match app boot time
              await new Promise(r => setTimeout(r, 1000));
              const shell = await cache.match('/maiga.html');
              if (shell) return shell;
            }
            return fetch(event.request);
          }).catch(() => fetch(event.request));
        }

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
 
  // API GET requests: Network-first, fallback to cache for offline feed access
  if (isApi && event.request.method === 'GET') {
    event.respondWith(
      fetch(event.request)
        .then(async (response) => {
          if (response && response.status === 200) {
            const cache = await caches.open(API_CACHE_NAME);
            cache.put(event.request, response.clone());
          }
          return response;
        })
        .catch(async () => {
          const cache = await caches.open(API_CACHE_NAME);
          return cache.match(event.request) || new Response(JSON.stringify({ error: 'Offline' }), { status: 503 });
        })
    );
  }
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
    vibrate: [200, 100, 200], // Stronger haptic feedback
    tag: data.tag || 'maiga-notification', // Groups similar notifications
    renotify: true, // Buzz the phone even if a notification with this tag is already visible
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