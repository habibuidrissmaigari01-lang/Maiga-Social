require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const passport = require('passport');
const { DeleteObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');

// Updated paths because routes were moved into the public folder
const authRoutes = require('./public/routes/auth');
const mainRoutes = require('./public/routes/main');
const { isAuthenticated } = require('./middleware');
// Models are now in the same directory
const { User, Message, Post, Group, Story, Call, Setting, Comment, s3Client, setIo } = require('./models'); 

const app = express();
const server = http.createServer(app);

// Increase timeout settings to accommodate large file uploads (e.g., 10 minutes)
server.timeout = 600000;
server.keepAliveTimeout = 120000;
server.headersTimeout = 125000;

const io = new Server(server);
setIo(io); // Connect Socket.io to Mongoose middleware

// --- Mongoose 8 Configuration ---
// Explicitly set strictQuery to maintain predictable filtering behavior
mongoose.set('strictQuery', false);

// --- Configuration ---
const PORT = parseInt(process.env.PORT, 10) || 3000;
const MONGO_URI = process.env.MONGO_URL || process.env.MONGODB_URL;
const SESSION_SECRET = process.env.SESSION_SECRET; 

// Robust URL handling: ensure no trailing slash on the public URL
let R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;
if (R2_PUBLIC_URL && R2_PUBLIC_URL.endsWith('/')) {
    R2_PUBLIC_URL = R2_PUBLIC_URL.slice(0, -1);
}

// --- Startup Environment Validation ---
const requiredEnvVars = [
    { name: 'MONGO_URL', value: MONGO_URI },
    { name: 'SESSION_SECRET', value: SESSION_SECRET },
    { name: 'R2_ACCESS_KEY_ID', value: process.env.R2_ACCESS_KEY_ID },
    { name: 'R2_SECRET_ACCESS_KEY', value: process.env.R2_SECRET_ACCESS_KEY },
    { name: 'R2_BUCKET_NAME', value: process.env.R2_BUCKET_NAME },
    { name: 'R2_S3_API_URL', value: process.env.R2_S3_API_URL },
    { name: 'R2_PUBLIC_URL', value: R2_PUBLIC_URL },
    { name: 'BREVO_API_KEY', value: process.env.BREVO_API_KEY },
    { name: 'SENDER_EMAIL', value: process.env.SENDER_EMAIL }
];

const missingVars = requiredEnvVars.filter(v => !v.value);

if (missingVars.length > 0) {
    process.exit(1);
}

// --- Middleware ---
app.set('trust proxy', 1); // Required for secure cookies on Railway
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Content Security Policy Middleware ---
app.use((req, res, next) => {
    const r2Domain = R2_PUBLIC_URL ? new URL(R2_PUBLIC_URL).hostname : '';
     
    // Identify admin requests to provide a slightly more flexible policy
    const isAdminRequest = req.path.startsWith('/admin') || req.path.includes('monitor.html');
    
    // If not admin, restrict to specific file paths instead of entire domains
    const cdnSources = isAdminRequest 
        ? "https://cdn.jsdelivr.net https://cdnjs.cloudflare.com" 
        : "https://cdn.jsdelivr.net/npm/chart.js https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.23/jspdf.plugin.autotable.min.js";

    res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; " +
       `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data: https://apis.google.com https://connect.facebook.net https://www.googletagmanager.com https://static.cloudflareinsights.com https://www.google-analytics.com ${cdnSources}; ` +
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; " +
        `img-src 'self' data: blob: https://*.googleusercontent.com https://*.facebook.com ${r2Domain} https://api.dicebear.com https://images.unsplash.com https://img.icons8.com https://user-images.githubusercontent.com https://api.qrserver.com https://placehold.co; ` +
        `media-src 'self' data: blob: ${r2Domain} https://assets.mixkit.co https://actions.google.com https://www.soundhelix.com; ` +
        "font-src 'self' data: https://fonts.gstatic.com https://cdnjs.cloudflare.com; " +
        `connect-src 'self' https://*.google.com https://*.facebook.com https://*.google-analytics.com https://*.turnix.io ${r2Domain} https://api.qrserver.com wss:; ` +
        "frame-src 'self' https://accounts.google.com https://www.facebook.com https://www.google.com; " +
        "worker-src 'self' blob:; " +
        "manifest-src 'self'; " +
        "object-src 'none'; " +
        "base-uri 'self' https://accounts.google.com; " +
        "form-action 'self';"
    );
    next();
});

