// index.js (Cloudflare Worker entry point)

export default {
    async fetch(request, env, ctx) {
        const jsonError = (message, status = 502) => {
            return new Response(JSON.stringify({ error: message, success: false }), {
                status,
                headers: { 'Content-Type': 'application/json' }
            });
        };

        const url = new URL(request.url);
        let path = url.pathname;

        // Handle favicon to prevent 404 console errors
        if (path === '/favicon.ico') {
            return new Response(null, { status: 204 });
        }
        
        // Handle WebSocket Proxying and Socket.io long-polling
        if (path.startsWith('/socket.io') || request.headers.get('Upgrade') === 'websocket') {
            if (!env.BACKEND_URL) return jsonError('Backend not configured.', 502);

            // Defensive: Remove trailing slashes and accidentally included internal ports
            const target = env.BACKEND_URL.replace(/\/$/, '').replace(/:3000$/, '') + path + url.search;
            try {
                return await fetch(new Request(target, request));
            } catch (e) {
                return jsonError('WebSocket Proxy Error', 502);
            }
        }

        if (path.startsWith('/api')) {
            // PROXY ALL API REQUESTS TO RAILWAY BACKEND
            if (!env.BACKEND_URL) return jsonError('Backend not configured.', 502);

            // Defensive: Ensure we hit the public HTTPS edge, not the internal port
            const target = env.BACKEND_URL.replace(/\/$/, '').replace(/:3000$/, '') + path + url.search;
            console.log(`Proxying request to: ${target}`);

            try {
                const backendRequest = new Request(target, {
                    method: request.method,
                    headers: new Headers(request.headers),
                    body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : null,
                    redirect: 'manual' // Let the browser handle redirects
                });

                const response = await fetch(backendRequest);
                // Intercept HTML error pages from Railway and return JSON instead
                if (response.status >= 500) return jsonError(`Backend Error (${response.status})`, response.status);
                return response;
            } catch (err) {
                console.error(`Proxy Error: ${err.message} | Target: ${target}`);
                return jsonError('Backend unreachable. Check if Railway service is running.', 502);
            }
        } else {
            // Serve static assets
            // The ASSETS binding is automatically available in the Worker environment
            // and handles requests for static files from the 'public' directory.
            // For specific HTML files, we can redirect or serve directly if needed.
            if (path === '/' || path === '/index.html') {
                return env.ASSETS.fetch(new Request(new URL('/index.html', request.url), request));
            } else if (path === '/ysu') {
                return env.ASSETS.fetch(new Request(new URL('/ysu.html', request.url), request));
            } else if (path === '/home') {
                return env.ASSETS.fetch(new Request(new URL('/maiga.html', request.url), request));
            } else if (path === '/admin') {
                return env.ASSETS.fetch(new Request(new URL('/admin.html', request.url), request));
            }

            // Fallback to serving other static assets
            return env.ASSETS.fetch(request);
        }
    },
};