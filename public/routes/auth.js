const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const fs = require('fs');
const { body, validationResult } = require('express-validator');
const { exec } = require('child_process');
const { User } = require('../../models');

// Stores for OTP
const regOtpStore = new Map();
const passwordResetStore = new Map();

// Helper Email Function
async function sendEmail(to, subject, text) {
    const codeMatch = text.match(/\d{6}/);
    const code = codeMatch ? codeMatch[0] : '';
    const cleanText = text.replace(code, '').replace(':', '').trim();

    const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <style>
        body { font-family: sans-serif; background-color: #f4f4f5; padding: 20px; }
        .email-container { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 12px; overflow: hidden; }
        .header { background: #6366f1; padding: 20px; text-align: center; color: white; }
        .content { padding: 30px; text-align: center; color: #333; }
        .otp-box { background: #f8fafc; border: 2px dashed #cbd5e1; padding: 15px; margin: 20px auto; width: fit-content; font-size: 24px; font-weight: bold; letter-spacing: 5px; color: #4f46e5; }
    </style>
</head>
<body>
    <div class="email-container">
        <div class="header"><h1>${subject}</h1></div>
        <div class="content">
            <p>${cleanText}</p>
            ${code ? `<div class="otp-box">${code}</div>` : ''}
        </div>
    </div>
</body>
</html>`;

    const emailContent = `
****************************************
 OTP CODE: ${code || 'N/A'}
****************************************
Date: ${new Date().toLocaleString()}
To: ${to}
Subject: ${subject}
----------------
${htmlContent}
================
`;
    try {
        await fs.promises.writeFile('email.txt', emailContent);
        // Auto-open email.txt
        const openCmd = process.platform === 'win32' ? 'start' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
        exec(`${openCmd} email.txt`);
    } catch (err) {
        console.error('[EMAIL] Failed:', err);
    }
}

// Routes
router.post('/send-reg-otp', async (req, res) => {
    const { identity } = req.body;
    if (!identity) return res.status(400).json({ success: false, message: 'Email or phone is required' });

    const existingUser = await User.findOne({ $or: [{ email: identity.toLowerCase() }, { phone: identity }] });
    if (existingUser) return res.status(400).json({ success: false, message: 'Account already exists.' });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    regOtpStore.set(identity, { otp, expires: Date.now() + 10 * 60 * 1000 });
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
        
        const identity = email || phone;
        const record = regOtpStore.get(identity);
        if (!record || record.otp !== otp || Date.now() > record.expires) {
            return res.status(400).json({ message: 'Invalid or expired verification code.' });
        }

        const existingUser = await User.findOne({ $or: [{ username }, { email }] });
        if (existingUser) return res.status(400).json({ message: 'Username or email already exists' });

        const hashedPassword = await bcrypt.hash(password, 10);
        const user = new User({
            name: `${first_name} ${surname}`,
            username, email, password: hashedPassword, birthday, gender, phone
        });
        await user.save();
        regOtpStore.delete(identity);
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
        console.error(err); // Log exact error to console for debugging
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

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    passwordResetStore.set(forgot_identity, { otp, expires: Date.now() + 10 * 60 * 1000 });
    await sendEmail(forgot_identity, 'Password Reset', `Code: ${otp}`);
    res.json({ message: 'Reset code sent.' });
});

router.post('/verify-otp', (req, res) => {
    const { forgot_identity, otp } = req.body;
    const record = passwordResetStore.get(forgot_identity);
    if (!record || record.otp !== otp) return res.status(400).json({ message: 'Invalid code.' });
    res.json({ message: 'Code verified.' });
});

router.post('/reset-password', async (req, res) => {
    const { forgot_identity, otp, new_password } = req.body;
    const record = passwordResetStore.get(forgot_identity);
    if (!record || record.otp !== otp) return res.status(400).json({ message: 'Invalid session.' });

    const hashedPassword = await bcrypt.hash(new_password, 10);
    await User.findOneAndUpdate({ $or: [{ email: forgot_identity.toLowerCase() }, { phone: forgot_identity }] }, { password: hashedPassword });
    passwordResetStore.delete(forgot_identity);
    res.json({ message: 'Password reset successfully.' });
});

module.exports = router;
