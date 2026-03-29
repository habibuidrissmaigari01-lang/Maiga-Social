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
    music_track: String
}, schemaOptions);

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
        const PostModel = mongoose.model('Post');
        const post = await PostModel.findOne(this.getQuery());
        if (!post) return;

        const triggerUserId = update.$addToSet.likes;
        // Don't send a notification if the user likes their own post
        if (post.user.toString() === triggerUserId.toString()) return;

        const NotificationModel = mongoose.model('Notification');
        await NotificationModel.create({
            type: 'like',
            user: post.user, // Author of the post
            trigger_user: triggerUserId, // Person who liked
            post: post._id
        });
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

const messageSchema = new mongoose.Schema({
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    receiver: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    group: { type: mongoose.Schema.Types.ObjectId, ref: 'Group' },
    content: String,
    media: String,
    media_type: { type: String, default: 'text' },
    is_read: { type: Boolean, default: false },
    read_by: [{ 
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        read_at: { type: Date, default: Date.now }
    }],
    deleted_for: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    is_edited: { type: Boolean, default: false },
    is_pinned: { type: Boolean, default: false },
    reply_to: { type: mongoose.Schema.Types.ObjectId, ref: 'Message' },
    poll: {
        question: String,
        options: [{ text: String, votes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }] }]
    }
}, schemaOptions);

// Virtual to count readers in a group chat
messageSchema.virtual('read_count').get(function() {
    return this.read_by ? this.read_by.length : 0;
});

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

    const populatedMsg = await doc.populate('sender', 'name first_name surname avatar');
    const msgData = {
        id: doc._id,
        content: doc.content,
        type: doc.media_type,
        author: populatedMsg.sender.full_name, // Using the virtual here!
        avatar: populatedMsg.sender.avatar,
        created_at: doc.createdAt
    };

    const target = doc.group ? `group_${doc.group}` : doc.receiver.toString();
    ioInstance.to(target).emit('receive_message', msgData);
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
        } catch (error) {
            console.error("Story media cleanup failed:", error.message);
        }
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
    sdp_offer: String,
    sdp_answer: String,
    status: { type: String, default: 'ringing' },
    ice_candidates: [String],
    created_at: { type: Date, default: Date.now }
});

const reportSchema = new mongoose.Schema({
    reporter: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reported_user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reason: String,
    details: String,
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
