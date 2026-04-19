const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const fs = require('fs');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const FacebookStrategy = require('passport-facebook').Strategy;
const { body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const { exec } = require('child_process');
const { User, Otp, Setting, Log } = require('../../models');

// --- Passport Google Strategy ---
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    passport.use(new GoogleStrategy({
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: "/api/auth/google/callback",
        proxy: true,
        passReqToCallback: true
    }, async (req, accessToken, refreshToken, profile, done) => {
        try {
            let user = await User.findOne({ $or: [{ googleId: profile.id }, { email: profile.emails[0].value.toLowerCase() }] });
            if (user) {
                if (!user.googleId) { user.googleId = profile.id; await user.save(); }
                await Log.create({
                    user: user._id,
                    action: 'LOGIN_GOOGLE',
                    details: `User ${user.username} logged in via Google.`,
                    ip: req.ip
                });
                return done(null, user);
            }
            user = await User.create({
                googleId: profile.id,
                name: profile.displayName,
                email: profile.emails[0].value.toLowerCase(),
                avatar: profile.photos?.[0]?.value,
                username: profile.emails[0].value.split('@')[0] + Math.floor(Math.random() * 1000),
                account_type: 'maiga'
            });
            await Log.create({
                user: user._id,
                action: 'REGISTER_GOOGLE',
                details: `New user ${user.username} registered via Google.`,
                ip: req.ip
            });
            done(null, user);
        } catch (err) { done(err, null); }
    }));
}

// --- Passport Facebook Strategy ---
if (process.env.FACEBOOK_CLIENT_ID && process.env.FACEBOOK_CLIENT_SECRET) {
    passport.use(new FacebookStrategy({
        clientID: process.env.FACEBOOK_CLIENT_ID,
        clientSecret: process.env.FACEBOOK_CLIENT_SECRET,
        callbackURL: "/api/auth/facebook/callback",
        proxy: true,
        profileFields: ['id', 'displayName', 'photos', 'email'],
        passReqToCallback: true
    }, async (req, accessToken, refreshToken, profile, done) => {
        try {
            let user = await User.findOne({ $or: [{ facebookId: profile.id }, { email: profile.emails?.[0]?.value?.toLowerCase() }] });
            if (user) {
                if (!user.facebookId) { user.facebookId = profile.id; await user.save(); }
                await Log.create({
                    user: user._id,
                    action: 'LOGIN_FACEBOOK',
                    details: `User ${user.username} logged in via Facebook.`,
                    ip: req.ip
                });
                return done(null, user);
            }
            user = await User.create({
                facebookId: profile.id,
                name: profile.displayName,
                email: profile.emails?.[0]?.value?.toLowerCase(),
                avatar: profile.photos?.[0]?.value, // Facebook profile photos might be an array
                username: profile.displayName.replace(/\s+/g, '_').toLowerCase() + Math.floor(Math.random() * 1000),
                account_type: 'maiga'
            });
            await Log.create({
                user: user._id,
                action: 'REGISTER_FACEBOOK',
                details: `New user ${user.username} registered via Facebook.`,
                ip: req.ip
            });
            done(null, user);
        } catch (err) { done(err, null); }
    }));
}

// Brute-force protection for the login route
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10, // Limit each IP to 10 login requests per window
    message: { message: 'Too many login attempts from this IP, please try again after 15 minutes.' },
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

