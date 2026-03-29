const express = require('express');
const router = express.Router();
const multer = require('multer');
const fs = require('fs');
const webpush = require('web-push');
const { PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { isAuthenticated } = require('../../middleware');
const { User, Post, Message, Group, Call, Story, Report, Notification, Comment, s3Client } = require('../../models');

const publicVapidKey = process.env.VAPID_PUBLIC_KEY;
const privateVapidKey = process.env.VAPID_PRIVATE_KEY;
if (publicVapidKey && privateVapidKey) {
    const senderEmail = process.env.SENDER_EMAIL || 'admin@maiga.social';
    webpush.setVapidDetails(`mailto:${senderEmail}`, publicVapidKey, privateVapidKey);
}

const upload = multer({ storage: multer.memoryStorage() });

// Robust URL handling: ensure the base URL has no trailing slash
const BASE_PUBLIC_URL = process.env.R2_PUBLIC_URL?.replace(/\/+$/, '');

const uploadToR2 = async (file, folder) => {
    const key = `${folder}/${Date.now()}-${file.originalname.replace(/\s+/g, '_')}`;
    await s3Client.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
    }));
    return `${BASE_PUBLIC_URL}/${key}`;
};

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
                } catch (cleanupErr) {
                    console.error("Old avatar cleanup failed:", cleanupErr.message);
                }
            }
            updates.avatar = await uploadToR2(req.file, 'avatars');
        }

        await User.findByIdAndUpdate(req.session.userId, { $set: updates }, { runValidators: true });
        res.json({ success: true });
    } catch (error) {
        console.error("Profile update failed:", error);
        res.status(500).json({ success: false, error: 'Failed to update profile details.' });
    }
});

router.get('/get_posts', isAuthenticated, async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = 10;
    const skip = (page - 1) * limit;
    const query = req.query.user_id ? { user: req.query.user_id } : {};
    
    // Populate 'user' and include fields needed for the 'full_name' virtual
    const posts = await Post.find(query)
        .populate('user', 'name first_name surname avatar is_verified')
        .sort({ createdAt: -1 }).skip(skip).limit(limit);
    
    res.json(posts.map(p => ({
        id: p._id, user_id: p.user?._id, author: p.user?.full_name || 'Deleted User', avatar: p.user?.avatar,
        content: p.content, media: p.media, media_type: p.media_type,
        time: formatTime(p.createdAt), likes: p.likes.length,
        saved: p.saved_by.includes(req.session.userId),
        myReaction: p.likes.includes(req.session.userId) ? 'like' : null
    })));
});

router.post('/create_post', isAuthenticated, upload.single('media'), async (req, res) => {
    let mediaUrl = null;
    if (req.file) {
        const folder = req.file.mimetype.startsWith('video') ? 'reels' : 'posts';
        mediaUrl = await uploadToR2(req.file, folder);
    }
    const post = new Post({
        user: req.session.userId,
        content: req.body.content,
        media: mediaUrl,
        media_type: req.file ? (req.file.mimetype.startsWith('video') ? 'video' : 'image') : null
    });
    await post.save();
    res.json({ success: true, post: await post.populate('user', 'name avatar') });
});

router.post('/send_message', isAuthenticated, upload.single('media'), async (req, res) => {
    const { receiver_id, group_id, content, media_type } = req.body;
    
    let mediaUrl = null;
    if (req.file) {
        const folder = req.file.mimetype.startsWith('audio') ? 'voice_notes' : 'messages';
        mediaUrl = await uploadToR2(req.file, folder);
    }

    const msg = new Message({
        sender: req.session.userId,
        receiver: receiver_id || null,
        group: group_id || null,
        content: content,
        media: mediaUrl,
        media_type: media_type || 'text'
    });
    
    // Hook in models.js now handles the socket emission automatically!
    await msg.save();
    res.json({ success: true });
});

