const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');
const { exec } = require('child_process');
const { Upload } = require('@aws-sdk/lib-storage');
const { PutObjectCommand, DeleteObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { isAuthenticated } = require('../../middleware');
const { User, Post, Message, Group, Call, Story, Report, Notification, Comment, Setting, Log, Broadcast, s3Client } = require('../../models');

const publicVapidKey = process.env.VAPID_PUBLIC_KEY;
const privateVapidKey = process.env.VAPID_PRIVATE_KEY;
if (publicVapidKey && privateVapidKey) {
    const senderEmail = process.env.SENDER_EMAIL || 'admin@maiga.social';
    webpush.setVapidDetails(`mailto:${senderEmail}`, publicVapidKey, privateVapidKey);
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, '../../uploads');
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname.replace(/\s+/g, '_'));
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 100 * 1024 * 1024 } // Limit individual files to 100MB
});

// Robust URL handling: ensure the base URL has no trailing slash
const BASE_PUBLIC_URL = process.env.R2_PUBLIC_URL?.replace(/\/+$/, '');

// Helper: Get Video Duration using ffprobe
const getVideoDuration = (filePath) => {
    return new Promise((resolve, reject) => {
        // Check if ffprobe exists by running 'ffprobe -version'
        exec('ffprobe -version', (versionErr) => {
            if (versionErr) {
                console.warn('FFmpeg/ffprobe not found on system. Skipping duration check.');
                return resolve(null);
            }

            exec(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`, (err, stdout) => {
                if (err) return resolve(null);
            resolve(parseFloat(stdout));
        });
        });
    });
};

const uploadToR2 = async (file, folder) => {
    const key = `${folder}/${Date.now()}-${file.originalname.replace(/\s+/g, '_')}`;

    try {
        // SECURITY: Check video duration if the file is a video
        if (file.mimetype.startsWith('video')) {
            try {
                const duration = await getVideoDuration(file.path);
                if (duration !== null && duration > 180) { // Only throw if duration was actually retrieved
                    throw new Error('Video duration exceeds the 3-minute limit.');
                }
            } catch (err) {
                throw new Error(err.message || 'Failed to verify video duration.');
            }
        }

        const fileStream = fs.createReadStream(file.path);
        const parallelUpload = new Upload({
            client: s3Client,
            params: {
                Bucket: process.env.R2_BUCKET_NAME,
                Key: key,
                Body: fileStream,
                ContentType: file.mimetype,
            },
            queueSize: 4,
            partSize: 1024 * 1024 * 5,
        });

        await parallelUpload.done();
        return `${BASE_PUBLIC_URL}/${key}`;
    } finally {
        // Always delete the temporary file from the server's disk after R2 upload completes or fails
        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
    }
};

// Backend Helper: Check if a file actually exists in the R2 bucket
const checkR2FileExists = async (key) => {
    try {
        await s3Client.send(new HeadObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: key,
        }));
        return true;
    } catch (err) {
        return false;
    }
};

// Helper
const formatTime = (date) => {
    const now = new Date();
    const past = new Date(date);

    if (!date || isNaN(past.getTime())) {
        return ''; // Return empty string for invalid or missing dates
    }
    const diff = Math.floor((now - past) / 1000);

    if (diff < 0) return 'Just now'; 
    if (diff < 60) return 'Just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
    return past.toLocaleDateString();
};

// Helper to extract a URL from text
function extractUrl(text) {
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const match = urlRegex.exec(text);
    return match ? match[0] : null;
}

// Helper to fetch and parse Open Graph metadata
async function getLinkPreview(url) {
    try {
        const response = await fetch(url, {
            headers: { 'User-Agent': 'MaigaSocialBot/1.0' }
        });
        const html = await response.text();

        const ogTags = {};
        // Improved regex to handle various meta tag formats
        const metaRegex = /<meta\s+(?:property|name)=["']og:([^"']+)["']\s+content=["']([^"']*)["']\s*\/?>/gi;
        let match;
        while ((match = metaRegex.exec(html)) !== null) {
            ogTags[match[1]] = match[2];
        }

        return {
            url: url,
            title: ogTags.title || null,
            description: ogTags.description || null,
            image: ogTags.image || null
        };
    } catch (error) {
        return null;
    }
}

// Middleware to check for Admin privileges
const isAdmin = async (req, res, next) => {
    const user = await User.findById(req.session.userId);
    if (user && user.is_admin) {
        return next();
    }
    res.status(403).json({ error: 'Admin access denied' });
};

// --- Routes ---

router.get('/get_init_data', isAuthenticated, async (req, res) => {
    try {
        const userId = req.session.userId;
        
        // Fetch all critical data in parallel on the server
        const [user, posts, chats, groups, connections, trending, notifications] = await Promise.all([
            User.findById(userId),
            Post.find({ media_type: { $ne: 'video' } }).populate('user', 'name first_name surname avatar is_verified').sort({ createdAt: -1 }).limit(20),
            Message.find({ $or: [{ sender: userId }, { receiver: userId }] }).sort({ createdAt: -1 }).populate('sender receiver', 'name avatar online'),
            Group.find({ 'members.user': userId }),
            User.findById(userId).populate('following', 'name avatar username online dept'),
            Post.aggregate([{ $match: { createdAt: { $gte: new Date(Date.now() - 7*24*60*60*1000) }, content: { $regex: /#/ } } }]), // Simplified trending logic
            Notification.find({ user: userId }).populate('trigger_user', 'name avatar').sort({ created_at: -1 }).limit(10)
        ]);

        res.json({
            user: {
                id: user._id, name: user.name, username: user.username, 
                avatar: user.avatar, dept: user.dept, bio: user.bio,
                is_admin: user.is_admin, followerIds: user.followers, followingIds: user.following
            },
            posts: posts.map(p => ({ id: p._id, author: p.user?.full_name, content: p.content, media: p.media, time: formatTime(p.createdAt), likes: p.likes.length })),
            chats: [], // Map your chat logic here
            groups: groups.map(g => ({ id: g._id, name: g.name, avatar: g.avatar, type: 'group' })),
            following: connections.following.map(f => ({ id: f._id, name: f.name, avatar: f.avatar })),
            trending: [], // Map trending logic here
            notifications: notifications
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to aggregate data' });
    }
});

router.get('/get_user', isAuthenticated, async (req, res) => {
    const user = await User.findById(req.session.userId);
    const postsCount = await Post.countDocuments({ user: user._id });
    res.json({
        id: user._id, name: user.name, username: user.username, account_type: user.account_type,
        avatar: user.avatar, dept: user.dept, bio: user.bio,
        email: user.email, is_admin: user.is_admin,
        followerIds: user.followers, followingIds: user.following,
        total_posts_count: postsCount
    });
});

router.post('/update_profile', isAuthenticated, upload.single('avatar'), async (req, res) => {
    // SECURITY: Protect against mass assignment by only destructuring allowed fields.
    // This prevents users from self-promoting to admin via the request body.
    try {
        const { name, username, bio, dept } = req.body;
        const updates = { name, username, bio, dept };
        
        if (req.file) {
            const user = await User.findById(req.session.userId);
            
            // If current avatar is an R2 URL (starts with http), delete the old file
            if (user && user.avatar && user.avatar.startsWith('http')) {
                try {
                    const oldUrl = new URL(user.avatar);
                    const oldKey = oldUrl.pathname.startsWith('/') ? oldUrl.pathname.substring(1) : oldUrl.pathname;
                    
                    await s3Client.send(new DeleteObjectCommand({
                        Bucket: process.env.R2_BUCKET_NAME,
                        Key: oldKey
                    }));
                } catch (cleanupErr) { }
            }
            updates.avatar = await uploadToR2(req.file, 'avatars');
        }

        await User.findByIdAndUpdate(req.session.userId, { $set: updates }, { runValidators: true });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to update profile details.' });
    }
});

router.post('/update_privacy', isAuthenticated, async (req, res) => {
    try {
        const { privateAccount, activityStatus, location } = req.body;
        // Note: You may need to add these fields to your userSchema first
        await User.findByIdAndUpdate(req.session.userId, { 
            $set: { 'privacy_settings': { privateAccount, activityStatus, location } } 
        });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false }); }
});

router.post('/update_language', isAuthenticated, async (req, res) => {
    try {
        await User.findByIdAndUpdate(req.session.userId, { $set: { language: req.body.language } });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false }); }
});

router.post('/update_recent_stickers', isAuthenticated, async (req, res) => {
    try {
        await User.findByIdAndUpdate(req.session.userId, { $set: { recent_stickers: req.body.stickers } });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false }); }
});

router.post('/submit_support_ticket', isAuthenticated, async (req, res) => {
    try {
        const user = await User.findById(req.session.userId);
        const report = new Report({
            reporter: req.session.userId,
            reason: 'Support Ticket: ' + req.body.title,
            details: req.body.description,
            status: 'open'
        });
        await report.save();

        // Alert admins via Socket.io
        req.io.to('admins').emit('new_report', {
            id: report._id,
            reason: report.reason,
            reporter: user.name,
            time: 'Just now'
        });

        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false }); }
});

router.get('/get_posts', isAuthenticated, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = 20; // Increased from 10 to 20 posts per page for better scrolling experience
        const skip = (page - 1) * limit;
        
        const baseQuery = { media_type: { $ne: 'video' } };
        if (req.query.hashtag) {
            baseQuery.content = { $regex: new RegExp('#' + req.query.hashtag, 'i') };
        }
        
        const query = req.query.user_id ? { user: req.query.user_id, ...baseQuery } : baseQuery;
        
        // Populate 'user' and include fields needed for the 'full_name' virtual
        let posts = await Post.find(query)
            .populate('user', 'name first_name surname avatar is_verified').populate({ path: 'shared_post', populate: { path: 'user', select: 'name avatar' } })
            .sort({ createdAt: -1 }).skip(skip).limit(limit + 1); // Fetch one extra to check for more

        // Randomize the current batch and interleave to prevent consecutive posts from the same author
        if (!req.query.user_id && posts.length > 2) {
            // Shuffle for variety
            posts.sort(() => Math.random() - 0.5);
            
            // Interleave logic: Group by author and spread them out
            const interleaved = [];
            const pools = new Map();
            for (const p of posts) {
                const uid = p.user ? p.user._id.toString() : p._id.toString(); // Group deleted users by post ID to avoid clustering
                if (!pools.has(uid)) pools.set(uid, []);
                pools.get(uid).push(p);
            }
            const sortedPools = Array.from(pools.values()).sort((a, b) => b.length - a.length);
            while (interleaved.length < posts.length) {
                for (const pool of sortedPools) {
                    if (pool.length > 0) interleaved.push(pool.shift());
                }
            }
            posts = interleaved;
        }
        
        const hasMorePosts = posts.length > limit;
        const postsToReturn = posts.slice(0, limit);
        
        res.json(postsToReturn.map(p => ({
            id: p._id, user_id: p.user?._id, author: p.user?.full_name || 'User', avatar: p.user?.avatar,
            content: p.content, media: p.media, media_type: p.media_type,
            time: formatTime(p.createdAt), likes: p.likes.length,
            comments: p.comments_count || 0,
            views: p.views || 0,
            saved: p.saved_by.some(id => id.toString() === req.session.userId?.toString()),
            myReaction: p.likes.some(id => id && id.toString() === req.session.userId?.toString()) ? 'like' : null,
            link_preview: p.link_preview // Include link preview
        })));
    } catch (err) {
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.get('/get_post', isAuthenticated, async (req, res) => {
    try {
        const post = await Post.findById(req.query.post_id)
            .populate('user', 'name first_name surname avatar is_verified');
        if (!post) return res.status(404).json({ error: 'Post not found' });
        
        res.json({
            id: post._id, user_id: post.user?._id, author: post.user?.full_name || 'User', avatar: post.user?.avatar,
            content: post.content, media: post.media, media_type: post.media_type,
            time: formatTime(post.createdAt), likes: post.likes.length,
            comments: post.comments_count || 0,
            views: post.views || 0,
            saved: post.saved_by.some(id => id.toString() === req.session.userId?.toString()),
            myReaction: post.likes.some(id => id && id.toString() === req.session.userId?.toString()) ? 'like' : null,
            link_preview: post.link_preview // Include link preview
        });
    } catch (err) {
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.post('/create_post', isAuthenticated, upload.array('media', 10), async (req, res) => {
    let mediaUrls = [];
    let firstMime = null;
    if (req.files && req.files.length > 0) {
        for (const file of req.files) {
            const folder = file.mimetype.startsWith('video') ? 'reels' : 
                          (file.mimetype.startsWith('audio') ? 'voice_notes' : 'posts');
            const url = await uploadToR2(file, folder);
            mediaUrls.push(url);
            if (!firstMime) firstMime = file.mimetype;
        }
    }

    const post = new Post({
        user: req.session.userId,
        content: req.body.content,
        media: mediaUrls,
        media_type: firstMime ? (firstMime.startsWith('video') ? 'video' : 
                                (firstMime.startsWith('audio') ? 'audio' : 'image')) : null,
        feeling: req.body.feeling,
    });

    // Generate link preview if a URL is present in the content
    const detectedUrl = extractUrl(req.body.content);
    if (detectedUrl) {
        const linkPreview = await getLinkPreview(detectedUrl);
        if (linkPreview) post.link_preview = linkPreview;
    }
    await post.save();
    const populatedPost = await post.populate('user', 'name first_name surname avatar is_verified');

    // Notify followers
    const author = await User.findById(req.session.userId);
    const notifications = author.followers.map(followerId => ({
        user: followerId,
        type: 'post',
        post: post._id,
        trigger_user: req.session.userId
    }));
    if (notifications.length > 0) await Notification.insertMany(notifications);
    
    // Return a fully formatted post object for optimistic UI update
    res.json({ success: true, post: {
        id: populatedPost._id, user_id: populatedPost.user?._id, author: populatedPost.user?.full_name || 'Deleted User', avatar: populatedPost.user?.avatar,
        content: populatedPost.content, media: populatedPost.media, 
        media_type: populatedPost.media_type || (req.file?.mimetype.startsWith('video') ? 'video' : 'image'),
        time: formatTime(populatedPost.createdAt), likes: 0, comments: 0, views: 0, saved: false, myReaction: null, 
        link_preview: populatedPost.link_preview, // Include link preview
        verified: populatedPost.user?.is_verified ?? false
    }});
});

router.post('/send_message', isAuthenticated, upload.single('media'), async (req, res) => {
    const { receiver_id, group_id, content, media_type, reply_to_id } = req.body;
    
    let targetReceiverId = receiver_id;
    // Handle special case for 'support-admin'
    if (receiver_id === 'support-admin') {
        // Assuming there's a User with username 'support-admin' acting as the support agent
        const supportUser = await User.findOne({ username: 'support-admin' });
        if (!supportUser) return res.status(404).json({ error: 'Support admin user not found' });
        targetReceiverId = supportUser._id;
    }
    
    let mediaUrl = null;
    if (req.file) {
        // Organize R2 storage by media type
        const isAudio = req.file.mimetype.startsWith('audio') || media_type === 'audio';
        const folder = isAudio ? 'voice_notes' : (media_type === 'sticker' ? 'stickers' : 'messages');
        mediaUrl = await uploadToR2(req.file, folder);
    }

    // Handle Disappearing Messages (24h)
    const user = await User.findById(req.session.userId);
    const isDisappearing = user.disappearing_chats.some(c => c.chat_id.toString() === (targetReceiverId || group_id));
    let expiryDate = null;
    if (isDisappearing) {
        expiryDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
    }

    const msg = new Message({
        sender: req.session.userId,
        receiver: targetReceiverId || null,
        group: group_id || null,
        content: content,
        media: mediaUrl,
        media_type: media_type || 'text',
        reply_to: reply_to_id || null,
        expires_at: expiryDate
    });

    // Generate link preview for messages too
    const detectedUrl = extractUrl(content);
    if (detectedUrl) {
        const linkPreview = await getLinkPreview(detectedUrl);
        if (linkPreview) msg.link_preview = linkPreview;
    }
    
    await msg.save();
    // Return the message ID so the frontend can track read receipts for this specific message
    res.json({ success: true, message_id: msg._id });
});

router.post('/create_group', isAuthenticated, upload.single('avatar'), async (req, res) => {
    try {
        const { name, description, members, permissions, approve_members } = req.body;
        let avatarUrl = 'img/logo.png';
        if (req.file) avatarUrl = await uploadToR2(req.file, 'groups');

        // Creator must be added as an admin automatically
        const parsedMembers = JSON.parse(members).map(id => ({ user: id, role: 'member' }));
        parsedMembers.push({ user: req.session.userId, role: 'admin' });

        const group = new Group({
            name,
            description,
            avatar: avatarUrl,
            members: parsedMembers,
            permissions: JSON.parse(permissions || '{}'),
            approve_members: approve_members === '1',
            invite_link_code: Math.random().toString(36).substring(2, 8).toUpperCase()
        });

        await group.save();
        res.json({ success: true, group });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.post('/delete_chat_history', isAuthenticated, async (req, res) => {
    const { chat_id } = req.body;
    const userId = req.session.userId;
    
    await Message.deleteMany({
        group: null,
        $or: [
            { sender: userId, receiver: chat_id },
            { sender: chat_id, receiver: userId }
        ]
    });
    res.json({ success: true });
});
router.get('/get_chats', isAuthenticated, async (req, res) => {
    const userId = req.session.userId;
    const messages = await Message.find({ $or: [{ sender: userId }, { receiver: userId }] })
        .sort({ createdAt: -1 }).populate('sender receiver', 'name avatar online');
    
    // Get unread counts per sender
    const unreadAggregate = await Message.aggregate([
        { $match: { receiver: userId, is_read: false, deleted_for: { $ne: userId } } },
        { $group: { _id: "$sender", count: { $sum: 1 } } }
    ]);
    const unreadMap = new Map(unreadAggregate.map(item => [item._id.toString(), item.count]));

    const user = await User.findById(userId);
    const archivedIds = user.archived_chats.map(c => c.chat_id.toString());

    const chats = new Map();
    messages.forEach(m => {
        if (!m.sender || !m.receiver || !m.sender._id || !m.receiver._id) return; 
        
        const other = m.sender._id.toString() === userId.toString() ? m.receiver : m.sender;
        const otherId = other._id.toString();
        
        const isMe = m.sender._id.toString() === userId.toString();
        const prefix = isMe ? '<span class="text-blue-600 dark:text-blue-400 font-bold">You:</span> ' : '';
        
        if (!chats.has(otherId) && !archivedIds.includes(otherId)) {
            chats.set(otherId, {
                id: other._id, name: other.name, avatar: other.avatar,
                status: other.online ? 'online' : 'offline',
                last_seen: other.last_seen,
                lastMsg: prefix + (m.media_type === 'text' ? m.content : `<i>Sent a ${m.media_type}</i>`), 
                lastMsgId: m._id,
                lastMsgByMe: isMe,
                lastMsgIsRead: m.is_read,
                lastMsgTimestamp: m.createdAt,
                time: formatTime(m.createdAt),
                unread: unreadMap.has(otherId),
                unreadCount: unreadMap.get(otherId) || 0
            });
        }
    });
    res.json(Array.from(chats.values()));
});

router.get('/get_groups', isAuthenticated, async (req, res) => {
    try {
        const user = await User.findById(req.session.userId);
        const archivedIds = user.archived_chats.map(c => c.chat_id.toString());

        const groups = await Group.find({ 'members.user': req.session.userId, _id: { $nin: archivedIds } });

        // Get unread counts per group
        const groupUnreadAggregate = await Message.aggregate([
            { $match: { group: { $in: groups.map(g => g._id) }, "read_by.user": { $ne: req.session.userId }, deleted_for: { $ne: req.session.userId } } },
            { $group: { _id: "$group", count: { $sum: 1 } } }
        ]);
        const groupUnreadMap = new Map(groupUnreadAggregate.map(item => [item._id.toString(), item.count]));
        
        const groupData = await Promise.all(groups.map(async g => {
            // Fetch the actual last message for this group to persist it after refresh
            const lastMessage = await Message.findOne({ group: g._id }).sort({ createdAt: -1 }).populate('sender', 'name');
            
            const isMe = lastMessage ? (lastMessage.sender?._id.toString() === req.session.userId.toString()) : false;
            const senderPrefix = lastMessage ? (isMe ? '<span class="text-blue-600 dark:text-blue-400 font-bold">You:</span> ' : `<span class="text-indigo-500 dark:text-indigo-400 font-bold">${lastMessage.sender?.name?.split(' ')[0]}:</span> `) : '';
            const lastMsgText = lastMessage ? (lastMessage.media_type === 'text' ? lastMessage.content : `<i>Sent a ${lastMessage.media_type}</i>`) : 'No messages yet';
            
            return {
                id: g._id,
                name: g.name,
                avatar: g.avatar || 'img/default-group.png',
                type: 'group',
                lastMsg: senderPrefix + lastMsgText,
                lastMsgId: lastMessage?._id,
                lastMsgByMe: isMe,
                lastMsgIsRead: lastMessage ? lastMessage.is_read : false,
                lastMsgTimestamp: lastMessage ? lastMessage.createdAt : null,
                time: lastMessage ? formatTime(lastMessage.createdAt) : '',
                unread: groupUnreadMap.has(g._id.toString()),
                unreadCount: groupUnreadMap.get(g._id.toString()) || 0
            };
        }));
        res.json(groupData);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch groups' });
    }
});

router.get('/get_profile', isAuthenticated, async (req, res) => {
    try {
        const user = await User.findById(req.query.user_id)
            .select('-push_subscription -public_key');
        if (!user) return res.status(404).json({ error: 'User not found' });

        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;
        const totalPostsCount = await Post.countDocuments({ user: user._id });
        const posts = await Post.find({ user: user._id, media_type: { $ne: 'video' } }).sort({ createdAt: -1 }).skip(skip).limit(limit + 1); // Fetch one extra to check for more

        res.json({
            id: user._id,
            name: user.full_name,
            username: user.username,
            avatar: user.avatar,
            bio: user.bio,
            dept: user.dept,
            online: user.online,
            last_seen: user.last_seen,
            is_admin: user.is_admin,
            followers_count: user.followers.length,
            following_count: user.following.length,
            total_posts_count: totalPostsCount,
            posts: posts.slice(0, limit).map(p => ({
                id: p._id,
                content: p.content,
                media: p.media,
                media_type: p.media_type,
                time: formatTime(p.createdAt),
                likes: p.likes.length,
                comments: p.comments_count || 0,
                saved: p.saved_by.some(id => id.toString() === req.session.userId.toString()),
                myReaction: p.likes.some(id => id.toString() === req.session.userId.toString()) ? 'like' : null,
                author: user.full_name,
                avatar: user.avatar
            })),
            hasMorePosts: posts.length > limit
        });
    } catch (error) {
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.get('/get_most_active_users', isAuthenticated, async (req, res) => {
    try {
        const lastMonth = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // Last 30 days

        const activeUsers = await Post.aggregate([
            { $match: { createdAt: { $gte: lastMonth } } },
            { $group: { _id: '$user', post_count: { $sum: 1 } } },
            { $sort: { post_count: -1 } },
            { $limit: 10 },
            {
                $lookup: {
                    from: 'users', // The collection name for User model
                    localField: '_id',
                    foreignField: '_id',
                    as: 'user_details'
                }
            },
            { $unwind: '$user_details' },
            { $project: {
                id: '$user_details._id',
                name: '$user_details.name',
                username: '$user_details.username',
                avatar: '$user_details.avatar',
                post_count: 1
            }}
        ]);
        res.json(activeUsers);
    } catch (error) { res.status(500).json({ error: 'Failed to fetch most active users' }); }
});

router.get('/get_messages', isAuthenticated, async (req, res) => {
    try {
        const { chat_id, type } = req.query;
        const userId = req.session.userId;
        
        let targetChatId = chat_id;
        // Handle special case for 'support-admin'
        if (chat_id === 'support-admin' && type === 'support') {
            // Assuming there's a User with username 'support-admin' acting as the support agent
            const supportUser = await User.findOne({ username: 'support-admin' });
            if (!supportUser) return res.status(404).json({ error: 'Support admin user not found' });
            targetChatId = supportUser._id;
        }
        
        const query = {
            ...(type === 'group' ? { group: chat_id } : { $or: [{ sender: userId, receiver: chat_id }, { sender: chat_id, receiver: userId }] }),
            deleted_for: { $ne: userId }
        };
        
        if (req.query.search) query.content = { $regex: req.query.search, $options: 'i' };
        if (req.query.starred === 'true') query.starred_by = userId;

        const messages = await Message.find(query)
            .sort({ createdAt: 1 })
            .populate('sender', 'name first_name surname avatar')
            .populate('reply_to');

        res.json(messages.map(m => ({
            id: m._id, sender_id: m.sender?._id, content: m.content,
            media: m.media, media_type: m.media_type, created_at: m.createdAt,
            delivered: m.is_delivered,
            is_read: m.is_read, avatar: m.sender?.avatar, 
            pinned: m.is_pinned,
            is_edited: m.is_edited,
            read_by: m.read_by,
            link_preview: m.link_preview,
            poll_id: m.poll?._id,
            question: m.poll?.question,
            options: m.poll?.options,
            starred: m.starred_by.some(id => id.toString() === userId?.toString()),
            replyTo: m.reply_to ? { author: 'User', content: m.reply_to.content } : null,
            first_name: m.sender?.first_name || m.sender?.name?.split(' ')[0] || 'User',
            surname: m.sender?.surname || ''
        })));
    } catch (err) {
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.post('/mark_messages_read', isAuthenticated, async (req, res) => {
    const { chat_id, type } = req.body;
    const userId = req.session.userId;
    const user = await User.findById(userId);

    let targetChatId = chat_id;
    // Handle special case for 'support-admin'
    if (chat_id === 'support-admin' && type === 'support') {
        // Assuming there's a User with username 'support-admin' acting as the support agent
        const supportUser = await User.findOne({ username: 'support-admin' });
        if (!supportUser) return res.status(404).json({ error: 'Support admin user not found' });
        targetChatId = supportUser._id;
    }

    const filter = type === 'group' 
        ? { group: chat_id, 'read_by.user': { $ne: userId } }
        : { sender: chat_id, receiver: userId, is_read: false };

    await Message.updateMany(filter, { 
        $set: { is_read: true },
        $addToSet: { read_by: { user: userId, first_name: user.first_name || user.name } } 
    });
    res.json({ success: true });
});

router.get('/get_message_reactions', isAuthenticated, async (req, res) => {
    try {
        const { message_id } = req.query;
        const message = await Message.findById(message_id)
            .populate('reactions.user', 'name avatar username');
        if (!message) return res.status(404).json({ error: 'Message not found' });
        res.json(message.reactions);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch reactions' });
    }
});

router.post('/react_message', isAuthenticated, async (req, res) => {
    try {
        const { message_id, emoji } = req.body;
        const userId = req.session.userId;
        const message = await Message.findById(message_id);
        if (!message) return res.status(404).json({ error: 'Message not found' });

        // Remove existing reaction by this user
        const existingIndex = message.reactions.findIndex(r => r.user.toString() === userId.toString());
        
        if (existingIndex > -1) {
            if (message.reactions[existingIndex].emoji === emoji) {
                message.reactions.splice(existingIndex, 1); // Toggle off
            } else {
                message.reactions[existingIndex].emoji = emoji; // Change emoji
            }
        } else {
            message.reactions.push({ user: userId, emoji });
        }

        await message.save();
        
        const target = message.group ? `group_${message.group}` : (message.receiver ? message.receiver.toString() : message.sender.toString());
        req.io.to(target).emit('message_reacted', { message_id, reactions: message.reactions });

        res.json({ success: true, reactions: message.reactions });
    } catch (error) {
        res.status(500).json({ error: 'Failed to react' });
    }
});

router.post('/toggle_pin_message', isAuthenticated, async (req, res) => {
    const { message_id } = req.body;
    const msg = await Message.findById(message_id);
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    
    msg.is_pinned = !msg.is_pinned;
    await msg.save();
    res.json({ success: true, pinned: msg.is_pinned });
});

router.post('/send_wave', isAuthenticated, async (req, res) => {
    const { user_id } = req.body;
    const waveMsg = new Message({
        sender: req.session.userId,
        receiver: user_id,
        content: '👋',
        media_type: 'sticker'
    });
    await waveMsg.save();
    res.json({ success: true });
});

router.post('/toggle_star_message', isAuthenticated, async (req, res) => {
    try {
        const { message_id } = req.body;
        const userId = req.session.userId;
        const msg = await Message.findById(message_id);
        if (!msg) return res.status(404).json({ error: 'Message not found' });

        const index = msg.starred_by.findIndex(id => id.toString() === userId.toString());
        let starred = false;
        if (index === -1) {
            msg.starred_by.push(userId);
            starred = true;
        } else {
            msg.starred_by.splice(index, 1);
        }
        await msg.save();
        res.json({ success: true, starred });
    } catch (error) {
        res.status(500).json({ error: 'Failed to toggle star' });
    }
});

router.get('/get_starred_messages', isAuthenticated, async (req, res) => {
    const messages = await Message.find({ starred_by: req.session.userId })
        .populate('sender', 'name avatar')
        .sort({ createdAt: -1 });
    res.json(messages);
});

router.post('/mark_all_messages_read', isAuthenticated, async (req, res) => {
    try {
        const userId = req.session.userId;
        const user = await User.findById(userId);
        const firstName = user.first_name || user.name || 'User';

        // Mark all 1-on-1 messages as read
        await Message.updateMany(
            { receiver: userId, is_read: false },
            { 
                $set: { is_read: true },
                $addToSet: { read_by: { user: userId, first_name: firstName } } 
            }
        );

        // For groups, mark the user as having read all messages they haven't seen yet
        await Message.updateMany(
            { group: { $ne: null }, 'read_by.user': { $ne: userId } },
            { $addToSet: { read_by: { user: userId, first_name: firstName } } }
        );

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to mark all as read' });
    }
});

router.post('/admin/dismiss_all_reports', isAuthenticated, isAdmin, async (req, res) => {
    try {
        await Report.updateMany({ status: 'open' }, { $set: { status: 'dismissed' } });
        res.json({ success: true, message: 'All open reports dismissed.' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to dismiss all reports.' });
    }
});

router.post('/mark_chat_unread', isAuthenticated, async (req, res) => {
    const { chat_id } = req.body;
    const userId = req.session.userId;

    // Remove the user from the read_by array for all messages in the chat
    await Message.updateMany(
        { $or: [{ sender: userId, receiver: chat_id }, { sender: chat_id, receiver: userId }] },
        { $pull: { read_by: { user: userId } }, $set: { is_read: false } }
    );
    res.json({ success: true });
});

router.post('/remove_follower', isAuthenticated, async (req, res) => {
    const { user_id } = req.body; // The user to remove from current user's followers
    const currentUserId = req.session.userId;

    await User.findByIdAndUpdate(currentUserId, { $pull: { followers: user_id } });
    await User.findByIdAndUpdate(user_id, { $pull: { following: currentUserId } });

    res.json({ success: true });
});

router.post('/delete_comment', isAuthenticated, async (req, res) => {
    const { comment_id } = req.body;
    const userId = req.session.userId;

    const comment = await Comment.findById(comment_id);
    if (!comment) return res.status(404).json({ error: 'Comment not found' });

    // Only allow deletion by comment owner or post owner
    const post = await Post.findById(comment.post);
    if (!comment.user.equals(userId) && (!post || !post.user.equals(userId))) {
        return res.status(403).json({ error: 'Unauthorized to delete this comment' });
    }

    await Comment.deleteOne({ _id: comment_id });
    await Post.findByIdAndUpdate(comment.post, { $inc: { comments_count: -1 } });

    res.json({ success: true });
});

router.post('/share_post', isAuthenticated, async (req, res) => {
    const { post_id } = req.body;
    const originalPost = await Post.findById(post_id);
    if (!originalPost) return res.status(404).json({ error: 'Original post not found' });

    const newPost = new Post({
        user: req.session.userId,
        content: originalPost.content, // Or add custom share text
        media: originalPost.media,
        media_type: originalPost.media_type,
        shared_post: originalPost._id // Reference to the original post
    });
    await newPost.save();

    await Post.findByIdAndUpdate(post_id, { $inc: { shares: 1 } });

    res.json({ success: true, post: newPost });
});

router.post('/delete_group', isAuthenticated, async (req, res) => {
    const { group_id } = req.body;
    const userId = req.session.userId;

    const group = await Group.findById(group_id);
    if (!group) return res.status(404).json({ error: 'Group not found' });

    const member = group.members.find(m => m.user.equals(userId));
    if (!member || member.role !== 'admin') {
        return res.status(403).json({ error: 'Only group admins can delete the group' });
    }

    await Message.deleteMany({ group: group_id });
    await Group.deleteOne({ _id: group_id });

    res.json({ success: true });
});

router.post('/promote_group_member', isAuthenticated, async (req, res) => {
    const { group_id, member_id } = req.body;
    const userId = req.session.userId;

    const group = await Group.findById(group_id);
    if (!group) return res.status(404).json({ error: 'Group not found' });

    const currentUserIsAdmin = group.members.some(m => m.user.equals(userId) && m.role === 'admin');
    if (!currentUserIsAdmin) return res.status(403).json({ error: 'Only admins can promote members' });

    const memberToPromote = group.members.find(m => m.user.equals(member_id));
    if (!memberToPromote) return res.status(404).json({ error: 'Member not found in group' });

    memberToPromote.role = 'admin';
    await group.save();
    res.json({ success: true });
});

router.post('/create_poll', isAuthenticated, async (req, res) => {
    const { receiver_id, group_id, question, options } = req.body;
    const pollData = {
        question,
        options: options.map(opt => ({ text: opt, votes: [] }))
    };
    
    const msg = new Message({
        sender: req.session.userId,
        receiver: receiver_id || null,
        group: group_id || null,
        media_type: 'poll',
        poll: pollData
    });
    await msg.save();
    res.json({ success: true });
});

router.post('/vote_poll', isAuthenticated, async (req, res) => {
    const { poll_id, option_id } = req.body;
    const userId = req.session.userId;

    // Find message containing this poll and remove user's existing votes in that poll
    await Message.updateOne(
        { "poll._id": poll_id },
        { $pull: { "poll.options.$[].votes": userId } }
    );

    // Add vote to specific option
    const result = await Message.updateOne(
        { "poll.options._id": option_id },
        { $addToSet: { "poll.options.$.votes": userId } }
    );

    res.json({ success: !!result.modifiedCount });
});

router.get('/get_call_history', isAuthenticated, async (req, res) => {
    const userId = req.session.userId;
    let calls = await Call.find({ 
        $or: [{ caller: userId }, { receiver: userId }],
        deleted_for: { $ne: userId }
    })
        .sort({ created_at: -1 })
        .populate('caller receiver', 'name avatar online');
    
    // Filter out potential nulls from deleted accounts
    calls = calls.filter(c => c.caller && c.receiver);
    res.json(calls);
});

router.post('/clear_call_history', isAuthenticated, async (req, res) => {
    const userId = req.session.userId;
    await Call.updateMany(
        { $or: [{ caller: userId }, { receiver: userId }] },
        { $addToSet: { deleted_for: userId } }
    );
    res.json({ success: true });
});

router.post('/delete_call_log', isAuthenticated, async (req, res) => {
    const { call_id } = req.body;
    const userId = req.session.userId;
    await Call.findByIdAndUpdate(call_id, { 
        $addToSet: { deleted_for: userId } 
    });
    res.json({ success: true });
});

router.get('/get_message_read_details', isAuthenticated, async (req, res) => {
    const msg = await Message.findById(req.query.message_id)
        .populate('read_by.user', 'name avatar');
    res.json({
        delivered_at: msg?.delivered_at,
        read_details: msg ? msg.read_by : []
    });
});
router.post('/toggle_reaction', isAuthenticated, async (req, res) => {
    const userId = req.session.userId;
    const { post_id, reaction } = req.body;
    const post = await Post.findById(post_id);
    if (!post) return res.status(404).json({ error: 'Post not found' });

    // Remove any existing reaction by this user
    post.likes = post.likes.filter(id => id.toString() !== userId.toString());

    // Add new reaction if it's not an un-react action
    if (reaction) {
        post.likes.push(userId);
    }

    await post.save();
    res.json({ success: true });
});

router.post('/remove_group_member', isAuthenticated, async (req, res) => {
    const { group_id, member_id } = req.body;
    const userId = req.session.userId;

    const group = await Group.findById(group_id);
    if (!group) return res.status(404).json({ error: 'Group not found' });

    const currentUserIsAdmin = group.members.some(m => m.user.equals(userId) && m.role === 'admin');
    if (!currentUserIsAdmin) return res.status(403).json({ error: 'Only admins can remove members' });

    await Group.findByIdAndUpdate(group_id, { $pull: { members: { user: member_id } } });
    res.json({ success: true });
});

router.post('/toggle_group_invite_link', isAuthenticated, async (req, res) => {
    const { group_id } = req.body;
    const userId = req.session.userId;

    const group = await Group.findById(group_id);
    if (!group) return res.status(404).json({ error: 'Group not found' });

    const currentUserIsAdmin = group.members.some(m => m.user.equals(userId) && m.role === 'admin');
    if (!currentUserIsAdmin) return res.status(403).json({ error: 'Only admins can manage invite links' });

    group.invite_link_active = !group.invite_link_active;
    if (group.invite_link_active) {
        group.invite_link_code = Math.random().toString(36).substring(2, 8).toUpperCase();
    } else {
        group.invite_link_code = null;
    }
    await group.save();
    res.json({ success: true, active: group.invite_link_active, new_code: group.invite_link_code });
});

router.post('/handle_join_request', isAuthenticated, async (req, res) => {
    const { group_id, user_id, decision } = req.body;
    const userId = req.session.userId;

    const group = await Group.findById(group_id);
    if (!group) return res.status(404).json({ error: 'Group not found' });

    const currentUserIsAdmin = group.members.some(m => m.user.equals(userId) && m.role === 'admin');
    if (!currentUserIsAdmin) return res.status(403).json({ error: 'Only admins can handle join requests' });

    if (decision === 'approve') {
        group.members.push({ user: user_id, role: 'member' });
    }
    group.join_requests = group.join_requests.filter(req => !req.equals(user_id));
    await group.save();
    res.json({ success: true });
});

router.post('/join_group_via_link', isAuthenticated, async (req, res) => {
    const { code } = req.body;
    const userId = req.session.userId;

    const group = await Group.findOne({ invite_link_code: code, invite_link_active: true });
    if (!group) return res.status(404).json({ error: 'Invalid or expired invite link' });
    if (group.members.some(m => m.user.equals(userId))) return res.json({ success: true, message: 'Already a member' });

    if (group.approve_members) {
        group.join_requests.push(userId);
        await group.save();
        return res.json({ success: true, message: 'Join request sent to admins', action: 'requested' });
    } else {
        group.members.push({ user: userId, role: 'member' });
        await group.save();
        return res.json({ success: true, message: 'Joined group successfully', action: 'joined' });
    }
});

router.post('/clear_chat', isAuthenticated, async (req, res) => {
    const { chat_id, type } = req.body;
    const userId = req.session.userId;

    if (type === 'group') {
        // For groups, mark messages as deleted for the current user
        await Message.updateMany({ group: chat_id }, { $addToSet: { deleted_for: userId } });
    } else {
        // For 1-on-1 chats, mark messages as deleted for the current user
        await Message.updateMany(
            { $or: [{ sender: userId, receiver: chat_id }, { sender: chat_id, receiver: userId }] },
            { $addToSet: { deleted_for: userId } }
        );
    }
    res.json({ success: true });
});

router.get('/saved_posts', isAuthenticated, async (req, res) => {
    const userId = req.session.userId;
    const posts = await Post.find({ saved_by: userId })
        .populate('user', 'name first_name surname avatar is_verified')
        .sort({ createdAt: -1 });

    res.json(posts.map(p => ({
        id: p._id, user_id: p.user?._id, author: p.user?.full_name || 'Deleted User', avatar: p.user?.avatar,
        content: p.content, media: p.media, media_type: p.media_type,
        time: formatTime(p.createdAt), likes: p.likes.length,
        comments: p.comments_count || 0,
        views: p.views || 0,
        saved: true, // Always true for saved posts list
        myReaction: p.likes.some(id => id.toString() === userId.toString()) ? 'like' : null
    })));
});

router.post('/toggle_follow', isAuthenticated, async (req, res) => {
    try {
        const targetId = req.body.user_id;
        const myId = req.session.userId;
        const targetUser = await User.findById(targetId);
        
        const isFollowing = targetUser.followers.some(id => id.toString() === myId.toString());
        if (isFollowing) {
            await User.findByIdAndUpdate(myId, { $pull: { following: targetId } });
            await User.findByIdAndUpdate(targetId, { $pull: { followers: myId } });
        } else {
            await User.findByIdAndUpdate(myId, { $addToSet: { following: targetId } });
            await User.findByIdAndUpdate(targetId, { $addToSet: { followers: myId } });

            // Create Follow Notification
            await Notification.create({
                user: targetId,
                type: 'follow',
                trigger_user: myId
            });
        }
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: 'Action failed' }); }
});

router.post('/toggle_save', isAuthenticated, async (req, res) => {
    const post = await Post.findById(req.body.post_id);
    if (!post) return res.status(404).json({ error: 'Post not found' });
    const userId = req.session.userId;
    const index = post.saved_by.findIndex(id => id.toString() === userId.toString());
    if (index === -1) {
        post.saved_by.push(userId);
    } else {
        post.saved_by.splice(index, 1);
    }
    await post.save();
    res.json({ success: true });
});

router.get('/get_comments', isAuthenticated, async (req, res) => {
    try {
        const comments = await Comment.find({ post: req.query.post_id })
            .populate('user', 'name avatar')
            .sort({ createdAt: 1 });
        res.json(comments.map(c => ({
            id: c._id, user_id: c.user._id, author: c.user.name, avatar: c.user.avatar,
            content: c.content, media: c.media, media_type: c.media_type, time: formatTime(c.createdAt)
        })));
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

router.post('/add_comment', isAuthenticated, upload.single('media'), async (req, res) => {
    try {
        const { post_id, content, parent_comment_id, media_type } = req.body;
        let mediaUrl = null;
        if (req.file) mediaUrl = await uploadToR2(req.file, 'comments');

        const comment = new Comment({
            post: post_id, user: req.session.userId, content, media: mediaUrl,
            media_type: media_type || (req.file ? (req.file.mimetype.startsWith('audio') ? 'audio' : 'image') : 'text'),
            parent_comment: parent_comment_id || null
        });
        await comment.save();
        await Post.findByIdAndUpdate(post_id, { $inc: { comments_count: 1 } });

        // Create notification for comment
        const post = await Post.findById(post_id);
        if (post && post.user.toString() !== req.session.userId.toString()) {
            const Notification = mongoose.model('Notification');
            const existingNotif = await Notification.findOne({
                user: post.user,
                post: post._id,
                type: 'comment',
                is_read: false
            });

            if (existingNotif) {
                await Notification.updateOne({ _id: existingNotif._id }, { $set: { trigger_user: req.session.userId }, $inc: { others_count: 1 } });
            } else {
                await Notification.create({ type: 'comment', user: post.user, trigger_user: req.session.userId, post: post._id, others_count: 0 });
            }
        }

        res.json({ success: true, comment_id: comment._id, content, media: mediaUrl });
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

router.get('/get_reels', isAuthenticated, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;
        const query = { media_type: 'video' };
        if (req.query.user_id) query.user = req.query.user_id;

        // Fetching reels
        let reels = await Post.find(query).populate('user', 'name avatar').sort({ createdAt: -1 }).skip(skip).limit(limit);
        
        // Randomize and interleave reels to avoid author clustering
        if (!req.query.user_id && reels.length > 2) {
            reels.sort(() => Math.random() - 0.5);

            const interleaved = [];
            const pools = new Map();
            for (const r of reels) {
                const uid = r.user ? r.user._id.toString() : r._id.toString();
                if (!pools.has(uid)) pools.set(uid, []);
                pools.get(uid).push(r);
            }
            const sortedPools = Array.from(pools.values()).sort((a, b) => b.length - a.length);
            while (interleaved.length < reels.length) {
                for (const pool of sortedPools) {
                    if (pool.length > 0) interleaved.push(pool.shift());
                }
            }
            reels = interleaved;
        }

        const userId = req.session.userId;
        res.json(reels.map(r => ({
            id: r._id, user_id: r.user?._id, author: r.user?.name || 'User', avatar: r.user?.avatar,
            media: r.media, caption: r.content, likes: r.likes.length, views: r.views || 0,
            comments: r.comments_count || 0, // Ensure comments count is included
            liked: r.likes.some(id => id && id.toString() === userId?.toString()),
            saved: r.saved_by.some(id => id && id.toString() === userId?.toString()),
            myReaction: r.likes.some(id => id && id.toString() === userId?.toString()) ? 'like' : null,
            seen: r.viewed_by.some(id => id && id.toString() === userId?.toString())
        })));
    } catch (error) {
        res.status(500).json({ error: 'Internal Server Error', details: error.message });
    }
});

router.get('/get_trending_reels', isAuthenticated, async (req, res) => {
    try {
        const userId = req.session.userId;
        const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

        // Fetch reels with high engagement from the last 7 days
        const reels = await Post.find({
            media_type: 'video',
            createdAt: { $gte: lastWeek }
        })
        .populate('user', 'name avatar')
        .sort({ views: -1, 'likes.length': -1 })
        .limit(10);

        res.json(reels.map(r => ({
            id: r._id,
            user_id: r.user?._id,
            author: r.user?.name || 'User',
            avatar: r.user?.avatar,
            media: r.media,
            caption: r.content,
            likes: r.likes.length,
            views: r.views || 0,
            seen: r.viewed_by.some(id => id && id.toString() === userId?.toString())
        })));
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch trending reels' });
    }
});

router.get('/get_group_info', isAuthenticated, async (req, res) => {
    const group = await Group.findById(req.query.group_id).populate('members.user', 'name avatar');
    if (!group) return res.status(404).json({ error: 'Group not found' });
    res.json({
        id: group._id, name: group.name, description: group.description, avatar: group.avatar,
        members: group.members.map(m => ({ id: m.user._id, first_name: m.user.name.split(' ')[0], avatar: m.user.avatar, role: m.role })),
        permissions: group.permissions, invite_link_code: group.invite_link_code
    });
});

router.post('/leave_group', isAuthenticated, async (req, res) => {
    await Group.findByIdAndUpdate(req.body.group_id, { $pull: { members: { user: req.session.userId } } });
    res.json({ success: true });
});

router.get('/friends/suggestions', isAuthenticated, async (req, res) => {
    const user = await User.findById(req.session.userId);
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;
    const suggestions = await User.find({ 
        _id: { $nin: [req.session.userId, ...user.following] },
        blocked: false 
    }).skip(skip).limit(limit + 1).select('name username avatar dept online'); // Fetch one extra to check for more
    res.json({
        users: suggestions.slice(0, limit).map(u => ({ id: u._id, name: u.name, username: u.username, avatar: u.avatar, dept: u.dept, online: u.online })),
        hasMore: suggestions.length > limit
    });
});

router.get('/get_connections', isAuthenticated, async (req, res) => {
    try {
        const { type, user_id } = req.query;
        const targetUserId = user_id || req.session.userId;
        
        const user = await User.findById(targetUserId);
        if (!user) return res.status(404).json({ error: 'User not found' });

        let connectionList = [];
        
        if (type === 'followers') {
            // Get people who are following this user
            const followers = await User.find({ following: targetUserId }).select('name first_name surname avatar username online dept _id');
            connectionList = followers.filter(u => u != null).map(u => ({ 
                id: u._id, 
                name: u.full_name || u.name, 
                avatar: u.avatar, 
                username: u.username, 
                online: u.online, 
                dept: u.dept 
            }));
        } else {
            // Get people this user is following (default)
            await user.populate('following', 'name first_name surname avatar username online dept');
            connectionList = user.following.filter(u => u != null).map(u => ({ 
                id: u._id, 
                name: u.full_name || u.name, 
                avatar: u.avatar, 
                username: u.username, 
                online: u.online, 
                dept: u.dept 
            }));
        }
        
        res.json(connectionList);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch connections' });
    }
});

router.post('/toggle_story_reaction', isAuthenticated, async (req, res) => {
    try {
        const { story_id } = req.body;
        const story = await Story.findById(story_id);
        if (!story) return res.status(404).json({ error: 'Story not found' });

        const userId = req.session.userId;
        const index = story.likes.indexOf(userId);
        if (index === -1) {
            story.likes.push(userId);
        } else {
            story.likes.splice(index, 1);
        }
        await story.save();
        res.json({ success: true, liked: index === -1 });
    } catch (error) {
        res.status(500).json({ error: 'Failed to toggle story reaction' });
    }
});

router.get('/search_posts', isAuthenticated, async (req, res) => {
    try {
        const { q } = req.query;
        if (!q) return res.json([]);
        const posts = await Post.find({ 
            content: { $regex: q, $options: 'i' },
            media_type: { $ne: 'video' } 
        })
        .populate('user', 'name first_name surname avatar is_verified')
        .limit(10);
        
        res.json(posts.map(p => ({ 
            id: p._id, content: p.content, media: p.media, 
            author: p.user?.full_name || p.user?.name, avatar: p.user?.avatar, time: formatTime(p.createdAt) 
        })));
    } catch (err) { res.status(500).json([]); }
});

router.get('/search_reels', isAuthenticated, async (req, res) => {
    try {
        const { q } = req.query;
        if (!q) return res.json([]);
        const reels = await Post.find({ 
            content: { $regex: q, $options: 'i' },
            media_type: 'video' 
        })
        .populate('user', 'name first_name surname avatar')
        .limit(10);
        
        res.json(reels.map(r => ({ 
            id: r._id, content: r.content, media: r.media, 
            author: r.user?.full_name || r.user?.name, avatar: r.user?.avatar 
        })));
    } catch (err) { res.status(500).json([]); }
});

router.get('/search_users', isAuthenticated, async (req, res) => {
    const users = await User.find({ name: { $regex: req.query.q, $options: 'i' } }).limit(10);
    res.json(users.map(u => ({ id: u._id, name: u.name, avatar: u.avatar, dept: u.dept })));
});

router.post('/subscribe', isAuthenticated, async (req, res) => {
    await User.findByIdAndUpdate(req.session.userId, { push_subscription: req.body });
    res.status(201).json({});
});

router.post('/create_story', isAuthenticated, upload.single('media'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Media file is required' });

        const mediaUrl = await uploadToR2(req.file, 'stories');
        const { audience, type, has_music, music_track } = req.body;

        const story = new Story({
            user: req.session.userId,
            media: mediaUrl,
            type: type || (req.file.mimetype.startsWith('video') ? 'video' : 'image'),
            audience: audience || 'public',
            has_music: has_music === 'true' || has_music === '1',
            music_track: music_track || null
        });

        await story.save();

        // Notify followers (if public)
        if (audience === 'public') {
            const author = await User.findById(req.session.userId);
            const notifications = author.followers.map(followerId => ({
                user: followerId,
                type: 'post',
                story: story._id,
                trigger_user: req.session.userId
            }));
            if (notifications.length > 0) await Notification.insertMany(notifications);
        }

        res.json({ success: true, story: await story.populate('user', 'name avatar') });
    } catch (error) {
        res.status(500).json({ error: 'Failed to create story' });
    }
});

router.post('/toggle_close_friend', isAuthenticated, async (req, res) => {
    try {
        const { friend_id } = req.body;
        const user = await User.findById(req.session.userId);
        const index = user.close_friends.indexOf(friend_id);

        if (index === -1) user.close_friends.push(friend_id); else user.close_friends.splice(index, 1);
        await user.save();
        res.json({ success: true, is_added: index === -1 });
    } catch (error) {
        res.status(500).json({ error: 'Failed to toggle close friend status' });
    }
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

router.get('/get_stories', isAuthenticated, async (req, res) => {
    try {
        const userId = req.session.userId;
        const user = await User.findById(userId);
        
        // Calculate the timestamp for 24 hours ago
        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
        
        // Fetch all recent stories
        const stories = await Story.find({
            createdAt: { $gte: yesterday }
        }).populate('user', 'name avatar close_friends')
          .sort({ createdAt: -1 }); // Sort newest to oldest so it starts from the latest update

        // Show all stories to everyone
        const filteredStories = stories;

        res.json(filteredStories.map(s => ({
            id: s._id,
            user_id: s.user._id,
            first_name: s.user.first_name || s.user.name?.split(' ')[0] || 'User',
            avatar: s.user.avatar,
            media: s.media,
            type: s.type,
            view_count: s.view_count || 0,
            has_music: s.has_music,
            music_track: s.music_track,
            audience: s.audience,
            created_at: s.createdAt,
            seen: s.views.some(id => id.toString() === userId)
        })));
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch stories' });
    }
});

router.post('/record_story_view', isAuthenticated, async (req, res) => {
    try {
        const { story_id } = req.body;
        // Update the story: add user to unique views array and increment total count
        await Story.findByIdAndUpdate(story_id, {
            $addToSet: { views: req.session.userId },
            $inc: { view_count: 1 }
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to record view' });
    }
});

router.get('/get_story_viewers', isAuthenticated, async (req, res) => {
    try {
        const { story_id } = req.query;
        // Security: Ensure the story belongs to the requester
        const story = await Story.findOne({ _id: story_id, user: req.session.userId })
            .populate('views', 'name avatar');

        if (!story) return res.status(404).json({ error: 'Story not found or unauthorized' });

        res.json(story.views.map(v => ({
            id: v._id,
            name: v.name,
            avatar: v.avatar
        })));
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch story viewers' });
    }
});

router.post('/delete_story', isAuthenticated, async (req, res) => {
    try {
        const { story_id } = req.body;
        const story = await Story.findOne({ _id: story_id, user: req.session.userId });
        if (!story) return res.status(404).json({ error: 'Story not found' });

        await Story.deleteOne({ _id: story_id });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete story' });
    }
});

router.post('/delete_message', isAuthenticated, async (req, res) => {
    try {
        const { message_id, mode } = req.body;
        const userId = req.session.userId;

        const message = await Message.findById(message_id);
        if (!message) return res.status(404).json({ error: 'Message not found' });

        if (mode === 'everyone') {
            if (!message.sender.equals(userId)) {
                return res.status(403).json({ error: 'Unauthorized' });
            }

            // Delete physical file from R2 if it exists
            if (message.media && message.media.startsWith('http')) {
                try {
                    const url = new URL(message.media);
                    const key = url.pathname.startsWith('/') ? url.pathname.substring(1) : url.pathname;
                    await s3Client.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key }));
                } catch (e) { }
            }

            await Message.deleteOne({ _id: message_id });
            const target = message.group ? `group_${message.group}` : message.receiver.toString();
            req.io.to(target).emit('message_deleted', { message_id });
        } else {
            // Delete for me only
            await Message.findByIdAndUpdate(message_id, { $addToSet: { deleted_for: userId } });
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete message' });
    }
});

router.post('/edit_message', isAuthenticated, async (req, res) => {
    try {
        const { message_id, content, media_type } = req.body;
        const message = await Message.findById(message_id);
        
        if (!message || !message.sender.equals(req.session.userId)) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        message.content = content;
        message.media_type = media_type || message.media_type;
        message.is_edited = true;
        await message.save();

        const msgData = {
            id: message._id,
            sender_id: message.sender,
            receiver_id: message.receiver,
            group_id: message.group,
            content: message.content,
            media_type: message.media_type
        };

        const target = message.group ? `group_${message.group}` : message.receiver.toString();
        req.io.to(target).emit('message_edited', msgData);
        // Also notify the sender so other tabs update
        req.io.to(message.sender.toString()).emit('message_edited', msgData);

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to edit message' });
    }
});

router.post('/report_message', isAuthenticated, async (req, res) => {
    try {
        const { message_id, reason, context } = req.body;
        const message = await Message.findById(message_id).populate('sender');
        if (!message) return res.status(404).json({ error: 'Message not found' });

        const report = new Report({
            reporter: req.session.userId,
            reported_user: message.sender?._id,
            reason: reason,
            details: `Reported Message ID: ${message_id}\nContent Context: ${context || 'N/A'}\nOriginal Media: ${message.media || 'None'}`,
            status: 'open'
        });

        await report.save();

        // Alert admins via Socket.io
        req.io.to('admins').emit('new_report', {
            id: report._id,
            reason: reason,
            reporter: 'User',
            time: 'Just now'
        });

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to submit report' });
    }
});

router.post('/report_user', isAuthenticated, upload.single('screenshot'), async (req, res) => {
    try {
        const { user_id, reason, details, priority } = req.body;
        let screenshotUrl = null;
        if (req.file) screenshotUrl = await uploadToR2(req.file, 'reports');

        const report = new Report({
            reporter: req.session.userId,
            reported_user: user_id,
            reason: reason,
            details: details + (screenshotUrl ? `\nEvidence: ${screenshotUrl}` : ''),
            priority: priority || 'low',
            status: 'open'
        });

        await report.save();

        // Alert admins via Socket.io
        req.io.to('admins').emit('new_report', {
            id: report._id,
            reason: reason,
            reporter: 'User',
            time: 'Just now'
        });

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to submit report' });
    }
});

router.get('/admin/get_dashboard_stats', isAuthenticated, async (req, res) => {
    try {
        const adminUser = await User.findById(req.session.userId);
        if (!adminUser.is_admin) return res.status(403).json({ error: 'Access denied' });

        const total_users = await User.countDocuments();
        const maiga_users = await User.countDocuments({ account_type: 'maiga' });
        const ysu_users = await User.countDocuments({ account_type: 'ysu' });
        const open_reports = await Report.countDocuments({ status: 'open' });
        const online_users = await User.countDocuments({ online: true });
        
        // Dynamic Recommended Actions
        const recentFlagged = await Report.countDocuments({ status: 'open', reason: /post/i });
        const newUsersToday = await User.countDocuments({ createdAt: { $gte: new Date().setHours(0,0,0,0) } });

        const recommendations = [
            { text: `Review ${open_reports} pending user reports`, priority: open_reports > 5 ? 'high' : 'medium' },
            { text: `Check ${recentFlagged} posts flagged for content`, priority: recentFlagged > 0 ? 'medium' : 'low' },
            { text: `${newUsersToday} new users joined today`, priority: 'low' }
        ];

        res.json({ total_users, maiga_users, ysu_users, open_reports, online_users, recommendations });
    } catch (error) { res.status(500).json({ error: 'Failed' }); }
});

router.get('/admin/get_user_profile_details', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const user = await User.findById(req.query.user_id).populate('banned_by', 'name');
        if (!user) return res.status(404).json({ error: 'User not found' });
        
        // Admin sees sensitive fields like email, phone, and IP logs
        res.json(user);
    } catch (error) { res.status(500).json({ error: 'Failed to fetch details' }); }
});

router.get('/admin/get_account_type_stats', isAuthenticated, async (req, res) => {
    const maiga = await User.countDocuments({ account_type: 'maiga' });
    const ysu = await User.countDocuments({ account_type: 'ysu' });
    res.json({ maiga, ysu });
});

router.get('/admin/get_posts_per_day_stats', isAuthenticated, async (req, res) => {
    const last7Days = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const stats = await Post.aggregate([
        { $match: { createdAt: { $gte: last7Days } } },
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } }
    ]);
    res.json({ labels: stats.map(s => s._id), data: stats.map(s => s.count) });
});

router.get('/admin/get_weekly_signups', isAuthenticated, async (req, res) => {
    const last7Days = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const stats = await User.aggregate([
        { $match: { createdAt: { $gte: last7Days } } },
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } }
    ]);
    res.json({ labels: stats.map(s => s._id), data: stats.map(s => s.count) });
});

router.get('/admin/get_weekly_signups_by_type', isAuthenticated, async (req, res) => {
    const last7Days = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const stats = await User.aggregate([
        { $match: { createdAt: { $gte: last7Days } } },
        { $group: { 
            _id: { date: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, type: "$account_type" },
            count: { $sum: 1 }
        }},
        { $sort: { "_id.date": 1 } }
    ]);
    const labels = [...new Set(stats.map(s => s._id.date))];
    const maigaData = labels.map(l => (stats.find(s => s._id.date === l && s._id.type === 'maiga')?.count || 0));
    const ysuData = labels.map(l => (stats.find(s => s._id.date === l && s._id.type === 'ysu')?.count || 0));
    res.json({ labels, maigaData, ysuData });
});

router.get('/admin/get_users', isAuthenticated, async (req, res) => {
    try {
        const { page = 1, limit = 10, search = '', filter = 'all', sort = 'name', dir = 'asc' } = req.query;
        const query = {};
        if (search) query.name = { $regex: search, $options: 'i' };
        if (filter === 'online') query.online = true;
        if (filter === 'blocked') query.blocked = true;
        if (filter === 'maiga') query.account_type = 'maiga';
        if (filter === 'ysu') query.account_type = 'ysu';

        const users = await User.find(query)
            .sort({ [sort]: dir === 'asc' ? 1 : -1 })
            .skip((page - 1) * limit)
            .limit(parseInt(limit));
        const total = await User.countDocuments(query);

        res.json({ users: users.map(u => ({
            id: u._id, name: u.name, email: u.email, dept: u.dept, avatar: u.avatar,
            online: u.online, blocked: u.blocked, is_verified: u.is_verified, account_type: u.account_type
        })), total });
    } catch (error) { res.status(500).json({ error: 'Failed' }); }
});

router.get('/admin/get_settings', isAuthenticated, async (req, res) => {
    const settings = await Setting.find({});
    const config = { site_name: 'Maiga Social', maintenance_mode: false, allow_registrations: true };
    settings.forEach(s => config[s.key] = s.value);
    res.json({ success: true, settings: config });
});

router.post('/admin/save_settings', isAuthenticated, isAdmin, async (req, res) => {
    const updates = req.body;
    for (const [key, value] of Object.entries(updates)) {
        await Setting.findOneAndUpdate({ key }, { value }, { upsert: true });
    }
    res.json({ success: true });
});

router.get('/admin/get_flagged_posts', isAuthenticated, async (req, res) => {
    const reports = await Report.find({ status: 'open', reason: /post/i }).populate('reported_user', 'name avatar');
    res.json(reports.map(r => ({
        id: r._id, report_id: r._id, author: r.reported_user?.name || 'User', reason: r.reason, content: r.details, time: formatTime(r.created_at)
    })));
});

router.get('/admin/get_broadcast_history', isAuthenticated, async (req, res) => {
    const history = await Broadcast.find({}).sort({ sent_at: -1 }).limit(50);
    res.json({ success: true, history });
});

router.get('/admin/get_logs', isAuthenticated, async (req, res) => {
    const { startDate, endDate, action } = req.query;
    const query = {};
    if (startDate || endDate) {
        query.timestamp = {};
        if (startDate) query.timestamp.$gte = new Date(startDate);
        if (endDate) query.timestamp.$lte = new Date(endDate);
    }
    if (action) query.action = action;

    const logs = await Log.find(query).populate('user', 'name').sort({ timestamp: -1 }).limit(100);
    res.json({ 
        success: true, 
        logs: logs.map(l => ({
            id: l._id, timestamp: formatTime(l.timestamp), user: l.user?.name || 'System', action: l.action, details: l.details
        })) 
    });
});

router.get('/vapid_public_key', isAuthenticated, (req, res) => {
    res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

router.get('/get_archived_chats', isAuthenticated, async (req, res) => {
    try {
        const user = await User.findById(req.session.userId);
        const archivedList = [];

        for (const item of user.archived_chats) {
            if (item.chat_type === 'group') {
                const group = await Group.findById(item.chat_id);
                if (group) archivedList.push({ id: group._id, name: group.name, avatar: group.avatar, type: 'group', lastMsg: 'Archived Group' });
            } else {
                const otherUser = await User.findById(item.chat_id);
                if (otherUser) archivedList.push({ id: otherUser._id, name: otherUser.name, avatar: otherUser.avatar, type: 'user', lastMsg: 'Archived Chat' });
            }
        }
        res.json(archivedList);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch archives' });
    }
});

router.post('/toggle_archive_chat', isAuthenticated, async (req, res) => {
    try {
        const { chat_id, type } = req.body;
        const user = await User.findById(req.session.userId);
        
        const index = user.archived_chats.findIndex(c => c.chat_id.toString() === chat_id);
        let archived = false;

        if (index === -1) {
            user.archived_chats.push({ chat_id, chat_type: type });
            archived = true;
        } else {
            user.archived_chats.splice(index, 1);
        }

        await user.save();
        res.json({ success: true, archived });
    } catch (error) {
        res.status(500).json({ error: 'Failed to toggle archive' });
    }
});

router.post('/block_user', isAuthenticated, async (req, res) => {
    try {
        const { user_id } = req.body;
        await User.findByIdAndUpdate(req.session.userId, { 
            $addToSet: { blocked_users: user_id } 
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to block user' });
    }
});

router.post('/unblock_user', isAuthenticated, async (req, res) => {
    try {
        const { user_id } = req.body;
        await User.findByIdAndUpdate(req.session.userId, { 
            $pull: { blocked_users: user_id } 
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to unblock user' });
    }
});

router.get('/get_blocked_users', isAuthenticated, async (req, res) => {
    const user = await User.findById(req.session.userId).populate('blocked_users', 'name avatar');
    res.json(user.blocked_users.map(u => u._id));
});

router.get('/get_blocked_user_details', isAuthenticated, async (req, res) => {
    const user = await User.findById(req.session.userId).populate('blocked_users', 'name avatar username dept');
    res.json(user.blocked_users.map(u => ({ id: u._id, name: u.name, avatar: u.avatar, username: u.username, dept: u.dept })));
});

router.get('/get_security_data', isAuthenticated, async (req, res) => {
    const user = await User.findById(req.session.userId).select('login_sessions');
    res.json(user.login_sessions || []);
});

router.get('/get_notifications', isAuthenticated, async (req, res) => {
    const notifications = await Notification.find({ user: req.session.userId })
        .populate('trigger_user', 'name first_name surname avatar')
        .sort({ created_at: -1 }).limit(20);

    // Get unread counts broken down by category
    const categoryCounts = await Notification.aggregate([
        { $match: { user: new mongoose.Types.ObjectId(req.session.userId), is_read: false } },
        { $group: { _id: "$type", count: { $sum: 1 } } }
    ]);

    const unreadByCategory = {
        like: 0,
        follow: 0,
        post: 0,
        mention: 0,
        system: 0
    };
    categoryCounts.forEach(item => { if (unreadByCategory[item._id] !== undefined) unreadByCategory[item._id] = item.count; });

    const formatted = notifications.map(n => {
        let content = n.content;
        if (n.type === 'like' && n.trigger_user) {
            const name = n.trigger_user.first_name || n.trigger_user.name;
            content = n.others_count > 0 
                ? `${name} and ${n.others_count} others liked your post` 
                : `${name} liked your post`;
        }
        const obj = n.toObject();
        obj.content = content; // Override content with grouped text
        obj.trigger_user_id = n.trigger_user?._id || n.trigger_user;
        return obj;
    });

    const unreadCount = await Notification.countDocuments({ user: req.session.userId, is_read: false });
    res.json({ notifications: formatted, unreadCount, unreadByCategory });
});

router.post('/mark_notifications_read', isAuthenticated, async (req, res) => {
    try {
        const { notification_ids } = req.body;
        let filter = { user: req.session.userId, is_read: false };
        
        // If specific IDs are provided, only mark those as read
        if (notification_ids && Array.isArray(notification_ids)) {
            filter._id = { $in: notification_ids };
        }

        await Notification.updateMany(filter, { $set: { is_read: true } });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to clear notifications' });
    }
});

router.post('/update_public_key', isAuthenticated, async (req, res) => {
    await User.findByIdAndUpdate(req.session.userId, { public_key: req.body.public_key });
    res.json({ success: true });
});

router.get('/get_public_key', isAuthenticated, async (req, res) => {
    const user = await User.findById(req.query.user_id).select('public_key');
    res.json({ public_key: user?.public_key });
});

router.post('/increment_reel_view', isAuthenticated, async (req, res) => {
    await Post.updateOne(
        { _id: req.body.post_id, viewed_by: { $ne: req.session.userId } },
        { $inc: { views: 1 }, $addToSet: { viewed_by: req.session.userId } }
    );
    res.json({ success: true });
});

router.post('/toggle_disappearing_mode', isAuthenticated, async (req, res) => {
    try {
        const { chat_id, type } = req.body;
        const user = await User.findById(req.session.userId);
        const index = user.disappearing_chats.findIndex(c => c.chat_id.toString() === chat_id);
        
        let active = false;
        if (index === -1) {
            user.disappearing_chats.push({ chat_id, chat_type: type });
            active = true;
        } else {
            user.disappearing_chats.splice(index, 1);
        }

        await user.save();
        
        // Notify the other side via Socket
        const target = type === 'group' ? `group_${chat_id}` : chat_id;
        req.io.to(target).emit('disappearing_mode_changed', { 
            chat_id, 
            active,
            user_name: user.name 
        });

        res.json({ success: true, active });
    } catch (error) { res.status(500).json({ error: 'Failed' }); }
});
router.get('/get_post_likes', isAuthenticated, async (req, res) => {
    try {
        const post = await Post.findById(req.query.post_id);
        if (!post) return res.json([]);

        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const skip = (page - 1) * limit;

        // Using User.find is more efficient for pagination than populating a potentially huge array
        const likers = await User.find({ _id: { $in: post.likes } })
            .select('name first_name surname avatar username online dept')
            .skip(skip)
            .limit(limit);

        res.json(likers);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch likers' });
    }
});

router.get('/get_music_tracks', isAuthenticated, async (req, res) => {
    // This would typically query a collection or external API
    res.json([
        { title: 'Corporate Vibes', artist: 'Maiga', src: 'https://assets.mixkit.co/music/preview/mixkit-tech-house-vibes-130.mp3' },
        { title: 'Study Lo-fi', artist: 'YSU', src: 'https://assets.mixkit.co/music/preview/mixkit-dreaming-big-31.mp3' }
    ]);
});

router.get('/get_stickers', isAuthenticated, (req, res) => {
    res.json({
        editor: ['🔥', '✨', '🎓', '📚'],
        story: [
            { name: 'Celebration', url: '/img/stickers/party.svg' },
            { name: 'Verified', url: '/img/stickers/check.svg' }
        ]
    });
});

router.post('/update_group_info', isAuthenticated, upload.single('avatar'), async (req, res) => {
    try {
        const { group_id, name, description, permissions, approve_members } = req.body;
        const group = await Group.findById(group_id);
        if (!group) return res.status(404).json({ error: 'Group not found' });

        const member = group.members.find(m => m.user.equals(req.session.userId));
        if (!member || (member.role !== 'admin' && !group.permissions.can_edit_settings)) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        const updates = { name, description, approve_members: approve_members === '1' };
        if (permissions) updates.permissions = JSON.parse(permissions);
        if (req.file) updates.avatar = await uploadToR2(req.file, 'groups');

        await Group.findByIdAndUpdate(group_id, { $set: updates });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.post('/add_group_members', isAuthenticated, async (req, res) => {
    try {
        const { group_id, members } = req.body;
        const group = await Group.findById(group_id);
        if (!group) return res.status(404).json({ error: 'Group not found' });

        const member = group.members.find(m => m.user.equals(req.session.userId));
        if (!member || (member.role !== 'admin' && !group.permissions.can_add_members)) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        const newMembers = members.map(id => ({ user: id, role: 'member' }));
        await Group.findByIdAndUpdate(group_id, { $addToSet: { members: { $each: newMembers } } });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.post('/revoke_group_invite_link', isAuthenticated, async (req, res) => {
    try {
        const { group_id } = req.body;
        const group = await Group.findById(group_id);
        if (!group) return res.status(404).json({ error: 'Group not found' });

        const member = group.members.find(m => m.user.equals(req.session.userId));
        if (!member || member.role !== 'admin') return res.status(403).json({ error: 'Unauthorized' });

        const newCode = Math.random().toString(36).substring(2, 8).toUpperCase();
        group.invite_link_code = newCode;
        await group.save();
        res.json({ success: true, new_code: newCode });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Admin Routes
router.get('/admin/get_reports', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const reports = await Report.find({ status: 'open' })
            .populate('reporter', 'name avatar')
            .populate('reported_user', 'name avatar')
            .sort({ created_at: -1 });
        
        res.json(reports.map(r => ({
            id: r._id,
            reporter: r.reporter,
            reported_user: r.reported_user,
            reason: r.reason,
            details: r.details,
            time: formatTime(r.created_at)
        })));
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch reports' });
    }
});

router.post('/admin/dismiss_report', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const { report_id } = req.body;
        await Report.findByIdAndUpdate(report_id, { status: 'dismissed' });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to dismiss report' });
    }
});

router.post('/admin/block_and_resolve_report', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const { report_id, user_id } = req.body;
        
        // Block the user
        await User.findByIdAndUpdate(user_id, { blocked: true });
        // Resolve the report
        await Report.findByIdAndUpdate(report_id, { status: 'dismissed' });

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to process action' });
    }
});

router.post('/admin/delete_post', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const { post_id } = req.body;
        const post = await Post.findById(post_id);
        if (!post) return res.status(404).json({ error: 'Post not found' });
        // Hook in models.js now handles R2 cleanup automatically!

        await Post.deleteOne({ _id: post_id });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete post' });
    }
});

router.post('/admin/delete_broadcast', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const { id } = req.body;
        await Broadcast.deleteOne({ _id: id });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete broadcast record' });
    }
});

router.post('/admin/revoke_session', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const { user_id, session_id } = req.body;
        await User.findByIdAndUpdate(user_id, { 
            $pull: { login_sessions: { _id: session_id } } 
        });
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: 'Failed to revoke session' }); }
});

router.post('/admin/warn_user', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const { user_id, message, report_id } = req.body;
        
        const notification = new Notification({
            user: user_id,
            type: 'system',
            content: `⚠️ Warning from Admin: ${message}`,
            is_read: false
        });
        await notification.save();

        if (report_id) {
            await Report.findByIdAndUpdate(report_id, { status: 'dismissed' });
        }

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to send warning' });
    }
});

router.post('/admin/ban_user', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const { user_id, reason } = req.body;
        // Permanently set blocked status and record administrative details
        await User.findByIdAndUpdate(user_id, { 
            blocked: true,
            banned_by: req.session.userId,
            ban_reason: reason || 'No reason provided'
        });
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to ban user' });
    }
});

router.get('/admin/get_blocked_user_details', isAuthenticated, isAdmin, async (req, res) => {
    try {
        // Fetch all users marked as globally blocked/banned
        const blockedUsers = await User.find({ blocked: true })
            .populate('banned_by', 'name username')
            .select('name username email avatar bio dept createdAt updatedAt banned_by ban_reason');
        
        res.json(blockedUsers.map(u => ({
            id: u._id,
            name: u.name,
            username: u.username,
            email: u.email,
            avatar: u.avatar,
            joined_at: u.createdAt,
            banned_at: u.updatedAt,
            banned_by: u.banned_by ? u.banned_by.name : 'System',
            ban_reason: u.ban_reason
        })));
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch blocked user details' });
    }
});

router.get('/admin/search_blocked_users', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const { q } = req.query;
        if (!q) return res.json([]);

        // Find banned users matching email or username
        const blockedUsers = await User.find({ 
            blocked: true,
            $or: [
                { username: { $regex: q, $options: 'i' } },
                { email: { $regex: q, $options: 'i' } }
            ]
        })
        .populate('banned_by', 'name username')
        .select('name username email avatar banned_by ban_reason updatedAt');
        
        res.json(blockedUsers.map(u => ({
            id: u._id,
            name: u.name,
            username: u.username,
            email: u.email,
            avatar: u.avatar,
            banned_by: u.banned_by ? u.banned_by.name : 'System',
            ban_reason: u.ban_reason,
            banned_at: u.updatedAt
        })));
    } catch (error) {
        res.status(500).json({ error: 'Failed to search blocked users' });
    }
});

router.get('/admin/group_activity_report', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const { group_id } = req.query;
        const last7Days = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

        const activity = await Message.aggregate([
            { $match: { group: new mongoose.Types.ObjectId(group_id), createdAt: { $gte: last7Days } } },
            { $group: {
                _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
                count: { $sum: 1 }
            }},
            { $sort: { _id: 1 } }
        ]);

        res.json(activity);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch activity report' });
    }
});

router.get('/admin/get_admin_notifications', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const notifications = await Notification.find({ user: req.session.userId })
            .sort({ created_at: -1 })
            .limit(20);
        
        res.json({ 
            success: true, 
            notifications: notifications.map(n => ({
                id: n._id,
                message: n.content,
                time: formatTime(n.created_at),
                unread: !n.is_read,
                icon: n.type === 'system' ? 'fa-triangle-exclamation' : 'fa-bell'
            }))
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch notifications' });
    }
});

router.post('/admin/mark_all_notifications_read', isAuthenticated, isAdmin, async (req, res) => {
    try {
        await Notification.updateMany({ user: req.session.userId, is_read: false }, { $set: { is_read: true } });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to update notifications' });
    }
});

router.post('/admin/delete_notification', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const { id } = req.body;
        await Notification.deleteOne({ _id: id, user: req.session.userId });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete notification' });
    }
});

router.post('/admin/save_settings', isAuthenticated, isAdmin, async (req, res) => {
    // Placeholder - in a full implementation, you would save these to a 'Settings' collection
    res.json({ success: true });
});

router.post('/admin/send_broadcast', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const { title, message } = req.body;
        const users = await User.find({}, '_id');
        const notifications = users.map(u => ({
            user: u._id,
            type: 'system',
            content: `${title ? title + ': ' : ''}${message}`,
            is_read: false
        }));
        await Notification.insertMany(notifications);
        
        // Persist to history
        await Broadcast.create({ title, message, sent_by: req.session.userId });
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to send broadcast' });
    }
});

router.post('/admin/update_admin_profile', isAuthenticated, isAdmin, upload.single('avatar'), async (req, res) => {
    try {
        const { name } = req.body;
        const updates = { name };
        if (req.file) updates.avatar = await uploadToR2(req.file, 'admin');
        
        await User.findByIdAndUpdate(req.session.userId, { $set: updates });
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: 'Failed to update admin profile' }); }
});

router.post('/admin/clear_chat', isAuthenticated, isAdmin, async (req, res) => {
    const { chat_id } = req.body;
    await Message.deleteMany({ $or: [{ sender: chat_id }, { receiver: chat_id }] });
    res.json({ success: true });
});

router.post('/admin/toggle_verify_user', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const { user_id } = req.body;
        const user = await User.findById(user_id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        user.is_verified = !user.is_verified;
        await user.save();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to toggle verification' });
    }
});

router.post('/admin/toggle_admin', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const { user_id } = req.body;
        const user = await User.findById(user_id);
        if (!user) return res.status(404).json({ error: 'User not found' });

        user.is_admin = !user.is_admin;
        
        if (user.is_admin) {
            // Make all existing users follow this new admin
            const allUserIds = await User.find({ _id: { $ne: user._id } }, '_id');
            const ids = allUserIds.map(u => u._id);
            
            // Update all users to add admin to their 'following'
            await User.updateMany(
                { _id: { $in: ids } },
                { $addToSet: { following: user._id } }
            );
            
            // Add all users to admin's 'followers'
            user.followers = [...new Set([...user.followers, ...ids])];
        }

        await user.save();
        res.json({ success: true, is_admin: user.is_admin });
    } catch (error) { res.status(500).json({ error: 'Failed to toggle admin status' }); }
});

router.post('/admin/delete_user', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const { user_id } = req.body;
        await User.deleteOne({ _id: user_id });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete user' });
    }
});

router.post('/admin/unblock_user', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const { user_id } = req.body;
        await User.findByIdAndUpdate(user_id, { 
            blocked: false, 
            $unset: { banned_by: 1, ban_reason: 1 } 
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to unblock user' });
    }
});

router.get('/get_trending', isAuthenticated, async (req, res) => {
    try {
        // Aggregate hashtags from posts created in the last 7 days
        const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const posts = await Post.find({ 
            createdAt: { $gte: lastWeek },
            content: { $regex: /#/ } 
        }, 'content');

        const counts = {};
        posts.forEach(p => {
            const tags = p.content.match(/#\w+/g);
            if (tags) {
                tags.forEach(t => {
                    counts[t] = (counts[t] || 0) + 1;
                });
            }
        });

        const trending = Object.entries(counts)
            .map(([tag, count]) => ({ tag: tag.replace('#', ''), count, category: 'Trending' }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 10);

        res.json(trending);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch trending' });
    }
});

router.get('/get_forum_topics', isAuthenticated, async (req, res) => {
    // Placeholder topics for the community forum
    res.json([
        { id: 1, title: 'General Discussion', description: 'Talk about anything!', posts: 120 },
        { id: 2, title: 'Campus News', description: 'Latest updates from YSU.', posts: 45 },
        { id: 3, title: 'Marketplace', description: 'Buy and sell items.', posts: 89 }
    ]);
});

router.get('/get_muted_chats', isAuthenticated, async (req, res) => {
    try {
        const user = await User.findById(req.session.userId);
        const mutedList = [];

        for (const item of user.muted_chats) {
            if (item.chat_type === 'group') {
                const group = await Group.findById(item.chat_id);
                if (group) mutedList.push({ id: group._id, name: group.name, avatar: group.avatar, type: 'group', lastMsg: 'Group chat muted' });
            } else {
                const otherUser = await User.findById(item.chat_id);
                if (otherUser) mutedList.push({ id: otherUser._id, name: otherUser.name, avatar: otherUser.avatar, type: 'user', lastMsg: 'Chat muted' });
            }
        }
        res.json(mutedList);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch muted chats' });
    }
});

router.post('/toggle_mute', isAuthenticated, async (req, res) => {
    try {
        const { chat_id, type } = req.body;
        const userId = req.session.userId;
        const user = await User.findById(userId);
        
        const index = user.muted_chats.findIndex(c => c.chat_id.toString() === chat_id && c.chat_type === type);
        let muted = false;

        if (index === -1) {
            user.muted_chats.push({ chat_id, chat_type: type });
            muted = true;
        } else {
            user.muted_chats.splice(index, 1);
        }

        await user.save();
        res.json({ success: true, muted });
    } catch (error) {
        res.status(500).json({ error: 'Failed to toggle mute status' });
    }
});

router.get('/get_pinned_chats', isAuthenticated, async (req, res) => {
    try {
        const user = await User.findById(req.session.userId);
        const pinnedList = [];

        for (const item of user.pinned_chats) {
            if (item.chat_type === 'group') {
                const group = await Group.findById(item.chat_id);
                if (group) pinnedList.push({ id: group._id, name: group.name, avatar: group.avatar, type: 'group', lastMsg: 'Group chat pinned' });
            } else {
                const otherUser = await User.findById(item.chat_id);
                if (otherUser) pinnedList.push({ id: otherUser._id, name: otherUser.name, avatar: otherUser.avatar, type: 'user', lastMsg: 'Chat pinned' });
            }
        }
        res.json(pinnedList);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch pinned chats' });
    }
});

router.post('/toggle_pin_chat', isAuthenticated, async (req, res) => {
    try {
        const { chat_id, type } = req.body;
        const userId = req.session.userId;
        const user = await User.findById(userId);
        
        const index = user.pinned_chats.findIndex(c => c.chat_id.toString() === chat_id && c.chat_type === type);
        let pinned = false;

        if (index === -1) {
            user.pinned_chats.push({ chat_id, chat_type: type });
            pinned = true;
        } else {
            user.pinned_chats.splice(index, 1);
        }

        await user.save();
        res.json({ success: true, pinned });
    } catch (error) {
        res.status(500).json({ error: 'Failed to toggle pin status' });
    }
});

router.post('/admin/migrate_avatars', isAuthenticated, async (req, res) => {
    try {
        const adminUser = await User.findById(req.session.userId);
        if (!adminUser || !adminUser.is_admin) return res.status(403).json({ error: 'Access denied' });

        // Identify the old default strings you want to replace
        const oldDefaults = [
            'img/default-avatar.png',
            'https://api.dicebear.com/7.x/avataaars/svg?seed=default'
        ];

        // Update Males
        const maleResult = await User.updateMany(
            { gender: 'male', avatar: { $in: oldDefaults } },
            { $set: { avatar: 'img/male.png' } }
        );

        // Update Females
        const femaleResult = await User.updateMany(
            { gender: 'female', avatar: { $in: oldDefaults } },
            { $set: { avatar: 'img/female.png' } }
        );

        res.json({ 
            success: true, 
            stats: { malesUpdated: maleResult.modifiedCount, femalesUpdated: femaleResult.modifiedCount } 
        });
    } catch (error) {
        res.status(500).json({ error: 'Migration failed', details: error.message });
    }
});

router.get('/get_animated_stickers', isAuthenticated, (req, res) => {
    res.json([
        { name: 'Celebration', url: '/img/stickers/party.svg' },
        { name: 'Verified', url: '/img/stickers/check.svg' }
    ]);
});

module.exports = router;