// --- Maintenance Middleware ---
const checkMaintenance = async (req, res, next) => {
    try {
        const maintenanceSetting = await Setting.findOne({ key: 'maintenance_mode' });
        const isMaintenance = maintenanceSetting ? maintenanceSetting.value : false;

        if (isMaintenance) {
            const user = await User.findById(req.session.userId);
            if (user && user.is_admin) return next();
            
            const untilSetting = await Setting.findOne({ key: 'maintenance_until' });
            return res.status(503).json({ error: 'Maintenance Mode', until: untilSetting ? untilSetting.value : null });
        }
        next();
    } catch (err) {
        next();
    }
};

app.use((req, res, next) => {
    req.io = io;
    next();
});

// Middleware to check for Admin privileges
const isAdmin = async (req, res, next) => {
    // isAuthenticated should have already set req.session.userId
    if (!req.session.userId) {
        // This case should ideally be caught by isAuthenticated first,
        // but it's a good fallback.
        return res.redirect('/'); 
    }
    const user = await User.findById(req.session.userId);
    if (user && user.is_admin) {
        return next();
    }
    // If authenticated but not admin, redirect to home
    return res.redirect('/home'); 
};
// Session Setup
const mongoConnection = mongoose.connect(MONGO_URI, {
    // Prevent the app from hanging forever if DB is down
    serverSelectionTimeoutMS: 5000, 
    connectTimeoutMS: 10000,
});

app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true, // Renew session on each request
    store: MongoStore.create({
        mongoUrl: MONGO_URI,
        collectionName: 'sessions',
        ttl: 60 * 60 * 24 * 7, // 1 week in seconds
        stringify: false,
        autoRemove: 'interval'
    }),
    cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 1000 * 60 * 60 * 24 * 7 // Persist for 1 week
    }
}));

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
    try {
        const user = await User.findById(id);
        done(null, user);
    } catch (err) { done(err, null); }
});

// --- Background Tasks ---
const cleanupExpiredStories = async () => {
    try {
        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const query = { createdAt: { $lt: yesterday } };

        // 1. Find stories with media to clean up R2 first
        const expiredWithMedia = await Story.find({ ...query, media: { $exists: true, $not: { $size: 0 } } });
        
        for (const story of expiredWithMedia) {
            const mediaArray = Array.isArray(story.media) ? story.media : [story.media];
            for (const m of mediaArray) {
                if (m && m.startsWith('http')) {
                    try {
                        const url = new URL(m);
                        const key = url.pathname.startsWith('/') ? url.pathname.substring(1) : url.pathname;
                        await s3Client.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key }));
                    } catch (err) { /* Silent fail for R2 deletion */ }
                }
            }
        }

        // 2. Perform batch delete from Database
        await Story.deleteMany(query);
    } catch (err) {
    }
};

const cleanupExpiredMessages = async () => {
    try {
        const now = new Date();
        const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        
        // Find messages that are either 30 days old OR have passed their specific expires_at date
        const query = {
            $or: [
                { createdAt: { $lt: thirtyDaysAgo } },
                { expires_at: { $lt: now } }
            ]
        };

        // 1. Find those with media to clean up R2 first
        const expiredWithMedia = await Message.find({ ...query, media: { $exists: true, $ne: null } });
        
        for (const msg of expiredWithMedia) {
            if (msg.media && msg.media.startsWith('http')) {
                try {
                    const url = new URL(msg.media);
                    const key = url.pathname.startsWith('/') ? url.pathname.substring(1) : url.pathname;
                    await s3Client.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key }));
                } catch (err) { }
            }
        }

        // 2. Perform batch delete from Database
        await Message.deleteMany(query);
    } catch (err) { }
};