router.get('/get_chats', isAuthenticated, async (req, res) => {
    const userId = req.session.userId;
    const messages = await Message.find({ $or: [{ sender: userId }, { receiver: userId }] })
        .sort({ created_at: -1 }).populate('sender receiver', 'name avatar online');
    
    const user = await User.findById(userId);
    const archivedIds = user.archived_chats.map(c => c.chat_id.toString());

    const chats = new Map();
    messages.forEach(m => {
        const other = m.sender._id.equals(userId) ? m.receiver : m.sender;
        const otherId = other._id.toString();

        if (!chats.has(otherId) && !archivedIds.includes(otherId)) {
            chats.set(otherId, {
                id: other._id, name: other.name, avatar: other.avatar,
                status: other.online ? 'online' : 'offline',
                lastMsg: m.content, time: formatTime(m.created_at)
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
        res.json(groups.map(g => ({
            id: g._id,
            name: g.name,
            avatar: g.avatar || 'img/default-group.png',
            type: 'group',
            lastMsg: 'Group chat',
            unread: false
        })));
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
        const posts = await Post.find({ user: user._id }).sort({ createdAt: -1 }).skip(skip).limit(limit + 1); // Fetch one extra to check for more

        res.json({
            id: user._id,
            name: user.full_name,
            username: user.username,
            avatar: user.avatar,
            bio: user.bio,
            dept: user.dept,
            online: user.online,
            is_admin: user.is_admin,
            followers_count: user.followers.length,
            following_count: user.following.length,
            posts: posts.slice(0, limit).map(p => ({
                id: p._id,
                content: p.content,
                media: p.media,
                media_type: p.media_type,
                time: formatTime(p.createdAt),
                likes: p.likes.length,
                author: user.full_name, // Redundant but useful for frontend consistency
                avatar: user.avatar // Redundant but useful for frontend consistency
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
    const { chat_id, type } = req.query;
    const userId = req.session.userId;
    
    const query = {
        ...(type === 'group' ? { group: chat_id } : { $or: [{ sender: userId, receiver: chat_id }, { sender: chat_id, receiver: userId }] }),
        deleted_for: { $ne: userId }
    };
    
    // Add content search filter if query is provided
    if (req.query.search) {
        query.content = { $regex: req.query.search, $options: 'i' };
    }

    const messages = await Message.find(query).sort({ created_at: 1 }).populate('sender', 'name first_name surname avatar');
    res.json(messages.map(m => ({
        id: m._id, sender_id: m.sender._id, content: m.content,
        media: m.media, media_type: m.media_type, created_at: m.created_at,
        is_read: m.is_read, avatar: m.sender.avatar,
        first_name: m.sender.first_name || m.sender.name?.split(' ')[0] || 'User',
        surname: m.sender.surname || ''
    })));
});

router.post('/toggle_reaction', isAuthenticated, async (req, res) => {
    const userId = req.session.userId;
    const post = await Post.findById(req.body.post_id);
    if (!post) return res.status(404).json({ error: 'Post not found' });

    const isLiked = post.likes.some(id => id.toString() === userId.toString());
    if (isLiked) {
        await post.updateOne({ $pull: { likes: userId } });
    } else {
        await post.updateOne({ $addToSet: { likes: userId } });
    }
    res.json({ success: true });
});

router.post('/toggle_follow', isAuthenticated, async (req, res) => {
    try {
        const targetId = req.body.user_id;
        const myId = req.session.userId;
        const targetUser = await User.findById(targetId);
        
        const isFollowing = targetUser.followers.includes(myId);
        if (isFollowing) {
            await User.findByIdAndUpdate(myId, { $pull: { following: targetId } });
            await User.findByIdAndUpdate(targetId, { $pull: { followers: myId } });
        } else {
            await User.findByIdAndUpdate(myId, { $addToSet: { following: targetId } });
            await User.findByIdAndUpdate(targetId, { $addToSet: { followers: myId } });
        }
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: 'Action failed' }); }
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
        const { post_id, content, parent_comment_id } = req.body;
        let mediaUrl = null;
        if (req.file) mediaUrl = await uploadToR2(req.file, 'comments');

        const comment = new Comment({
            post: post_id, user: req.session.userId, content, media: mediaUrl,
            media_type: req.file ? (req.file.mimetype.startsWith('audio') ? 'audio' : 'image') : 'text',
            parent_comment: parent_comment_id || null
        });
        await comment.save();
        await Post.findByIdAndUpdate(post_id, { $inc: { comments_count: 1 } });
        res.json({ success: true, comment_id: comment._id, content, media: mediaUrl });
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

router.get('/get_reels', isAuthenticated, async (req, res) => {
    const query = { media_type: 'video' };
    if (req.query.user_id) query.user = req.query.user_id;
    const reels = await Post.find(query).populate('user', 'name avatar').sort({ createdAt: -1 });
    res.json(reels.map(r => ({
        id: r._id, user_id: r.user._id, author: r.user.name, avatar: r.user.avatar,
        media: r.media, caption: r.content, likes: r.likes.length, views: r.views,
        liked: r.likes.includes(req.session.userId)
    })));
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
    const suggestions = await User.find({ 
        _id: { $nin: [req.session.userId, ...user.following] },
        blocked: false 
    }).limit(10).select('name username avatar dept online');
    res.json(suggestions.map(u => ({ id: u._id, name: u.name, username: u.username, avatar: u.avatar, dept: u.dept, online: u.online })));
});

router.get('/get_connections', isAuthenticated, async (req, res) => {
    const user = await User.findById(req.session.userId).populate('following', 'name avatar username online dept');
    res.json(user.following.map(u => ({ id: u._id, name: u.name, avatar: u.avatar, username: u.username, online: u.online, dept: u.dept })));
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

router.post('/subscribe', isAuthenticated, async (req, res) => {
    await User.findByIdAndUpdate(req.session.userId, { push_subscription: req.body });
    res.status(201).json({});
});

router.get('/search_users', isAuthenticated, async (req, res) => {
    const users = await User.find({ name: { $regex: req.query.q, $options: 'i' } }).limit(10);
    res.json(users.map(u => ({ id: u._id, name: u.name, avatar: u.avatar, dept: u.dept })));
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
        
        // Fetch stories from self and people the user follows
        const creators = [userId, ...user.following];
        
        const stories = await Story.find({
            user: { $in: creators },
            createdAt: { $gte: yesterday }
        }).populate('user', 'name avatar close_friends');

        // Filter stories based on privacy settings
        const filteredStories = stories.filter(story => {
            // Always show own stories
            if (story.user._id.equals(userId)) return true;
            // Public stories are visible to all followers
            if (story.audience === 'public') return true;
            // Close Friends stories only visible if current user is in the creator's list
            if (story.audience === 'close_friends') {
                return story.user.close_friends.includes(userId);
            }
            return false;
        });

        res.json(filteredStories.map(s => ({
            id: s._id,
            user_id: s.user._id,
            first_name: s.user.name.split(' ')[0],
            avatar: s.user.avatar,
            media: s.media,
            type: s.type,
            view_count: s.view_count || 0,
            has_music: s.has_music,
            music_track: s.music_track,
            audience: s.audience,
            created_at: s.createdAt
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
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to submit report' });
    }
});

router.post('/report_user', isAuthenticated, upload.single('screenshot'), async (req, res) => {
    try {
        const { user_id, reason, details } = req.body;
        let screenshotUrl = null;
        if (req.file) screenshotUrl = await uploadToR2(req.file, 'reports');

        const report = new Report({
            reporter: req.session.userId,
            reported_user: user_id,
            reason: reason,
            details: details + (screenshotUrl ? `\nEvidence: ${screenshotUrl}` : ''),
            status: 'open'
        });

        await report.save();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to submit report' });
    }
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

router.get('/get_notifications', isAuthenticated, async (req, res) => {
    const notifications = await Notification.find({ user: req.session.userId })
        .sort({ created_at: -1 }).limit(20);
    res.json(notifications);
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
    await Post.findByIdAndUpdate(req.body.post_id, { $inc: { views: 1 }, $addToSet: { viewed_by: req.session.userId } });
    res.json({ success: true });
});

router.get('/get_post_likes', isAuthenticated, async (req, res) => {
    const post = await Post.findById(req.query.post_id).populate('likes', 'name avatar');
    res.json(post?.likes || []);
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

// Admin Routes
router.get('/admin/get_reports', isAuthenticated, async (req, res) => {
    try {
        const user = await User.findById(req.session.userId);
        if (!user.is_admin) return res.status(403).json({ error: 'Access denied' });

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

router.post('/admin/dismiss_report', isAuthenticated, async (req, res) => {
    try {
        const user = await User.findById(req.session.userId);
        if (!user.is_admin) return res.status(403).json({ error: 'Access denied' });

        const { report_id } = req.body;
        await Report.findByIdAndUpdate(report_id, { status: 'dismissed' });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to dismiss report' });
    }
});

router.post('/admin/block_and_resolve_report', isAuthenticated, async (req, res) => {
    try {
        const user = await User.findById(req.session.userId);
        if (!user.is_admin) return res.status(403).json({ error: 'Access denied' });

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

router.post('/admin/delete_post', isAuthenticated, async (req, res) => {
    try {
        const user = await User.findById(req.session.userId);
        if (!user.is_admin) return res.status(403).json({ error: 'Access denied' });

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

router.post('/admin/warn_user', isAuthenticated, async (req, res) => {
    try {
        const adminUser = await User.findById(req.session.userId);
        if (!adminUser.is_admin) return res.status(403).json({ error: 'Access denied' });

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

router.post('/admin/ban_user', isAuthenticated, async (req, res) => {
    try {
        const adminUser = await User.findById(req.session.userId);
        if (!adminUser || !adminUser.is_admin) return res.status(403).json({ error: 'Access denied' });

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

router.get('/admin/get_blocked_user_details', isAuthenticated, async (req, res) => {
    try {
        const adminUser = await User.findById(req.session.userId);
        if (!adminUser || !adminUser.is_admin) return res.status(403).json({ error: 'Access denied' });

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

router.get('/admin/search_blocked_users', isAuthenticated, async (req, res) => {
    try {
        const adminUser = await User.findById(req.session.userId);
        if (!adminUser || !adminUser.is_admin) return res.status(403).json({ error: 'Access denied' });

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

router.get('/vapid_public_key', isAuthenticated, (req, res) => {
    res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
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

module.exports = router;
