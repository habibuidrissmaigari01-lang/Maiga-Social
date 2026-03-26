import express from 'express';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'node:path';
import session from 'express-session';
import MongoStore from 'connect-mongo';
import { Server } from "socket.io";
import multer from 'multer';
import fs from 'node:fs';
import { Brevo } from '@getbrevo/brevo';
import { body, validationResult } from 'express-validator';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
// Removed fluent-ffmpeg: Cloudflare Workers cannot run binaries.

// Import models using ESM syntax
import { User, Post, Story, Comment, Message, Notification } from './models.js';

// Connect to Database
const mongoUrl = process.env.MONGO_URL;
if (!mongoUrl) {
    console.error('FATAL ERROR: MONGO_URL is not defined in the environment.');
}

// Log the connection string (masking the password) to verify credentials are loaded
const maskedUrl = mongoUrl.replace(/:([^:@]{1,})@/, ':****@');
console.log(`Attempting to connect to MongoDB: ${maskedUrl}`);

mongoose.connect(mongoUrl)
    .then(() => {
        console.log('MongoDB Connected');
        console.log(`Connected to database: ${mongoose.connection.name}`);
    })
    .catch(err => {
        console.error('MongoDB Connection Error:', err.message);
    });

const app = express();

// --- Production-Ready CORS Setup ---
const allowedOrigins = [
    'http://localhost:3000', // For local development
    // TODO: Add your production frontend URL here. Example:
    // 'https://www.maiga.social'
];

// Socket.io requires a stateful server. 
// On Cloudflare Workers, you must use Durable Objects or a managed WebSocket provider.

// --- Middleware ---

// Enable CORS for all routes to allow frontend to connect
app.use(cors({
    origin: function (origin, callback) {
        // allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) === -1) {
            const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
            return callback(new Error(msg), false);
        }
        return callback(null, true);
    },
    credentials: true
}));

// Parse incoming JSON request bodies
app.use(express.json());

// Session Middleware
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
    console.error('FATAL ERROR: SESSION_SECRET is not defined in the environment.');
}

app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false, // Don't create session until something stored
    store: MongoStore.create({ 
        mongoUrl: mongoUrl,
        ttl: 14 * 24 * 60 * 60 // = 14 days
    }),
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 14 } // 14 days
}));

// Configure S3 client for Cloudflare R2
const s3 = new S3Client({
    region: 'auto',
    endpoint: process.env.R2_S3_API_URL,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
});

// File Upload Setup (Multer for local temporary storage)
// Use MemoryStorage instead of DiskStorage
const storage = multer.memoryStorage(); 
const upload = multer({
    storage: storage,
    limits: { fileSize: 100 * 1024 * 1024 } // 100 MB limit
});

// --- R2 Helper Functions ---

// Helper function to upload a file from a local path to R2
async function uploadToR2(file, originalFileName) {
    // For Workers, file is an object from multer.memoryStorage()
    const fileBody = file.buffer; 
    const key = Date.now().toString() + path.extname(originalFileName);

    const uploadParams = {
        Bucket: process.env.R2_BUCKET_NAME,
        Key: key,
        Body: fileBody,
        ACL: 'public-read',
    };

    await s3.send(new PutObjectCommand(uploadParams));

    if (!process.env.R2_PUBLIC_URL) {
        console.warn('[WARNING] R2_PUBLIC_URL is not set in .env. The returned URL might not be publicly accessible.');
        return `${process.env.R2_S3_API_URL}/${process.env.R2_BUCKET_NAME}/${key}`;
    }
    return `${process.env.R2_PUBLIC_URL}/${key}`;
}

// Helper to delete a file from R2 given its public URL
async function deleteFromR2(fileUrl) {
    if (!fileUrl || !process.env.R2_PUBLIC_URL || !fileUrl.startsWith(process.env.R2_PUBLIC_URL)) {
        console.log(`[R2] Skipping deletion for non-R2 URL: ${fileUrl}`);
        return;
    }
    try {
        const key = path.basename(new URL(fileUrl).pathname);
        const deleteParams = { Bucket: process.env.R2_BUCKET_NAME, Key: key };
        await s3.send(new DeleteObjectCommand(deleteParams));
        console.log(`[R2] Deleted: ${key}`);
    } catch (err) {
        console.error(`[R2] Failed to delete ${fileUrl}:`, err.message);
    }
}

// --- Rate Limiter (In-Memory) ---
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 minutes
const MAX_REQUESTS = 10; // Max 10 attempts per window

const rateLimiter = (req, res, next) => {
    const ip = req.ip;
    const now = Date.now();
    
    if (!rateLimitMap.has(ip)) {
        rateLimitMap.set(ip, []);
    }
    
    let requests = rateLimitMap.get(ip);
    requests = requests.filter(time => now - time < RATE_LIMIT_WINDOW);
    
    if (requests.length >= MAX_REQUESTS) {
        return res.status(429).json({ message: 'Too many attempts. Please try again later.' });
    }
    
    requests.push(now);
    rateLimitMap.set(ip, requests);
    next();
};

// Auth Middleware
const auth = (req, res, next) => {
    if (!req.session.userId) {
        return res.status(401).json({ message: 'Unauthorized' });
    }
    next();
};

// --- OTP Store (In-Memory for Forgot Password) ---
const otpStore = new Map();

