const express = require('express');
const path = require('path');
const session = require('express-session');

const app = express();
const port = 3000;

// Middleware
app.use(express.json()); // for parsing application/json
app.use(express.urlencoded({ extended: true })); // for parsing application/x-www-form-urlencoded

// In-memory session store for demonstration
app.use(session({
    secret: 'a-very-secret-key-for-maiga',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false } // Set to true if using https
}));

// Serve static files from the project directory
app.use(express.static(__dirname));

// --- NEW API Routes for Auth ---

app.post('/api/register', (req, res) => {
    getMockData(req);
    const { email, username, password, account_type, first_name, surname } = req.body;

    // Basic validation
    if (!email || !username || !password || !first_name || !surname) {
        return res.status(400).json({ message: 'Please fill all fields.' });
    }

    // Check if user exists
    const existingUser = req.session.mock_users.find(u => u.email === email || u.username === username);
    if (existingUser) {
        return res.status(400).json({ message: 'User with that email or username already exists.' });
    }

    const newUser = {
        id: Date.now(),
        name: first_name + ' ' + surname,
        username: username,
        email: email,
        dept: 'New Student',
        blocked: false,
        online: false,
        is_verified: 0,
        account_type: account_type || 'maiga', // Default to 'maiga' if not provided
        created_at: new Date().toISOString(),
        last_seen: new Date().toISOString(),
        bio: 'New to Maiga Social!',
        avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=${username}`,
        followingIds: []
    };

    req.session.mock_users.push(newUser);

    res.status(201).json({ message: 'User registered successfully!' });
});

app.post('/api/login', (req, res) => {
    getMockData(req);
    const { login_identity, login_password } = req.body;

    if (!login_identity) {
        return res.status(400).json({ message: 'Please provide email or username.' });
    }

    const user = req.session.mock_users.find(u => (u.email === login_identity || u.username === login_identity));

    // In a real app, you'd compare a hashed password. Here we just check if user exists.
    if (!user) {
        return res.status(400).json({ message: 'Invalid credentials.' });
    }

    // Check if user is blocked
    if (user.blocked) {
        return res.status(403).json({ message: 'This account has been blocked.' });
    }

    req.session.userId = user.id;
    res.json({ message: 'Login successful', user });
});

// --- Mock Database ---
// This simulates your database. Replace this with your actual database connection and queries.
const getMockData = (req) => {
    // Mock logged-in user ID
    req.session.userId = 1;

    if (!req.session.mock_users) {
        req.session.mock_users = [
            {id: 1, name: 'Habibu Idriss Maigari', username: 'lucky', email: 'habibu@example.com', dept: 'Computer Science', blocked: false, online: true, is_verified: 1, account_type: 'maiga', created_at: '2026-03-01T10:00:00Z', last_seen: new Date().toISOString(), bio: 'CS Student | Developer', avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Lucky', followingIds: [2, 4]},
            {id: 2, name: 'Fatima Ali', username: 'fatima', email: 'fatima@ysu.edu.ng', dept: 'Biological Sciences', blocked: false, online: false, is_verified: 0, account_type: 'ysu', created_at: '2026-03-02T11:00:00Z', last_seen: '2026-03-20T11:00:00Z', bio: 'Future biologist.', avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Fatima', followingIds: [1]},
            {id: 3, name: 'Musa Ibrahim', username: 'musa', email: 'musa@example.com', dept: 'Physics', blocked: true, online: false, is_verified: 0, account_type: 'maiga', created_at: '2026-03-03T12:00:00Z', last_seen: '2026-03-19T12:00:00Z', bio: 'Exploring the universe.', avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Musa', followingIds: [4]},
            {id: 4, name: 'Aisha Yusuf', username: 'aisha', email: 'aisha@ysu.edu.ng', dept: 'Law', blocked: false, online: true, is_verified: 1, account_type: 'ysu', created_at: '2026-03-04T13:00:00Z', last_seen: new Date().toISOString(), bio: 'Law student.', avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Aisha', followingIds: [1]},
            ...Array.from({length: 20}, (_, i) => ({
                id: 5 + i,
                name: `User ${5 + i}`,
                username: `user${5+i}`,
                email: `user${5+i}@example.com`,
                dept: 'Various',
                blocked: i % 5 === 0,
                online: i % 3 === 0,
                is_verified: i % 2 === 0 ? 1 : 0,
                account_type: i % 2 === 0 ? 'maiga' : 'ysu',
                created_at: `2026-03-${10+i}T10:00:00Z`,
                last_seen: `2026-03-${20+i}T10:00:00Z`,
                bio: 'A student at Maiga.',
                avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=User${5+i}`,
                followingIds: []
            }))
        ];
    }
    if (!req.session.mock_posts) {
        req.session.mock_posts = [
            { id: 1001, user_id: 2, content: 'Just finished my biology project! 🔬 #YSU', media: 'https://placehold.co/600x400?text=Project', mediaType: 'image', created_at: '2026-03-22T10:00:00Z', likes: 15, comments: 3, shares: 2, saved: false, myReaction: null },
            { id: 1002, user_id: 4, content: 'Reading up on contract law. Fascinating stuff!', media: null, mediaType: 'text', created_at: '2026-03-21T18:30:00Z', likes: 8, comments: 1, shares: 0, saved: true, myReaction: 'like' },
            { id: 1003, user_id: 1, content: 'My new coding setup is finally complete! #devlife', media: 'https://placehold.co/600x400?text=Setup', mediaType: 'image', created_at: '2026-03-20T12:00:00Z', likes: 42, comments: 7, shares: 5, saved: false, myReaction: null },
        ];
        // Add user details to posts
        req.session.mock_posts.forEach(p => {
            const user = req.session.mock_users.find(u => u.id === p.user_id);
            p.author = user.name;
            p.avatar = user.avatar;
            p.verified = user.is_verified === 1;
            p.time = '1d'; // Mock time
        });
    }
    if (!req.session.mock_groups) { // New mock data
        req.session.mock_groups = [
            { id: 1, name: 'YSU Computer Science Dept', avatar: 'https://placehold.co/100x100?text=YSU-CS', brand: 'ysu', members: [2, 4] },
            { id: 2, name: 'Maiga Developers', avatar: 'https://placehold.co/100x100?text=Maiga', brand: 'maiga', members: [1, 3, 4] },
        ];
    }
    if (!req.session.mock_forum_topics) { // New mock data
        req.session.mock_forum_topics = [
            { id: 1, category: 'Academics', title: 'Exam Timetable Discussion', author: 'Fatima Ali', replies: 12, brand: 'ysu' },
            { id: 2, category: 'General', title: 'Welcome to Maiga Social!', author: 'Habibu Maigari', replies: 5, brand: 'maiga' },
        ];
    }
    if (!req.session.mock_chats) {
        req.session.mock_chats = {
            '2': [
                { id: 1, sender: 'them', content: 'Hey! How are you?', time: '10:30 AM' },
                { id: 2, sender: 'me', content: 'I am good, thanks! How about you?', time: '10:31 AM' }
            ],
            '4': [
                { id: 3, sender: 'them', content: 'Did you see the exam schedule?', time: 'Yesterday' }
            ]
        };
    }
    if (!req.session.mock_reports) {
        req.session.mock_reports = [
            { id: 1, reporter_id: 4, reason: 'Spam', details: 'This user is posting spam links.', content_id: 123, time: '2h ago', first_name: 'Aisha', surname: 'Yusuf' },
            { id: 2, reporter_id: 3, reason: 'Harassment', details: 'Inappropriate comments on my post.', content_id: 456, time: '5h ago', first_name: 'Musa', surname: 'Ibrahim' }
        ];
    }
    if (!req.session.mock_flagged_posts) {
        req.session.mock_flagged_posts = [
            { id: 101, report_id: 1, author: 'Spammer Person', content: 'Check out my cool new site! spam.com', reason: 'Spam', time: '3h ago' }
        ];
    }
    if (!req.session.mock_logs) {
        req.session.mock_logs = [
            { id: 1, timestamp: '2026-03-06 10:00:15', user: 'Umar Faruk', action: 'LOGIN', details: 'User logged in from IP 192.168.1.1' },
            { id: 2, timestamp: '2026-03-06 09:45:32', user: 'Admin', action: 'DELETE_POST', details: 'Deleted post #102 for hate speech.' },
        ];
    }
    if (!req.session.mock_settings) {
        req.session.mock_settings = {
            site_name: 'Maiga Social',
            maintenance_mode: false,
            allow_registrations: true
        };
    }
    if (!req.session.mock_broadcasts) {
        req.session.mock_broadcasts = [
            { id: 1, title: 'Welcome!', message: 'Welcome to the new version of our app.', sent_at: '2026-03-05 12:00:00' }
        ];
    }
    if (!req.session.mock_notifications) {
        req.session.mock_notifications = [
            { id: 1, message: 'New user registration: Fatima Ali', time: '5m ago', unread: true, icon: 'fa-user-plus' },
            { id: 2, message: 'High server load detected', time: '1h ago', unread: true, icon: 'fa-server' },
        ];
    }
};

