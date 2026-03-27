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
                if (path === '/api/send-reg-otp') action = 'send-reg-otp';
                else if (path === '/api/forgot-password') action = 'forgot-password';
                else if (path === '/api/verify-otp') action = 'verify-otp';
                else if (path === '/api/reset-password') action = 'reset-password';
                else if (path === '/api/get_terms') action = 'get_terms';
                else if (path === '/api' || path === '/api/') action = 'dashboard_stats'; // Default for /api
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
                                    sender: { name: 'Maiga Social', email: 'admin@maigasocial.com' },
                                    to: [{ email: identity }],
                                    subject: 'Your Maiga Social Verification Code',
                                    htmlContent: `
                                        <!DOCTYPE html>
                                        <html>
                                        <head>
                                            <meta charset="utf-8">
                                            <meta name="viewport" content="width=device-width, initial-scale=1.0">
                                        </head>
                                        <body style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f3f4f6; margin: 0; padding: 0;">
                                            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f3f4f6; padding: 40px 20px;">
                                                <tr>
                                                    <td align="center">
                                                        <table width="100%" maxWidth="600" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px; background-color: #ffffff; border-radius: 16px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); overflow: hidden;">
                                                            <tr>
                                                                <td style="background-color: #4f46e5; padding: 20px; text-align: center;">
                                                                    <img src="/img/logo.png" alt="Maiga Social Logo" style="max-width: 150px; height: auto; display: block; margin: 0 auto;">
                                                                </td>
                                                            </tr>
                                                            <tr>
                                                                <td style="padding: 40px; text-align: left;">
                                                                    <h2 style="color: #111827; margin: 0 0 16px 0; font-size: 22px; font-weight: 700;">Verify your account</h2>
                                                                    <p style="color: #4b5563; font-size: 16px; line-height: 1.6; margin: 0 0 24px 0;">
                                                                        Thank you for joining Maiga Social. Use the verification code below to complete your registration process. This code is valid for the next <strong>5 minutes</strong>.
                                                                    </p>
                                                                    <div style="text-align: center; background-color: #f9fafb; border: 2px dashed #e5e7eb; border-radius: 12px; padding: 24px; margin-bottom: 24px;">
                                                                        <span style="display: block; font-size: 12px; text-transform: uppercase; letter-spacing: 2px; color: #6b7280; margin-bottom: 10px; font-weight: 600;">Your Verification Code</span>
                                                                        <span style="font-size: 42px; font-weight: 800; color: #4f46e5; letter-spacing: 10px;">${otp}</span>
                                                                    </div>
                                                                    <p style="color: #9ca3af; font-size: 14px; line-height: 1.5; margin: 0;">
                                                                        If you didn't request this, you can safely ignore this email. For your security, never share this code with anyone.
                                                                    </p>
                                                                </td>
                                                            </tr>
                                                            <tr>
                                                                <td style="padding: 20px 40px; background-color: #f9fafb; text-align: center; border-top: 1px solid #f3f4f6;">
                                                                    <p style="color: #9ca3af; font-size: 12px; margin: 0;">&copy; 2026 Maiga Social. All rights reserved.</p>
                                                                </td>
                                                            </tr>
                                                        </table>
                                                    </td>
                                                </tr>
                                            </table>
                                        </body>
                                        </html>`
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
                    const resetToken = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15); // Placeholder for a real token
                    const resetLink = `https://your-app-domain.com/reset-password?token=${resetToken}&email=${identity}`;

                    if (!identity) return new Response(JSON.stringify({ success: false, message: 'Identity missing' }), { status: 400 });

                    if (env.BREVO_API_KEY && identity) {
                        try {
                            await fetch('https://api.brevo.com/v3/smtp/email', {
                                method: 'POST',
                                headers: {
                                    'api-key': env.BREVO_API_KEY,
                                    'content-type': 'application/json'
                                },
                                body: JSON.stringify({
                                    sender: { name: 'Maiga Social', email: 'admin@maigasocial.com' },
                                    to: [{ email: identity }],
                                    subject: 'Reset Your Maiga Social Password',
                                    htmlContent: `
                                        <!DOCTYPE html>
                                        <html>
                                        <head>
                                            <meta charset="utf-8">
                                            <meta name="viewport" content="width=device-width, initial-scale=1.0">
                                        </head>
                                        <body style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f3f4f6; margin: 0; padding: 0;">
                                            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f3f4f6; padding: 40px 20px;">
                                                <tr>
                                                    <td align="center">
                                                        <table width="100%" maxWidth="600" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px; background-color: #ffffff; border-radius: 16px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); overflow: hidden;">
                                                            <tr>
                                                                <td style="background-color: #4f46e5; padding: 20px; text-align: center;">
                                                                    <img src="YOUR_LOGO_URL_HERE" alt="Maiga Social Logo" style="max-width: 150px; height: auto; display: block; margin: 0 auto;">
                                                                </td>
                                                            </tr>
                                                            <tr>
                                                                <td style="padding: 40px; text-align: left;">
                                                                    <h2 style="color: #111827; margin: 0 0 16px 0; font-size: 22px; font-weight: 700;">Password Reset Request</h2>
                                                                    <p style="color: #4b5563; font-size: 16px; line-height: 1.6; margin: 0 0 24px 0;">
                                                                        We received a request to reset the password for your Maiga Social account.
                                                                        If you made this request, please click the button below to set a new password:
                                                                    </p>
                                                                    <div style="text-align: center; margin-bottom: 24px;">
                                                                        <a href="${resetLink}" style="display: inline-block; padding: 12px 24px; background-color: #4f46e5; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600;">Reset Password</a>
                                                                    </div>
                                                                    <p style="color: #9ca3af; font-size: 14px; line-height: 1.5; margin: 0;">
                                                                        If you didn't request a password reset, you can safely ignore this email. Your password will not be changed.
                                                                    </p>
                                                                </td>
                                                            </tr>
                                                            <tr>
                                                                <td style="padding: 20px 40px; background-color: #f9fafb; text-align: center; border-top: 1px solid #f3f4f6;">
                                                                    <p style="color: #9ca3af; font-size: 12px; margin: 0;">&copy; 2026 Maiga Social. All rights reserved.</p>
                                                                </td>
                                                            </tr>
                                                        </table>
                                                    </td>
                                                </tr>
                                            </table>
                                        </body>
                                        </html>`
                                })
                            });
                        } catch (e) {
                            console.error(`[BREVO NETWORK ERROR] Could not reach Brevo API for password reset: ${e.message}`);
                        }
                    }

                    // In a real application, you would store the resetToken in a database
                    // associated with the user's email and set an expiration time.
                    return new Response(JSON.stringify({ success: true, message: `If an account with ${identity} exists, a password reset link has been sent.` }), { headers: { 'Content-Type': 'application/json' } });
                }
                case 'verify-otp': {
                    const { identity, otp } = body; // Expect identity and otp from frontend

                    if (!identity || !otp) {
                        return new Response(JSON.stringify({ success: false, message: 'Identity and OTP are required.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
                    }

                    const storedOtp = env.KV ? await env.KV.get(`otp:${identity}`) : null;
                    
                    if (!env.KV && otp === '123456') { // Fallback if KV not deployed
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
                        const backendResponse = await fetch(backendRequest);
                        if (!backendResponse.ok) {
                            console.error(`[Backend Proxy Error] Status: ${backendResponse.status}, URL: ${backendRequest.url}, Response: ${await backendResponse.text()}`);
                        }
                        return backendResponse;
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