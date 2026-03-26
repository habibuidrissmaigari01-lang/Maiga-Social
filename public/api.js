require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const webpush = require('web-push');

const authRoutes = require('./routes/auth');
const mainRoutes = require('./routes/main');
const { User, Message } = require('./models'); // Import for Socket logic

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- Configuration ---
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URL || 'mongodb://localhost:27017/maiga';
const SESSION_SECRET = 'your_secret_key'; 

// --- Middleware ---
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Attach IO to request for routes to use
app.use((req, res, next) => {
    req.io = io;
    next();
});

// Session Setup
app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ mongoUrl: MONGO_URI }),
    cookie: { httpOnly: true } // Default: Session cookie (expires on close)
}));

// MongoDB Connection
mongoose.connect(MONGO_URI)
    .then(() => console.log('MongoDB Connected'))
    .catch(err => console.error('MongoDB Connection Error:', err));

// Web Push Setup
const publicVapidKey = process.env.VAPID_PUBLIC_KEY;
const privateVapidKey = process.env.VAPID_PRIVATE_KEY;
if (publicVapidKey && privateVapidKey) {
    try {
        webpush.setVapidDetails('mailto:admin@maiga.social', publicVapidKey, privateVapidKey);
    } catch (err) { console.error('WebPush Config Error:', err.message); }
}

// --- Routes ---
app.use('/api', authRoutes);
app.use('/api', mainRoutes);

// --- Socket.io Logic ---
io.on('connection', (socket) => {
    socket.on('join_room', (userId) => {
        socket.join(userId);
        socket.userId = userId;
        User.findByIdAndUpdate(userId, { online: true }).exec();
    });
    
    socket.on('join_group', (groupId) => {
        socket.join(`group_${groupId}`);
    });

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
            } else {
                io.to(data.from).emit('call_ended');
            }
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
        if (socket.userId) {
            User.findByIdAndUpdate(socket.userId, { last_seen: new Date(), online: true }).exec();
        }
    });

    socket.on('disconnect', () => {
        if (socket.userId) User.findByIdAndUpdate(socket.userId, { online: false }).exec();
    });
});

app.get('/api/vapid_public_key', (req, res) => {
    res.json({ publicKey: publicVapidKey });
});

// --- Protect Dashboard Route ---
const requireLogin = (req, res, next) => {
    if (req.session.userId) {
        next();
    } else {
        res.redirect('/'); // Redirect to login if not authenticated
    }
};

// Intercept maiga.html request to check auth
app.get('/maiga.html', requireLogin, (req, res) => {
    res.sendFile(path.join(__dirname, 'maiga.html'));
});

// Serve Static Files
app.use(express.static(__dirname));

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log("--- Registered Routes Loaded ---");
});
