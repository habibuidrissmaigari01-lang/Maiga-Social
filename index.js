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
        // We now also proxy app routes and sensitive files so the backend can enforce access control
        const isProxyRequest = 
            path === '/' ||
            path === '/index.html' ||
            path.startsWith('/api') || 
            path.startsWith('/socket.io') || 
            request.headers.get('Upgrade') === 'websocket' ||
            ['/home', '/maiga', '/maiga.js', '/offline.html', '/admin'].includes(path);

        if (isProxyRequest) {
            if (!env.BACKEND_URL) return jsonError('Backend URL not configured in Worker environment.', 502);

            const backendUrl = new URL(env.BACKEND_URL);
            
            // Prevent infinite loops: Ensure we aren't proxying to the same domain
            if (backendUrl.hostname === url.hostname && !env.BACKEND_URL.includes('localhost')) {
                return jsonError('Proxy Loop Detected: BACKEND_URL cannot be the same as the Worker domain.', 502);
            }

            // Construct the target URL. 
            // We use the hostname and port from BACKEND_URL but keep the original request's path and query.
            const target = new URL(request.url);
            target.protocol = backendUrl.protocol;
            target.host = backendUrl.host;

            try {
                const headers = new Headers(request.headers);

                // Render ingress requires the Host header to match the assigned service domain (e.g., xxx.onrender.com)
                // We set this to the backend host to ensure Render routes the request to your application.
                headers.set('Host', backendUrl.hostname); 
                headers.set('X-Forwarded-Host', url.host);
                headers.set('X-Forwarded-Proto', 'https');
                headers.set('X-Real-IP', request.headers.get('cf-connecting-ip') || '');
                
                // Ensure WebSocket headers are preserved for the handshake
                if (request.headers.get('Upgrade') === 'websocket') {
                    headers.set('Connection', 'Upgrade');
                }

                const backendRequest = new Request(target.toString(), {
                    method: request.method,
                    headers: headers,
                    body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : null,
                    redirect: 'follow'
                });

                const response = await fetch(backendRequest);
                if (response.status >= 500) return jsonError(`Backend Error (${response.status})`, response.status);
                return response;
            } catch (err) {
                return jsonError(`Backend unreachable (${err.message}). Check if Render service is running.`, 502);
            }
        } else {
            // Serve static assets
            // The ASSETS binding is automatically available in the Worker environment
            // and handles requests for static files from the 'public' directory.
            // For specific HTML files, we can redirect or serve directly if needed.
           if (path === '/ysu') {
                return env.ASSETS.fetch(new Request(new URL('/ysu.html', request.url), request));
            }
            return env.ASSETS.fetch(request);
        }
    },
};