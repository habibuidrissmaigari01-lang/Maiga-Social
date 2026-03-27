require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt'); // For password hashing
const http = require('http'); // Keep http for server creation
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const multer = require('multer'); // Import multer
const fs = require('fs'); // Import fs for file operations
const webpush = require('web-push'); // Assuming web-push is used

const authRoutes = require('./routes/auth');
const mainRoutes = require('./routes/main');
const { User, Message, Post, Comment } = require('../models'); // Corrected path to models.js

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Configure Multer for file uploads
const upload = multer({ dest: 'uploads/' }); // Files will be temporarily stored in 'uploads/'

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

// Web Push Setup (VAPID Keys)
const publicVapidKey = process.env.VAPID_PUBLIC_KEY;
const privateVapidKey = process.env.VAPID_PRIVATE_KEY;

if (!publicVapidKey || !privateVapidKey) {
    console.warn('VAPID keys are not set. Push notifications will not work.');
    console.warn('Generate them using `npx web-push generate-vapid-keys` and set them as environment variables.');
} else {
    try {
        webpush.setVapidDetails('mailto:admin@maiga.social', publicVapidKey, privateVapidKey);
    } catch (err) { console.error('WebPush Config Error:', err.message); }
}

// --- Routes ---
app.use('/api', authRoutes);
app.use('/api', mainRoutes);

// --- Direct API Routes for Auth (to ensure they are handled) ---
// These can be moved into routes/auth.js later if preferred

app.post('/api/register', async (req, res, next) => {
    try {
        const { email, username, password, account_type, first_name, surname } = req.body;

        if (!email || !username || !password || !first_name || !surname) {
            return res.status(400).json({ message: 'Please fill all fields.' });
        }

        const existingUser = await User.findOne({ $or: [{ email }, { username }] });
        if (existingUser) {
            return res.status(400).json({ message: 'User with that email or username already exists.' });
        }

        // Hash password before saving
        const hashedPassword = await bcrypt.hash(password, 10); // 10 is the salt rounds

        const newUser = new User({
            name: `${first_name} ${surname}`,
            username: username,
            email: email,
            password: hashedPassword,
            dept: 'New Student', // Default value
            account_type: account_type || 'maiga', // Default to 'maiga'
            created_at: new Date(),
            last_seen: new Date(),
            bio: 'New to Maiga Social!',
            avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=${username}`,
            // Other default fields will be set by Mongoose schema defaults
        });

        await newUser.save();

        res.status(201).json({ message: 'User registered successfully!' });
    } catch (error) {
        next(error); // Pass error to generic error handler
    }
});

app.post('/api/add_comment', upload.single('media'), async (req, res, next) => {
    try {
        const { post_id, content, parent_comment_id } = req.body;
        const mediaFile = req.file; // This will contain the uploaded file info

        let commentContent = content;
        let media = null;
        let media_type = 'text';

        if (mediaFile) {
            // Rename and move the file to a permanent location
            const newFileName = `${Date.now()}-${mediaFile.originalname}`;
            const newFilePath = path.join(__dirname, 'uploads', newFileName);
            fs.renameSync(mediaFile.path, newFilePath);

            media = `/uploads/${newFileName}`; // Store the URL path
            media_type = mediaFile.mimetype.startsWith('audio') ? 'audio' : mediaFile.mimetype.split('/')[0];
        }

        const newComment = new Comment({
            post: post_id,
            user: req.session.userId, // Assuming user is authenticated
            content: commentContent,
            media: media,
            media_type: media_type,
            parent_comment: parent_comment_id || null
        });

        await newComment.save();
        // Update post comments count
        await Post.findByIdAndUpdate(post_id, { $inc: { comments_count: 1 } });

        res.status(201).json({ message: 'Comment added successfully!' });
    } catch (error) {
        next(error); // Pass error to generic error handler
    }
});

app.post('/api/login', async (req, res, next) => {
    try {
        const { login_identity, login_password } = req.body;

        if (!login_identity || !login_password) {
            return res.status(400).json({ message: 'Please provide email/username and password.' });
        }

        const user = await User.findOne({ $or: [{ email: login_identity }, { username: login_identity }] }).select('+password'); // Select password field

        if (!user) {
            return res.status(400).json({ message: 'Invalid credentials.' });
        }

        const isMatch = await bcrypt.compare(login_password, user.password);
        if (!isMatch) {
            return res.status(400).json({ message: 'Invalid credentials.' });
        }

        if (user.blocked) {
            return res.status(403).json({ message: 'This account has been blocked.' });
        }

        req.session.userId = user._id; // Store user ID in session
        res.json({ message: 'Login successful', user: { id: user._id, username: user.username, name: user.name, avatar: user.avatar } }); // Return limited user data
    } catch (error) {
        next(error);
    }
});

app.get('/api/check_username', async (req, res, next) => {
    try {
        const { username } = req.query;
        const user = await User.findOne({ username });
        res.json({ available: !user });
    } catch (error) {
        next(error);
    }
});

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

// New route to save push subscriptions from the frontend
app.post('/api/subscribe', async (req, res) => {
    const subscription = req.body;
    const userId = req.session.userId; // Assuming user is logged in and userId is in session

    if (!userId) {
        return res.status(401).json({ message: 'Unauthorized: User not logged in.' });
    }

    try {
        // In a real application, you would save this subscription object to a database
        // associated with the user. For this example, we'll update the user's document.
        await User.findByIdAndUpdate(userId, { pushSubscription: subscription });
        console.log(`User ${userId} subscribed to push notifications.`);
        res.status(201).json({ message: 'Subscription saved successfully.' });
    } catch (error) {
        console.error('Error saving subscription:', error);
        res.status(500).json({ message: 'Failed to save subscription.' });
    }
});

// New route to send push notifications (example - typically triggered by server events)
app.post('/api/send-push', async (req, res) => {
    const { title, body, url = '/' } = req.body;
    const targetUserId = req.body.userId; // Or get from session if sending to self

    if (!targetUserId) {
        return res.status(400).json({ message: 'Target user ID is required.' });
    }

    try {
        const user = await User.findById(targetUserId);
        if (!user || !user.pushSubscription) {
            return res.status(404).json({ message: 'User not found or no active push subscription.' });
        }

        const payload = JSON.stringify({ title, body, url });
        await webpush.sendNotification(user.pushSubscription, payload);
        res.status(200).json({ message: 'Push notification sent.' });
    } catch (error) {
        console.error('Error sending push notification:', error);
        res.status(500).json({ message: 'Failed to send push notification.' });
    }
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

// --- Generic Error Handling Middleware ---
app.use((err, req, res, next) => {
    console.error('API Error:', err.stack);
    res.status(err.status || 500).json({ message: err.message || 'Internal Server Error' });
});