// Brute-force protection for OTP request routes
const otpRequestLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 3, // Limit each IP to 3 OTP requests per window
    message: { message: 'Too many OTP requests from this IP, please try again after 5 minutes.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// Brute-force protection for OTP verification routes
const otpVerificationLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // Limit each IP to 5 OTP verification attempts per window
    message: { message: 'Too many OTP verification attempts from this IP, please try again after 15 minutes.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// Helper Email Function
async function sendEmail(to, subject, text) {

    const codeMatch = text.match(/\d{6}/);
    const code = codeMatch ? codeMatch[0] : '';
    const cleanText = text.replace(code, '').replace(':', '').trim();

    try {
        const response = await fetch('https://api.brevo.com/v3/smtp/email', {
            method: 'POST',
            headers: {
                'api-key': process.env.BREVO_API_KEY,
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                sender: { 
                    name: 'Maiga Social', 
                    email: process.env.SENDER_EMAIL || 'admin@maiga.social' 
                },
                to: [{ email: to }],
                subject: subject,
                htmlContent: `
                    <!DOCTYPE html>
                    <html>
                    <body style="font-family: sans-serif; background-color: #f3f4f6; padding: 40px 20px;">
                        <table width="100%" maxWidth="600" style="max-width: 600px; background-color: #ffffff; margin: 0 auto; border-radius: 16px; overflow: hidden;">
                            <tr>
                                <td style="background-color: #4f46e5; padding: 20px; text-align: center; color: white;">
                                    <h1 style="margin: 0;">Maiga Social</h1>
                                </td>
                            </tr>
                            <tr>
                                <td style="padding: 40px;">
                                    <h2 style="color: #111827;">${subject}</h2>
                                    <p style="color: #4b5563; font-size: 16px;">${cleanText}</p>
                                    ${code ? `
                                    <div style="text-align: center; background-color: #f9fafb; border: 2px dashed #e5e7eb; border-radius: 12px; padding: 24px; margin: 24px 0;">
                                        <span style="font-size: 42px; font-weight: 800; color: #4f46e5; letter-spacing: 10px;">${code}</span>
                                    </div>` : ''}
                                    <p style="color: #9ca3af; font-size: 14px;">If you didn't request this, you can safely ignore this email.</p>
                                </td>
                            </tr>
                        </table>
                    </body>
                    </html>`
            })
        });

        if (!response.ok) { }
    } catch (err) { }
}

// --- OAuth Routes ---
router.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
router.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/' }), (req, res) => {
    req.session.userId = req.user._id.toString(); // Ensure session is set
    req.session.save(() => res.redirect('/home'));
});

router.get('/auth/facebook', passport.authenticate('facebook', { scope: ['email'] }));
router.get('/auth/facebook/callback', passport.authenticate('facebook', { failureRedirect: '/' }), (req, res) => {
    req.session.userId = req.user._id.toString(); // Ensure session is set
    req.session.save(() => res.redirect('/home'));
});

