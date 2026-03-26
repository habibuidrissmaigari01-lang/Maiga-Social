// index.js (Cloudflare Worker entry point)

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        let path = url.pathname;

        // Handle favicon to prevent 404 console errors
        if (path === '/favicon.ico') {
            return new Response(null, { status: 204 });
        }
        
        // Handle WebSocket Proxying and Socket.io long-polling
        if (path.startsWith('/socket.io') || request.headers.get('Upgrade') === 'websocket') {
            if (env.BACKEND_URL) {
                const socketRequest = new Request(env.BACKEND_URL + path + url.search, request);
                return fetch(socketRequest);
            }
        }

        if (path.startsWith('/api')) {
            let action = url.searchParams.get('action');
            
            // Map path-based routes used by the frontend to internal actions
            if (!action) {
                if (path === '/api/login') action = 'login';
                else if (path === '/api/register') action = 'register';
                else if (path === '/api/send-reg-otp') action = 'send-reg-otp';
                else if (path === '/api/update_profile') action = 'update_profile';
                else if (path === '/api/forgot-password') action = 'forgot-password';
                else if (path === '/api/verify-otp') action = 'verify-otp';
                else if (path === '/api/reset-password') action = 'reset-password';
                else if (path === '/api/check_username') action = 'check_username';
                else if (path === '/api/get_terms') action = 'get_terms';
                else if (path === '/api') action = 'dashboard_stats'; // Default for /api
            }

            // Parse body only if needed for edge actions (OTP)
            let body = {};
            const contentType = request.headers.get("content-type") || "";
            if (request.method === 'POST' && contentType.includes("application/json")) {
                try { body = await request.clone().json(); } catch (e) { body = {}; }
            }

            switch (action) {
                case 'get_terms':
                    return new Response(JSON.stringify({ content: 'These are your site terms and conditions.' }), { headers: { 'Content-Type': 'application/json' } });
                
                case 'send-reg-otp': {
                    const otp = Math.floor(100000 + Math.random() * 900000).toString();
                    const identity = body.identity;

                    if (!identity) return new Response(JSON.stringify({ success: false, message: 'Identity missing' }), { status: 400 });
                    
                    console.log(`[OTP DEBUG] Sending code ${otp} to ${identity}`);

                    if (env.BREVO_API_KEY && identity) { // Ensure identity is not empty for sending email
                        try {
                            await fetch('https://api.brevo.com/v3/smtp/email', {
                                method: 'POST',
                                headers: {
                                    'api-key': env.BREVO_API_KEY,
                                    'content-type': 'application/json'
                                },
                                body: JSON.stringify({
                                    sender: { name: 'Maiga Social', email: 'no-reply@yourdomain.com' },
                                    to: [{ email: identity }],
                                    subject: 'Your Verification Code',
                                    textContent: `Your Maiga Social verification code is: ${otp}`
                                })
                            });
                        } catch (e) {
                            console.error(`[BREVO NETWORK ERROR] Could not reach Brevo API: ${e.message}`);
                        }
                    }

                    // Store OTP in KV with an expiration (e.g., 5 minutes = 300 seconds)
                    if (env.KV) {
                        await env.KV.put(`otp:${identity}`, otp, { expirationTtl: 300 });
                    }

                    return new Response(JSON.stringify({ 
                        success: true, 
                        message: `OTP sent to ${identity}.` 
                    }), { headers: { 'Content-Type': 'application/json' } });
                }
                case 'forgot-password': {
                    const identity = body.forgot_identity || 'user';
                    return new Response(JSON.stringify({ success: true, message: `Account found. Code sent to ${identity}.` }), { headers: { 'Content-Type': 'application/json' } });
                }
                case 'verify-otp': {
                    const { identity, otp } = body; // Expect identity and otp from frontend

                    if (!identity || !otp) {
                        return new Response(JSON.stringify({ success: false, message: 'Identity and OTP are required.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
                    }

                    const storedOtp = env.KV ? await env.KV.get(`otp:${identity}`) : null;
                    
                    if (!env.KV && body.otp === '123456') { // Fallback if KV not deployed
                         return new Response(JSON.stringify({ success: true, message: 'OTP Verified (Dev Mode).' }), { headers: { 'Content-Type': 'application/json' } });
                    }

                    if (!storedOtp) {
                        return new Response(JSON.stringify({ success: false, message: 'OTP expired or not found. Please request a new one.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
                    }

                    if (storedOtp === otp) {
                        await env.KV.delete(`otp:${identity}`);
                        return new Response(JSON.stringify({ success: true, message: 'OTP Verified.' }), { headers: { 'Content-Type': 'application/json' } });
                    } else {
                        return new Response(JSON.stringify({ success: false, message: 'Invalid OTP.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
                    }
                }
                default: {
                    // PROXY ALL OTHER REQUESTS TO MONGODB BACKEND
                    if (env.BACKEND_URL) {
                        const backendRequest = new Request(env.BACKEND_URL + path + url.search, {
                            method: request.method,
                            headers: request.headers,
                            body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : null,
                            redirect: 'follow'
                        });
                        return await fetch(backendRequest);
                    }
                    
                    return new Response(JSON.stringify({ error: `Action '${action}' not found and no backend configured.` }), { status: 404, headers: { 'Content-Type': 'application/json' } });
                }
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