const cleanupExpiredPosts = async () => {
    try {
        const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000); // 1 year ago
        const expiredPosts = await Post.find({ createdAt: { $lt: oneYearAgo } });

        if (expiredPosts.length > 0) {
            for (const post of expiredPosts) {
                // Calling deleteOne on the query triggers the hook in models.js for R2 cleanup
                await Post.deleteOne({ _id: post._id });
            }
        }
    } catch (err) {
    }
};

const runWeeklyOrphanCleanup = async () => {
    try {
        const enabledSetting = await Setting.findOne({ key: 'auto_cleanup_enabled' });
        if (!enabledSetting || !enabledSetting.value) return;

        console.info('[Auto-Cleanup] Starting weekly orphaned file scan...');

        // 1. Get all objects from R2
        const listCommand = new ListObjectsV2Command({ Bucket: process.env.R2_BUCKET_NAME });
        const r2Data = await s3Client.send(listCommand);
        if (!r2Data.Contents || r2Data.Contents.length === 0) return;

        // 2. Aggregate all media references from database
        const [users, posts, stories, messages, comments, groups] = await Promise.all([
            User.find({}, 'avatar banner'),
            Post.find({}, 'media'),
            Story.find({}, 'media'),
            Message.find({}, 'media'),
            Comment.find({}, 'media'),
            Group.find({}, 'avatar')
        ]);

        const dbUrls = new Set();
        users.forEach(u => { if (u.avatar) dbUrls.add(u.avatar); if (u.banner) dbUrls.add(u.banner); });
        groups.forEach(g => { if (g.avatar) dbUrls.add(g.avatar); });
        posts.forEach(p => p.media.forEach(m => dbUrls.add(m)));
        stories.forEach(s => s.media.forEach(m => dbUrls.add(m)));
        messages.forEach(m => { if (m.media) dbUrls.add(m.media); });
        comments.forEach(c => { if (c.media) dbUrls.add(c.media); });

        // 3. Filter for orphans
        const orphans = r2Data.Contents.filter(obj => {
            return ![...dbUrls].some(url => url && url.includes(obj.Key));
        }).map(obj => ({ Key: obj.Key }));

        if (orphans.length > 0) {
            // R2 DeleteObjects supports max 1000 keys per request
            for (let i = 0; i < orphans.length; i += 1000) {
                const chunk = orphans.slice(i, i + 1000);
                await s3Client.send(new DeleteObjectsCommand({
                    Bucket: process.env.R2_BUCKET_NAME,
                    Delete: { Objects: chunk }
                }));
            }
            console.info(`[Auto-Cleanup] Successfully deleted ${orphans.length} orphaned files.`);
        } else {
            console.info('[Auto-Cleanup] No orphaned files found.');
        }
    } catch (err) {
        console.error('[Auto-Cleanup] Error during scheduled cleanup:', err);
    }
};

// MongoDB Connection
mongoConnection.then(() => {
    // --- Mongoose 8 Change Stream: Read Receipts ---
    try {
        const messageChangeStream = Message.watch([], { fullDocument: 'updateLookup' });
        messageChangeStream.on('change', (change) => {
            if (change.operationType === 'update') {
                const doc = change.fullDocument;
                const updatedFields = change.updateDescription.updatedFields;

                // Trigger event if is_read or read_by is updated
                if (updatedFields.is_read === true || updatedFields.read_by) {
                    io.to(doc.sender.toString()).emit('read_receipt', {
                        message_id: doc._id,
                        read_by: doc.read_by,
                        is_read: doc.is_read
                    });
                }
            }
        });
    } catch (streamErr) { }

    // Run cleanups immediately on start, then every 60 minutes
    const runAllCleanups = () => {
        cleanupExpiredStories();
        cleanupExpiredMessages();
        cleanupExpiredPosts();
    };

    runAllCleanups();
    setInterval(runAllCleanups, 60 * 60 * 1000);
    // Run orphan cleanup every 7 days
    setInterval(runWeeklyOrphanCleanup, 7 * 24 * 60 * 60 * 1000);
}).catch(err => { });