router.post('/send-reg-otp', otpRequestLimiter, async (req, res) => {
    const { identity } = req.body;
    if (!identity) return res.status(400).json({ success: false, message: 'Email or phone is required' });

    const existingUser = await User.findOne({ $or: [{ email: identity.toLowerCase() }, { phone: identity }] });
    if (existingUser) return res.status(400).json({ success: false, message: 'Account already exists.' });

    const existingOtp = await Otp.findOne({ identity: identity.toLowerCase(), type: 'registration' });
    const now = Date.now();
    const threeMinutes = 3 * 60 * 1000; // 3 minutes
    const tenMinutes = 10 * 60 * 1000; // 10 minutes

    if (existingOtp) {
        const timePassed = now - existingOtp.createdAt.getTime();
        // Case 1: Still within the initial 3-minute cooldown
        if (timePassed < threeMinutes) {
            const remaining = Math.ceil((threeMinutes - timePassed) / 1000);
            return res.status(429).json({ success: false, message: 'Please wait before requesting a new code.', remaining });
        }

        // Case 2: More than 3 attempts and within the 10-minute extended cooldown
        if (existingOtp.attempts >= 3 && (timePassed < tenMinutes)) {
            const remaining = Math.ceil((tenMinutes - timePassed) / 1000);
            return res.status(429).json({ success: false, message: 'Too many OTP requests. Please try again later.', remaining });
        }
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    let updateData = { otp, createdAt: new Date() };
    updateData.attempts = existingOtp && (now - existingOtp.createdAt.getTime() < tenMinutes) ? existingOtp.attempts + 1 : 1;

    await Otp.findOneAndUpdate({ identity: identity.toLowerCase(), type: 'registration' }, updateData, { upsert: true, new: true });
    await sendEmail(identity, 'Maiga Verification Code', `Your verification code is: ${otp}`);
    res.json({ success: true, message: 'Verification code sent.' });
});

router.post('/register', [
    body('username').trim().notEmpty().withMessage('Username is required').matches(/^[a-zA-Z0-9_]+$/).withMessage('Invalid username'),
    body('email').isEmail().withMessage('Invalid email').normalizeEmail(),
    body('password').isLength({ min: 6 }).withMessage('Password too short'),
    body('first_name').trim().notEmpty().withMessage('First name required'),
    body('surname').trim().notEmpty().withMessage('Surname required'), // Added account_type validation
    body('otp').notEmpty().withMessage('OTP required'),
    body('account_type').optional().isIn(['maiga', 'ysu']).withMessage('Invalid account type')
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ message: errors.array()[0].msg });

    try {
        const { username, email, password, first_name, surname, birthday, gender, phone, otp, account_type } = req.body;
        
        // SECURITY: Verify that the email/phone provided matches the one verified via OTP
        const providedIdentity = (email || phone).toLowerCase();
        if (!providedIdentity) {
            return res.status(400).json({ message: 'Identity (Email or Phone) is required.' });
        }

        const identity = (email || phone).toLowerCase();
        const record = await Otp.findOne({ identity, type: 'registration' });
        if (!record) {
            return res.status(400).json({ message: 'Invalid or expired verification code.' });
        }

        if (record.attempts >= 5) {
            return res.status(429).json({ message: 'Too many failed attempts. Please request a new code.' });
        }

        if (record.otp !== otp) {
            await Otp.updateOne({ _id: record._id }, { $inc: { attempts: 1 } });
            return res.status(400).json({ message: 'Invalid verification code.' });
        }

        const existingUser = await User.findOne({ $or: [{ username }, { email }] });
        if (existingUser) return res.status(400).json({ message: 'Username or email already exists' });

        const user = new User({
            name: (first_name + ' ' + surname).trim(), account_type: account_type || 'maiga', // Set account_type
            username, email, password, birthday, gender, phone
        });
        
        // Auto-follow existing admins
        const admins = await User.find({ is_admin: true });
        if (admins.length > 0) {
            const adminIds = admins.map(a => a._id);
            user.following = adminIds;
            // Add the new user to all admins' followers list
            await User.updateMany(
                { _id: { $in: adminIds } },
                { $addToSet: { followers: user._id } }
            );
        }

        await user.save();
        await Otp.deleteOne({ _id: record._id });
        res.json({ success: true, message: 'Registration successful' });
    } catch (err) {
        res.status(400).json({ message: 'Registration failed', error: err.message });
    }
});

router.post('/login', loginLimiter, async (req, res) => {
    try {
      const { login_identity, login_password, remember_me, account_type } = req.body;
        const identity = login_identity.trim().toLowerCase();
        const user = await User.findOne({ $or: [{ email: identity }, { username: identity }] }).select('+password');
        
        if (!user || !(await bcrypt.compare(login_password, user.password))) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

         // Fetch cross-portal login preference
        const crossPortalSetting = await Setting.findOne({ key: 'allow_cross_portal_login' });
        const allowCrossPortal = crossPortalSetting ? crossPortalSetting.value : false;

        // Enforce account isolation if not permitted (Admins are always allowed)
        if (!allowCrossPortal && !user.is_admin && account_type && user.account_type !== account_type) {
            const correctUrl = user.account_type === 'ysu' ? 'ysu.html' : 'index.html';
            return res.status(403).json({ 
                message: `Access Denied. This account is registered for ${user.account_type === 'ysu' ? 'YSU' : 'Maiga'} Social.`,
                redirect: correctUrl 
            });
        }

        // Enforce account isolation: users can only login through their respective registration portal
        if (account_type && user.account_type !== account_type) {
            const portalName = user.account_type === 'ysu' ? 'YSU Social' : 'Maiga Social';
            return res.status(403).json({ message: `Access Denied. This account is registered for ${portalName}. Please login via the correct portal.` });
        }

        // Regenerate the session to prevent session fixation and clear any previous user state
        req.session.regenerate(async (err) => {
            if (err) return res.status(500).json({ message: 'Session error' });

            // Every login is persistent by default to support PWA installations.
            // The long-lived duration is handled by the default config in api.js.

            req.session.userId = user._id.toString();
            user.online = true;
            await user.save();

            // Explicitly save the session before sending the response to ensure consistency
            req.session.save(saveErr => {
                if (saveErr) return res.status(500).json({ message: 'Session save failed' });
                res.json({ message: 'Login successful' });
            });
        });
    } catch (err) {
        res.status(500).json({ message: 'Server error' });
    }
});

