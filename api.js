require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const multer = require('multer');
const fs = require('fs');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const webpush = require('web-push');

// Updated paths because routes were moved into the public folder
const authRoutes = require('./public/routes/auth');
const mainRoutes = require('./public/routes/main');
const { isAuthenticated } = require('./middleware');
// Models are now in the same directory
const { User, Message, Post, Comment, Group, setIo, setS3 } = require('./models'); 

const app = express();
const server = http.createServer(app);
const io = new Server(server);
setIo(io); // Connect Socket.io to Mongoose middleware

// Cloudflare R2 Configuration
const s3Client = new S3Client({
    region: 'auto',
    endpoint: process.env.R2_S3_API_URL,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
});
setS3(s3Client); // Inject S3 client into models for hooks

const upload = multer({ storage: multer.memoryStorage() });

// --- Mongoose 8 Configuration ---
// Explicitly set strictQuery to maintain predictable filtering behavior
mongoose.set('strictQuery', false);

// --- Configuration ---
const PORT = process.env.PORT || 3000;
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
    { name: 'R2_PUBLIC_URL', value: R2_PUBLIC_URL }
];

const missingVars = requiredEnvVars.filter(v => !v.value);

if (missingVars.length > 0) {
    missingVars.forEach(v => console.error(`CRITICAL ERROR: ${v.name} is not defined in environment variables.`));
    console.error("Please check your Railway Dashboard -> Variables tab and ensure all Database and R2 keys are present.");
    process.exit(1);
}

// --- Middleware ---
app.set('trust proxy', 1); // Required for secure cookies on Railway
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
    store: MongoStore.create({
        mongoUrl: MONGO_URI,
        collectionName: 'sessions',
        stringify: false,
        autoRemove: 'interval'
    }),
    cookie: { 
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production', // Only send over HTTPS in production
        sameSite: 'lax'
    }
}));

// --- Global Error Handling for Crash Loops ---
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// MongoDB Connection
mongoConnection
    .then(() => {
        console.log("Successfully connected to MongoDB");
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
        } catch (streamErr) {
            console.warn("Change Streams not supported on this DB deployment. Read receipts will not be real-time.");
        }
    })
    .catch(err => {
        console.error("MongoDB connection error:", err);
    });

// Start listening immediately so Railway's health check passes
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

// --- Routes ---
app.use('/api', authRoutes);
app.use('/api', mainRoutes);

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
        socket.userId = userId;
        
        // Automatically join rooms for all groups the user is a member of
        const userGroups = await Group.find({ 'members.user': userId }, '_id');
        userGroups.forEach(group => {
            socket.join(`group_${group._id}`);
        });

        await User.findByIdAndUpdate(userId, { online: true });
    });
    socket.on('join_group', (groupId) => socket.join(`group_${groupId}`));
    socket.on('typing', (data) => {
        const target = data.group_id ? `group_${data.group_id}` : data.receiver_id;
        socket.to(target).emit('display_typing', { chat_id: data.sender_id, sender_id: data.sender_id, is_group: !!data.group_id });
    });
    socket.on('call_user', async (data) => {
        try {
            const caller = await User.findById(data.from);
            const receiver = await User.findById(data.userToCall);
            if (caller && receiver && !caller.blocked_users.includes(receiver._id) && !receiver.blocked_users.includes(caller._id)) {
                io.to(data.userToCall).emit('incoming_call', { signal: data.signalData, from: data.from, name: data.name, avatar: data.avatar, type: data.type });
            } else { io.to(data.from).emit('call_ended'); }
        } catch (e) { }
    });
    socket.on('answer_call', (data) => io.to(data.to).emit('call_accepted', data.signal));
    socket.on('ice_candidate', (data) => io.to(data.to).emit('ice_candidate', data.candidate));
    socket.on('end_call', (data) => io.to(data.to).emit('call_ended'));
    socket.on('reject_call', (data) => io.to(data.to).emit('call_ended'));
    socket.on('mark_seen', async (data) => {
        if (!socket.userId) return;
        
        const filter = data.type === 'group' 
            ? { group: data.chat_id, 'read_by.user': { $ne: socket.userId } }
            : { sender: data.chat_id, receiver: socket.userId, is_read: false };

        const update = data.type === 'group'
            ? { $push: { read_by: { user: socket.userId, read_at: new Date() } } }
            : { $set: { is_read: true }, $push: { read_by: { user: socket.userId, read_at: new Date() } } };

        await Message.updateMany(filter, update);
        
        io.to(data.chat_id).emit('messages_seen', { viewer_id: socket.userId });
    });
    socket.on('update_last_seen', () => {
        if (socket.userId) User.findByIdAndUpdate(socket.userId, { last_seen: new Date(), online: true }).exec();
    });
    socket.on('disconnect', () => {
        if (socket.userId) User.findByIdAndUpdate(socket.userId, { online: false }).exec();
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