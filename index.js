// index.js (Cloudflare Worker entry point)

// Mock data (will be re-initialized on each request in this stateless environment)
let mock_users = [];
let mock_posts = [];
let mock_groups = [];
let mock_forum_topics = [];
let mock_chats = {};
let mock_reports = [];
let mock_flagged_posts = [];
let mock_logs = [];
let mock_settings = {};
let mock_broadcasts = [];
let mock_notifications = [];

const getMockData = () => {
    // Re-initialize mock data for each request in a stateless worker environment
    // In a real application, this would interact with persistent storage like KV or Durable Objects.
    mock_users = [
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
    mock_posts = [
        { id: 1001, user_id: 2, content: 'Just finished my biology project! 🔬 #YSU', media: 'https://placehold.co/600x400?text=Project', mediaType: 'image', created_at: '2026-03-22T10:00:00Z', likes: 15, comments: 3, shares: 2, saved: false, myReaction: null },
        { id: 1002, user_id: 4, content: 'Reading up on contract law. Fascinating stuff!', media: null, mediaType: 'text', created_at: '2026-03-21T18:30:00Z', likes: 8, comments: 1, shares: 0, saved: true, myReaction: 'like' },
        { id: 1003, user_id: 1, content: 'My new coding setup is finally complete! #devlife', media: 'https://placehold.co/600x400?text=Setup', mediaType: 'image', created_at: '2026-03-20T12:00:00Z', likes: 42, comments: 7, shares: 5, saved: false, myReaction: null },
    ];
    // Add user details to posts
    mock_posts.forEach(p => {
        const user = mock_users.find(u => u.id === p.user_id);
        p.author = user.name;
        p.avatar = user.avatar;
        p.verified = user.is_verified === 1;
        p.time = '1d'; // Mock time
    });
    mock_groups = [
        { id: 1, name: 'YSU Computer Science Dept', avatar: 'https://placehold.co/100x100?text=YSU-CS', brand: 'ysu', members: [2, 4] },
        { id: 2, name: 'Maiga Developers', avatar: 'https://placehold.co/100x100?text=Maiga', brand: 'maiga', members: [1, 3, 4] },
    ];
    mock_forum_topics = [
        { id: 1, category: 'Academics', title: 'Exam Timetable Discussion', author: 'Fatima Ali', replies: 12, brand: 'ysu' },
        { id: 2, category: 'General', title: 'Welcome to Maiga Social!', author: 'Habibu Maigari', replies: 5, brand: 'maiga' },
    ];
    mock_chats = {
        '2': [
            { id: 1, sender: 'them', content: 'Hey! How are you?', time: '10:30 AM' },
            { id: 2, sender: 'me', content: 'I am good, thanks! How about you?', time: '10:31 AM' }
        ],
        '4': [
            { id: 3, sender: 'them', content: 'Did you see the exam schedule?', time: 'Yesterday' }
        ]
    };
    mock_reports = [
        { id: 1, reporter_id: 4, reason: 'Spam', details: 'This user is posting spam links.', content_id: 123, time: '2h ago', first_name: 'Aisha', surname: 'Yusuf' },
        { id: 2, reporter_id: 3, reason: 'Harassment', details: 'Inappropriate comments on my post.', content_id: 456, time: '5h ago', first_name: 'Musa', surname: 'Ibrahim' }
    ];
    mock_flagged_posts = [
        { id: 101, report_id: 1, author: 'Spammer Person', content: 'Check out my cool new site! spam.com', reason: 'Spam', time: '3h ago' }
    ];
    mock_logs = [
        { id: 1, timestamp: '2026-03-06 10:00:15', user: 'Umar Faruk', action: 'LOGIN', details: 'User logged in from IP 192.168.1.1' },
        { id: 2, timestamp: '2026-03-06 09:45:32', user: 'Admin', action: 'DELETE_POST', details: 'Deleted post #102 for hate speech.' },
    ];
    mock_settings = {
        site_name: 'Maiga Social',
        maintenance_mode: false,
        allow_registrations: true
    };
    mock_broadcasts = [
        { id: 1, title: 'Welcome!', message: 'Welcome to the new version of our app.', sent_at: '2026-03-05 12:00:00' }
    ];
    mock_notifications = [
        { id: 1, message: 'New user registration: Fatima Ali', time: '5m ago', unread: true, icon: 'fa-user-plus' },
        { id: 2, message: 'High server load detected', time: '1h ago', unread: true, icon: 'fa-server' },
    ];
};

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        let path = url.pathname;

        // Handle favicon to prevent 404 console errors
        if (path === '/favicon.ico') {
            return new Response(null, { status: 204 });
        }

        // Re-initialize mock data for each request (stateless worker)
        getMockData();

        // Mock Authentication (Simulating session/logged-in user)
        let currentUserId = 1; 
        let currentUser = mock_users.find(u => u.id === currentUserId);

        if (path.startsWith('/api')) {
            let action = url.searchParams.get('action');
            
            // Map path-based routes used by the frontend to internal actions
            if (!action) {
                if (path === '/api/login') action = 'login';
                else if (path === '/api/register') action = 'register';
                else if (path === '/api/send-reg-otp') action = 'send-reg-otp';
                else if (path === '/api/forgot-password') action = 'forgot-password';
                else if (path === '/api/verify-otp') action = 'verify-otp';
                else if (path === '/api/reset-password') action = 'reset-password';
                else if (path === '/api/check_username') action = 'check_username';
                else if (path === '/api/get_terms') action = 'get_terms';
                else if (path === '/api') action = 'dashboard_stats'; // Default for /api
            }

            let body = {};
            if (request.method === 'POST') {
                try {
                    body = await request.json();
                } catch (e) {
                    // Body might be empty or not JSON
                    body = {};
                }
            }

            // Mock Authentication Check (simplified)
            if (!currentUser && action !== 'login' && action !== 'register') {
                return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
            }

            switch (action) {
                case 'get_users': {
                    let users = [...mock_users];
                    if (url.searchParams.get('filter') === 'blocked') users = users.filter(u => u.blocked);
                    if (url.searchParams.get('filter') === 'online') users = users.filter(u => u.online);
                    if (url.searchParams.get('filter') === 'maiga') users = users.filter(u => u.account_type === 'maiga');
                    if (url.searchParams.get('filter') === 'ysu') users = users.filter(u => u.account_type === 'ysu');
                    if (url.searchParams.get('search')) {
                        const q = url.searchParams.get('search').toLowerCase();
                        users = users.filter(u => u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
                    }
                    if (url.searchParams.get('sort')) {
                        users.sort((a, b) => {
                            const valA = a[url.searchParams.get('sort')] || '';
                            const valB = b[url.searchParams.get('sort')] || '';
                            if (valA < valB) return url.searchParams.get('dir') === 'asc' ? -1 : 1;
                            if (valA > valB) return url.searchParams.get('dir') === 'asc' ? 1 : -1;
                            return 0;
                        });
                    }
                    const total = users.length;
                    const page = parseInt(url.searchParams.get('page')) || 1;
                    const limit = parseInt(url.searchParams.get('limit')) || 5;
                    const offset = (page - 1) * limit;
                    const paginatedUsers = users.slice(offset, offset + limit);
                    return new Response(JSON.stringify({ users: paginatedUsers, total: total }), { headers: { 'Content-Type': 'application/json' } });
                }
                case 'get_user_profile_details': {
                    const user = mock_users.find(u => u.id == url.searchParams.get('user_id'));
                    if (user) {
                        user.posts = [
                            { id: 1, time: '2d ago', content: 'This is a sample post.', media: 'https://placehold.co/600x400' },
                            { id: 2, time: '3d ago', content: 'Another sample post!' }
                        ];
                        return new Response(JSON.stringify(user), { headers: { 'Content-Type': 'application/json' } });
                    } else {
                        return new Response(JSON.stringify({ error: 'User not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
                    }
                }
                case 'block_user':
                case 'unblock_user':
                case 'toggle_block_user': {
                    const user = mock_users.find(u => u.id == body.user_id);
                    if (user) {
                        user.blocked = !user.blocked;
                        return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
                    } else {
                        return new Response(JSON.stringify({ error: 'User not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
                    }
                }
                case 'toggle_verify_user': {
                    const user = mock_users.find(u => u.id == body.user_id);
                    if (user) {
                        user.is_verified = user.is_verified == 1 ? 0 : 1;
                        return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
                    } else {
                        return new Response(JSON.stringify({ error: 'User not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
                    }
                }
                case 'delete_user': {
                    mock_users = mock_users.filter(u => u.id != body.user_id);
                    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
                }
                case 'logout': {
                    // In a stateless worker, "logging out" means clearing client-side state.
                    // Here, we just return success.
                    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
                }
                case 'get_settings':
                    return new Response(JSON.stringify({ success: true, settings: mock_settings }), { headers: { 'Content-Type': 'application/json' } });
                case 'save_settings':
                    mock_settings = { ...mock_settings, ...body };
                    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
                case 'get_admin_notifications':
                    return new Response(JSON.stringify({ success: true, notifications: mock_notifications }), { headers: { 'Content-Type': 'application/json' } });
                case 'mark_all_notifications_read':
                    mock_notifications.forEach(n => n.unread = false);
                    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
                case 'delete_notification':
                    mock_notifications = mock_notifications.filter(n => n.id != body.id);
                    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
                case 'get_broadcast_history':
                    return new Response(JSON.stringify({ success: true, history: mock_broadcasts }), { headers: { 'Content-Type': 'application/json' } });
                case 'send_broadcast':
                    mock_broadcasts.unshift({ id: Date.now(), ...body, sent_at: new Date().toISOString() });
                    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
                case 'delete_broadcast':
                    mock_broadcasts = mock_broadcasts.filter(b => b.id != body.id);
                    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
                case 'get_logs':
                    return new Response(JSON.stringify({ success: true, logs: mock_logs }), { headers: { 'Content-Type': 'application/json' } });
                case 'get_reports':
                    return new Response(JSON.stringify(mock_reports), { headers: { 'Content-Type': 'application/json' } });
                case 'get_flagged_posts':
                    return new Response(JSON.stringify(mock_flagged_posts), { headers: { 'Content-Type': 'application/json' } });
                case 'get_groups': {
                    const userGroups = mock_groups.filter(g => {
                        if (currentUser.account_type === 'ysu') {
                            return g.brand === 'ysu' || (g.brand === 'maiga' && g.members.includes(currentUser.id));
                        }
                        if (currentUser.account_type === 'maiga') {
                            return g.brand === 'maiga';
                        }
                        return false;
                    });
                    return new Response(JSON.stringify(userGroups), { headers: { 'Content-Type': 'application/json' } });
                }
                case 'get_forum_topics': {
                    const userTopics = mock_forum_topics.filter(t => {
                        if (currentUser.account_type === 'ysu') {
                            return t.brand === 'ysu';
                        }
                        if (currentUser.account_type === 'maiga') {
                            return t.brand === 'maiga';
                        }
                        return false;
                    });
                    return new Response(JSON.stringify(userTopics), { headers: { 'Content-Type': 'application/json' } });
                }
                case 'create_group': {
                    const { name, members } = body;
                    const newGroup = {
                        id: Date.now(),
                        name: name,
                        avatar: `https://placehold.co/100x100?text=${name.substring(0, 3)}`,
                        brand: currentUser.account_type,
                        members: [currentUser.id, ...members]
                    };
                    mock_groups.push(newGroup);
                    return new Response(JSON.stringify({ success: true, group: newGroup }), { headers: { 'Content-Type': 'application/json' } });
                }
                case 'add_group_members': {
                    const { group_id, members_to_add } = body;
                    const group = mock_groups.find(g => g.id == group_id);
                    if (!group) return new Response(JSON.stringify({ error: 'Group not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
                    if (group.brand === 'ysu' && members_to_add.some(id => mock_users.find(u => u.id == id)?.account_type === 'maiga')) return new Response(JSON.stringify({ error: 'Cannot add Maiga users to a YSU group.' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
                    group.members = [...new Set([...group.members, ...members_to_add])];
                    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
                }
                case 'get_user': {
                    currentUser.followerIds = mock_users.filter(u => u.followingIds && u.followingIds.includes(currentUser.id)).map(u => u.id);
                    return new Response(JSON.stringify(currentUser), { headers: { 'Content-Type': 'application/json' } });
                }
                case 'get_posts': {
                    const page = parseInt(url.searchParams.get('page')) || 1;
                    const limit = 10;
                    const offset = (page - 1) * limit;
                    const posts = mock_posts.slice(offset, offset + limit);
                    return new Response(JSON.stringify(posts), { headers: { 'Content-Type': 'application/json' } });
                }
                case 'create_post': {
                    const { content } = body;
                    const newPost = {
                        id: Date.now(),
                        user_id: currentUser.id,
                        author: currentUser.name,
                        avatar: currentUser.avatar,
                        content: content,
                        media: null,
                        mediaType: 'text',
                        created_at: new Date().toISOString(),
                        time: 'Just now',
                        likes: 0, comments: 0, shares: 0, saved: false, myReaction: null,
                        verified: currentUser.is_verified === 1
                    };
                    mock_posts.unshift(newPost);
                    return new Response(JSON.stringify({ success: true, post: newPost }), { headers: { 'Content-Type': 'application/json' } });
                }
                case 'toggle_follow': {
                    const { user_id } = body;
                    currentUser.followingIds = currentUser.followingIds || [];
                    const index = currentUser.followingIds.indexOf(user_id);
                    if (index > -1) {
                        currentUser.followingIds.splice(index, 1);
                    } else {
                        currentUser.followingIds.push(user_id);
                    }
                    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
                }
                case 'get_connections': {
                    if (url.searchParams.get('type') === 'following') {
                        return new Response(JSON.stringify(mock_users.filter(u => currentUser.followingIds.includes(u.id))), { headers: { 'Content-Type': 'application/json' } });
                    } else {
                        const followerIds = mock_users.filter(u => u.followingIds && u.followingIds.includes(currentUser.id)).map(u => u.id);
                        return new Response(JSON.stringify(mock_users.filter(u => followerIds.includes(u.id))), { headers: { 'Content-Type': 'application/json' } });
                    }
                }
                case 'get_messages': {
                    const chatId = url.searchParams.get('chat_id');
                    return new Response(JSON.stringify(mock_chats[chatId] || []), { headers: { 'Content-Type': 'application/json' } });
                }
                case 'update_report_status':
                case 'approve_post':
                case 'remove_post':
                case 'delete_post':
                    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
                case 'get_dashboard_stats':
                    return new Response(JSON.stringify({
                        total_users: mock_users.length,
                        open_reports: mock_reports.length,
                        online_users: mock_users.filter(u => u.online).length
                    }), { headers: { 'Content-Type': 'application/json' } });
                case 'get_account_type_stats':
                    return new Response(JSON.stringify({
                        maiga: mock_users.filter(u => u.account_type === 'maiga').length,
                        ysu: mock_users.filter(u => u.account_type === 'ysu').length
                    }), { headers: { 'Content-Type': 'application/json' } });
                case 'get_posts_per_day_stats':
                    return new Response(JSON.stringify({ labels: ['Mar 1', 'Mar 2', 'Mar 3', 'Mar 4', 'Mar 5', 'Mar 6', 'Mar 7'], data: [12, 19, 3, 5, 2, 3, 9] }), { headers: { 'Content-Type': 'application/json' } });
                case 'get_weekly_signups':
                    return new Response(JSON.stringify({ labels: ['Week 1', 'Week 2', 'Week 3', 'Week 4'], data: [5, 9, 7, 12] }), { headers: { 'Content-Type': 'application/json' } });
                case 'get_weekly_signups_by_type':
                    return new Response(JSON.stringify({
                        labels: ['Week 1', 'Week 2', 'Week 3', 'Week 4'],
                        maigaData: [2, 5, 3, 8],
                        ysuData: [3, 4, 4, 4]
                    }), { headers: { 'Content-Type': 'application/json' } });
                case 'register': {
                    const { email, username, password, account_type, first_name, surname } = body;

                    if (!email || !username || !password || !first_name || !surname) {
                        return new Response(JSON.stringify({ message: 'Please fill all fields.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
                    }

                    const existingUser = mock_users.find(u => u.email === email || u.username === username);
                    if (existingUser) {
                        return new Response(JSON.stringify({ message: 'User with that email or username already exists.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
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
                        account_type: account_type || 'maiga',
                        created_at: new Date().toISOString(),
                        last_seen: new Date().toISOString(),
                        bio: 'New to Maiga Social!',
                        avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=${username}`,
                        followingIds: []
                    };

                    mock_users.push(newUser);
                    return new Response(JSON.stringify({ message: 'User registered successfully!' }), { status: 201, headers: { 'Content-Type': 'application/json' } });
                }
                case 'login': {
                    const { login_identity, login_password } = body;

                    if (!login_identity) {
                        return new Response(JSON.stringify({ message: 'Please provide email or username.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
                    }

                    const user = mock_users.find(u => (u.email === login_identity || u.username === login_identity));

                    if (!user) {
                        return new Response(JSON.stringify({ message: 'Invalid credentials.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
                    }

                    if (user.blocked) {
                        return new Response(JSON.stringify({ message: 'This account has been blocked.' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
                    }

                    // In a real app, you'd compare a hashed password. Here we just check if user exists.
                    // For mock, assume any password is fine if user exists.
                    // currentUserId = user.id; // This would be handled by client-side token/cookie
                    return new Response(JSON.stringify({ message: 'Login successful', user }), { headers: { 'Content-Type': 'application/json' } });
                }
                case 'check_username': {
                    const username = url.searchParams.get('username');
                    const available = !mock_users.some(u => u.username === username);
                    return new Response(JSON.stringify({ available }), { headers: { 'Content-Type': 'application/json' } });
                }
                case 'get_terms': {
                    return new Response(JSON.stringify({ content: 'These are mock terms and conditions.' }), { headers: { 'Content-Type': 'application/json' } });
                }
                case 'send-reg-otp': {
                    const otp = Math.floor(100000 + Math.random() * 900000).toString();
                    const identity = body.identity || 'user';
                    
                    // This logs the code to your Cloudflare Dashboard (Workers -> Logs -> Real-time Logs)
                    console.log(`[OTP DEBUG] Sending code ${otp} to ${identity}`);

                    // --- ACTUAL EMAIL SENDING LOGIC (Example for Brevo/Sendinblue) ---
                    if (env.BREVO_API_KEY && identity) { // Ensure identity is not empty for sending email
                        try {
                            const brevoResponse = await fetch('https://api.brevo.com/v3/smtp/email', {
                                method: 'POST',
                                headers: {
                                    'api-key': env.BREVO_API_KEY,
                                    'content-type': 'application/json'
                                },
                                body: JSON.stringify({
                                    sender: { name: 'Maiga Social', email: 'no-reply@yourdomain.com' },
                                    to: [{ email: identity }],
                                    subject: 'Your Verification Code',
                                    textContent: `Your Maiga Social verification code is: ${otp}`
                                })
                            });
                            if (!brevoResponse.ok) console.error(`[BREVO ERROR] Failed to send email: ${brevoResponse.status} ${await brevoResponse.text()}`);
                        } catch (e) {
                            console.error(`[BREVO NETWORK ERROR] Could not reach Brevo API: ${e.message}`);
                        }
                    }

                    // Store OTP in KV with an expiration (e.g., 5 minutes = 300 seconds)
                    // Use the identity (email/phone) as part of the key
                    if (env.OTP_KV) {
                        await env.OTP_KV.put(`otp:${identity}`, otp, { expirationTtl: 300 });
                        console.log(`[OTP DEBUG] Stored OTP for ${identity} in KV.`);
                    }

                    return new Response(JSON.stringify({ 
                        success: true, 
                        message: `OTP sent to ${identity}. (Mock: Use code ${otp} to proceed)` 
                    }), { headers: { 'Content-Type': 'application/json' } });
                }
                case 'forgot-password': {
                    const identity = body.forgot_identity || 'user';
                    return new Response(JSON.stringify({ success: true, message: `Account found. Code sent to ${identity}.` }), { headers: { 'Content-Type': 'application/json' } });
                }
                case 'verify-otp': {
                    const { identity, otp } = body; // Expect identity and otp from frontend

                    if (!identity || !otp) {
                        return new Response(JSON.stringify({ success: false, message: 'Identity and OTP are required.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
                    }

                    if (!env.OTP_KV) {
                        // KV is not configured, fallback to mock verification for demonstration
                        return new Response(JSON.stringify({ success: true, message: 'OTP Verified (Mock Mode).' }), { headers: { 'Content-Type': 'application/json' } });
                    }

                    const storedOtp = await env.OTP_KV.get(`otp:${identity}`);

                    if (!storedOtp) {
                        return new Response(JSON.stringify({ success: false, message: 'OTP expired or not found. Please request a new one.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
                    }

                    if (storedOtp === otp) {
                        await env.OTP_KV.delete(`otp:${identity}`); // OTP consumed, delete it
                        console.log(`[OTP DEBUG] OTP verified and deleted for ${identity}.`);
                        return new Response(JSON.stringify({ success: true, message: 'OTP Verified.' }), { headers: { 'Content-Type': 'application/json' } });
                    } else {
                        console.log(`[OTP DEBUG] Invalid OTP for ${identity}. Provided: ${otp}, Stored: ${storedOtp}`);
                        return new Response(JSON.stringify({ success: false, message: 'Invalid OTP.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
                    }
                }
                case 'reset-password': {
                    return new Response(JSON.stringify({ success: true, message: 'Password changed successfully.' }), { headers: { 'Content-Type': 'application/json' } });
                }
                default:
                    return new Response(JSON.stringify({ error: `Action '${action}' not found.` }), { status: 404, headers: { 'Content-Type': 'application/json' } });
            }
        } else {
            // Serve static assets
            // The ASSETS binding is automatically available in the Worker environment
            // and handles requests for static files from the 'public' directory.
            // For specific HTML files, we can redirect or serve directly if needed.
            if (path === '/' || path === '/index.html') {
                return env.ASSETS.fetch(new Request(new URL('/index.html', request.url), request));
            } else if (path === '/ysu') {
                return env.ASSETS.fetch(new Request(new URL('/ysu.html', request.url), request));
            } else if (path === '/home') {
                return env.ASSETS.fetch(new Request(new URL('/maiga.html', request.url), request));
            } else if (path === '/admin') {
                return env.ASSETS.fetch(new Request(new URL('/admin.html', request.url), request));
            }

            // Fallback to serving other static assets
            return env.ASSETS.fetch(request);
        }
    },
};