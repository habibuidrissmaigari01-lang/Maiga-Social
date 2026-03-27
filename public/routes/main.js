const express = require('express');
const router = express.Router();
const multer = require('multer');
const fs = require('fs');
const webpush = require('web-push');
const { isAuthenticated } = require('../../middleware');
const { User, Post, Message, Group, Call } = require('../../models');

// File Upload Config
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
       const now = new Date();
       const folder = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}`;
       let dir = 'uploads/';
       if (file.fieldname === 'avatar') dir = `uploads/avatars/`;
       else if (file.mimetype.startsWith('video')) dir = `uploads/reels/`;
       else dir = `uploads/post/`;
       if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
       cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/\s+/g, '_'))
});
const upload = multer({ storage });

// Helper
const formatTime = (date) => {
    const diff = Math.floor((new Date() - new Date(date)) / 1000);
    if (diff < 60) return 'Just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    return new Date(date).toLocaleDateString();
};

// --- Routes ---

router.get('/get_user', isAuthenticated, async (req, res) => {
    const user = await User.findById(req.session.userId);
    res.json({
        id: user._id, name: user.name, username: user.username,
        avatar: user.avatar, dept: user.dept, bio: user.bio,
        email: user.email, is_admin: user.is_admin,
        followerIds: user.followers, followingIds: user.following
    });
});

router.post('/update_profile', isAuthenticated, upload.single('avatar'), async (req, res) => {
    const updates = { ...req.body };
    if (req.file) updates.avatar = req.file.path.replace(/\\/g, '/');
    await User.findByIdAndUpdate(req.session.userId, updates);
    res.json({ success: true });
});

router.get('/get_posts', isAuthenticated, async (req, res) => {
    const posts = await Post.find({}).populate('user', 'name avatar isVerified').sort({ created_at: -1 }).limit(10);
    res.json(posts.map(p => ({
        id: p._id, user_id: p.user._id, author: p.user.name, avatar: p.user.avatar,
        content: p.content, media: p.media, mediaType: p.mediaType,
        time: formatTime(p.created_at), likes: p.likes.length,
        saved: p.saved_by.includes(req.session.userId),
        myReaction: p.likes.includes(req.session.userId) ? 'like' : null
    })));
});

router.post('/create_post', isAuthenticated, upload.single('media'), async (req, res) => {
    const post = new Post({
        user: req.session.userId,
        content: req.body.content,
        media: req.file ? req.file.path.replace(/\\/g, '/') : null,
        mediaType: req.file ? (req.file.mimetype.startsWith('video') ? 'video' : 'image') : null
    });
    await post.save();
    res.json({ success: true, post: await post.populate('user', 'name avatar') });
});

router.post('/send_message', isAuthenticated, upload.single('media'), async (req, res) => {
    const { receiver_id, group_id, content, media_type } = req.body;
    
    // Check blocks logic here (omitted for brevity, copy from original if needed)

    const msg = new Message({
        sender: req.session.userId,
        receiver: receiver_id || null,
        group: group_id || null,
        content: content,
        media: req.file ? req.file.path.replace(/\\/g, '/') : null,
        media_type: media_type || 'text'
    });
    await msg.save();
    
    const populatedMsg = await msg.populate('sender', 'name avatar');
    const msgData = {
        id: populatedMsg._id, sender_id: populatedMsg.sender._id,
        content: populatedMsg.content, created_at: populatedMsg.created_at,
        avatar: populatedMsg.sender.avatar, author: populatedMsg.sender.name,
        type: populatedMsg.media_type
    };
    
    // Socket Emit via req.io
    if (group_id) {
        req.io.to(`group_${group_id}`).emit('receive_message', msgData);
    } else {
        req.io.to(receiver_id).emit('receive_message', msgData);
        // Push Notification logic here
    }
    
    res.json({ success: true, message: msgData });
});

router.get('/get_chats', isAuthenticated, async (req, res) => {
    const userId = req.session.userId;
    const messages = await Message.find({ $or: [{ sender: userId }, { receiver: userId }] })
        .sort({ created_at: -1 }).populate('sender receiver', 'name avatar online');
    
    const chats = new Map();
    messages.forEach(m => {
        const other = m.sender._id.equals(userId) ? m.receiver : m.sender;
        if (!chats.has(other._id.toString())) {
            chats.set(other._id.toString(), {
                id: other._id, name: other.name, avatar: other.avatar,
                status: other.online ? 'online' : 'offline',
                lastMsg: m.content, time: formatTime(m.created_at)
            });
        }
    });
    res.json(Array.from(chats.values()));
});

router.get('/get_messages', isAuthenticated, async (req, res) => {
    const { chat_id, type } = req.query;
    const userId = req.session.userId;
    const query = type === 'group' ? { group: chat_id } : { $or: [{ sender: userId, receiver: chat_id }, { sender: chat_id, receiver: userId }] };
    
    const messages = await Message.find(query).sort({ created_at: 1 }).populate('sender', 'name avatar');
    res.json(messages.map(m => ({
        id: m._id, sender_id: m.sender._id, content: m.content,
        media: m.media, media_type: m.media_type, created_at: m.created_at,
        is_read: m.is_read, first_name: m.sender.name.split(' ')[0], avatar: m.sender.avatar
    })));
});

router.post('/toggle_reaction', isAuthenticated, async (req, res) => {
    const post = await Post.findById(req.body.post_id);
    const userId = req.session.userId;
    const index = post.likes.indexOf(userId);
    if (index === -1) post.likes.push(userId); else post.likes.splice(index, 1);
    await post.save();
    res.json({ success: true });
});

router.post('/toggle_save', isAuthenticated, async (req, res) => {
    const post = await Post.findById(req.body.post_id);
    const userId = req.session.userId;
    const index = post.saved_by.indexOf(userId);
    if (index === -1) {
        post.saved_by.push(userId);
    } else {
        post.saved_by.splice(index, 1);
    }
    await post.save();
    res.json({ success: true });
});

router.post('/subscribe', isAuthenticated, async (req, res) => {
    await User.findByIdAndUpdate(req.session.userId, { push_subscription: req.body });
    res.status(201).json({});
});

router.get('/search_users', isAuthenticated, async (req, res) => {
    const users = await User.find({ name: { $regex: req.query.q, $options: 'i' } }).limit(10);
    res.json(users.map(u => ({ id: u._id, name: u.name, avatar: u.avatar, dept: u.dept })));
});

// Call Routes
router.get('/check_incoming_call', isAuthenticated, async (req, res) => {
    const call = await Call.findOne({ receiver: req.session.userId, status: 'ringing' }).populate('caller', 'name avatar');
    if (call) {
        res.json({ incoming: true, call: { id: call._id, caller_id: call.caller._id, first_name: call.caller.name, avatar: call.caller.avatar, type: call.type, sdp_offer: call.sdp_offer } });
    } else {
        res.json({ incoming: false });
    }
});

module.exports = router;
