import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
    name: String,
    username: { type: String, unique: true },
    email: { type: String, unique: true },
    password: { type: String, select: false },
    avatar: { type: String, default: 'img/default-avatar.png' },
    bio: String,
    dept: String,
    account_type: { type: String, default: 'maiga' }, // 'maiga' or 'ysu'
    followers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    following: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    blocked_users: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    is_admin: { type: Boolean, default: false },
    isVerified: { type: Boolean, default: false },
    online: { type: Boolean, default: false },
    last_seen: Date,
    public_key: String,
    gender: String,
    birthday: Date,
    phone: String,
    push_subscription: Object
});

const postSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    content: String,
    media: String,
    mediaType: String,
    created_at: { type: Date, default: Date.now },
    likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    saved_by: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    shares: { type: Number, default: 0 },
    comments_count: { type: Number, default: 0 },
    views: { type: Number, default: 0 },
    viewedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    music_track: String
});

const commentSchema = new mongoose.Schema({
    post: { type: mongoose.Schema.Types.ObjectId, ref: 'Post' },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    content: String,
    media: String,
    media_type: String,
    parent_comment: { type: mongoose.Schema.Types.ObjectId, ref: 'Comment' },
    created_at: { type: Date, default: Date.now }
});

const messageSchema = new mongoose.Schema({
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    receiver: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    group: { type: mongoose.Schema.Types.ObjectId, ref: 'Group' },
    content: String,
    media: String,
    media_type: { type: String, default: 'text' },
    created_at: { type: Date, default: Date.now },
    is_read: { type: Boolean, default: false },
    read_by: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    is_edited: { type: Boolean, default: false },
    is_pinned: { type: Boolean, default: false },
    reply_to: { type: mongoose.Schema.Types.ObjectId, ref: 'Message' },
    poll: {
        question: String,
        options: [{ text: String, votes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }] }]
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
});

const storySchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    media: String,
    type: String,
    created_at: { type: Date, default: Date.now },
    views: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    audience: { type: String, default: 'public' }, // 'public', 'close_friends'
    has_music: { type: Boolean, default: false },
    music_track: String
});

const notificationSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    trigger_user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    type: String,
    content: String,
    is_read: { type: Boolean, default: false },
    created_at: { type: Date, default: Date.now }
});

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

export const User = mongoose.model('User', userSchema);
export const Post = mongoose.model('Post', postSchema);
export const Comment = mongoose.model('Comment', commentSchema);
export const Message = mongoose.model('Message', messageSchema);
export const Group = mongoose.model('Group', groupSchema);
export const Story = mongoose.model('Story', storySchema);
export const Notification = mongoose.model('Notification', notificationSchema);
export const Call = mongoose.model('Call', callSchema);
export const Report = mongoose.model('Report', reportSchema);
export const Bookmark = mongoose.model('Bookmark', bookmarkSchema);