// --- Main API Router ---
app.all('/api', (req, res) => {
    getMockData(req);

    const action = req.query.action;
    const body = req.body;

    // Mock Authentication Check
    const currentUser = req.session.mock_users.find(u => u.id === req.session.userId);
    if (!currentUser && action !== 'login' && action !== 'register') return res.status(401).json({ error: 'Unauthorized' });

    switch (action) {
        case 'get_users': {
            let users = [...req.session.mock_users];
            if (req.query.filter === 'blocked') users = users.filter(u => u.blocked);
            if (req.query.filter === 'online') users = users.filter(u => u.online);
            if (req.query.filter === 'maiga') users = users.filter(u => u.account_type === 'maiga');
            if (req.query.filter === 'ysu') users = users.filter(u => u.account_type === 'ysu');
            if (req.query.search) {
                const q = req.query.search.toLowerCase();
                users = users.filter(u => u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
            }
            if (req.query.sort) {
                users.sort((a, b) => {
                    const valA = a[req.query.sort] || '';
                    const valB = b[req.query.sort] || '';
                    if (valA < valB) return req.query.dir === 'asc' ? -1 : 1;
                    if (valA > valB) return req.query.dir === 'asc' ? 1 : -1;
                    return 0;
                });
            }
            const total = users.length;
            const page = parseInt(req.query.page) || 1;
            const limit = parseInt(req.query.limit) || 5;
            const offset = (page - 1) * limit;
            const paginatedUsers = users.slice(offset, offset + limit);
            res.json({ users: paginatedUsers, total: total });
            break;
        }
        case 'get_user_profile_details': {
            const user = req.session.mock_users.find(u => u.id == req.query.user_id);
            if (user) {
                user.posts = [
                    { id: 1, time: '2d ago', content: 'This is a sample post.', media: 'https://placehold.co/600x400' },
                    { id: 2, time: '3d ago', content: 'Another sample post!' }
                ];
                res.json(user);
            } else {
                res.status(404).json({ error: 'User not found' });
            }
            break;
        }
        case 'block_user':
        case 'unblock_user':
        case 'toggle_block_user': { // From admin panel
            const user = req.session.mock_users.find(u => u.id == body.user_id);
            if (user) {
                user.blocked = !user.blocked;
                res.json({ success: true });
            } else {
                // Also handle blocking for main app
                res.status(404).json({ error: 'User not found' });
            }
            break;
        }
        case 'toggle_verify_user': {
            const user = req.session.mock_users.find(u => u.id == body.user_id);
            if (user) {
                user.is_verified = user.is_verified == 1 ? 0 : 1;
                res.json({ success: true });
            } else {
                res.status(404).json({ error: 'User not found' });
            }
            break;
        }
        case 'delete_user': {
            req.session.mock_users = req.session.mock_users.filter(u => u.id != body.user_id);
            res.json({ success: true });
            break;
        }
        case 'logout': {
            req.session.destroy(err => {
                if (err) return res.status(500).json({ error: 'Could not log out.' });
            });
            res.json({ success: true });
            break;
        }
        case 'get_settings':
            res.json({ success: true, settings: req.session.mock_settings });
            break;
        case 'save_settings':
            req.session.mock_settings = { ...req.session.mock_settings, ...body };
            res.json({ success: true });
            break;
        case 'get_admin_notifications':
            res.json({ success: true, notifications: req.session.mock_notifications });
            break;
        case 'mark_all_notifications_read':
            req.session.mock_notifications.forEach(n => n.unread = false);
            res.json({ success: true });
            break;
        case 'delete_notification':
            req.session.mock_notifications = req.session.mock_notifications.filter(n => n.id != body.id);
            res.json({ success: true });
            break;
        case 'get_broadcast_history':
            res.json({ success: true, history: req.session.mock_broadcasts });
            break;
        case 'send_broadcast':
            req.session.mock_broadcasts.unshift({ id: Date.now(), ...body, sent_at: new Date().toISOString() });
            res.json({ success: true });
            break;
        case 'delete_broadcast':
            req.session.mock_broadcasts = req.session.mock_broadcasts.filter(b => b.id != body.id);
            res.json({ success: true });
            break;
        case 'get_logs':
            res.json({ success: true, logs: req.session.mock_logs });
            break;
        case 'get_reports':
            res.json(req.session.mock_reports);
            break;
        case 'get_flagged_posts':
            res.json(req.session.mock_flagged_posts);
            break;
        case 'get_groups': {
            const userGroups = req.session.mock_groups.filter(g => {
                // YSU users see YSU groups + Maiga groups they are in
                if (currentUser.account_type === 'ysu') {
                    return g.brand === 'ysu' || (g.brand === 'maiga' && g.members.includes(currentUser.id));
                }
                // Maiga users see Maiga groups
                if (currentUser.account_type === 'maiga') {
                    return g.brand === 'maiga';
                }
                return false;
            });
            res.json(userGroups);
            break;
        }
        case 'get_forum_topics': {
            const userTopics = req.session.mock_forum_topics.filter(t => {
                if (currentUser.account_type === 'ysu') {
                    return t.brand === 'ysu';
                }
                if (currentUser.account_type === 'maiga') {
                    return t.brand === 'maiga';
                }
                return false;
            });
            res.json(userTopics);
            break;
        }
        case 'create_group': {
            const { name, members } = body;
            const newGroup = {
                id: Date.now(),
                name: name,
                avatar: `https://placehold.co/100x100?text=${name.substring(0, 3)}`,
                brand: currentUser.account_type, // Tag group with creator's brand
                members: [currentUser.id, ...members]
            };
            req.session.mock_groups.push(newGroup);
            res.json({ success: true, group: newGroup });
            break;
        }
        case 'add_group_members': {
            const { group_id, members_to_add } = body;
            const group = req.session.mock_groups.find(g => g.id == group_id);
            if (!group) return res.status(404).json({ error: 'Group not found' });
            if (group.brand === 'ysu' && members_to_add.some(id => req.session.mock_users.find(u => u.id == id)?.account_type === 'maiga')) return res.status(403).json({ error: 'Cannot add Maiga users to a YSU group.' });
            group.members = [...new Set([...group.members, ...members_to_add])];
            res.json({ success: true });
            break;
        }
        // --- Main App API Endpoints ---
        case 'get_user': {
            currentUser.followerIds = req.session.mock_users.filter(u => u.followingIds && u.followingIds.includes(currentUser.id)).map(u => u.id);
            res.json(currentUser);
            break;
        }
        case 'get_posts': {
            const page = parseInt(req.query.page) || 1;
            const limit = 10;
            const offset = (page - 1) * limit;
            const posts = req.session.mock_posts.slice(offset, offset + limit);
            res.json(posts);
            break;
        }
        case 'create_post': {
            const { content } = req.body;
            const newPost = {
                id: Date.now(),
                user_id: currentUser.id,
                author: currentUser.name,
                avatar: currentUser.avatar,
                content: content,
                media: null, // Simplified: no media upload in mock
                mediaType: 'text',
                created_at: new Date().toISOString(),
                time: 'Just now',
                likes: 0, comments: 0, shares: 0, saved: false, myReaction: null,
                verified: currentUser.is_verified === 1
            };
            req.session.mock_posts.unshift(newPost);
            res.json({ success: true, post: newPost });
            break;
        }
        case 'toggle_follow': {
            const { user_id } = req.body;
            currentUser.followingIds = currentUser.followingIds || [];
            const index = currentUser.followingIds.indexOf(user_id);
            if (index > -1) {
                currentUser.followingIds.splice(index, 1);
            } else {
                currentUser.followingIds.push(user_id);
            }
            res.json({ success: true });
            break;
        }
        case 'get_connections': {
            if (req.query.type === 'following') {
                res.json(req.session.mock_users.filter(u => currentUser.followingIds.includes(u.id)));
            } else { // followers
                const followerIds = req.session.mock_users.filter(u => u.followingIds && u.followingIds.includes(currentUser.id)).map(u => u.id);
                res.json(req.session.mock_users.filter(u => followerIds.includes(u.id)));
            }
            break;
        }
        case 'get_messages': {
            const chatId = req.query.chat_id;
            res.json(req.session.mock_chats[chatId] || []);
            break;
        }
        case 'update_report_status':
        case 'approve_post':
        case 'remove_post':
        case 'delete_post':
            res.json({ success: true });
            break;
        case 'get_dashboard_stats':
            res.json({
                total_users: req.session.mock_users.length,
                open_reports: req.session.mock_reports.length,
                online_users: req.session.mock_users.filter(u => u.online).length
            });
            break;
        case 'get_account_type_stats':
            res.json({
                maiga: req.session.mock_users.filter(u => u.account_type === 'maiga').length,
                ysu: req.session.mock_users.filter(u => u.account_type === 'ysu').length
            });
            break;
        case 'get_posts_per_day_stats':
            res.json({ labels: ['Mar 1', 'Mar 2', 'Mar 3', 'Mar 4', 'Mar 5', 'Mar 6', 'Mar 7'], data: [12, 19, 3, 5, 2, 3, 9] });
            break;
        case 'get_weekly_signups':
            res.json({ labels: ['Week 1', 'Week 2', 'Week 3', 'Week 4'], data: [5, 9, 7, 12] });
            break;
        case 'get_weekly_signups_by_type':
            // Mock data - in a real app, you'd query your DB and group by week and account_type
            res.json({
                labels: ['Week 1', 'Week 2', 'Week 3', 'Week 4'],
                maigaData: [2, 5, 3, 8],
                ysuData: [3, 4, 4, 4]
            });
            break;
        default:
            res.status(404).json({ error: `Action '${action}' not found.` });
    }
});

// Route for root to serve index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Route for /ysu to serve ysu.html
app.get('/ysu', (req, res) => {
    res.sendFile(path.join(__dirname, 'ysu.html'));
});

// Route for /home to serve maiga.html
app.get('/home', (req, res) => {
    res.sendFile(path.join(__dirname, 'maiga.html'));
});

// Route for /admin to serve admin.html
app.get('/admin', (req, res) => {
    req.session.isAdmin = true; // Mock admin login
    res.sendFile(path.join(__dirname, 'admin.html'));
});

app.listen(port, () => {
    console.log(`Maiga server listening at http://localhost:${port}`);
    console.log('Admin panel available at http://localhost:3000/admin');
});