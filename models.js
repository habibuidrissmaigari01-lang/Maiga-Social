const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');

// Variable to hold the Socket.io instance for real-time broadcasts
let ioInstance;

// Cloudflare R2 Configuration (Centralized)
const s3Client = new S3Client({
    region: 'auto',
    endpoint: process.env.R2_S3_API_URL,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
});

// --- Mongoose 8 Global Plugin ---
// This ensures that validation runs on all update operations by default.
mongoose.plugin((schema) => {
    schema.pre(['update', 'updateOne', 'updateMany', 'findOneAndUpdate'], function (next) {
        this.setOptions({ runValidators: true });
        next();
    });
});

const schemaOptions = {
    timestamps: true,
    toJSON: {
        virtuals: true, // Required for virtuals to show up in API responses (Alpine.js)
        transform: (doc, ret) => {
            delete ret.password;
            delete ret.__v;
            return ret;
        }
    }
};

const userSchema = new mongoose.Schema({
    name: String,
    first_name: String, // Added to support virtual logic
    surname: String,    // Added to support virtual logic
    username: { type: String, unique: true },
    email: { type: String, unique: true, lowercase: true },
    password: { type: String, select: false },
    avatar: { 
        type: String, 
        default: function() {
            // Detect gender and return the corresponding local image path
            return this.gender === 'female' ? 'img/female.png' : 'img/male.png';
        }
    },
    bio: String,
    dept: String,
    account_type: { type: String, default: 'maiga' }, // 'maiga' or 'ysu'
    followers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    following: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    close_friends: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    archived_chats: [{
        chat_id: mongoose.Schema.Types.ObjectId,
        chat_type: { type: String, enum: ['user', 'group'] }
    }],
    blocked_users: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    is_admin: { type: Boolean, default: false },
    muted_chats: [{
        chat_id: { type: mongoose.Schema.Types.ObjectId, required: true },
        chat_type: { type: String, enum: ['user', 'group'], required: true }
    }],
    pinned_chats: [{
        chat_id: { type: mongoose.Schema.Types.ObjectId, required: true },
        chat_type: { type: String, enum: ['user', 'group'], required: true }
    }],
    disappearing_chats: [{
        chat_id: { type: mongoose.Schema.Types.ObjectId, required: true },
        chat_type: { type: String, enum: ['user', 'group'], required: true }
    }],
    login_sessions: [{
        device: String,
        browser: String,
        location: String,
        ip: String,
        last_active: { type: Date, default: Date.now }
    }],
    privacy_settings: {
        privateAccount: { type: Boolean, default: false },
        activityStatus: { type: Boolean, default: true },
        location: { type: Boolean, default: true }
    },
    language: { type: String, default: 'English' },
    recent_stickers: [String],
    is_verified: { type: Boolean, default: false },
    blocked: { type: Boolean, default: false },
    banned_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    ban_reason: String,
    online: { type: Boolean, default: false },
    last_seen: Date,
    public_key: String,
    gender: String,
    birthday: Date,
    phone: String,
    push_subscription: Object
}, schemaOptions);

// --- Password Hashing Hook ---
userSchema.pre('save', async function(next) {
    // Only hash the password if it has been modified (or is new)
    if (!this.isModified('password')) return next();
    
    try {
        const salt = await bcrypt.genSalt(10);
        this.password = await bcrypt.hash(this.password, salt);
        next();
    } catch (error) { next(error); }
});

// Computed full_name virtual
userSchema.virtual('full_name').get(function() {
    if (this.first_name || this.surname) return `${this.first_name || ''} ${this.surname || ''}`.trim();
    return this.name; // Fallback to existing name field
});

// Indexes for User search and filtering
userSchema.index({ online: 1 });
userSchema.index({ account_type: 1 });
userSchema.index({ name: 'text', username: 'text' });
userSchema.index({ blocked: 1 });
userSchema.index({ gender: 1, avatar: 1 });
userSchema.index({ blocked: 1, username: 1 }); // For admin search
userSchema.index({ blocked: 1, email: 1 });    // For admin search

const postSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    content: String,
    media: String,
    media_type: String,
    likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    saved_by: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    shares: { type: Number, default: 0 },
    comments_count: { type: Number, default: 0 },
    views: { type: Number, default: 0 },
    viewed_by: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    music_track: String,
    feeling: String,
    link_preview: { // New field for rich link previews
        url: String,
        title: String,
        description: String,
        image: String
    }
}, schemaOptions);

// Performance: Indexes for feed filtering and Reels
postSchema.index({ user: 1, createdAt: -1 });
postSchema.index({ media_type: 1, createdAt: -1 });
postSchema.index({ saved_by: 1, createdAt: -1 });
postSchema.index({ content: "text" }); // For trending topics search
postSchema.index({ user: 1, media_type: 1, createdAt: -1 }); // For get_reels by user
postSchema.index({ createdAt: -1, user: 1 }); // Optimized index for 'most active users' aggregation

// --- Mongoose 8 Hook: Automated R2 Cleanup ---
// Intercepts deleteOne operations to remove media from Cloudflare R2
postSchema.pre('deleteOne', { document: false, query: true }, async function() {
    const doc = await this.model.findOne(this.getQuery());
    if (doc && doc.media && doc.media.startsWith('http')) {
        try {
            // Extract key from URL (e.g., "posts/12345-image.jpg")
            const url = new URL(doc.media);
            const key = url.pathname.startsWith('/') ? url.pathname.substring(1) : url.pathname;
            
            await s3Client.send(new DeleteObjectCommand({
                Bucket: process.env.R2_BUCKET_NAME,
                Key: key
            }));
        } catch (error) {
            // Cleanup failed
        }
    }
});

// --- Mongoose 8 Middleware for Automated Notifications ---
postSchema.post('updateOne', async function() {
    const update = this.getUpdate();
    // Check if the update operation was adding a like ($addToSet)
    if (update.$addToSet && update.$addToSet.likes) {
        const Post = mongoose.model('Post');
        const Notification = mongoose.model('Notification');
        const post = await Post.findOne(this.getQuery());
        if (!post) return;

        const triggerUserId = update.$addToSet.likes;
        // Don't send a notification if the user likes their own post
        if (post.user.toString() === triggerUserId.toString()) return;

        // Attempt to find an existing unread 'like' notification for this post
        const existingNotif = await Notification.findOne({
            user: post.user,
            post: post._id,
            type: 'like',
            is_read: false
        });

        if (existingNotif) {
            await Notification.updateOne({ _id: existingNotif._id }, { $set: { trigger_user: triggerUserId }, $inc: { others_count: 1 } });
        } else {
            await Notification.create({ type: 'like', user: post.user, trigger_user: triggerUserId, post: post._id, others_count: 0 });
        }
    }
});

const commentSchema = new mongoose.Schema({
    post: { type: mongoose.Schema.Types.ObjectId, ref: 'Post' },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    content: String,
    media: String,
    media_type: String,
    parent_comment: { type: mongoose.Schema.Types.ObjectId, ref: 'Comment' },
}, schemaOptions);

// Index for fetching comments on a post
commentSchema.index({ post: 1, createdAt: 1 });

const messageSchema = new mongoose.Schema({
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    receiver: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    group: { type: mongoose.Schema.Types.ObjectId, ref: 'Group' },
    content: String,
    media: String,
    media_type: { type: String, default: 'text' },
    is_delivered: { type: Boolean, default: false },
    delivered_at: Date,
    expires_at: { type: Date, index: { expires: 0 } }, // TTL Index: Deletes doc when this time is reached
    is_read: { type: Boolean, default: false },
    read_by: [{ 
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        first_name: String, // Cache name for quick display
        read_at: { type: Date, default: Date.now }
    }],
    deleted_for: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    is_edited: { type: Boolean, default: false },
    is_pinned: { type: Boolean, default: false },
    reply_to: { type: mongoose.Schema.Types.ObjectId, ref: 'Message' },
    poll: {
        question: String,
        options: [{ text: String, votes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }] }]
    },
    starred_by: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
}, schemaOptions);