// --- Routes ---
app.get('/api/get_ice_credentials', async (req, res) => {
    const fallbackStun = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' }
    ];

    try {
        const apiKey = process.env.TURNEX_SECRET_KEY;
        
        if (!apiKey) {
            console.warn('TURNEX_SECRET_KEY missing in .env, falling back to STUN only');
            return res.json(fallbackStun);
        }

        const response = await fetch(`https://api.turnix.io/v1/turn/credentials?apiKey=${apiKey}`, { timeout: 5000 });
        const iceServersData = await response.json();
        // Ensure we return the actual array. Turnix usually wraps it in an 'iceServers' key.
        res.json(iceServersData.iceServers || iceServersData);
    } catch (error) {
        res.json(fallbackStun);
    }
});

app.use('/api', authRoutes); // Auth (login/reg) should always be accessible to check user type
app.use('/api', checkMaintenance, mainRoutes);

server.listen(PORT, '0.0.0.0');

// --- Health Check Endpoint ---
app.get('/api/health', async (req, res) => {
    const healthcheck = {
        uptime: process.uptime(),
        message: 'OK',
        timestamp: Date.now(),
        mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
    };
    try {
        res.send(healthcheck);
    } catch (e) {
        healthcheck.message = e;
        res.status(503).send(healthcheck);
    }
});

// --- Socket.io Logic ---
io.on('connection', (socket) => {
    socket.on('join_room', async (userId) => {
        socket.join(userId);

        // Only perform database operations if the room name is a valid MongoDB User ID
        if (mongoose.Types.ObjectId.isValid(userId)) {
            socket.userId = userId;

            // Automatically join rooms for all groups the user is a member of
            const userGroups = await Group.find({ 'members.user': userId }, '_id');
            userGroups.forEach(group => {
                socket.join(`group_${group._id}`);
            });

            const now = new Date();
            await User.findByIdAndUpdate(userId, { online: true, last_seen: now });
            // Broadcast to everyone that this user is now online
            socket.broadcast.emit('user_status', { userId: userId, status: 'online', lastSeen: now });
        }
    });
    socket.on('join_group', (groupId) => socket.join(`group_${groupId}`));
    socket.on('typing', async (data) => {
        const target = data.group_id ? `group_${data.group_id}` : data.receiver_id;
        const user = await User.findById(data.sender_id).select('name');
        socket.to(target).emit('display_typing', {
            chat_id: data.group_id || data.receiver_id, // Use receiver_id for 1-on-1 chats
            sender_id: data.sender_id,
            is_group: !!data.group_id,
            sender_name: user?.name?.split(' ')[0] || 'Someone'
        });
        // Set a timeout to automatically send 'hide_typing' if no further typing events
        clearTimeout(socket.typingTimeout);
        socket.typingTimeout = setTimeout(() => { socket.to(target).emit('hide_typing', { chat_id: data.group_id || data.receiver_id, sender_id: data.sender_id, is_group: !!data.group_id }); }, 3000); // Hide after 3 seconds of no activity
    });
    socket.on('call_user', async (data) => {
        try {
            const caller = await User.findById(data.from);
            const receiver = await User.findById(data.userToCall);
            if (caller && receiver && (caller.is_admin || (!caller.blocked_users.includes(receiver._id) && !receiver.blocked_users.includes(caller._id)))) {
                // Create call record in DB
                const call = await Call.create({
                    caller: data.from,
                    receiver: data.userToCall,
                    type: data.type,
                    status: 'ringing'
                });

                io.to(data.userToCall).emit('incoming_call', { 
                    callId: call._id,
                    signal: data.signalData, 
                    from: data.from, 
                    name: data.name, 
                    avatar: data.avatar, 
                    type: data.type 
                });
            } else { io.to(data.from).emit('call_ended'); }
        } catch (e) { }
    });
    socket.on('answer_call', async (data) => {
        await Call.findByIdAndUpdate(data.callId, { status: 'accepted', is_missed: false });
        io.to(data.to).emit('call_accepted', data.signal);
    });
    socket.on('ice_candidate', (data) => io.to(data.to).emit('ice_candidate', data.candidate));
    socket.on('end_call', async (data) => {
        await Call.findByIdAndUpdate(data.callId, { status: 'ended', duration: data.duration || 0 });
        io.to(data.to).emit('call_ended');
    });
    socket.on('reject_call', async (data) => {
        await Call.findByIdAndUpdate(data.callId, { status: 'rejected' });
        io.to(data.to).emit('call_ended');
    });
    socket.on('mark_seen', async (data) => {
        if (!socket.userId) return;
        
        const filter = data.type === 'group' 
            ? { group: data.chat_id, 'read_by.user': { $ne: socket.userId } }
            : { sender: data.chat_id, receiver: socket.userId, is_read: false, group: null };

        // Persist the seen status to the database
        // This triggers the Mongoose Change Stream which emits 'read_receipt'
        const user = await User.findById(socket.userId).select('name');
        if (!user) return;
        await Message.updateMany(filter, { 
            $set: { is_read: true },
            $addToSet: { read_by: { user: socket.userId, first_name: (user.name || 'User').split(' ')[0] } } 
        });

        const target = data.type === 'group' ? `group_${data.chat_id}` : data.chat_id;
        io.to(target).emit('messages_seen', { viewer_id: socket.userId });
    });
    socket.on('message_received', async (data) => {
        if (!socket.userId || !data.message_id) return;
        
        const msg = await Message.findByIdAndUpdate(data.message_id, { 
            $set: { is_delivered: true, delivered_at: new Date() } 
        }, { new: true });

        if (msg) {
            // Notify the sender that the message was delivered
            io.to(msg.sender.toString()).emit('message_delivered', { message_id: msg._id });
        }
    });
    socket.on('update_last_seen', () => {
        if (socket.userId) {
            const now = new Date();
            User.findByIdAndUpdate(socket.userId, { last_seen: now, online: true }).exec();
            socket.broadcast.emit('user_status', { userId: socket.userId, status: 'online', lastSeen: now });
        }
    });
    socket.on('disconnect', () => {
        if (socket.userId) {
            const now = new Date();
            User.findByIdAndUpdate(socket.userId, { online: false, last_seen: now }).exec();
            // Notify everyone that this user went offline
            socket.broadcast.emit('user_status', { userId: socket.userId, status: 'offline', lastSeen: now });
            if (socket.typingTimeout) clearTimeout(socket.typingTimeout); // Clear any pending typing timeouts
        }
    });
});

