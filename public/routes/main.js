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
    const now = new Date();
    const past = new Date(date);
    const diff = Math.floor((now - past) / 1000);

    if (diff < 0) return 'Just now'; 
    if (diff < 60) return 'Just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
    return past.toLocaleDateString();
};

// --- Routes ---

router.get('/get_user', isAuthenticated, async (req, res) => {
    const user = await User.findById(req.session.userId);
    res.json({
        id: user._id, name: user.name, username: user.username, account_type: user.account_type,
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

router.get('/get_posts', isAuthenticated, async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = 10;
    const skip = (page - 1) * limit;
    const query = req.query.user_id ? { user: req.query.user_id, media_type: { $ne: 'video' } } : { media_type: { $ne: 'video' } };
    
    // Populate 'user' and include fields needed for the 'full_name' virtual
    const posts = await Post.find(query)
        .populate('user', 'name first_name surname avatar is_verified')
        .sort({ createdAt: -1 }).skip(skip).limit(limit);
    
    res.json(posts.map(p => ({
        id: p._id, user_id: p.user?._id, author: p.user?.full_name || 'Deleted User', avatar: p.user?.avatar,
        content: p.content, media: p.media, media_type: p.media_type,
        time: formatTime(p.createdAt), likes: p.likes.length,
        comments: p.comments_count || 0, // Ensure comments count is included
        views: p.views || 0, // Ensure views count is included
        saved: p.saved_by.some(id => id.toString() === req.session.userId),
        myReaction: p.likes.some(id => id.toString() === req.session.userId) ? 'like' : null
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
    const populatedPost = await post.populate('user', 'name first_name surname avatar is_verified');
    
    // Return a fully formatted post object for optimistic UI update
    res.json({ success: true, post: {
        id: populatedPost._id, user_id: populatedPost.user?._id, author: populatedPost.user?.full_name || 'Deleted User', avatar: populatedPost.user?.avatar,
        content: populatedPost.content, media: populatedPost.media, 
        media_type: populatedPost.media_type || (req.file?.mimetype.startsWith('video') ? 'video' : 'image'),
        time: formatTime(populatedPost.createdAt), likes: 0, comments: 0, views: 0, saved: false, myReaction: null,
        verified: populatedPost.user?.is_verified ?? false
    }});
});

router.post('/send_message', isAuthenticated, upload.single('media'), async (req, res) => {
    const { receiver_id, group_id, content, media_type, reply_to_id } = req.body;
    
    let mediaUrl = null;
    if (req.file) {
        // Organize R2 storage by media type
        const isAudio = req.file.mimetype.startsWith('audio') || media_type === 'audio';
        const folder = isAudio ? 'voice_notes' : (media_type === 'sticker' ? 'stickers' : 'messages');
        mediaUrl = await uploadToR2(req.file, folder);
    }

    // Handle Disappearing Messages (24h)
    const user = await User.findById(req.session.userId);
    const isDisappearing = user.disappearing_chats.some(c => c.chat_id.toString() === (receiver_id || group_id));
    let expiryDate = null;
    if (isDisappearing) {
        expiryDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
    }

    const msg = new Message({
        sender: req.session.userId,
        receiver: receiver_id || null,
        group: group_id || null,
        content: content,
        media: mediaUrl,
        media_type: media_type || 'text',
        reply_to: reply_to_id || null,
        expires_at: expiryDate
    });
    
    // Hook in models.js now handles the socket emission automatically!
    await msg.save();
    res.json({ success: true });
});

router.post('/create_group', isAuthenticated, upload.single('avatar'), async (req, res) => {
    try {
        const { name, description, members, permissions, approve_members } = req.body;
        let avatarUrl = 'img/default-group.png';
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
    
    const user = await User.findById(userId);
    const archivedIds = user.archived_chats.map(c => c.chat_id.toString());

    const chats = new Map();
    messages.forEach(m => {
        if (!m.sender || !m.receiver || !m.sender._id || !m.receiver._id) return; 
        
        const other = m.sender._id.toString() === userId.toString() ? m.receiver : m.sender;
        const otherId = other._id.toString();
        
        if (!chats.has(otherId) && !archivedIds.includes(otherId)) {
            chats.set(otherId, {
                id: other._id, name: other.name, avatar: other.avatar,
                status: other.online ? 'online' : 'offline',
                lastMsg: m.media_type === 'text' ? m.content : `Sent a ${m.media_type}`, 
                time: formatTime(m.createdAt)
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
        
        const groupData = await Promise.all(groups.map(async g => {
            // Fetch the actual last message for this group to persist it after refresh
            const lastMessage = await Message.findOne({ group: g._id }).sort({ createdAt: -1 });
            
            return {
                id: g._id,
                name: g.name,
                avatar: g.avatar || 'img/default-group.png',
                type: 'group',
                lastMsg: lastMessage ? (lastMessage.media_type === 'text' ? lastMessage.content : `Sent a ${lastMessage.media_type}`) : 'No messages yet',
                time: lastMessage ? formatTime(lastMessage.createdAt) : '',
                unread: false
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

    // Add Star filter
    if (req.query.starred === 'true') {
        query.starred_by = userId;
    }

    const messages = await Message.find(query)
        .sort({ createdAt: 1 })
        .populate('sender', 'name first_name surname avatar')
        .populate('reply_to');

    res.json(messages.map(m => ({
        id: m._id, sender_id: m.sender._id, content: m.content,
        media: m.media, media_type: m.media_type, created_at: m.createdAt,
        delivered: m.is_delivered,
        is_read: m.is_read, avatar: m.sender.avatar, 
        pinned: m.is_pinned,
        is_edited: m.is_edited,
        read_by: m.read_by,
        poll_id: m.poll?._id,
        question: m.poll?.question,
        options: m.poll?.options,
        starred: m.starred_by.some(id => id.toString() === userId.toString()),
        replyTo: m.reply_to ? { author: 'User', content: m.reply_to.content } : null,
        first_name: m.sender.first_name || m.sender.name?.split(' ')[0] || 'User',
        surname: m.sender.surname || ''
    })));
});

router.post('/mark_messages_read', isAuthenticated, async (req, res) => {
    const { chat_id, type } = req.body;
    const userId = req.session.userId;
    const user = await User.findById(userId);

    const filter = type === 'group' 
        ? { group: chat_id, 'read_by.user': { $ne: userId } }
        : { sender: chat_id, receiver: userId, is_read: false };

    await Message.updateMany(filter, { 
        $set: { is_read: true },
        $addToSet: { read_by: { user: userId, first_name: user.first_name || user.name } } 
    });
    res.json({ success: true });
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
        original_post: originalPost._id // Reference to the original post
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
        res.json({ success: true, comment_id: comment._id, content, media: mediaUrl });
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

router.get('/get_reels', isAuthenticated, async (req, res) => {
    const query = { media_type: 'video' };
    if (req.query.user_id) query.user = req.query.user_id;
    const reels = await Post.find(query).populate('user', 'name avatar').sort({ createdAt: -1 });
    const userId = req.session.userId;
    res.json(reels.map(r => ({
        id: r._id, user_id: r.user._id, author: r.user.name, avatar: r.user.avatar,
        media: r.media, caption: r.content, likes: r.likes.length, views: r.views || 0,
        comments: r.comments_count || 0, // Ensure comments count is included
        liked: r.likes.some(id => id.toString() === userId.toString()),
        saved: r.saved_by.some(id => id.toString() === userId.toString()),
        myReaction: r.likes.some(id => id.toString() === userId.toString()) ? 'like' : null
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
    const user = await User.findById(req.session.userId).populate('following', 'name first_name surname avatar username online dept');
    res.json(user.following.filter(u => u != null).map(u => ({ 
        id: u._id, 
        name: u.full_name || u.name, 
        avatar: u.avatar, 
        username: u.username, 
        online: u.online, 
        dept: u.dept 
    })));
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
                return story.user.close_friends.some(cfId => cfId.toString() === userId);
            }
            return false;
        });

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
