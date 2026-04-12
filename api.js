require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
const webpush = require('web-push');

// Updated paths because routes were moved into the public folder
const authRoutes = require('./public/routes/auth');
const mainRoutes = require('./public/routes/main');
const { isAuthenticated } = require('./middleware');
// Models are now in the same directory
const { User, Message, Post, Group, Story, Call, Setting, s3Client, setIo } = require('./models'); 

const app = express();
const activeCallTimeouts = new Map();

const server = http.createServer(app);
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

// --- Background Call Rejection API ---
// This endpoint is called by the Service Worker when a user clicks "Decline" on a push notification
app.post('/api/reject_call_background', async (req, res) => {
    const { callId, callerId } = req.body;
    if (activeCallTimeouts.has(callId)) {
        clearTimeout(activeCallTimeouts.get(callId));
        activeCallTimeouts.delete(callId);
    }

    try {
        const call = await Call.findByIdAndUpdate(callId, { status: 'rejected' }, { new: true }).populate('caller');
        if (io) io.to(callerId).emit('call_ended');
        
        // Send a "Missed Call" notification to the receiver to replace the ringing one
        const receiver = await User.findById(call.receiver);
        if (receiver && receiver.push_subscription) {
            const payload = JSON.stringify({
                title: `Missed ${call.type} call`,
                body: `Call from ${call.caller.name} declined`,
                icon: call.caller.avatar,
                tag: 'call-notification', // Same tag replaces the active "Incoming" notification
                data: { url: '/home?activeTab=calls' },
                requireInteraction: false // This one can fade away normally
            });
            webpush.sendNotification(receiver.push_subscription, payload).catch(() => {});
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
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
}).catch(err => { });

// --- Routes ---
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
            if (caller && receiver && !caller.blocked_users.includes(receiver._id) && !receiver.blocked_users.includes(caller._id)) {
                // Create call record in DB
                const call = await Call.create({
                    caller: data.from,
                    receiver: data.userToCall,
                    type: data.type,
                    status: 'ringing',
                    sdp_offer: JSON.stringify(data.signalData)
                });

                io.to(data.userToCall).emit('incoming_call', { 
                    callId: call._id,
                    signal: data.signalData, 
                    from: data.from, 
                    name: data.name, 
                    avatar: data.avatar, 
                    type: data.type 
                });

                 // Set 45-second timeout for the call
                const timeout = setTimeout(async () => {
                    const currentCall = await Call.findById(call._id).populate('caller receiver');
                    if (currentCall && currentCall.status === 'ringing') {
                        currentCall.status = 'ended';
                        currentCall.is_missed = true;
                        await currentCall.save();

                        io.to(data.from).emit('call_ended');
                        io.to(data.userToCall).emit('call_ended');

                        if (currentCall.receiver.push_subscription) {
                            const missedPayload = JSON.stringify({
                                title: `Missed ${currentCall.type} call`,
                                body: `${currentCall.caller.name} called you`,
                                icon: currentCall.caller.avatar,
                                tag: 'call-notification',
                                data: { url: '/home?activeTab=calls' },
                                requireInteraction: false
                            });
                            webpush.sendNotification(currentCall.receiver.push_subscription, missedPayload).catch(() => {});
                        }
                    }
                    activeCallTimeouts.delete(call._id.toString());
                }, 45000);
                activeCallTimeouts.set(call._id.toString(), timeout);

                // Send Push Notification for Background/Out-of-app support
                if (receiver.push_subscription) {
                    const payload = JSON.stringify({
                        title: `Incoming ${data.type} call`,
                        body: `${data.name} is calling you...`,
                        icon: data.avatar,
                        tag: 'call-notification',
                        data: {
                            url: `/home?callId=${call._id}&type=${data.type}`,
                            type: 'call',
                            callId: call._id,
                            callerId: data.from
                        },
                        actions: [
                            { action: 'answer', title: 'Answer' },
                            { action: 'decline', title: 'Decline' }
                        ],
                        // Rhythmic vibration to simulate a ringtone
                        vibrate: [500, 110, 500, 110, 450, 110, 200, 110, 170, 40, 450, 110, 200, 110, 170, 40],
                        renotify: true,
                        requireInteraction: true // Keep notification visible until user acts
                    });

                    webpush.sendNotification(receiver.push_subscription, payload).catch(err => {
                        if (err.statusCode === 410 || err.statusCode === 404) {
                            User.findByIdAndUpdate(receiver._id, { $unset: { push_subscription: 1 } }).exec();
                        }
                    });
                }
            } else { io.to(data.from).emit('call_ended'); }
        } catch (e) { }
    });
    socket.on('answer_call', async (data) => {
        const cid = data.callId?.toString();
        if (cid && activeCallTimeouts.has(cid)) {
            clearTimeout(activeCallTimeouts.get(cid));
            activeCallTimeouts.delete(cid);
        }
        await Call.findByIdAndUpdate(data.callId, { status: 'accepted', is_missed: false, sdp_answer: JSON.stringify(data.signal) }).populate('caller receiver');
        io.to(data.to).emit('call_accepted', data.signal);
    });
    socket.on('ice_candidate', (data) => io.to(data.to).emit('ice_candidate', data.candidate));
    socket.on('end_call', async (data) => {
         const cid = data.callId?.toString();
        if (cid && activeCallTimeouts.has(cid)) {
            clearTimeout(activeCallTimeouts.get(cid));
            activeCallTimeouts.delete(cid);
        }
        const call = await Call.findById(data.callId).populate('caller receiver');
        if (!call) return;

        const wasRinging = call.status === 'ringing';
        call.status = 'ended';
        call.duration = data.duration || 0;
        await call.save();

        io.to(data.to).emit('call_ended');

        // If the caller ends the call while it's still ringing, notify the receiver they missed it
        if (wasRinging && call.receiver.push_subscription) {
            const missedPayload = JSON.stringify({
                title: `Missed ${call.type} call`,
                body: `${call.caller.name} called you`,
                icon: call.caller.avatar,
                tag: 'call-notification', // Replaces the ringing notification
                data: { url: '/home?activeTab=calls' },
                requireInteraction: false
            });
            webpush.sendNotification(call.receiver.push_subscription, missedPayload).catch(() => {});
        }
    });
    socket.on('reject_call', async (data) => {
        const cid = data.callId?.toString();
        if (cid && activeCallTimeouts.has(cid)) {
            clearTimeout(activeCallTimeouts.get(cid));
            activeCallTimeouts.delete(cid);
        }

        const call = await Call.findByIdAndUpdate(data.callId, { status: 'rejected' }, { new: true }).populate('caller receiver');
        io.to(data.to).emit('call_ended');

        // If the receiver manually declines in-app, send a push to clear any background notification on other devices
        if (call && call.receiver.push_subscription) {
            const missedPayload = JSON.stringify({
                title: `Missed ${call.type} call`,
                body: `You declined a call from ${call.caller.name}`,
                icon: call.caller.avatar,
                tag: 'call-notification',
                data: { url: '/home?activeTab=calls' },
                requireInteraction: false
            });
            webpush.sendNotification(call.receiver.push_subscription, missedPayload).catch(() => {});
        }
    });
    socket.on('mark_seen', async (data) => {
        if (!socket.userId) return;
        
        const filter = data.type === 'group' 
            ? { group: data.chat_id, 'read_by.user': { $ne: socket.userId } }
            : { sender: data.chat_id, receiver: socket.userId, is_read: false, group: null };

        // Persist the seen status to the database
        // This triggers the Mongoose Change Stream which emits 'read_receipt'
        const user = await User.findById(socket.userId);
        await Message.updateMany(filter, { 
            $set: { is_read: true },
            $addToSet: { read_by: { user: socket.userId, first_name: user.name.split(' ')[0] } } 
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

// Intercept maiga.html to check session
app.get('/maiga.html', requireLogin, (req, res) => {
    // Adjusted path to find the HTML in the public subfolder
    res.sendFile(path.join(__dirname, 'public', 'maiga.html'));
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
    res.status(err.status || 500).json({ message: err.message || 'Internal Server Error' });
});