// --- Auth Protection ---
const requireLogin = (req, res, next) => {
    if (req.session.userId) {
        next();
    } else {
        res.redirect('/'); 
    }
};

// Intercept app routes to check session and serve the shell
app.get(['/maiga.html', '/maiga', '/home'], requireLogin, (req, res) => {
    // Adjusted path to find the HTML in the public subfolder
    res.sendFile(path.join(__dirname, 'public', 'maiga.html'));
});

// Explicit route for YSU portal (Always accessible without login)
app.get(['/ysu', '/ysu.html'], (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'ysu.html'));
});

// NEW: Admin panel route with authentication and admin check
app.get('/admin', isAuthenticated, isAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'monitor.html'));
});

// NEW: Middleware to restrict direct access to sensitive files
// This is placed BEFORE express.static to intercept the requests
app.use(async (req, res, next) => {
    const protectedFiles = ['/maiga.js', '/offline.html'];
    const adminFiles = ['/monitor.html'];
    
    if (protectedFiles.includes(req.path) && !req.session.userId) {
        return res.redirect('/');
    }

    if (adminFiles.includes(req.path)) {
        if (!req.session.userId) return res.redirect('/');
        const user = await User.findById(req.session.userId);
        if (!user || !user.is_admin) return res.redirect('/home');
    }
    next();
});

// Serve static assets ONLY from the public folder
// This ensures api.js, models.js, and .env are NOT accessible via browser
app.use(express.static(path.join(__dirname, 'public')));

// Fallback for root route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Generic Error Handling ---
app.use((err, req, res, next) => {
    // Server-side Log File Writer
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${req.method} ${req.url}\n` +
                     `User: ${req.session?.userId || 'Guest'}\n` +
                     `Error: ${err.message}\n` +
                     `${err.stack}\n` +
                     `${'-'.repeat(50)}\n`;

    fs.appendFile(path.join(__dirname, 'server_errors.log'), logEntry, (fsErr) => {
        if (fsErr) console.error('Failed to write to error log file:', fsErr);
    });

    res.status(err.status || 500).json({ message: err.message || 'Internal Server Error' });
});