// OTP Store for Registration
const regOtpStore = new Map();

// --- Email Helper (Mock for Localhost) ---
async function sendEmail(to, subject, text, account_type = 'maiga') {
    const isYSU = account_type === 'ysu';
    const brandName = isYSU ? 'YSU Social' : 'Maiga Social';
    const brandColor = isYSU ? '#00642E' : '#667eea'; // YSU Green, Maiga Blue
    const brandLogo = isYSU ? 'https://www.ysu.edu.ng/wp-content/uploads/2020/02/ysu-logo.jpg' : 'https://maiga-social-app.com/img/logo.png'; // Using absolute URLs for email clients

    const codeMatch = text.match(/\d{6}/);
    const code = codeMatch ? codeMatch[0] : '';
    const cleanText = text.replace(code, '').replace(':', '').trim();

    const emailContent = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background-color:#f4f4f5;padding:20px;margin:0}.email-container{max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb}.header{background-color:${brandColor};padding:30px;text-align:center}.header img{max-width:70px;border-radius:10px}.content{padding:40px;text-align:center;color:#333}.content p{font-size:16px;line-height:1.5;color:#555}.otp-box{background:#f1f5f9;border:2px dashed #cbd5e1;padding:15px;margin:30px auto;width:-moz-fit-content;width:fit-content;font-size:32px;font-weight:700;letter-spacing:8px;color:${brandColor};border-radius:8px}.footer{padding:20px;text-align:center;font-size:12px;color:#999;background-color:#f8fafc}</style></head>
<body><div class="email-container"><div class="header"><img src="${brandLogo}" alt="${brandName} Logo"></div><div class="content"><h1 style="color:#111;font-size:24px;margin-bottom:10px">${subject}</h1><p>${cleanText}</p>${code?`<div class="otp-box">${code}</div>`:""}<p>If you did not request this, please ignore this email.</p></div><div class="footer">&copy; ${new Date().getFullYear()} ${brandName}. All rights reserved.</div></div></body></html>`;

    // --- 1. Brevo Integration (Production/Real Email) ---
    // Requires Node.js 18+ for native fetch, or install node-fetch
    if (process.env.BREVO_API_KEY) {
        const defaultClient = Brevo.ApiClient.instance;
        const apiKey = defaultClient.authentications['api-key'];
        apiKey.apiKey = process.env.BREVO_API_KEY;

        const apiInstance = new Brevo.TransactionalEmailsApi();
        const sendSmtpEmail = new Brevo.SendSmtpEmail();

        sendSmtpEmail.subject = subject;
        sendSmtpEmail.htmlContent = emailContent;
        sendSmtpEmail.sender = { name: brandName, email: process.env.SENDER_EMAIL || 'no-reply@maiga.social' };
        sendSmtpEmail.to = [{ email: to }];

        try {
            await apiInstance.sendTransacEmail(sendSmtpEmail);
            console.log(`[EMAIL] Real email sent to ${to} via Brevo SDK.`);
            return; // Exit if sent successfully
        } catch (err) {
            // The Brevo SDK error object can be large, so we log the relevant part
            const errorMessage = err.response ? JSON.stringify(err.response.body) : err.message;
            console.error('[EMAIL] Brevo SDK Error:', errorMessage);
            console.warn('[EMAIL] Failed to send real email via SDK, falling back to local file.');
        }
    }

    // --- 2. Local Fallback (Development) ---
    try {
        // For demonstration, we'll write to a specific HTML file to make it easy to view.
        await fs.promises.writeFile('email.html', emailContent);
        console.log(`[EMAIL] Mock email sent to ${to}. Check email.html`);
        // Also keep the old log for compatibility
        await fs.promises.appendFile('email.txt', `To: ${to}\nSubject: ${subject}\nText: ${text}\n\n`);
    } catch (err) {
        console.error('[EMAIL] Failed to write email file:', err);
    }
}

// --- API Routes ---

/**
 * @route   POST /api/register
 * @desc    Register a new user
 * @access  Public
 */
app.post('/api/send-reg-otp', rateLimiter, async (req, res) => {
    const { identity, account_type } = req.body;
    if (!identity) {
        return res.status(400).json({ success: false, message: 'Email or phone is required' });
    }

    // Rate Limit: Check if OTP was sent recently to this identity
    const existingRecord = regOtpStore.get(identity);
    if (existingRecord && existingRecord.lastSent && (Date.now() - existingRecord.lastSent < 60000)) {
        const waitSeconds = Math.ceil((60000 - (Date.now() - existingRecord.lastSent)) / 1000);
        return res.status(429).json({ success: false, message: `Please wait ${waitSeconds}s before resending.` });
    }

    // Check if user already exists to prevent sending OTP for existing accounts
    const existingUser = await User.findOne({ $or: [{ email: identity.toLowerCase() }, { phone: identity }] });
    if (existingUser) {
        return res.status(400).json({ success: false, message: 'An account with this email/phone already exists.' });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    regOtpStore.set(identity, { otp, expires: Date.now() + 10 * 60 * 1000, lastSent: Date.now() }); // 10 min expiry + timestamp

    const subject = account_type === 'ysu' ? 'YSU Social Verification Code' : 'Maiga Verification Code';

    // Send OTP via Email (Mock)
    await sendEmail(identity, subject, `Your verification code is: ${otp}`, account_type);

    res.json({ success: true, message: 'Verification code sent.' });
});


app.post('/api/register', rateLimiter, [
    body('firstName').notEmpty().withMessage('Please enter all required fields'),
    body('last_name').notEmpty().withMessage('Please enter all required fields'),
    body('email').isEmail().withMessage('Please enter all required fields'),
    body('username').notEmpty().withMessage('Please enter all required fields'),
    body('password').notEmpty().withMessage('Please enter all required fields'),
    body('password')
        .isLength({ min: 8 })
        .matches(/[A-Z]/)
        .matches(/[a-z]/)
        .matches(/[0-9]/)
        .withMessage('Password must be at least 8 characters long and contain uppercase, lowercase, and a number.'),
    body('confirm_password').custom((value, { req }) => {
        if (value !== req.body.password) {
            throw new Error('Passwords do not match');
        }
        return true;
    }),
    body('phone').optional(),
    body('otp').notEmpty().withMessage('Verification code is required')
        .custom((value, { req }) => {
            const identity = req.body.email || req.body.phone;
            const record = regOtpStore.get(identity);
            if (!record || record.otp !== value || Date.now() > record.expires) {
                throw new Error('Invalid or expired verification code.');
            }
            return true;
        })
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ message: errors.array()[0].msg });
    }

    const {
        firstName,
        last_name,
        email,
        phone,
        password,
        birthday,
        username,
        gender,
    } = req.body;

    const identity = email || phone;

    try {
        // Check if user already exists
        let user = await User.findOne({ $or: [{ email: email.toLowerCase() }, { username }] });
        if (user) {
            return res.status(400).json({ message: 'User with that email or username already exists' });
        }

        // Hash the password before saving
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // Create new user instance from the User model
        user = new User({
            firstName,
            surname: last_name,
            email: email.toLowerCase(),
            phone,
            password: hashedPassword,
            birthday,
            username,
            gender,
        });

        // Save user to the database
        await user.save();

        // After successful registration, clear the OTP
        regOtpStore.delete(identity);

        // Don't send the password back in the response
        user.password = undefined;

        // Respond with the created user (in a real app, you'd return a JWT)
        res.status(201).json({
            message: 'User registered successfully!',
            user,
        });

    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});

/**
 * @route   POST /api/login
 * @desc    Authenticate user
 * @access  Public
 */
app.post('/api/login', rateLimiter, async (req, res) => {
    const { login_identity, login_password } = req.body;

    if (!login_identity || !login_password) {
        return res.status(400).json({ message: 'Please provide credentials' });
    }

    try {
        const user = await User.findOne({
            $or: [{ email: login_identity }, { username: login_identity }]
        });

        if (!user || !(await bcrypt.compare(login_password, user.password))) {
            return res.status(400).json({ message: 'Invalid credentials' });
        }

        req.session.userId = user._id; // Create session
        user.password = undefined;
        res.json({ message: 'Login successful', user });

    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});

/**
 * @route   GET /api/logout
 * @desc    Logout user and destroy session
 * @access  Public
 */
app.get('/api/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) return res.status(500).json({ message: 'Could not log out' });
        res.clearCookie('connect.sid');
        res.json({ message: 'Logout successful' });
    });
});

/**
 * @route   POST /api/forgot-password
 * @desc    Initiate password reset (Send OTP)
 */
app.post('/api/forgot-password', rateLimiter, async (req, res) => {
    const { forgot_identity } = req.body;
    if (!forgot_identity) return res.status(400).json({ message: 'Please provide email or username' });

    try {
        const user = await User.findOne({
            $or: [{ email: forgot_identity.toLowerCase() }, { username: forgot_identity }]
        });

        if (user) {
            // Generate 6 digit OTP
            const otp = Math.floor(100000 + Math.random() * 900000).toString();
            // Store OTP with 10 min expiration
            otpStore.set(forgot_identity, { otp, expires: Date.now() + 10 * 60 * 1000 });
            
            // Send OTP via Email (Mock)
            const subject = user.account_type === 'ysu' ? 'YSU Password Reset Code' : 'Maiga Password Reset Code';
            await sendEmail(user.email, subject, `Your password reset code is: ${otp}`, user.account_type);
        }
        
        // Always return success to prevent user enumeration
        res.json({ message: 'If an account exists, a verification code has been sent.', success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

/**
 * @route   POST /api/verify-otp
 * @desc    Verify OTP before resetting password
 */
app.post('/api/verify-otp', rateLimiter, async (req, res) => {
    const { forgot_identity, otp } = req.body;
    const record = otpStore.get(forgot_identity);

    if (!record || record.otp !== otp || Date.now() > record.expires) {
        return res.status(400).json({ message: 'Invalid or expired code' });
    }

    res.json({ message: 'Code verified', success: true });
});

/**
 * @route   POST /api/reset-password
 * @desc    Reset password with verified OTP
 */
app.post('/api/reset-password', rateLimiter, async (req, res) => {
    const { forgot_identity, otp, new_password } = req.body;
    
    if (!new_password || new_password.length < 8) {
        return res.status(400).json({ message: 'Password must be at least 8 characters' });
    }

    const record = otpStore.get(forgot_identity);
    if (!record || record.otp !== otp || Date.now() > record.expires) {
        return res.status(400).json({ message: 'Invalid or expired session. Please start over.' });
    }

    try {
        const user = await User.findOne({
            $or: [{ email: forgot_identity.toLowerCase() }, { username: forgot_identity }]
        });

        if (!user) return res.status(404).json({ message: 'User not found' });

        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(new_password, salt);
        await user.save();

        otpStore.delete(forgot_identity); // Clear used OTP

        res.json({ message: 'Password reset successful. You can now login.', success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

/**
 * @route   GET /api/get_messages
 * @desc    Get messages for a specific chat
 * @access  Private
 */
app.get('/api/get_messages', auth, async (req, res) => {
    try {
        const { chat_id, type } = req.query;
        const query = type === 'group' 
            ? { group: chat_id }
            : { 
                $or: [
                    { sender: req.session.userId, receiver: chat_id },
                    { sender: chat_id, receiver: req.session.userId }
                ]
              };
        
        const messages = await Message.find(query)
            .sort({ created_at: 1 })
            .populate('sender', 'firstName surname avatar')
            .populate('read_by', 'firstName surname avatar');

        res.json(messages.map(m => ({
            id: m._id,
            sender_id: m.sender?._id || m.sender,
            first_name: m.sender?.firstName,
            surname: m.sender?.surname,
            avatar: m.sender?.avatar,
            content: m.content,
            media: m.media,
            media_type: m.media_type,
            created_at: m.created_at,
            is_read: m.is_read,
            read_by: m.read_by || [],
            is_edited: m.is_edited,
            is_pinned: m.is_pinned,
            replyTo: m.reply_to,
            poll: m.poll
        })));
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

/**
 * @route   POST /api/mark_messages_read
 * @desc    Mark messages in a chat as read
 * @access  Private
 */
app.post('/api/mark_messages_read', auth, async (req, res) => {
    try {
        const { chat_id, type } = req.body;
        const userId = req.session.userId;

        if (type === 'group') {
            // Add user to read_by array if not already there
            await Message.updateMany(
                { group: chat_id, read_by: { $ne: userId } },
                { $addToSet: { read_by: userId } }
            );
        } else {
            await Message.updateMany(
                { sender: chat_id, receiver: userId, is_read: false },
                { $set: { is_read: true }, $addToSet: { read_by: userId } }
            );
        }
        res.json({ success: true });
    } catch (e) {
        console.error('Mark as read error:', e);
        res.status(500).json({ message: 'Server Error' });
    }
});

/**
 * @route   GET /api/check_username
 * @desc    Check if username is available
 * @access  Public
 */
app.get('/api/check_username', async (req, res) => {
    try {
        const { username } = req.query;
        if (!username) return res.status(400).json({ message: 'Username is required' });

        const user = await User.findOne({ username });
        if (!user) {
            return res.json({ available: true });
        }

        // Generate potential suggestions
        const candidates = [
            `${username}${Math.floor(Math.random() * 1000)}`,
            `${username}${new Date().getFullYear()}`,
            `${username}_${Math.floor(Math.random() * 100)}`
        ];

        // Check if candidates are taken
        const takenUsers = await User.find({ username: { $in: candidates } }).select('username');
        const takenUsernames = takenUsers.map(u => u.username);
        const suggestions = candidates.filter(c => !takenUsernames.includes(c));

        res.json({ available: false, suggestions });
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
});

/**
 * @route   GET /api/friends/suggestions
 * @desc    Get friend suggestions based on department
 * @access  Private
 */
app.get('/api/friends/suggestions', auth, async (req, res) => {
    try {
        const currentUser = await User.findById(req.session.userId);
        if (!currentUser) return res.status(404).json({ message: 'User not found' });

        const followingIds = currentUser.following || [];

        // 1. Friends of Friends: Users followed by people I follow
        // Logic: Find users whose 'followers' array contains anyone from my 'following' list
        let suggestions = await User.find({
            followers: { $in: followingIds },
            _id: { $nin: [...followingIds, currentUser._id] }
        })
        .select('firstName surname username avatar dept')
        .limit(10);

        // Format friends of friends
        let formattedSuggestions = suggestions.map(user => ({
            id: user._id,
            name: `${user.firstName} ${user.surname}`,
            username: user.username,
            avatar: user.avatar,
            dept: user.dept,
            mutual_text: 'Followed by friends'
        }));

        // 2. Fallback: Users from same department if list is small
        if (formattedSuggestions.length < 5) {
            const excludeIds = [...followingIds, currentUser._id, ...suggestions.map(s => s._id)];
            
            const deptSuggestions = await User.find({
                dept: currentUser.dept,
                _id: { $nin: excludeIds }
            })
            .select('firstName surname username avatar dept')
            .limit(10 - formattedSuggestions.length);

            const formattedDept = deptSuggestions.map(user => ({
                id: user._id,
                name: `${user.firstName} ${user.surname}`,
                username: user.username,
                avatar: user.avatar,
                dept: user.dept,
                mutual_text: 'From your department'
            }));

            formattedSuggestions = [...formattedSuggestions, ...formattedDept];
        }

        res.json(formattedSuggestions);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});

/**
 * @route   GET /api/users/search
 * @desc    Search for users by username
 * @access  Private
 */
app.get('/api/users/search', auth, async (req, res) => {
    const { q } = req.query;

    if (!q) {
        return res.status(400).json({ message: 'Search query is required' });
    }

    try {
        // Use a case-insensitive regex for searching, and escape special characters
        const searchRegex = new RegExp(q.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'), 'i');

        const users = await User.find({
            username: searchRegex,
            _id: { $ne: req.session.userId } // Exclude the current user from results
        })
        .select('firstName surname username avatar dept') // Select only public fields
        .limit(10); // Limit results

        res.json(users);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});

/**
 * @route   POST /api/update_profile
 * @desc    Update user profile (bio, avatar, name)
 * @access  Private
 */
app.post('/api/update_profile', auth, upload.single('avatar'), async (req, res) => {
    try {
        const { bio, name, dept, username } = req.body;
        const updates = {};

        if (bio !== undefined) updates.bio = bio;
        if (dept !== undefined) updates.dept = dept;
        if (username !== undefined) updates.username = username;

        // Handle name update if provided (Splitting into firstName/surname)
        if (name) {
            const nameParts = name.trim().split(/\s+/);
            if (nameParts.length > 0) updates.firstName = nameParts[0];
            if (nameParts.length > 1) updates.surname = nameParts.slice(1).join(' ');
        }

        // Find the user to get the old avatar URL before updating
        const userToUpdate = await User.findById(req.session.userId);

        if (req.file) {
            // A new avatar is being uploaded
            const newAvatarUrl = await uploadToR2(req.file, req.file.originalname);

            // If there was an old avatar, delete it from R2
            if (userToUpdate && userToUpdate.avatar) {
                await deleteFromR2(userToUpdate.avatar);
            }

            updates.avatar = newAvatarUrl;
        }

        const user = await User.findByIdAndUpdate(
            req.session.userId,
            { $set: updates },
            { new: true }
        ).select('-password');

        res.json({ success: true, user });
    } catch (err) {
        console.error('Profile update error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

/**
 * @route   GET /api/user
 * @route   GET /api/get_user
 * @desc    Get current user profile
 * @access  Private
 */
const getUserHandler = async (req, res) => {
    try {
        const user = await User.findById(req.session.userId).select('-password');
        if (!user) return res.status(404).json({ message: 'User not found' });
        res.json(user);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: 'Server Error' });
    }
};

app.get('/api/user', auth, getUserHandler);
app.get('/api/get_user', auth, getUserHandler); // Alias for frontend compatibility

/**
 * @route   GET /api/get_profile
 * @desc    Get user profile by ID
 * @access  Private
 */
app.get('/api/get_profile', auth, async (req, res) => {
    try {
        const userId = req.query.user_id;
        if (!userId) {
            return res.status(400).json({ message: 'User ID is required' });
        }

        const user = await User.findById(userId).select('-password');
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }
        
        const userObject = user.toObject();
        userObject.name = `${user.firstName} ${user.surname}`;
        
        res.json(userObject);
    } catch (err) {
        console.error(err.message);
        if (err.kind === 'ObjectId') {
            return res.status(404).json({ message: 'User not found' });
        }
        res.status(500).json({ message: 'Server Error' });
    }
});
/**
 * @route   GET /api/posts
 * @desc    Get all posts
 * @access  Private
 */
app.get('/api/get_posts', auth, async (req, res) => {
    try {
        const currentUser = await User.findById(req.session.userId);

        const findQuery = {};
        if (req.query.user_id) {
            findQuery.user = req.query.user_id;
        } else {
            // Exclude videos (reels) from the main home feed
            findQuery.mediaType = { $ne: 'video' };
        }

        const posts = await Post.find(findQuery).sort({ created_at: -1 }).populate('user', 'firstName surname avatar');
        
        // Convert savedPosts ObjectIds to strings for comparison
        const savedPostIds = currentUser.savedPosts ? currentUser.savedPosts.map(id => id.toString()) : [];

        // Format for frontend
        const formattedPosts = posts.map(post => ({
            id: post._id,
            user_id: post.user._id,
            author: `${post.user.firstName} ${post.user.surname}`,
            avatar: post.user.avatar || 'img/default-avatar.png',
            content: post.content,
            media: post.media,
            mediaType: post.mediaType,
            time: new Date(post.created_at).toLocaleString(),
            likes: post.likes.length,
            comments: post.comments.length,
            shares: 0,
            saved: savedPostIds.includes(post._id.toString())
        }));
        res.json(formattedPosts);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});

/**
 * @route   GET /api/saved_posts
 * @desc    Get saved posts for the current user
 * @access  Private
 */
app.get('/api/get_saved_posts', auth, async (req, res) => {
    try {
        const currentUser = await User.findById(req.session.userId);
        if (!currentUser) return res.status(404).json({ message: 'User not found' });

        const savedPostIds = currentUser.savedPosts || [];

        const posts = await Post.find({ _id: { $in: savedPostIds } })
            .sort({ created_at: -1 })
            .populate('user', 'firstName surname avatar');

        const formattedPosts = posts.map(post => ({
            id: post._id,
            user_id: post.user._id,
            author: `${post.user.firstName} ${post.user.surname}`,
            avatar: post.user.avatar || 'img/default-avatar.png',
            content: post.content,
            media: post.media,
            mediaType: post.mediaType,
            time: new Date(post.created_at).toLocaleString(),
            likes: post.likes.length,
            comments: post.comments.length,
            shares: 0,
            saved: true
        }));
        res.json(formattedPosts);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});

/**
 * @route   POST /api/toggle_save
 * @desc    Toggle save status of a post
 * @access  Private
 */
app.post('/api/toggle_save_post', auth, async (req, res) => {
    try {
        const { post_id } = req.body;
        const user = await User.findById(req.session.userId);
        
        if (!user.savedPosts) {
            user.savedPosts = [];
        }

        const index = user.savedPosts.indexOf(post_id);
        const isSaved = index !== -1;

        if (isSaved) {
            user.savedPosts.splice(index, 1); // Unsave
        } else {
            user.savedPosts.push(post_id); // Save
        }
        
        await user.save();
        res.json({ success: true, saved: !isSaved });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});

/**
 * @route   POST /api/delete_account
 * @desc    Delete user account and data
 * @access  Private
 */
app.post('/api/delete_account', auth, async (req, res) => {
    try {
        const userId = req.session.userId;
        
        // Optional: Delete all posts by this user
        await Post.deleteMany({ user: userId });

        // Delete the user
        await User.findByIdAndDelete(userId);

        // Destroy the session
        req.session.destroy();
        res.json({ success: true, message: 'Account deleted successfully' });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});

/**
 * @route   GET /api/stories
 * @desc    Fetch stories (active in last 24h)
 * @access  Private
 */
app.get('/api/get_stories', auth, async (req, res) => {
    try {
        // Calculate 24 hours ago
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        
        const stories = await Story.find({ created_at: { $gt: oneDayAgo } })
            .populate('user', 'firstName surname avatar')
            .sort({ created_at: 1 });

        // Format for frontend
        const formattedStories = stories.map(story => ({
            id: story._id,
            user_id: story.user._id,
            first_name: story.user.firstName,
            surname: story.user.surname,
            avatar: story.user.avatar,
            media: story.media,
            type: story.type,
            created_at: story.created_at,
            has_music: story.hasMusic,
            music_track: story.musicTrack,
            audience: story.audience,
            view_count: story.views.length
        }));

        res.json(formattedStories);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});

/**
 * @route   GET /api/get_reels
 * @desc    Get all reels (video posts)
 * @access  Private
 */
app.get('/api/get_reels', auth, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 5;
        const findQuery = { mediaType: 'video' };
        if (req.query.user_id) {
            findQuery.user = req.query.user_id;
        }

        const reels = await Post.find(findQuery)
            .skip((page - 1) * limit)
            .limit(limit)
            .sort({ created_at: -1 })
            .populate('user', 'firstName surname avatar');
        
        // Format for frontend
        const formattedReels = reels.map(reel => ({
            id: reel._id,
            user_id: reel.user._id,
            author: `${reel.user.firstName} ${reel.user.surname}`,
            avatar: reel.user.avatar || 'img/default-avatar.png',
            caption: reel.content,
            media: reel.media,
            likes: reel.likes.length,
            comments: reel.comments.length,
            shares: 0,
            views: reel.views?.length || 0
        }));
        res.json(formattedReels);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});

/**
 * @route   POST /api/add_comment
 * @desc    Add a comment to a post
 * @access  Private
 */
app.post('/api/add_comment', auth, upload.single('media'), async (req, res) => {
    try {
        const { post_id, parent_comment_id, content } = req.body;
        
        let mediaUrl = null;
        let mediaType = null;
        
        if (req.file) {
            mediaUrl = await uploadToR2(req.file, req.file.originalname);
            mediaType = req.file.mimetype.split('/')[0];
        }

        const comment = new Comment({
            post: post_id,
            user: req.session.userId,
            content,
            media: mediaUrl,
            mediaType: mediaType,
            parentComment: parent_comment_id || null
        });

        await comment.save();
        await comment.populate('user', 'firstName surname avatar');

        const post = await Post.findById(post_id).populate('user');

        if (parent_comment_id) {
            await Comment.findByIdAndUpdate(parent_comment_id, { $push: { replies: comment._id } });
        } else {
            await Post.findByIdAndUpdate(post_id, { $push: { comments: comment._id } });
        }

        // --- Real-time Notification Logic ---
        if (post.user._id.toString() !== req.session.userId) {
            const currentUser = await User.findById(req.session.userId);
            const notification = new Notification({
                user: post.user._id,
                trigger_user: req.session.userId,
                type: 'comment',
                content: `commented on your post`,
                target_id: post._id
            });
            await notification.save();

            io.to(post.user._id.toString()).emit('new_notification', {
                id: notification._id,
                content: notification.content,
                avatar: currentUser.avatar,
                type: 'comment',
                time: 'Just now',
                unread: true
            });
        }

        res.json({
            success: true,
            comment_id: comment._id,
            content: comment.content,
            media: comment.media,
            media_type: comment.mediaType
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Failed to add comment' });
    }
});

/**
 * @route   GET /api/get_comments
 * @desc    Get comments for a post
 * @access  Private
 */
app.get('/api/get_comments', auth, async (req, res) => {
    try {
        const { post_id } = req.query;
        const comments = await Comment.find({ post: post_id, parentComment: null })
            .populate('user', 'firstName surname avatar')
            .populate({
                path: 'replies',
                populate: { path: 'user', select: 'firstName surname avatar' }
            })
            .sort({ created_at: -1 });

        const formatComment = (c) => ({
            id: c._id,
            user_id: c.user._id,
            author: `${c.user.firstName} ${c.user.surname}`,
            avatar: c.user.avatar,
            text: c.content,
            media: c.media,
            media_type: c.mediaType,
            time: new Date(c.created_at).toLocaleString(),
            replies: c.replies ? c.replies.map(formatComment) : [],
            parent_comment_id: c.parentComment
        });

        res.json(comments.map(formatComment));
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch comments' });
    }
});

/**
 * @route   POST /api/delete_comment
 * @desc    Delete a comment
 * @access  Private
 */
app.post('/api/delete_comment', auth, async (req, res) => {
    try {
        const { comment_id } = req.body;
        const comment = await Comment.findById(comment_id);
        
        if (!comment) return res.status(404).json({ error: 'Comment not found' });
        if (comment.user.toString() !== req.session.userId) return res.status(403).json({ error: 'Unauthorized' });

        if (comment.parentComment) {
            await Comment.findByIdAndUpdate(comment.parentComment, { $pull: { replies: comment._id } });
        } else {
            await Post.findByIdAndUpdate(comment.post, { $pull: { comments: comment._id } });
        }
        
        await Comment.deleteOne({ _id: comment_id });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete comment' });
    }
});

/**
 * @route   GET /api/get_notifications
 * @desc    Get user notifications
 * @access  Private
 */
app.get('/api/get_notifications', auth, async (req, res) => {
    try {
        const notifications = await Notification.find({ user: req.session.userId })
            .sort({ created_at: -1 })
            .populate('trigger_user', 'firstName surname avatar')
            .limit(20);

        res.json(notifications.map(n => ({
            id: n._id,
            content: n.content,
            avatar: n.trigger_user ? n.trigger_user.avatar : 'img/default-avatar.png',
            type: n.type,
            time: new Date(n.created_at).toLocaleString(),
            unread: !n.is_read
        })));
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch notifications' });
    }
});

/**
 * @route   POST /api/posts
 * @desc    Create a new post
 * @access  Private
 */
app.post('/api/create_post', auth, upload.single('media'), async (req, res) => {
    try {
        const { content } = req.body;
        let mediaUrl = null;
        let mediaType = 'text';
        
        if (req.file) {
            const isVideo = req.file.mimetype.startsWith('video');
            mediaType = isVideo ? 'video' : 'image';

            // Direct upload to R2 (processing logic removed as binaries aren't supported)
            mediaUrl = await uploadToR2(req.file, req.file.originalname);
        }

        const newPost = new Post({
            user: req.session.userId,
            content: content,
            media: mediaUrl,
            mediaType: mediaType
        });

        await newPost.save();
        
        // Populate user details to send back to frontend immediately
        await newPost.populate('user', 'firstName surname avatar');

        res.json({ success: true, post: newPost });
    } catch (err) {
        console.error('Post creation error:', err.message);
        res.status(500).json({ error: 'Failed to create post' });
    }
});

/**
 * @route   POST /api/create_story
 * @desc    Create a new story
 * @access  Private
 */
app.post('/api/create_story', auth, upload.single('media'), async (req, res) => {
    try {
        const { type, audience, has_music, music_track } = req.body;
        
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'No media file uploaded.' });
        }

        // Upload story media to R2 (no processing for this example, but you could add it)
        const mediaUrl = await uploadToR2(req.file, req.file.originalname);

        const newStory = new Story({
            user: req.session.userId,
            media: mediaUrl, // Use R2 URL
            type: type || req.file.mimetype.split('/')[0],
            audience: audience || 'public',
            has_music: has_music === '1',
            music_track: music_track || null
        });

        await newStory.save();
        
        res.json({ success: true, story: newStory });
    } catch (err) {
        console.error('Story creation error:', err.message);
        res.status(500).json({ success: false, error: 'Failed to create story' });
    }
});

/**
 * @route   POST /api/send_message
 * @desc    Send a message (text or media)
 * @access  Private
 */
app.post('/api/send_message', auth, upload.single('media'), async (req, res) => {
    try {
        const { content, media_type, receiver_id, group_id, reply_to_id } = req.body;

        const messageData = {
            sender: req.session.userId,
            content: content,
            media_type: media_type || 'text',
            reply_to: reply_to_id || null,
        };

        if (group_id) {
            messageData.group = group_id;
        } else {
            messageData.receiver = receiver_id;
        }

        if (req.file) {
            // Upload chat media to R2
            messageData.media = await uploadToR2(req.file, req.file.originalname);
            messageData.media_type = req.file.mimetype.split('/')[0]; // 'image', 'video', 'audio'
        }

        const newMessage = new Message(messageData);
        await newMessage.save();
        await newMessage.populate('sender', 'firstName surname avatar');

        // Emit via socket to the receiver or group
        const targetId = group_id ? `group_${group_id}` : receiver_id;
        io.to(targetId).emit('receive_message', newMessage.toObject());

        res.json({ success: true, message: newMessage });

    } catch (err) {
        console.error('Send message error:', err.message);
        res.status(500).json({ success: false, error: 'Failed to send message' });
    }
});

/**
 * @route   POST /api/delete_post
 * @desc    Delete a post and its media from R2
 * @access  Private
 */
app.post('/api/delete_post', auth, async (req, res) => {
    try {
        const { post_id } = req.body;
        const post = await Post.findById(post_id);

        if (!post) {
            return res.status(404).json({ error: 'Post not found' });
        }

        // Check if the current user is the author of the post
        if (post.user.toString() !== req.session.userId) {
            return res.status(403).json({ error: 'You are not authorized to delete this post' });
        }

        // If there's media, delete it from R2
        if (post.media) {
            await deleteFromR2(post.media);
        }

        // Delete all comments associated with the post
        await Comment.deleteMany({ post: post_id });

        // Delete the post itself
        await Post.findByIdAndDelete(post_id);

        res.json({ success: true, message: 'Post deleted successfully' });
    } catch (err) {
        console.error('Delete post error:', err.message);
        res.status(500).json({ error: 'Failed to delete post' });
    }
});

/**
 * @route   POST /api/delete_story
 * @desc    Delete a story and its media from R2
 * @access  Private
 */
app.post('/api/delete_story', auth, async (req, res) => {
    try {
        const { story_id } = req.body;
        const story = await Story.findById(story_id);

        if (!story) return res.status(404).json({ error: 'Story not found' });
        if (story.user.toString() !== req.session.userId) return res.status(403).json({ error: 'Unauthorized' });
        if (story.media) await deleteFromR2(story.media);

        await Story.findByIdAndDelete(story_id);
        res.json({ success: true });
    } catch (err) {
        console.error('Delete story error:', err.message);
        res.status(500).json({ error: 'Failed to delete story' });
    }
});

/**
 * @route   GET /maiga
 * @desc    Serve the main app page
 * @access  Private
 */
app.get('/home', auth, (req, res) => {
    // We serve the file that was previously maiga.js, now treated as HTML
    res.sendFile(path.resolve(__dirname, 'maiga.html'));
});

/**
 * @route   GET /ysu
 * @desc    Serve the YSU specific login page
 * @access  Public
 */
app.get('/ysu', (req, res) => {
    res.sendFile(path.resolve(__dirname, 'ysu.html'));
});

/**
 * @route   GET /api/auth/google
 * @desc    Mock Google Login (Simulated for Demo)
 * @access  Public
 */
app.get('/api/auth/google', async (req, res) => {
    try {
        let user = await User.findOne({ email: 'google_demo@maiga.social' });
        if (!user) {
            const hashedPassword = await bcrypt.hash('social123', 10);
            user = new User({
                firstName: 'Google', surname: 'User', username: 'google_demo',
                email: 'google_demo@maiga.social', password: hashedPassword,
                phone: '0000000000', birthday: new Date(), gender: 'other',
                avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Google'
            });
            await user.save();
        }
        req.session.userId = user._id;
        res.redirect('/maiga');
    } catch (err) { console.error(err); res.redirect('/'); }
});

/**
 * @route   GET /api/auth/facebook
 * @desc    Mock Facebook Login (Simulated for Demo)
 * @access  Public
 */
app.get('/api/auth/facebook', async (req, res) => {
    try {
        let user = await User.findOne({ email: 'facebook_demo@maiga.social' });
        if (!user) {
            const hashedPassword = await bcrypt.hash('social123', 10);
            user = new User({
                firstName: 'Facebook', surname: 'User', username: 'facebook_demo',
                email: 'facebook_demo@maiga.social', password: hashedPassword,
                phone: '0000000000', birthday: new Date(), gender: 'other',
                avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Facebook'
            });
            await user.save();
        }
        req.session.userId = user._id;
        res.redirect('/maiga');
    } catch (err) { console.error(err); res.redirect('/'); }
});

/**
 * @route   GET /
 * @desc    Serve the main HTML file
 * @access  Public
 */
app.get('/', (req, res) => {
    res.sendFile(path.resolve(__dirname, 'index.html'));
});


// --- Socket.io Real-time Logic ---
io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    // Client joins their specific room based on User ID
    socket.on('join_room', (userId) => {
        socket.join(userId);
        console.log(`User ${userId} joined their room.`);
    });

    // Client joins a group room
    socket.on('join_group', (groupId) => {
        socket.join(`group_${groupId}`);
    });

    // Handle typing events
    socket.on('typing', (data) => {
        const { chat_id, is_group, sender_id } = data;
        const target = is_group ? `group_${chat_id}` : chat_id;
        
        // Broadcast to target (Group room or Receiver ID)
        socket.to(target).emit('display_typing', {
            chat_id: is_group ? chat_id : sender_id, // If 1-on-1, the chat_id for receiver IS the sender
            sender_id: sender_id
        });
    });

    // Handle sending messages
    socket.on('send_message', (data) => {
        // Emit to the specific receiver
        io.to(data.receiver_id).emit('receive_message', data);
    });

    socket.on('update_last_seen', () => {
        // Placeholder for heartbeat event if index.js is the active server
        // In a real implementation with auth, we would update the DB here
        // e.g. if(socket.userId) User.findByIdAndUpdate(...)
    });

    socket.on('disconnect', () => {
        console.log('User disconnected');
    });
});

// --- Server Start ---
// Workers Entry Point
export default {
    async fetch(request, env, ctx) {
        return app(request, env, ctx);
    },
};