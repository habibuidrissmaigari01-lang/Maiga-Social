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
const webpush = require('web-push');

// Updated paths because routes were moved into the public folder
const authRoutes = require('./public/routes/auth');
const mainRoutes = require('./public/routes/main');
const { isAuthenticated } = require('./middleware');
// Models are now in the same directory
const { User, Message, Post, Comment } = require('./models'); 

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const upload = multer({ dest: 'uploads/' });

// Ensure uploads directory exists at startup
const uploadsDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
}

// --- Configuration ---
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URL; 
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev_secret_key'; 

// --- Middleware ---
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serves uploads from the root uploads folder
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads'))); 

app.use((req, res, next) => {
    req.io = io;
    next();
});

// Session Setup
app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ client: mongoose.connection.getClient() }),
    cookie: { httpOnly: true }
}));

// MongoDB Connection
if (!MONGO_URI) {
    console.error('CRITICAL ERROR: MONGO_URL is not defined in environment variables.');
}

mongoose.connect(MONGO_URI || 'mongodb://localhost:27017/maiga')
    .then(() => console.log('Successfully connected to MongoDB Atlas (v6.7)'))
    .catch(err => {
        console.error('MongoDB Connection Error:', err.message);
        process.exit(1); 
    });

// Web Push Setup
const publicVapidKey = process.env.VAPID_PUBLIC_KEY;
const privateVapidKey = process.env.VAPID_PRIVATE_KEY;

if (!publicVapidKey || !privateVapidKey) {
    console.warn('VAPID keys are not set. Push notifications will not work.');
} else {
    try {
        webpush.setVapidDetails('mailto:admin@maiga.social', publicVapidKey, privateVapidKey);
    } catch (err) { console.error('WebPush Config Error:', err.message); }
}

// --- Routes ---
app.use('/api', authRoutes);
app.use('/api', mainRoutes);

app.post('/api/add_comment', isAuthenticated, upload.single('media'), async (req, res, next) => {
    try {
        const { post_id, content, parent_comment_id } = req.body;
        const mediaFile = req.file;
        let media = null;
        let media_type = 'text';

        if (mediaFile) {
            const newFileName = `${Date.now()}-${mediaFile.originalname}`;
            const newFilePath = path.join(uploadsDir, newFileName);
            fs.renameSync(mediaFile.path, newFilePath);
            media = `/uploads/${newFileName}`;
            media_type = mediaFile.mimetype.startsWith('audio') ? 'audio' : mediaFile.mimetype.split('/')[0];
        }

        const newComment = new Comment({
            post: post_id,
            user: req.session.userId,
            content: content,
            media: media,
            media_type: media_type,
            parent_comment: parent_comment_id || null
        });
        await newComment.save();
        await Post.findByIdAndUpdate(post_id, { $inc: { comments_count: 1 } });
        res.status(201).json({ message: 'Comment added successfully!' });
    } catch (error) { next(error); }
});

// --- Socket.io Logic ---
io.on('connection', (socket) => {
    socket.on('join_room', (userId) => {
        socket.join(userId);
        socket.userId = userId;
        User.findByIdAndUpdate(userId, { online: true }).exec();
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
        } catch (e) { console.error('Call error:', e); }
    });
    socket.on('answer_call', (data) => io.to(data.to).emit('call_accepted', data.signal));
    socket.on('ice_candidate', (data) => io.to(data.to).emit('ice_candidate', data.candidate));
    socket.on('end_call', (data) => io.to(data.to).emit('call_ended'));
    socket.on('reject_call', (data) => io.to(data.to).emit('call_ended'));
    socket.on('mark_seen', async (data) => {
        if (!socket.userId || data.type !== 'user') return;
        await Message.updateMany({ sender: data.chat_id, receiver: socket.userId, is_read: false }, { $set: { is_read: true } });
        io.to(data.chat_id).emit('messages_seen', { viewer_id: socket.userId });
    });
    socket.on('update_last_seen', () => {
        if (socket.userId) User.findByIdAndUpdate(socket.userId, { last_seen: new Date(), online: true }).exec();
    });
    socket.on('disconnect', () => {
        if (socket.userId) User.findByIdAndUpdate(socket.userId, { online: false }).exec();
    });
});

app.get('/api/vapid_public_key', (req, res) => res.json({ publicKey: publicVapidKey }));

app.post('/api/subscribe', isAuthenticated, async (req, res) => {
    const userId = req.session.userId;
    try {
        await User.findByIdAndUpdate(userId, { pushSubscription: req.body });
        res.status(201).json({ message: 'Subscription saved' });
    } catch (error) { res.status(500).json({ message: 'Failed to save subscription' }); }
});

app.post('/api/send-push', isAuthenticated, async (req, res) => {
    const { title, body, url = '/', userId } = req.body;
    if (!userId) return res.status(400).json({ message: 'Target user ID is required.' });
    try {
        const user = await User.findById(userId);
        if (!user || !user.pushSubscription) return res.status(404).json({ message: 'No active push subscription.' });
        await webpush.sendNotification(user.pushSubscription, JSON.stringify({ title, body, url }));
        res.status(200).json({ message: 'Push notification sent.' });
    } catch (error) { res.status(500).json({ message: 'Failed to send push notification.' }); }
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

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

// --- Generic Error Handling ---
app.use((err, req, res, next) => {
    console.error('API Error:', err.stack);
    res.status(err.status || 500).json({ message: err.message || 'Internal Server Error' });
});