// Indexes for poll voting and starred messages
messageSchema.index({ starred_by: 1, createdAt: -1 });
// Optimized compound indexes for messaging performance (handling deletions)
messageSchema.index({ group: 1, deleted_for: 1, createdAt: 1 });
messageSchema.index({ sender: 1, receiver: 1, deleted_for: 1, createdAt: 1 });
messageSchema.index({ receiver: 1, sender: 1, deleted_for: 1, createdAt: 1 });

// Virtual to count readers in a group chat
messageSchema.virtual('read_count').get(function() {
    return this.read_by ? this.read_by.length : 0;
});
messageSchema.index({ "poll._id": 1 });

// --- Mongoose 8 Hook: Automated Message R2 Cleanup ---
messageSchema.pre('deleteOne', { document: false, query: true }, async function() {
    const doc = await this.model.findOne(this.getQuery());
    if (doc && doc.media && doc.media.startsWith('http')) {
        try {
            // Extract key from URL
            const url = new URL(doc.media);
            const key = url.pathname.startsWith('/') ? url.pathname.substring(1) : url.pathname;
            
            await s3Client.send(new DeleteObjectCommand({
                Bucket: process.env.R2_BUCKET_NAME,
                Key: key
            }));
        } catch (error) {
            // Cleanup failed
        }
    }
});

// --- Real-time Group Message Broadcast Hook ---
messageSchema.post('save', async function(doc) {
    if (!ioInstance) return;

    const populatedMsg = await doc.populate([
        { path: 'sender', select: 'name first_name surname avatar' },
        { path: 'group', select: 'name avatar' }
    ]);
    const msgData = {
        id: doc._id,
        sender_id: doc.sender._id,
        group_id: doc.group,
        group_name: populatedMsg.group?.name,
        group_avatar: populatedMsg.group?.avatar,
        content: doc.content,
        media_type: doc.media_type,
        author: populatedMsg.sender.full_name, // Using the virtual here!
        avatar: populatedMsg.sender.avatar,
        created_at: doc.createdAt
    };

    const target = doc.group ? `group_${doc.group}` : (doc.receiver ? doc.receiver.toString() : null);
    if (target) {
        ioInstance.to(target).emit('receive_message', msgData);
    }
});

const groupSchema = new mongoose.Schema({
    name: String,
    description: String,
    avatar: String,
    members: [{
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        role: { type: String, default: 'member' }
    }],
    permissions: {
        can_edit_settings: { type: Boolean, default: false },
        can_send_messages: { type: Boolean, default: true },
        can_add_members: { type: Boolean, default: false }
    },
    approve_members: { type: Boolean, default: false },
    invite_link_code: String,
    join_requests: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
}, schemaOptions);

// Index for group membership checks
groupSchema.index({ 'members.user': 1 });

const storySchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    media: String,
    type: String,
    views: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    view_count: { type: Number, default: 0 },
    audience: { type: String, default: 'public' }, // 'public', 'close_friends'
    has_music: { type: Boolean, default: false },
    music_track: String
}, schemaOptions);

// Index for story feed (last 24 hours)
storySchema.index({ user: 1, createdAt: -1 });

// --- Mongoose 8 Hook: Automated Story R2 Cleanup ---
storySchema.pre('deleteOne', { document: false, query: true }, async function() {
    const doc = await this.model.findOne(this.getQuery());
    if (doc && doc.media && doc.media.startsWith('http')) {
        try {
            // Extract key from URL
            const url = new URL(doc.media);
            const key = url.pathname.startsWith('/') ? url.pathname.substring(1) : url.pathname;
            
            await s3Client.send(new DeleteObjectCommand({
                Bucket: process.env.R2_BUCKET_NAME,
                Key: key
            }));
        } catch (error) { }
    }
});

const baseNotificationSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    is_read: { type: Boolean, default: false }
}, { 
    discriminatorKey: 'type', // This field determines which sub-schema to use
    timestamps: { createdAt: 'created_at', updatedAt: false },
    ...schemaOptions 
});

