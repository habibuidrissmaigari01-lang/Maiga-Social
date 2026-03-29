const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const fs = require('fs');
const { body, validationResult } = require('express-validator');
const { exec } = require('child_process');
const { User, Otp } = require('../../models');


// Helper Email Function
async function sendEmail(to, subject, text) {
    if (!process.env.BREVO_API_KEY) {
        console.error("Email skipped: BREVO_API_KEY is not defined.");
        return;
    }

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

        if (!response.ok) {
            const errorBody = await response.json();
            console.error("Brevo API delivery failure:", {
                status: response.status,
                details: errorBody
            });
        }
    } catch (err) {
        console.error("Network error connecting to Brevo:", err.message);
    }
}

// Routes
router.post('/send-reg-otp', async (req, res) => {
    const { identity } = req.body;
    if (!identity) return res.status(400).json({ success: false, message: 'Email or phone is required' });

    const existingUser = await User.findOne({ $or: [{ email: identity.toLowerCase() }, { phone: identity }] });
    if (existingUser) return res.status(400).json({ success: false, message: 'Account already exists.' });

    // Check for cooldown (60 seconds)
    const existingOtp = await Otp.findOne({ identity: identity.toLowerCase(), type: 'registration' });
    if (existingOtp && (Date.now() - existingOtp.createdAt.getTime() < 60000)) {
        return res.status(429).json({ success: false, message: 'Please wait 60 seconds before requesting a new code.' });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    await Otp.findOneAndUpdate({ identity: identity.toLowerCase(), type: 'registration' }, { otp, attempts: 0, createdAt: new Date() }, { upsert: true });
    await sendEmail(identity, 'Maiga Verification Code', `Your verification code is: ${otp}`);
    res.json({ success: true, message: 'Verification code sent.' });
});

router.post('/register', [
    body('username').trim().notEmpty().withMessage('Username is required').matches(/^[a-zA-Z0-9_]+$/).withMessage('Invalid username'),
    body('email').isEmail().withMessage('Invalid email').normalizeEmail(),
    body('password').isLength({ min: 6 }).withMessage('Password too short'),
    body('first_name').trim().notEmpty().withMessage('First name required'),
    body('surname').trim().notEmpty().withMessage('Surname required'),
    body('otp').notEmpty().withMessage('OTP required')
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ message: errors.array()[0].msg });

    try {
        const { username, email, password, first_name, surname, birthday, gender, phone, otp } = req.body;
        
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
            name: (first_name + ' ' + surname).trim(),
            username, email, password, birthday, gender, phone
        });
        await user.save();
        await Otp.deleteOne({ _id: record._id });
        res.json({ message: 'Registration successful' });
    } catch (err) {
        res.status(400).json({ message: 'Registration failed', error: err.message });
    }
});

router.post('/login', async (req, res) => {
    try {
        const { login_identity, login_password, remember_me } = req.body;
        const user = await User.findOne({ $or: [{ email: login_identity }, { username: login_identity }] }).select('+password');
        
        if (!user || !(await bcrypt.compare(login_password, user.password))) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }
        
        // Handle Remember Me
        if (remember_me) {
            req.session.cookie.maxAge = 1000 * 60 * 60 * 24 * 30; // 30 Days
        }

        req.session.userId = user._id;
        user.online = true;
        await user.save();
        res.json({ message: 'Login successful' });
    } catch (err) {
        res.status(500).json({ message: 'Server error' });
    }
});

router.get('/check_username', async (req, res) => {
    const user = await User.findOne({ username: req.query.username });
    res.json({ available: !user });
});

router.get('/logout', (req, res) => {
    if (req.session.userId) User.findByIdAndUpdate(req.session.userId, { online: false }).exec();
    req.session.destroy();
    res.json({ success: true });
});

router.post('/forgot-password', async (req, res) => {
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
    res.json({ message: 'Reset code sent.' });
});

router.post('/verify-otp', async (req, res) => {
    const { forgot_identity, otp } = req.body;
    const identity = forgot_identity.toLowerCase();
    const record = await Otp.findOne({ identity, type: 'password_reset' });
    
    if (!record) return res.status(400).json({ message: 'Verification code expired.' });

    if (record.attempts >= 5) {
        return res.status(429).json({ message: 'Too many failed attempts. Please request a new code.' });
    }

    if (record.otp !== otp) {
        await Otp.updateOne({ _id: record._id }, { $inc: { attempts: 1 } });
        return res.status(400).json({ message: 'Invalid code.' });
    }

    res.json({ message: 'Code verified.' });
});

router.post('/reset-password', async (req, res) => {
    const { forgot_identity, otp, new_password } = req.body;
    const identity = forgot_identity.toLowerCase();
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
    res.json({ message: 'Password reset successfully.' });
});

module.exports = router;
