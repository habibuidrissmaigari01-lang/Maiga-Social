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

        // Determine if this is an API or Socket.io request that needs proxying
        const isProxyRequest = path.startsWith('/api') || path.startsWith('/socket.io') || request.headers.get('Upgrade') === 'websocket';

        if (isProxyRequest) {
            if (!env.BACKEND_URL) return jsonError('Backend URL not configured in Worker environment.', 502);

            const backendUrl = new URL(env.BACKEND_URL);
            
            // Prevent infinite loops: Ensure we aren't proxying to the same domain
            if (backendUrl.hostname === url.hostname) {
                return jsonError('Proxy Loop Detected: BACKEND_URL cannot be the same as the Worker domain.', 502);
            }

            // Construct the target URL. Use HTTPS for production Railway targets.
            const protocol = backendUrl.protocol || 'https:';
            const target = `${protocol}//${backendUrl.host.replace(/:3000$/, '')}${path}${url.search}`;

            try {
                const headers = new Headers(request.headers);
                
                // Railway ingress requires the Host header to match the assigned domain (e.g., xxx.up.railway.app)
                // We strip the port to ensure it hits the public edge correctly.
                headers.set('Host', backendUrl.hostname); 
                headers.set('X-Forwarded-Host', url.host);
                headers.set('X-Real-IP', request.headers.get('cf-connecting-ip') || '');

                // For WebSockets, we must use the original request to preserve the upgrade handshake
                if (request.headers.get('Upgrade') === 'websocket') {
                    return await fetch(target, {
                        method: request.method,
                        headers: headers
                    });
                }

                const backendRequest = new Request(target, {
                    method: request.method,
                    headers: headers,
                    body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : null,
                    redirect: 'follow'
                });

                const response = await fetch(backendRequest);
                if (response.status >= 500) return jsonError(`Backend Error (${response.status})`, response.status);
                return response;
            } catch (err) {
                return jsonError(`Backend unreachable (${err.message}). Check if Railway service is running.`, 502);
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