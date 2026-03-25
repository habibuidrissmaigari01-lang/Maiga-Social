// Advanced Service Worker for Maiga/YSU Social

const getAppType = () => {
  const params = new URL(self.location.href).searchParams;
  return params.get('app') || 'maiga';
};

const APP_TYPE = getAppType();
const CACHE_NAME = `maiga-social-${APP_TYPE}-v1`;

// Base assets common to both versions
const COMMON_ASSETS = [
  '/alpine.js',
  '/maiga.js',
  'https://cdn.tailwindcss.com',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap'
];

// App specific assets
const APP_ASSETS = APP_TYPE === 'ysu' 
  ? ['/ysu', '/manifest-ysu.json', '/img/ysu-logo.jpg'] 
  : ['/', '/manifest-maiga.json', '/img/logo.png'];

const ASSETS_TO_CACHE = [...COMMON_ASSETS, ...APP_ASSETS];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Cache resources individually to prevent one error from stopping installation
      return Promise.all(
        ASSETS_TO_CACHE.map(url => {
          // For external CDNs, use no-cors to avoid CORS errors
          const request = url.startsWith('http') ? new Request(url, { mode: 'no-cors' }) : url;
          return fetch(request)
            .then(response => cache.put(request, response))
            .catch(err => console.warn(`Failed to cache: ${url}`, err));
        })
      );
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});

self.addEventListener('push', function(event) {
  const data = event.data.json();
  
  const options = {
    body: data.body,
    icon: data.icon || '/img/logo.png',
    badge: '/img/logo.png',
    data: { url: data.url }
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  if (event.notification.data.url) {
    event.waitUntil(
      clients.openWindow(event.notification.data.url)
    );
  }
});

self.addEventListener('fetch', function(event) {
  event.respondWith(
    caches.match(event.request).then(function(response) {
      if (response) return response;

      return fetch(event.request).then(function(response) {
        // Dynamically cache the main app page only when accessed successfully (logged in)
        if (event.request.method === 'GET' && response.status === 200) {
           const url = new URL(event.request.url);
           if (url.pathname === '/maiga') {
               const responseClone = response.clone();
               caches.open(CACHE_NAME).then(cache => cache.put(event.request, responseClone));
           }
        }
        return response;
      }).catch(function() {
        // Fallback for navigation requests to the main app page if offline
        if (event.request.mode === 'navigate') {
           return caches.match(APP_TYPE === 'ysu' ? '/ysu' : '/');
        }
      });
    })
  );
});