// Index for fetching notifications for a user
baseNotificationSchema.index({ user: 1, created_at: -1 });
baseNotificationSchema.index({ user: 1, is_read: 1 });

// --- Real-time Notification Broadcast Hook ---
baseNotificationSchema.post('save', function(doc) {
    if (ioInstance) {
        ioInstance.to(doc.user.toString()).emit('new_notification', doc);
    }
});

// --- Mongoose 8 TTL Index ---
// Automatically delete notifications 30 days after they are created (30 * 24 * 60 * 60 seconds)
baseNotificationSchema.index({ created_at: 1 }, { expireAfterSeconds: 2592000 });

const Notification = mongoose.model('Notification', baseNotificationSchema);

// Discriminator for 'Like' notifications
Notification.discriminator('like', new mongoose.Schema({
    post: { type: mongoose.Schema.Types.ObjectId, ref: 'Post', required: true },
    trigger_user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    others_count: { type: Number, default: 0 }
}));

// Discriminator for 'Follow' notifications
Notification.discriminator('follow', new mongoose.Schema({
    trigger_user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
}));

// Discriminator for 'Post' notifications (for new posts/stories)
Notification.discriminator('post', new mongoose.Schema({
    post: { type: mongoose.Schema.Types.ObjectId, ref: 'Post' },
    story: { type: mongoose.Schema.Types.ObjectId, ref: 'Story' },
    trigger_user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
}));

// Discriminator for 'Mention' notifications
Notification.discriminator('mention', new mongoose.Schema({
    post: { type: mongoose.Schema.Types.ObjectId, ref: 'Post', required: true },
    trigger_user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    comment: { type: mongoose.Schema.Types.ObjectId, ref: 'Comment' } // Optional: mention in a comment
}));

// Discriminator for 'System' notifications (just text)
Notification.discriminator('system', new mongoose.Schema({
    content: { type: String, required: true }
}));

const callSchema = new mongoose.Schema({
    caller: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    receiver: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    type: String,
    duration: { type: Number, default: 0 },
    is_missed: { type: Boolean, default: true },
    sdp_offer: String,
    sdp_answer: String,
    status: { type: String, default: 'ringing' }, // ringing, accepted, ended, rejected
    deleted_for: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    ice_candidates: [String],
    created_at: { type: Date, default: Date.now }
});

// Index for incoming call polling/checks
callSchema.index({ receiver: 1, status: 1 });

const reportSchema = new mongoose.Schema({
    reporter: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reported_user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reason: String,
    details: String,
    priority: { type: String, enum: ['low', 'medium', 'high'], default: 'low' },
    status: { type: String, default: 'open' }, // open, dismissed
    created_at: { type: Date, default: Date.now }
});

const bookmarkSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    post: { type: mongoose.Schema.Types.ObjectId, ref: 'Post', required: true },
    createdAt: { type: Date, default: Date.now }
});

const otpSchema = new mongoose.Schema({
    identity: { type: String, required: true },
    otp: { type: String, required: true },
    type: { type: String, enum: ['registration', 'password_reset'] },
    attempts: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now, expires: 600 } // Auto-delete after 10 mins
});

const models = {
    User: mongoose.model('User', userSchema),
    Post: mongoose.model('Post', postSchema),
    Comment: mongoose.model('Comment', commentSchema),
    Message: mongoose.model('Message', messageSchema),
    Group: mongoose.model('Group', groupSchema),
    Story: mongoose.model('Story', storySchema),
    Notification: Notification,
    Call: mongoose.model('Call', callSchema),
    Report: mongoose.model('Report', reportSchema),
    Bookmark: mongoose.model('Bookmark', bookmarkSchema),
    Otp: mongoose.model('Otp', otpSchema),
    s3Client // Export the client to remove duplication in other files
};

// Inject the Socket.io instance from api.js
models.setIo = (io) => { ioInstance = io; };

module.exports = models;