router.get('/check_username', async (req, res) => {
    try {
        const { username } = req.query;
        const user = await User.findOne({ username });
        
        let suggestions = [];
        if (user) {
            // Generate 3 simple suggestions
            suggestions.push(`${username}${Math.floor(Math.random() * 99)}`);
            suggestions.push(`${username}_${Math.floor(Math.random() * 999)}`);
            suggestions.push(`the_${username}`);
        }

        res.json({ available: !user, suggestions });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Database check failed' });
    }
});

router.get('/check_email', async (req, res) => {
    try {
        const { email } = req.query;
        const user = await User.findOne({ email: email.toLowerCase() });
        res.json({ available: !user });
    } catch (err) {
        res.status(500).json({ success: false });
    }
});

router.get('/check_phone', async (req, res) => {
    try {
        const { phone } = req.query;
        const user = await User.findOne({ phone });
        res.json({ available: !user });
    } catch (err) {
        res.status(500).json({ success: false });
    }
});

router.get('/logout', (req, res) => {
    if (req.session.userId) {
        User.findByIdAndUpdate(req.session.userId, { online: false }).exec();
    }
    res.setHeader('Clear-Site-Data', '"cache", "storage"');
    req.session.destroy(() => {
        res.json({ success: true });
    });
});

router.post('/forgot-password', otpRequestLimiter, async (req, res) => {
    const { forgot_identity } = req.body;
    const user = await User.findOne({ $or: [{ email: forgot_identity.toLowerCase() }, { phone: forgot_identity }] });
    if (!user) return res.status(404).json({ message: 'No account found.' });

    // Check for cooldown (60 seconds)
    const existingOtp = await Otp.findOne({ identity: forgot_identity.toLowerCase(), type: 'password_reset' });
    if (existingOtp && (Date.now() - existingOtp.createdAt.getTime() < 60000)) {
        return res.status(429).json({ success: false, message: 'Please wait 60 seconds before requesting a new code.' });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    await Otp.findOneAndUpdate({ identity: forgot_identity.toLowerCase(), type: 'password_reset' }, { otp, attempts: 0, createdAt: new Date() }, { upsert: true });
    await sendEmail(forgot_identity, 'Password Reset', `Code: ${otp}`);
    res.json({ success: true, message: 'Reset code sent.' });
});

router.post('/verify-otp', otpVerificationLimiter, async (req, res) => {
    const identity = (req.body.identity || req.body.forgot_identity || '').toLowerCase();
    const { otp } = req.body;
    
    const record = await Otp.findOne({ identity, type: { $in: ['registration', 'password_reset'] } });
    
    if (!record) return res.status(400).json({ message: 'Verification code expired.' });

    if (record.attempts >= 5) {
        return res.status(429).json({ message: 'Too many failed attempts. Please request a new code.' });
    }

    if (record.otp !== otp) {
        await Otp.updateOne({ _id: record._id }, { $inc: { attempts: 1 } });
        return res.status(400).json({ message: 'Invalid code.' });
    }

    res.json({ success: true, message: 'Code verified.' });
});

router.post('/reset-password', otpVerificationLimiter, async (req, res) => {
    const { forgot_identity, otp, new_password } = req.body;
    const identity = forgot_identity.toLowerCase();
    
    if (!new_password || new_password.length < 6) {
        return res.status(400).json({ message: 'New password must be at least 6 characters.' });
    }

    const record = await Otp.findOne({ identity, type: 'password_reset' });
    
    if (!record) return res.status(400).json({ message: 'Invalid session.' });

    if (record.attempts >= 5) {
        return res.status(429).json({ message: 'Too many failed attempts.' });
    }

    if (record.otp !== otp) {
        await Otp.updateOne({ _id: record._id }, { $inc: { attempts: 1 } });
        return res.status(400).json({ message: 'Invalid code.' });
    }

    const user = await User.findOne({ $or: [{ email: forgot_identity.toLowerCase() }, { phone: forgot_identity }] });
    if (user) {
        user.password = new_password;
        await user.save(); // Triggers the pre-save hashing hook
    }
    
    await Otp.deleteOne({ _id: record._id });
    res.json({ success: true, message: 'Password reset successfully.' });
});

router.post('/change_password', async (req, res) => {
    try {
        const { current_password, new_password } = req.body;
        const userId = req.session.userId;

        const user = await User.findById(userId).select('+password');
        if (!user) return res.status(404).json({ message: 'User not found' });

        if (!(await bcrypt.compare(current_password, user.password))) {
            return res.status(401).json({ message: 'Incorrect current password' });
        }

        if (new_password.length < 6) {
            return res.status(400).json({ message: 'New password must be at least 6 characters long' });
        }

        user.password = new_password; // The pre-save hook will hash this
        await user.save();
        res.json({ success: true, message: 'Password changed successfully' });
    } catch (error) {
        res.status(500).json({ message: 'Server error' });
    }
});

router.get('/get_terms', (req, res) => {
    const terms = `
<h3 class="font-bold text-lg border-b dark:border-gray-700 pb-2 mb-4">WELCOME TO MAIGA SOCIAL</h3>

<p class="mb-4"><b>1. ACCEPTANCE OF TERMS</b><br>
By clicking "Register" and using Maiga Social, you agree to be bound by these Terms and Conditions. If you do not agree to these terms, please do not use the platform.</p>

<p class="mb-4"><b>2. OWNERSHIP AND CONTACT INFORMATION</b><br>
Maiga Social is owned and operated by:<br>
<b>Owner Name:</b> Habibu Idriss Maigari<br>
<b>Phone No:</b> 09160971716<br>
<b>Address:</b> Potiskum, Yobe State, Nigeria<br>
<b>Official Email:</b> ${process.env.SENDER_EMAIL || 'admin@maiga.social'}</p>

<p class="mb-2"><b>3. ELIGIBILITY AND CONDUCT</b></p>
<ul class="list-disc pl-5 mb-4 space-y-1">
    <li>Users must provide accurate and truthful information during registration.</li>
    <li>You are solely responsible for the security of your account and all activity that occurs under it.</li>
    <li>Harassment, hate speech, bullying, and the sharing of illegal or explicit content are strictly prohibited.</li>
    <li>Users found violating community standards will face immediate suspension or a permanent ban.</li>
</ul>

<p class="mb-4"><b>4. CONTENT OWNERSHIP</b><br>
You retain ownership of the content you post. However, by posting, you grant Maiga Social a non-exclusive, royalty-free license to host, store, and display your content to other users as per your chosen privacy settings.</p>

<p class="mb-4"><b>5. PRIVACY & DATA</b><br>
Your personal data is handled with care. We do not sell your information to third parties. Please review your "Close Friends" lists and account visibility settings regularly to control your privacy.</p>

<p class="mb-4"><b>6. LIMITATION OF LIABILITY</b><br>
Maiga Social is provided "as is". Habibu Idriss Maigari and the Maiga Social team are not liable for user-generated content, service interruptions, or any damages arising from your use of the platform.</p>

<p class="mb-4"><b>7. TERMINATION</b><br>
We reserve the right to terminate or suspend access to our service immediately, without prior notice, for any violation of these terms.</p>

<p class="mb-4"><b>8. GOVERNING LAW</b><br>
These terms are governed by and construed in accordance with the laws of the Federal Republic of Nigeria.</p>

<p><b>9. AMENDMENTS</b><br>
We may update these terms occasionally. Continued use of the platform implies acceptance of updated terms.</p>`;
    res.json({ content: terms });
});

module.exports = router;
