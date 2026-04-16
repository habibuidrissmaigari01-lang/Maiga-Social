// Define CSRF_TOKEN globally to prevent ReferenceErrors
const CSRF_TOKEN = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '';

// Function to extract a URL from text
function extractUrl(text) {
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const match = urlRegex.exec(text);
    return match ? match[0] : null;
}

// Automatically switch between local and production backend
const API_BASE_URL = (function() {
    const host = window.location.hostname;
    return (host === 'localhost' || host === '127.0.0.1') ? 'http://localhost:3000' : '';
})();

// Silence harmless Alpine.js transition cancellation errors
window.addEventListener('unhandledrejection', (event) => {
    if (event.reason && event.reason.isFromCancelledTransition) {
        event.preventDefault();
    }
});


let isMaigaInitialized = false;
const initMaiga = () => {
    if (isMaigaInitialized) return;

    // Helper function for formatting post content (hashtags, mentions)
    window.formatContent = (content, linkPreview) => {
        if (!content) return '';
        content = content.replace(/</g, "&lt;").replace(/>/g, "&gt;"); // Basic sanitize
        content = content.replace(/#(\w+)/g, '<a href="#" class="text-blue-500 font-bold hover:underline" onclick="openHashtag(\'$1\'); return false;">#$1</a>');
        content = content.replace(/@(\w+)/g, '<a href="#" class="text-blue-500 font-bold hover:underline" onclick="openUserProfileByName(\'$1\'); return false;">@$1</a>');
         
        let html = content;
        if (linkPreview && linkPreview.url) {
            html += `
                <a href="${linkPreview.url}" target="_blank" rel="noopener noreferrer" class="block mt-3 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
                    ${linkPreview.image ? `<img src="${linkPreview.image}" alt="Link preview" class="w-full h-32 object-cover">` : ''}
                    <div class="p-3">
                        <p class="font-bold text-sm text-blue-600">${linkPreview.title || linkPreview.url}</p>
                        ${linkPreview.description ? `<p class="text-xs text-gray-500 line-clamp-2">${linkPreview.description}</p>` : ''}
                        <p class="text-[10px] text-gray-400 mt-1">${new URL(linkPreview.url).hostname}</p>
                    </div>
                </a>
            `;
        }
        return html;
    };

    // Shims for global onclick handlers used in dynamically injected HTML strings
    window.openHashtag = (tag) => {
        const el = document.querySelector('[x-data="appData"]');
        if (el && window.Alpine) Alpine.$data(el).openHashtag(tag);
    };
    window.openUserProfileByName = (name) => {
        const el = document.querySelector('[x-data="appData"]');
        if (el && window.Alpine) Alpine.$data(el).openUserProfileByName(name);
    };

    isMaigaInitialized = true;
    // Global Error Boundary to prevent app crashes
    Alpine.setErrorHandler((e, el, expression) => {
        console.error('Alpine Logic Error:', e, 'at element:', el, 'expression:', expression);
    });

    Alpine.data('appData', () => ({
        init() {
            this.mainInit(); 
            // Listen for ringtone triggers from Service Worker
            if ('serviceWorker' in navigator) {
                navigator.serviceWorker.addEventListener('message', (event) => {
                    if (event.data?.type === 'PLAY_CALL_RINGTONE' && !this.isCalling) {
                        document.getElementById('ringing-sound')?.play().catch(() => {});
                    }
                    if (event.data?.type === 'SYNC_START') {
                        this.syncState.active = true;
                        this.syncState.total = event.data.total;
                    }
                    if (event.data?.type === 'SYNC_PROGRESS') {
                        this.syncState.current = event.data.current;
                        if (event.data.store === 'posts') {
                            this.pendingPosts = this.pendingPosts.filter(p => p.id !== event.data.id);
                            this.refreshHomeFeed(false);
                        } else {
                            // Message synced, trigger individual chat refresh if active
                            if (this.activeChat) this.fetchMessages(this.activeChat, false);
                        }
                        if (this.syncState.current >= this.syncState.total) {
                            setTimeout(() => { this.syncState.active = false; this.syncState.current = 0; }, 2000);
                        }
                    }
                    if (event.data?.type === 'SYNC_ERROR' && event.data.status === 401) {
                        this.showToast('Auth Error', 'Your session expired. Please log in again to sync pending items.', 'error');
                    }
                });
            }
            this.$watch('appFontSize', (value) => localStorage.setItem('maiga_app_font_size', value));
            this.$watch('showChatShadows', (value) => localStorage.setItem('maiga_chat_shadows', value));
            this.arAssets.hat.src = 'https://img.icons8.com/color/96/party-hat.png'; // Reliable online URL
            this.loadSavedWallpaper();
            this.arAssets.background.src = 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?q=80&w=1080&auto=format&fit=crop';
            // Load recently used stickers from local storage
            this.$watch('isMessageSoundEnabled', (val) => localStorage.setItem('maiga_msg_sound', val));
            const savedRecents = localStorage.getItem('recent_stickers');
            if (savedRecents) {
                this.recentlyUsedStickers = JSON.parse(savedRecents);
            }
            this.initVisibilityListener();
            window.addEventListener('focus', () => this.checkClipboardForOtp?.());
            
            window.addEventListener('beforeinstallprompt', (e) => {
                e.preventDefault();
                this.installPrompt = e;
            }); // Fixed: Missing semicolon

            // Show guide overlay for new users
            if (!localStorage.getItem('guide_shown')) {
                this.showGuideOverlay = true;
            }
        },
        installPrompt: null,
        // Core App State
        user: { id: 0, name: '', username: '', nickname: '', avatar: '', banner: '', gender: 'male', account_type: 'maiga', followerIds: [], followingIds: [], total_posts_count: 0 },
        friends: JSON.parse(localStorage.getItem('maiga_friends_cache') || '[]'),
        theme: localStorage.getItem('theme') || 'system',
        darkMode: false,
        appFontSize: localStorage.getItem('maiga_app_font_size') || 'small',
        showChatShadows: localStorage.getItem('maiga_chat_shadows') !== 'false',
        isFullScreen: localStorage.getItem('maiga_fullscreen') === 'true',      
        isLeftSidebarCollapsed: localStorage.getItem('maiga_sidebar_collapsed') === 'true',
        isRightSidebarCollapsed: false,
        customWallpaperFile: null,
        pendingPosts: [],
        pendingMessages: [],
        syncState: { active: false, current: 0, total: 0 },
        iceTimeoutTimer: null,
        isNetworkBlocked: false,
        confirmModal: {
            show: false,
            title: '',
            message: '',
            confirmAction: () => {}
        },
        activeTab: (function() {
            if (!sessionStorage.getItem('maiga_session_initialized')) {
                sessionStorage.setItem('maiga_session_initialized', 'true');
                return 'home'; // Force home on first visit/login
            }
            return localStorage.getItem('maiga_active_tab') || 'home';
        })(),
        activeMessageTab: 'all',
        isLoading: true,
        dataLoaded: false,
        // Registration/Auth State
        currentStep: 1, 
        regOtp: '',
        regIdentity: '',
        otpTimer: 0,
        otpInterval: null,
        // Form data for registration
        registration: {
            first_name: '',
            surname: '',
            birthday: '',
            username: '',
            gender: '',
            phone: '',
            email: '',
            password: '',
            confirmPassword: '',
            account_type: 'maiga',
            terms: false
        },
        get passwordValidation() {
            const p = this.registration.password || '';
            return {
                length: p.length >= 8,
                uppercase: /[A-Z]/.test(p),
                number: /[0-9]/.test(p),
                match: p === this.registration.confirmPassword && p !== ''
            };
        },
        get passwordScore() {
            const v = this.passwordValidation;
            return (v.length ? 1 : 0) + (v.uppercase ? 1 : 0) + (v.number ? 1 : 0);
        },
        get formattedTimer() {
            const m = Math.floor(this.otpTimer / 60);
            const s = this.otpTimer % 60;
            return `${m}:${s.toString().padStart(2, '0')}`;
        },
        startOtpTimer() {
            this.otpTimer = 180; // 3 minutes
            clearInterval(this.otpInterval);
            this.otpInterval = setInterval(() => {
                if (this.otpTimer > 0) this.otpTimer--;
                else clearInterval(this.otpInterval);
            }, 1000);
        },
        async sendRegOtp() {
            if (!this.regIdentity) return this.showToast('Error', 'Email or Phone is required', 'error');
            const res = await this.apiFetch('/api/send-reg-otp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ identity: this.regIdentity })
            });
            if (res?.success) {
                this.showToast('Success', 'Verification code sent!', 'success');
                this.startOtpTimer();
                this.currentStep = 2;
            } else { 
                this.showToast('Error', res?.message || 'Failed to send OTP', 'error'); 
            }
        },
        async verifyOtp() {
            if (!this.regOtp) return this.showToast('Error', 'OTP is required', 'error');
            const res = await this.apiFetch('/api/verify-otp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ identity: this.regIdentity, otp: this.regOtp })
            });
            if (res?.success) {
                this.showToast('Verified', 'Code verified successfully.', 'success');
                this.currentStep = 3;
            } else { 
                this.showToast('Error', res?.message || 'Invalid code', 'error'); 
            }
        },
        async register() {
            if (this.passwordScore < 3) {
                return this.showToast('Error', 'Please choose a stronger password', 'error');
            }
            if (this.registration.password !== this.registration.confirmPassword) {
                return this.showToast('Error', 'Passwords do not match', 'error');
            }
            if (!this.registration.terms) {
                return this.showToast('Error', 'Please agree to the Terms and Conditions', 'error');
            }

            // Map identity back to email or phone for the backend
            if (this.regIdentity.includes('@')) this.registration.email = this.regIdentity;
            else this.registration.phone = this.regIdentity;

            const res = await this.apiFetch('/api/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ...this.registration,
                    otp: this.regOtp
                })
            });

            if (res?.success) {
                this.showToast('Welcome!', 'Registration successful. Redirecting...', 'success');
                setTimeout(() => window.location.href = '/home', 2000);
            } else {
                this.showToast('Registration Failed', res?.message || 'Please check your details', 'error');
            }
        },
        isMaintenanceMode: false,
        maintenanceEndTime: null,
        maintenanceCountdown: '',
        loadProgress: 0,
        showLoadingRetry: false,
        showSkeletons: true,
        isRefreshing: false,
        isOffline: !navigator.onLine,
        isIOS: /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream,
        isMessaging: false,
        fetchError: false,
        compressionProgress: 0,
        supportsPush: ('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window),
        pushPermission: Notification.permission || 'default',
        friendsPage: 1,
        messageContextMenu: { show: false, x: 0, y: 0, message: null },
        chatContextMenu: { show: false, x: 0, y: 0, chat: null },
        friendsLimit: 10,
        isLoadingMoreFriends: false,
        isSocketConnected: false,
        currentTime: Date.now(),
        typingUsers: {},
        drafts: {},
        toasts: [],
        recentSearches: JSON.parse(localStorage.getItem('maiga_recent_searches') || '[]'),

        // Feature Lists
        posts: [],
        myPosts: [],
        myPostsPage: 1,
        hasMoreMyPosts: true,
        isLoadingMoreMyPosts: false,
        reels: [],
         myReelsPage: 1,
        hasMoreMyReels: true,
        isLoadingMoreMyReels: false,
        trendingReels: [],
        groups: [],
        chats: [],
        notifications: [],
        trendingTopics: [],
        savedPostList: [],
        connectionList: [],
        followingList: [],
        followerList: [],
        blockedUsers: [],
        blockedUserDetails: [],
        callHistory: [],
        starredMessages: [],
        archivedChats: [],
        mutedChats: [],
        pinnedChats: [],
        forumTopics: [],
        musicTracks: [],
        animatedStickers: [],
        mostActiveUsers: [],
        wallpaperTemplates: [
            'https://user-images.githubusercontent.com/15075759/28719144-86dc0f70-73b1-11e7-911d-60d70fcded21.png', // Default Maiga
            'https://i.pinimg.com/originals/85/3c/69/853c696e174a169b50877a064082269a.jpg', // Dark geometric
            'https://i.pinimg.com/originals/0b/4e/7a/0b4e7a7e7e7e7e7e7e7e7e7e7e7e7e7e.jpg', // Light abstract
            'https://i.pinimg.com/originals/a8/1c/7e/a81c7e7e7e7e7e7e7e7e7e7e7e7e7e7e.jpg', // Minimalist white
            'https://i.pinimg.com/originals/b8/1c/7e/b81c7e7e7e7e7e7e7e7e7e7e7e7e7e7e.jpg', // Blue gradient
            'https://i.pinimg.com/originals/c8/1c/7e/c81c7e7e7e7e7e7e7e7e7e7e7e7e7e7e.jpg', // Green leaves
            'https://i.pinimg.com/originals/d8/1c/7e/d81c7e7e7e7e7e7e7e7e7e7e7e7e7e7e.jpg', // Pink floral
            'https://i.pinimg.com/originals/e8/1c/7e/e81c7e7e7e7e7e7e7e7e7e7e7e7e7e7e.jpg', // Purple nebula
            'https://i.pinimg.com/originals/f8/1c/7e/f81c7e7e7e7e7e7e7e7e7e7e7e7e7e7e.jpg', // Yellow dots
            'https://i.pinimg.com/originals/18/1c/7e/181c7e7e7e7e7e7e7e7e7e7e7e7e7e7e.jpg'  // Grey texture
        ],
        loginSessions: [],

        get filteredForwardList() {
            const combined = [...new Map([...this.followingList, ...this.followerList].map(item => [item.id, item])).values()];
            if (!this.reelForwardSearchQuery.trim()) return combined;
            const q = this.reelForwardSearchQuery.toLowerCase();
            return combined.filter(p => 
                p.name.toLowerCase().includes(q) || 
                p.username.toLowerCase().includes(q) ||
                (p.dept && p.dept.toLowerCase().includes(q))
            );
        },

        // UI Controls
        chatListSearchQuery: '',
        showOnlyUnread: false,
        isAutoExpanding: false,
        isChangingPassword: false,
        isMessageSoundEnabled: localStorage.getItem('maiga_msg_sound') !== 'false',
        isSavingProfile: false,
        avatarFileToUpload: null,
        avatarOriginalFile: null,
        bannerFile: null,
        isSubmittingGroup: false,
        isSubmittingReport: false,
        showReactionsModal: false,
        messageReactions: [],
        hasMorePosts: true,
        isSideMenuOpen: false,
        isFlashOn: false,
        hasFlashlight: false,
        isConfirmingCapture: false,
        showCameraFlash: false,
        reelForwardSearchQuery: '',
        hiddenReelDepts: JSON.parse(localStorage.getItem('maiga_hidden_depts') || '[]'),
        showReelMenu: false,
        focusRing: { show: false, x: 0, y: 0 },
        isReporting: false,
        isCreatingPost: false,
        isCreatingStory: false,
        isCreatingGroup: false,
        isEditingProfile: false,
        isEditingGroupInfo: false,
        isUpdatingGroupInfo: false,
        isAddingGroupMembers: false,
        isMediaEditorOpen: false,
        isCalling: false,
        isCallMinimized: false,
        isCallChatOpen: false,
        showStoryStickerPicker: false,
        showAllStoryColors: false,
        showMusicPicker: false,
        showStickerPicker: false,
        showCommentStickers: false,
        showLikesModal: false,
        showShareModal: false,
        showReelOptions: false,
        showPostOptions: false,
        showChatOptions: false,
        showChatMenu: false,
        showScrollTop: false,
        showGroupInfo: false,
        showMsgInfo: false,
        showFollowerList: null,
        showShareProfileModal: false,

        // Search & Filter State
        homeSearchQuery: '',
        homeSearchTab: 'users',
        friendsSearchQuery: '',
        friendsTab: 'suggestions',
        groupSearchQuery: '',
        connectionSearchQuery: '',
        chatSearchQuery: '',
        chatStarFilter: false,
        addMemberSearchQuery: '',

        // Form & Content State
        newPostContent: '',
        newPostFeeling: '',
        postBgStyleIndex: -1,
        newMessage: '',
        commentInput: '',
        storyFile: null,
        storyMediaPreview: null,
        storyMediaType: null,
        editorFile: null,
        editorPreviewUrl: null,
        editorType: null,
        textStoryStyleIndex: 0,
        textStoryFontIndex: 0,
        musicPickerSource: 'camera',

        // Interaction & Timing
        pullDistance: 0,
        pullStartY: 0,
        touchStartX: 0,
        touchStartY: 0,
        reelTouchStartY: 0,
        isScrollingReel: false,
        lastScrollTop: 0,
        isHeaderHidden: false,
        hasScrolled: false,
        isBouncing: false,
        swipeOffset: 0,
        isDragging: false,
        isPaused: false,
        lastBusyCall: null,
        vibrationInterval: null,
        callTimeoutTimer: null,
        restoreStateRan: false,
        maintInterval: null,
        typingIndicatorTimeout: null,
        lastHapticStep: 0,
        focusTimer: null,
        musicSourceNode: null,
        reelMenuTimer: null,
        touchTimer: null,

        // Admin State
        totalUsers: 0,
        currentPage: 1,
        itemsPerPage: 10,
        adminUsers: [],
        flaggedPosts: [],
        adminNotifications: [],
        accountTypeStats: { maiga: 0, ysu: 0 },
        postsPerDayStats: { labels: [], data: [] },
        weeklySignups: { labels: [], data: [] },
        settings: { site_name: 'Maiga Social', maintenance_mode: false, allow_registrations: true },
        adminSearchQuery: '',
        adminFilter: 'all',

        // Utility Methods
        formatLastSeen(date) {
            if (!date) return '';
            return new Date(date).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        },
        watchAgain(reel) {
            if (!reel) return;
            const video = document.getElementById('reel-video-' + reel.id);
            if (video) {
                video.currentTime = 0;
                video.play();
                reel.seen = false;
            }
        },
        scrubReel(reel, event) {
            if (!reel || !event) return;
            const video = document.getElementById('reel-video-' + reel.id);
            if (!video) return;
            
            const rect = event.currentTarget.getBoundingClientRect();
            const clientX = event.clientX || (event.touches && event.touches[0].clientX);
            const pos = (clientX - rect.left) / rect.width;
            const clampedPos = Math.max(0, Math.min(1, pos));
            
            video.currentTime = clampedPos * video.duration;
            reel.progress = clampedPos * 100;
        },
        toggleReelDescription(reel) {
            reel.isExpanded = !reel.isExpanded;
        },
        retryReelLoad(reel) {
            if (!reel) return;
            // Placeholder: implement reel retry logic here.
        },
        formatNumber(num) {
            if (num === null || num === undefined || Number.isNaN(Number(num))) return '0';
            return Number(num).toLocaleString();
        },
        getMockData(url) { return null; },
        getChatWallpaperStyle() {
            let style = '';
            if (this.selectedWallpaper) {
                style += `background-image: url('${this.selectedWallpaper}');`;
            }
            style += `filter: brightness(${this.wallpaperBrightness}%);`;
            return style;
        },

        async apiFetch(url, options = {}) {
            if (options.method && options.method !== 'GET') {
                options.headers = { ...options.headers, 'X-CSRF-Token': CSRF_TOKEN };
            }
            const fullUrl = url.startsWith('/') ? `${API_BASE_URL}${url}` : url;
            const maxRetries = options.retries ?? 2;
            const timeout = options.timeout ?? 300000; // Increased to 5 minutes for large uploads

            for (let i = 0; i <= maxRetries; i++) {
                try {
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), timeout);
                    const response = await fetch(fullUrl, { ...options, signal: controller.signal });
                    clearTimeout(timeoutId);
                    if (response.status === 401) {
                        localStorage.removeItem('maiga_session_active');
                        window.location.href = '/';
                        return null;
                    }
                    if (response.status === 503) {
                        this.isMaintenanceMode = true;
                        try {
                            const errData = await response.json();
                            if (errData.until) {
                                this.maintenanceEndTime = new Date(errData.until).getTime();
                                this.startMaintenanceTimer();
                            }
                        } catch (e) { }
                        return null;
                    }
                    if (response.ok) {
                        const contentType = response.headers.get('content-type');
                        return (contentType && contentType.includes('application/json')) ? await response.json() : null;
                    }
                    if (response.status < 500) break;
                    if (i < maxRetries) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
                } catch (error) {
                    if (i === maxRetries && !navigator.onLine) {
                        this.showToast('API Offline', 'The server is currently unreachable.', 'error');
                        // You could set a flag here to show a full-screen "API Down" error
                    }
                    if (i === maxRetries) {
                        this.showToast(error.name === 'AbortError' ? 'Timeout' : 'Network Error', 'Check connection.', 'error');
                        return null;
                    }
                    await new Promise(r => setTimeout(r, 1000 * (i + 1)));
                }
            }
            return null;
        },

        startMaintenanceTimer() {
            if (this.maintInterval) return;
            const update = () => {
                if (!this.maintenanceEndTime) {
                    this.maintenanceCountdown = 'Calculating...';
                    return;
                }
                const now = Date.now();
                const diff = this.maintenanceEndTime - now;
                if (diff <= 0) {
                    this.maintenanceCountdown = 'Completing soon...';
                    clearInterval(this.maintInterval);
                    this.maintInterval = null;
                    return;
                }
                const h = Math.floor(diff / 3600000);
                const m = Math.floor((diff % 3600000) / 60000);
                const s = Math.floor((diff % 60000) / 1000);
                this.maintenanceCountdown = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
            };
            update();
            this.maintInterval = setInterval(update, 1000);
        },

        async checkApiStatus() {
            this.showToast('Checking', 'Verifying server status...', 'info');
            const data = await this.apiFetch('/api/health', { timeout: 5000 });
            if (data && data.message === 'OK' && data.mongodb === 'connected') {
                this.isMaintenanceMode = false;
                this.showToast('Back Online', 'The system is ready. Refreshing...', 'success');
                setTimeout(() => window.location.reload(), 1500);
            } else {
                this.showToast('Still Offline', 'Maintenance is still in progress.', 'error');
            }
        },

        
        // --- MEDIA EDITOR STATE ---
        isMediaEditorOpen: false,
        editorSource: null, // 'post' or 'story'
        editorFile: null,
        editorPreviewUrl: null,
        editorType: null,
        editorOverlays: [],
        editorFilter: 'none',
        mostActiveUsers: [], // New state for most active users
        storyOverlays: [],
        editorStickers: [],
        storyStickers: [],
        editorMusic: null,
        stickerGroups: {
            smileys: ['😀','😃','😄','😁','😆','🥹','😅','😂','🤣','🥲','☺️','😊','😇','🙂','🙃','😉','😌','😍','🥰','😘','😗','😙','😚','😋','😛','😝','😜','🤪','🤨','🧐','🤓','😎','🥸','🤩','🥳','🙂‍↕️','😏','😒','🙂‍↔️','😞','😔','😟','😕','🙁','☹️','😣','😖','😫','😩','🥺','😢','😭','😤','😠','😡','🤬','🤯','😳','🥵','🥶','😶‍🌫️','😱','😨','😰','😥','😓','🤗','🤔','🫣','🤭','🫢','🫡','🤫','🫠','🤥','😶','🫥','😐','🫤','😑','🫨','😬','🙄','😯','😦','😧','😮','😲','🥱','🫩','😴','🤤','😪','😮‍💨','😵','😵‍💫','🤐','🥴','🤢','🤮','🤧','😷','🤒','🤕','🤑','🤠','😈','👻','💀','☠️'],
            gestures: ['🫶','🤲','👐','👏','🤝','👍','👎','👊','✊','🤛','🤜','🫷','🫸','🤞','✌️','🫰','🤟','🤘','👌','🤌','🤏','🫳','🫴','👈','👉','👆','👇','👆','☝️','✋','🤚','🖐️','🖖','👋','🤙','🫲','🫱','💪','🖕','✍️','🙏'],
            body: ['🫵','🦶','🦵','👄','🫦','🦷','👅','👂','🦻','👃','🫆','👥','🫂','🗣️','👤','🧠','👀','👁️','🐵','🙈','🙉','🙊','🐒'],
            hearts: ['🩷','❤️','🧡','💛','💚','🩵','💙','💜','🖤','🩶','🤍','🤎','💔','❤️‍🔥','❤️‍🩹','❣️','💕','💞','💓','💗','💖','💘','💝','💟'],
            symbols: ['❌','⭕','🛑','⛔','📛','🚫','💯','💢','♨️','🚷','🚯','🚳','🚱','🔞','📵','🚭','❗','‼️','❓','❔','❎','🛜','🧑‍🧒','🧑‍🧒‍🧒','🧑‍🧑','🧑','📶','🎦','0️⃣','1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟','🔢','#️⃣','*️⃣','☑️','✔️','🔈','🔇','🔉','🔊']
        },
        activeStickerCategory: 'smileys',
        stickerSearchQuery: '',
        
        // Simple Fuzzy Match Helper
        fuzzyMatch(query, text) {
            query = query.toLowerCase().replace(/\s/g, '');
            text = text.toLowerCase();
            let searchIndex = 0;
            for (let charIndex = 0; charIndex < text.length && searchIndex < query.length; charIndex++) {
                if (text[charIndex] === query[searchIndex]) searchIndex++;
            }
            return searchIndex === query.length;
        },
        getTypingUserName(userId) {
           if (this.typingUsers.length === 0) return '';
            if (this.typingUsers.length === 1) return `${this.typingUsers[0]} is typing...`;
            if (this.typingUsers.length === 2) return `${this.typingUsers[0]} and ${this.typingUsers[1]} are typing...`;
            return `${this.typingUsers[0]} and ${this.typingUsers.length - 1} others are typing...`;
        },


        get filteredStickers() {
            if (!this.stickerSearchQuery?.trim()) return this.stickerGroups?.[this.activeStickerCategory] || [];
            
            // Combine all groups for search
            const allStickers = Object.values(this.stickerGroups).flat();
            // Note: In a production app, you'd match against a keyword map. 
            // Here we just return the matches from the global list.
            return allStickers.filter(s => this.fuzzyMatch(this.stickerSearchQuery, s));
        },

        recentlyUsedStickers: [],
        recordStickerUse(sticker) {
            this.recentlyUsedStickers = [sticker, ...this.recentlyUsedStickers.filter(s => s !== sticker)].slice(0, 12);
            localStorage.setItem('recent_stickers', JSON.stringify(this.recentlyUsedStickers));
        },

        editorHistory: [],
        editorHistoryIndex: -1,
        showEditorStickers: false,
        isAddingStoryText: false,
        isAddingEditorText: false,
        editorText: '',
        editorTextColor: '#ffffff',
        isUploadingPost: false,
        isUploadingStory: false,
        isUploadingReel: false,
        isProcessingMetadata: false,
        editorTextFont: 'sans-serif',
        editorFonts: ['Intel One Mono', 'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy', 'Arial', 'Verdana', 'Times New Roman'],
        videoDuration: 0,
        videoTrim: { start: 0, end: 100 },
        cropper: null,
        isCropping: false,
        imageFilters: [
            { name: 'Normal', value: 'none' },
            { name: 'Grayscale', value: 'grayscale(1)' },
            { name: 'Sepia', value: 'sepia(1)' },
            { name: 'Saturate', value: 'saturate(2)' },
            { name: 'Contrast', value: 'contrast(1.5)' },
            { name: 'Brightness', value: 'brightness(1.2)' },
            { name: 'Invert', value: 'invert(1)' },
        ],
        drawings: [],
        // State from x-init moved here
        isDrawing: false,
        activeTool: 'brush', // 'brush' or 'eraser'
        currentPath: [],
        brushColor: '#ffffff',
        brushSize: 5,
        editorTextOpacity: 1,
        editorTextRotation: 0,

        selectMusic(track) {
            if (this.musicPickerSource === 'camera') {
                this.cameraMusic = track;
                this.$refs.cameraMusicPlayer.src = track.src;
                this.showMusicPicker = false;
                return;
            }
            this.tempStory.hasMusic = this.tempStory.musicTrack?.src !== track.src;
            this.tempStory.musicTrack = this.tempStory.hasMusic ? track : null;
            this.showMusicPicker = false;
        },
        selectEditorMusic(track) {
            this.editorMusic = track;
            this.showMusicPicker = false;
            this.showToast('Music Added', track.title, 'success');
        },
        textStoryStyles: [
            { background: 'linear-gradient(to bottom, #4f46e5, #9333ea)', color: '#ffffff' },
            { background: 'linear-gradient(to bottom, #f97316, #fde047)', color: '#ffffff' },
            { background: 'linear-gradient(to bottom, #0ea5e9, #2dd4bf)', color: '#ffffff' }, // Sky Blue to Teal
            { background: 'linear-gradient(to bottom, #ec4899, #f43f5e)', color: '#ffffff' }, // Pink to Red
            { background: 'linear-gradient(to bottom, #22c55e, #84cc16)', color: '#ffffff' }, // Green to Lime
            { background: 'linear-gradient(to bottom, #8b5cf6, #d946ef)', color: '#ffffff' }, // Purple to Fuchsia
            { background: 'linear-gradient(to bottom, #f59e0b, #ef4444)', color: '#ffffff' }, // Amber to Red
            { background: '#1f2937', color: '#ffffff' }, // Modern Dark Grey
            { background: '#ffffff', color: '#1f2937' }  // Clean White
        ],
        toggleTextFont() {
            this.textStoryFontIndex = (this.textStoryFontIndex + 1) % this.editorFonts.length;
            if (navigator.vibrate) navigator.vibrate(10);
        },
        get unreadBadgeDisplay() {
            const count = this.totalUnreadChats || 0;
            return count > 99 ? '99+' : count.toString();
        },
         get unreadGroupsCount() {
            return (this.groups || []).reduce((sum, g) => sum + (g.unreadCount || 0), 0);
        },
        get unreadForumsCount() {
            return (this.forumTopics || []).filter(t => t.isNew).length;
        },
        get unreadReportsCount() {
            return (this.reports || []).filter(r => r.status === 'open').length;
        },
        get sortedGroups() {
            let list = [...(this.groups || [])].filter(Boolean);
            if (this.showOnlyUnread) {
                list = list.filter(g => g.unreadCount > 0);
            }
            return list.sort((a, b) => {
                if (a.unread && !b.unread) return -1;
                if (!a.unread && b.unread) return 1;
                const aTimestamp = this.getChatTimestamp(a);
                const bTimestamp = this.getChatTimestamp(b);
                return bTimestamp - aTimestamp;
            });
        },
        hasUnviewedStory(userId) {
            if (!userId) return false;
            if (userId == this.user.id) return (this.myStories || []).some(s => !s.seen);
            const creator = (this.following || []).find(f => f.id == userId);
            return creator ? (creator.stories || []).some(s => !s.seen) : false;
        },
        getStoryRingClass(userId) {
            if (!this.hasUnviewedStory(userId)) return '';
            return userId == this.user.id 
                ? 'p-0.5 bg-gradient-to-br from-purple-500 to-blue-500 parallelogram-sm' 
                : 'p-0.5 bg-gradient-to-br from-blue-400 to-teal-400 parallelogram-sm';
        },
        shouldShow(msg, index) {
            if (index === 0) return true;
            const messages = this.chatMessages[this.activeChat?.id] || [];
            const prevMsg = messages[index - 1];
            return (prevMsg.sender_id !== msg.sender_id);
        },
        getUserColor(senderId) {
            const colors = [
                'text-blue-500', 'text-purple-500', 'text-pink-500', 'text-indigo-500',
                'text-teal-500', 'text-emerald-500', 'text-orange-500', 'text-rose-500'
            ];
            const hash = String(senderId).split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
            return colors[hash % colors.length];
        },
        async toggleStarMessage() {
            const msg = this.selectedMessageForOptions;
            if (!msg) return;
            const data = await this.apiFetch('/api/toggle_star_message', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message_id: msg.id })
            });
            if (data?.success) {
                msg.starred = !msg.starred;
            }
        },
        highlight(text, query) {
            if (!query || !text) return text || '';
            let sanitized = text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
            const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
            return sanitized.replace(regex, '<span class="bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 px-0.5 rounded-sm font-bold">$1</span>');

        },
        get unreadNotificationsDisplay() {
            const count = this.unreadNotificationsCount || 0;
            return count > 9 ? '9+' : count;
        },
        getSeenByText(msg) {
            if (!msg.read_by || !Array.isArray(msg.read_by) || msg.read_by.length === 0) return '';
            // Filter out self
            const readers = msg.read_by.filter(u => (u._id || u.id) != this.user.id);
            if (readers.length === 0) return '';
            
            const names = readers.map(u => u.first_name || u.name || 'User').join(', ');
            return `Seen by: ${names}`;
        },
        get filteredFollowingList() {
            const list = this.followingList || [];
            if (!this.friendsSearchQuery?.trim()) return list;
            const q = this.friendsSearchQuery.toLowerCase();
            return list.filter(f =>
                (f.name?.toLowerCase().includes(q)) ||
                (f.username?.toLowerCase().includes(q)) ||
                (f.dept?.toLowerCase().includes(q))
            );
        },
        get potentialGroupMembers() {
            if (!this.activeChat || !this.activeChat?.members) return this.filteredFollowingForGroup || [];
            const existingMemberIds = (this.activeChat?.members || []).map(m => m.id);
            let potential = (this.followingList || []).filter(f => !existingMemberIds.includes(f.id));

            // If adding to a YSU group, only show YSU members
            if (this.activeChat.account_type === 'ysu') {
                potential = potential.filter(f => f.account_type === 'ysu');
            }

            if (!this.addMemberSearchQuery.trim()) {
                return potential;
            }
            const q = this.addMemberSearchQuery.toLowerCase();
            return potential.filter(f => (f.name?.toLowerCase().includes(q)) || (f.username?.toLowerCase().includes(q)));
        },
        get filteredFriendsList() {
            if (!this.friendsSearchQuery?.trim()) return this.friends || [];
            const q = this.friendsSearchQuery.toLowerCase();
            return (this.friends || []).filter(f =>
                (f.name?.toLowerCase().includes(q)) ||
                (f.username?.toLowerCase().includes(q)) ||
                (f.dept?.toLowerCase().includes(q))
            );
        },
        get filteredFollowingForGroup() {
            // Combine following and followers for a complete member list
            const combined = [...(this.followingList || []), ...(this.followerList || [])];
            const uniqueMap = new Map();
            combined.forEach(u => uniqueMap.set(u.id.toString(), u));
            const list = Array.from(uniqueMap.values());

            if (!this.groupSearchQuery?.trim()) return list;
            const q = this.groupSearchQuery.toLowerCase();
            return list.filter(f =>
                (f.name?.toLowerCase().includes(q)) ||
                (f.username?.toLowerCase().includes(q)) ||
                (f.dept?.toLowerCase().includes(q))
            );
        },
        isEditingProfile: false,
        isSideMenuOpen: false,
        isCreatingGroup: false,
        activeChat: null,
        showMemberOptionsFor: null,
        isAddingGroupMembers: false,
        isAddingMembers: false,
        membersToAdd: [],
        addMemberSearchQuery: '',
        isEditingGroupInfo: false,
        editingGroup: { id: null, name: '', description: '', avatarPreview: null, avatarFile: null, permissions: {}, approve_members: false },
        createGroupStep: 1,
        newGroup: { 
            name: '', 
            description: '',
            members: [], 
            avatarFile: null, 
            avatarPreview: null,
            permissions: {
                can_edit_settings: false,
                can_send_messages: true,
                can_add_members: false,
            },
            approve_members: false,
        },
        newMessage: '',
        showChatOptions: false,
        showScrollTop: false,
        showStickerPicker: false,
        showLikesModal: false,
        likersList: [],
         viewingComments: null,
        replyingToComment: null,
        commentInput: '',
        showShareModal: false,
        sharingPost: null,
        showReelOptions: false,
        showPostOptions: false,
        selectedPostForMenu: null,
        selectedReel: null,
        lastReelClick: 0,
        isSpeedingUp: false,
        speedTimer: null,

        // --- CAMERA INTERFACE STATE ---
        isCameraOpen: false,
        cameraStream: null,
        cameraMusic: null,
        audioMixer: null,
        audioDestination: null,
        cameraSource: 'post', // 'post' or 'story'
        facingMode: 'user', // 'user' or 'environment'
        cameraMode: 'photo', // '15s', '30s', '60s', 'photo'
        isCountdownActive: false,
        countdownValue: 3,
        recordingTimeRemaining: 0,
        isCameraRecording: false,
        recordingProgress: 0,
        cameraRecorder: null,
        cameraChunks: [],
        beautyFilter: 'none',
        activeCameraFilter: 'none',
        brightnessIntensity: 100,
        contrastIntensity: 100,
        dollyZoomScale: 1,
        isGlitchActive: false,
        isDoubleExposureActive: false,
        secondaryVideoUrl: 'https://assets.mixkit.co/videos/preview/mixkit-light-leaks-and-bokeh-textures-2504-large.mp4',

        handleOverlayUpload(e) {
            const file = e.target.files[0];
            if (!file) return;
            
            if (this.secondaryVideoUrl && this.secondaryVideoUrl.startsWith('blob:')) {
                URL.revokeObjectURL(this.secondaryVideoUrl);
            }

            this.secondaryVideoUrl = URL.createObjectURL(file);
            this.isDoubleExposureActive = true;
            this.showToast('Overlay Updated', 'Custom exposure video loaded.', 'success');
        },

        micVolume: 0,
        micAnalyser: null,
        micDataArray: null,
        voiceEffect: 'none', // 'none', 'deep', 'chipmunk'
        arFilterMode: 'mask', // 'mask', 'hat'
        isFaceMeshActive: false,
        faceMesh: null,
        faceLandmarks: null,
        isBackgroundRemovalActive: false,
        selfieSegmentation: null,
        segmentationMask: null,
        arAssets: {
            hat: new Image(),
            background: new Image()
        },
        isGreenScreenActive: false,
        isAutoCaptureActive: false,
        faceDetector: null,
        isGhostModeActive: false,
        ghostFrame: null,
        isScanning: false,
        scanLinePosition: 0,
        scanLineDirection: 1, // 1 for down, -1 for up
        scanLineSpeed: 2, // pixels per frame
        qrDetector: null,
        filters: [
            { name: 'Normal', value: 'none' },
            { name: 'Beauty', value: 'brightness(1.1) saturate(1.1) contrast(1.05)' },
            { name: 'Vintage', value: 'sepia(0.4) contrast(1.2)' },
            { name: 'B&W', value: 'grayscale(1)' }
        ],
        filterIndex: 0,

        toggleBeautyFilter() {
            this.filterIndex = (this.filterIndex + 1) % this.filters.length;
            this.beautyFilter = this.filters[this.filterIndex].value;
            this.activeCameraFilter = this.filters[this.filterIndex].value;
            this.showToast('Filter', `Applied: ${this.filters[this.filterIndex].name}`, 'info');
        },

        async initFaceMesh() {
            if (this.faceMesh) return;
            // Dynamically load MediaPipe from CDN
            await this.loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/face_mesh.js');
            this.faceMesh = new FaceMesh({
                locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
            });
            this.faceMesh.setOptions({
                maxNumFaces: 1,
                refineLandmarks: true,
                minDetectionConfidence: 0.5,
                minTrackingConfidence: 0.5
            });
            this.faceMesh.onResults((results) => {
                this.faceLandmarks = results.multiFaceLandmarks ? results.multiFaceLandmarks[0] : null;
            });
        },

        loadScript(src) {
            return new Promise(resolve => {
                const s = document.createElement('script');
                s.src = src; s.onload = resolve;
                document.head.appendChild(s);
            });
        },

        async initSelfieSegmentation() {
            if (this.selfieSegmentation) return;
            await this.loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/selfie_segmentation.js');
            this.selfieSegmentation = new SelfieSegmentation({
                locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${file}`
            });
            this.selfieSegmentation.setOptions({ modelSelection: 1 });
            this.selfieSegmentation.onResults((results) => {
                this.segmentationMask = results.segmentationMask;
            });
        },

        async openCamera(source = 'post') {
            this.cameraSource = source;
            this.isCameraOpen = true;
            this.isCreatingPost = false;
            this.isCreatingStory = false;
            this.focusRing.show = false;
            this.isScanning = (source === 'scan');

            // Auto-switch to back camera for scanning
            if (this.isScanning) {
                this.facingMode = 'environment';
                this.cameraMode = 'scan';
            } else {
                this.facingMode = 'user';
            }

            if ('BarcodeDetector' in window) {
                this.qrDetector = new BarcodeDetector({ formats: ['qr_code'] });
            }
            if ('FaceDetector' in window) {
                this.faceDetector = new FaceDetector({ fastMode: true, maxDetectedFaces: 1 });
            }
            
            if (this.isFaceMeshActive) {
                await this.initFaceMesh();
            }
            
            if (this.isBackgroundRemovalActive) {
                await this.initSelfieSegmentation();
            }

            try {
                const stream = await navigator.mediaDevices.getUserMedia({
                    video: {
                        facingMode: this.facingMode,
                        width: { ideal: 1920, min: 1280 },
                        height: { ideal: 1080, min: 720 },
                        frameRate: { ideal: 30, max: 60 },
                        aspectRatio: { ideal: 1.7777777778 }
                    },
                    audio: true
                });
                this.cameraStream = Alpine.raw(stream);
                this.$refs.cameraFeed.srcObject = stream;
                this.$refs.cameraFeed.muted = true; // Prevent audio feedback loop during preview

                // Setup Lip Sync Analyser
                const audioContext = new (window.AudioContext || window.webkitAudioContext)();
                const sourceNode = audioContext.createMediaStreamSource(stream);
                this.micAnalyser = audioContext.createAnalyser();
                this.micAnalyser.fftSize = 64;
                sourceNode.connect(this.micAnalyser);
                this.micDataArray = new Uint8Array(this.micAnalyser.frequencyBinCount);

                this.$refs.cameraFeed.onloadedmetadata = () => {
                    const video = this.$refs.cameraFeed;
                    const canvas = this.$refs.cameraCanvas;
                    // Professional High-Res Sync: Match canvas pixels to camera pixels
                    canvas.width = video.videoWidth;
                    canvas.height = video.videoHeight;
                    canvas.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
                    if (this.isScanning) {
                        const boxSize = Math.min(canvas.width, canvas.height) * 0.7;
                        this.scanLinePosition = (canvas.height - boxSize) / 2;
                    }
                    this.startCanvasLoop();

                    // Detect flashlight capability
                    const track = stream.getVideoTracks()[0];
                    if (track && track.getCapabilities) {
                        const capabilities = track.getCapabilities();
                        this.hasFlashlight = !!capabilities.torch;
                    }
                };
            } catch (err) {
                this.showToast('Camera Error', 'Could not access camera. Please check permissions.', 'error');
                this.isCameraOpen = false;
            }
        },

        async toggleFlashlight() {
            if (!this.cameraStream) return;
            const track = this.cameraStream.getVideoTracks()[0];
            if (!track) return;

            try {
                this.isFlashOn = !this.isFlashOn;
                await track.applyConstraints({
                    advanced: [{ torch: this.isFlashOn }]
                });
            } catch (err) {
                this.isFlashOn = false;
                this.showToast('Flashlight Error', 'Could not toggle flashlight.', 'error');
            }
        },

        initVisibilityListener() {
            if (window._visibilityListenerAdded) return;
            window._visibilityListenerAdded = true;
            document.addEventListener('visibilitychange', () => {
                this.isPaused = document.hidden;
            });
        },

        startCanvasLoop() {
            const video = this.$refs.cameraFeed;
            const canvas = this.$refs.cameraCanvas;
            const ctx = canvas.getContext('2d');
            let lastQrScan = 0;
            let lastFaceDetect = 0;
            let lastFaceMeshUpdate = 0;
            let lastSegmentationUpdate = 0;
            let faceStayCount = 0;

            const render = async () => {
                if (!this.isCameraOpen || this.isPaused) return;

                // Clear canvas for each frame
                ctx.clearRect(0, 0, canvas.width, canvas.height);

                // Draw video frame first
                ctx.save();
                if (this.facingMode === 'user') { ctx.translate(canvas.width, 0); ctx.scale(-1, 1); }
                ctx.filter = this.isScanning ? 'none' : this.beautyFilter; // Accuracy: Use clean feed for QR detector
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                ctx.restore();
                ctx.filter = 'none';

                // 0. Update Lip Sync volume
                if (this.micAnalyser) {
                    this.micAnalyser.getByteFrequencyData(this.micDataArray);
                    this.micVolume = this.micDataArray.reduce((a, b) => a + b, 0) / this.micDataArray.length;
                }

                // 0. Process Selfie Segmentation
                if (this.isBackgroundRemovalActive && this.selfieSegmentation && Date.now() - lastSegmentationUpdate > 100) {
                    lastSegmentationUpdate = Date.now();
                    await this.selfieSegmentation.send({ image: video });
                }

                // 0. Process Face Mesh (Throttled further to prevent overheating)
                if (this.isFaceMeshActive && this.faceMesh && Date.now() - lastFaceMeshUpdate > 60) {
                    lastFaceMeshUpdate = Date.now();
                    await this.faceMesh.send({ image: video });
                }

                // 0. Process Double Exposure (Background Overlay)
                if (this.isDoubleExposureActive && this.$refs.secondaryVideo && this.cameraMode !== 'scan') {
                    ctx.globalCompositeOperation = 'screen';
                    ctx.globalAlpha = 0.5;
                    ctx.drawImage(this.$refs.secondaryVideo, 0, 0, canvas.width, canvas.height);
                    ctx.globalCompositeOperation = 'source-over';
                    ctx.globalAlpha = 1.0;
                }

                // 0. Optimized Glitch logic
                if (this.isGlitchActive && Math.random() > 0.85 && this.cameraMode !== 'scan') {
                    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                    const data = imgData.data;
                    const width = canvas.width;
                    const height = canvas.height;

                    // RGB Split & Horizontal Shift logic
                    for (let i = 0; i < 5; i++) {
                        const sliceY = Math.floor(Math.random() * height);
                        const sliceH = Math.floor(Math.random() * 30) + 10;
                        const offset = Math.floor(Math.random() * 40) - 20;

                        for (let y = sliceY; y < sliceY + sliceH && y < height; y++) {
                            for (let x = 0; x < width; x++) {
                                const idx = (y * width + x) * 4;
                                const targetX = (x + offset + width) % width;
                                const targetIdx = (y * width + targetX) * 4;
                                
                                data[targetIdx] = data[idx]; // Red split
                                data[targetIdx + 2] = data[(idx + 8) % data.length]; // Blue split
                            }
                        }
                    }
                    ctx.putImageData(imgData, 0, 0);
                }

                // Logic for Manual Beauty Sliders
                let activeFilter = this.beautyFilter;
                if (this.filters[this.filterIndex].name === 'Beauty') {
                    activeFilter = `brightness(${this.brightnessIntensity}%) contrast(${this.contrastIntensity}%) saturate(110%)`;
                }

                // --- COMPOSITING ENGINE ---
                if (this.isBackgroundRemovalActive && this.segmentationMask && this.cameraMode !== 'scan') {
                    // 1. Draw Background Image
                    ctx.drawImage(this.arAssets.background, 0, 0, canvas.width, canvas.height);
                    
                    // 2. Create mask for person
                    const offCanvas = new OffscreenCanvas(canvas.width, canvas.height);
                    const offCtx = offCanvas.getContext('2d');
                    offCtx.drawImage(this.segmentationMask, 0, 0, canvas.width, canvas.height);
                    offCtx.globalCompositeOperation = 'source-in';
                    offCtx.filter = activeFilter;
                    offCtx.drawImage(video, 0, 0, canvas.width, canvas.height);
                    
                    // 3. Composite person over background
                    ctx.drawImage(offCanvas, 0, 0);
                } else if (this.isGreenScreenActive) {
                    ctx.fillStyle = '#003366'; // Corporate blue background placeholder
                    ctx.fillRect(0, 0, canvas.width, canvas.height);
                    // ... existing chroma key logic (applied below)
                }

                // 1. Ghost Frame Overlay (Bottom Layer)
                if (this.isGhostModeActive && this.ghostFrame) {
                    ctx.globalAlpha = 0.4;
                    ctx.drawImage(this.ghostFrame, 0, 0, canvas.width, canvas.height);
                    ctx.globalAlpha = 1.0;
                }

                // 2. Live Camera Feed
                if (this.isGreenScreenActive && this.cameraMode !== 'scan') {
                    // Offscreen processing for Chroma Key
                    const offCanvas = new OffscreenCanvas(canvas.width, canvas.height);
                    const offCtx = offCanvas.getContext('2d');
                    offCtx.filter = activeFilter;
                    offCtx.drawImage(video, 0, 0, canvas.width, canvas.height);
                    const imgData = offCtx.getImageData(0, 0, canvas.width, canvas.height);
                    const data = imgData.data;
                    for (let i = 0; i < data.length; i += 4) {
                        // Key out green pixels (Green > Red and Blue)
                        if (data[i + 1] > 100 && data[i + 1] > data[i] * 1.4 && data[i + 1] > data[i + 2] * 1.4) {
                            data[i + 3] = 0;
                        }
                    }
                    ctx.putImageData(imgData, 0, 0);
                } else {
                    // Image already drawn at the beginning of render()
                }

                // 3. Draw AR Filter Elements
                if (this.isFaceMeshActive && this.faceLandmarks && this.cameraMode !== 'scan') {
                    this.drawARFilter(ctx);
                }

                ctx.filter = 'none';

                // 3. Draw AR Filter Elements
                if (this.isFaceMeshActive && this.faceLandmarks) {
                    this.drawARFilter(ctx);
                }

                // 3. QR Code Detection (Throttled to 200ms for faster response)
                if (this.isScanning && !this.isCameraRecording && Date.now() - lastQrScan > 200) {
                    lastQrScan = Date.now(); 
                    let raw = null;

                    if (this.qrDetector) {
                        const codes = await this.qrDetector.detect(canvas);
                        if (codes.length > 0) raw = codes[0].rawValue;
                    } else if (window.jsQR) {
                        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                        const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: "dontInvert" });
                        if (code) raw = code.data;
                    }

                    if (raw) {
                        document.getElementById('scan-sound')?.play().catch(() => {}); // Play success sound
                        if (raw.includes('/user/')) {
                            // Sanitize username (handle trailing slashes or query params)
                            const username = raw.split('/user/')[1].split('/')[0].split('?')[0];
                            this.closeCamera();
                            this.openUserProfileByName(username);
                            if (navigator.vibrate) navigator.vibrate(100);
                            this.showToast('Found!', `Opening @${username}`, 'success');
                        } else {
                            if (confirm(`External Link: ${raw}\n\nOpen in browser?`)) window.open(raw, '_blank');
                        }
                    }
                }

                // 4. Auto-Capture Face/Smile Detection (Throttled)
                if (this.faceDetector && this.isAutoCaptureActive && !this.isCameraRecording && this.cameraMode !== 'scan' && Date.now() - lastFaceDetect > 500) {
                    lastFaceDetect = Date.now();
                    const faces = await this.faceDetector.detect(canvas);
                    if (faces.length > 0) {
                        faceStayCount++;
                        if (faceStayCount >= 3) { // Trigger after 1.5 seconds of detection
                            faceStayCount = 0;
                            this.takeCameraPhoto();
                            if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
                        }
                    } else { faceStayCount = 0; }
                }

                // 5. Scanning Interface Overlay
                if (this.isScanning) {
                    const boxSize = Math.min(canvas.width, canvas.height) * 0.7;
                    const boxX = (canvas.width - boxSize) / 2;
                    const boxY = (canvas.height - boxSize) / 2;

                    // Dim the outside area
                    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
                    ctx.fillRect(0, 0, canvas.width, boxY); // Top
                    ctx.fillRect(0, boxY + boxSize, canvas.width, canvas.height - (boxY + boxSize)); // Bottom
                    ctx.fillRect(0, boxY, boxX, boxSize); // Left
                    ctx.fillRect(boxX + boxSize, boxY, canvas.width - (boxX + boxSize), boxSize); // Right

                    // Draw Blue Bounding Box Corners
                    ctx.strokeStyle = '#3b82f6';
                    ctx.lineWidth = 4;
                    const len = 30;
                    ctx.beginPath();
                    ctx.moveTo(boxX, boxY + len); ctx.lineTo(boxX, boxY); ctx.lineTo(boxX + len, boxY); // TL
                    ctx.moveTo(boxX + boxSize - len, boxY); ctx.lineTo(boxX + boxSize, boxY); ctx.lineTo(boxX + boxSize, boxY + len); // TR
                    ctx.moveTo(boxX, boxY + boxSize - len); ctx.lineTo(boxX, boxY + boxSize); ctx.lineTo(boxX + len, boxY + boxSize); // BL
                    ctx.moveTo(boxX + boxSize - len, boxY + boxSize); ctx.lineTo(boxX + boxSize, boxY + boxSize); ctx.lineTo(boxX + boxSize, boxY + boxSize - len); // BR
                    ctx.stroke();

                    // Restrict Scanning Line to within the box
                    ctx.fillStyle = 'rgba(59, 130, 246, 0.5)';
                    ctx.fillRect(boxX, this.scanLinePosition, boxSize, 2);
                    this.scanLinePosition += this.scanLineSpeed * this.scanLineDirection;
                    if (this.scanLinePosition >= boxY + boxSize || this.scanLinePosition <= boxY) {
                        this.scanLineDirection *= -1; // Reverse direction
                    }
                }
                requestAnimationFrame(render);
            };
            requestAnimationFrame(render);
        },

        triggerFocus(e) {
            if (!this.isCameraOpen || this.isConfirmingCapture) return;
            
            // 1. Calculate relative position
            const rect = this.$refs.cameraCanvas.getBoundingClientRect();
            this.focusRing.x = e.clientX - rect.left;
            this.focusRing.y = e.clientY - rect.top;
            this.focusRing.show = true;

            // 2. Hardware focus attempt (Limited browser support for advanced constraints)
            if (this.cameraStream) {
                const track = this.cameraStream.getVideoTracks()[0];
                if (track && track.applyConstraints) {
                    track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
                }
            }

            // 3. Auto-hide focus ring
            clearTimeout(this.focusTimer);
            this.focusTimer = setTimeout(() => { this.focusRing.show = false; }, 800);
        },

        async handleGalleryQr(e) {
            const file = e.target.files[0];
            if (!file) return;
            this.showToast('Scanning', 'Reading image from gallery...', 'info');

            const img = new Image();
            img.src = URL.createObjectURL(file);
            await new Promise(resolve => img.onload = resolve);

            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);

            let raw = null;
            if (this.qrDetector) {
                const codes = await this.qrDetector.detect(canvas);
                if (codes.length > 0) raw = codes[0].rawValue;
            } else if (window.jsQR) {
                const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                const code = jsQR(imageData.data, imageData.width, imageData.height);
                if (code) raw = code.data;
            }

            if (raw && raw.includes('/user/')) {
                const username = raw.split('/user/')[1].split('/')[0].split('?')[0];
                this.closeCamera();
                this.openUserProfileByName(username);
                document.getElementById('scan-sound')?.play().catch(() => {});
            } else {
                this.showToast('No Code Found', 'Could not detect a valid profile QR in this image.', 'error');
            }
            URL.revokeObjectURL(img.src);
            e.target.value = '';
        },

        drawARFilter(ctx) {
            if (!this.faceLandmarks) return;
            const landmarks = this.faceLandmarks;
            const canvas = this.$refs.cameraCanvas;
            
            if (this.arFilterMode === 'mask') {
                const leftEye = landmarks[33];
                const rightEye = landmarks[263];
                const eyeCenter = landmarks[168];
                const eyeDist = Math.abs(rightEye.x - leftEye.x) * canvas.width;
                const maskWidth = eyeDist * 2.5;
                const maskHeight = maskWidth * 0.4;

                ctx.save();
                ctx.translate(eyeCenter.x * canvas.width, eyeCenter.y * canvas.height);
                ctx.rotate(Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x));
                ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
                ctx.fillRect(-maskWidth/2, -maskHeight/2, maskWidth, maskHeight);
                ctx.restore();
            } else if (this.arFilterMode === 'hat' && this.arAssets.hat.complete) {
                const topHead = landmarks[10];
                const width = Math.abs(landmarks[454].x - landmarks[234].x) * canvas.width * 1.8;
                const height = width * (this.arAssets.hat.height / this.arAssets.hat.width);
                ctx.save();
                ctx.translate(topHead.x * canvas.width, topHead.y * canvas.height);
                ctx.rotate(Math.atan2(landmarks[454].y - landmarks[234].y, landmarks[454].x - landmarks[234].x));
                ctx.drawImage(this.arAssets.hat, -width/2, -height * 0.8, width, height);
                ctx.restore();
            }
        },

        closeCamera() {
            if (this.cameraStream) {
                this.cameraStream.getTracks().forEach(track => track.stop());
            }
            if (this.recordingTimer) clearInterval(this.recordingTimer);
            this.isCameraOpen = false;
            this.isFlashOn = false;
            this.isCameraRecording = false;
            if (this.cameraSource === 'post') this.isCreatingPost = true;
            if (this.cameraSource === 'story') this.isCreatingStory = true;
        },

        async triggerShutter() {
            if (this.cameraMode === 'photo' || this.cameraMode === 'scan') return this.takeCameraPhoto();
            if (this.isCameraRecording) return this.stopCameraRecording();
            
            // Start Countdown for Video Modes
            this.isCountdownActive = true;
            this.countdownValue = 3;
            
            const countInterval = setInterval(() => {
                this.countdownValue--;
                if (this.countdownValue <= 0) {
                    clearInterval(countInterval);
                    this.isCountdownActive = false;
                    this.startCameraRecording();
                } else {
                    if (navigator.vibrate) navigator.vibrate(50); // Haptic feedback per tick
                }
            }, 1000);
        },

        takeCameraPhoto() {
            this.showCameraFlash = true;
            setTimeout(() => { this.showCameraFlash = false; }, 100);
            document.getElementById('shutter-sound')?.play().catch(() => {});

            const dataUrl = this.$refs.cameraCanvas.toDataURL('image/jpeg', 0.9);
            
            // Capture frame for Ghost Mode
            const img = new Image();
            img.src = dataUrl;
            this.ghostFrame = img;

            this.selectedMedia = dataUrl;
            this.mediaType = 'image';
            
            // Convert to file for actual upload
            fetch(dataUrl).then(res => res.blob()).then(blob => {
                const file = new File([blob], `capture_${Date.now()}.jpg`, { type: 'image/jpeg' });
                if (this.cameraSource === 'post') {
                    this.postFile = file;
                    this.selectedMedia = dataUrl;
                } else {
                    this.storyFile = file;
                    this.storyMediaPreview = dataUrl;
                    this.storyMediaType = 'image';
                }
                this.closeCamera();
            }).catch(err => this.showToast('Error', 'Failed to capture photo.', 'error'));
        },

        startCameraRecording() {
            this.isCameraRecording = true;
            this.recordingProgress = 0;
            this.recordingTimeRemaining = parseInt(this.cameraMode);
            this.cameraChunks = [];
            
            // Capture filtered stream from canvas
            const stream = this.$refs.cameraCanvas.captureStream(30);

            // --- AUDIO MIXING ENGINE ---
            if (!this.audioMixer) {
                this.audioMixer = new (window.AudioContext || window.webkitAudioContext)();
                this.audioDestination = this.audioMixer.createMediaStreamDestination();
            }
            
            // 1. Add Microphone to mix with effects
            const micSource = this.audioMixer.createMediaStreamSource(this.cameraStream);
            let audioChain = micSource;

            if (this.voiceEffect === 'deep') {
                const filter = this.audioMixer.createBiquadFilter();
                filter.type = 'lowpass';
                filter.frequency.value = 400;
                audioChain.connect(filter);
                audioChain = filter;
            } else if (this.voiceEffect === 'chipmunk') {
                const filter = this.audioMixer.createBiquadFilter();
                filter.type = 'highpass';
                filter.frequency.value = 1200;
                audioChain.connect(filter);
                audioChain = filter;
            }

            audioChain.connect(this.audioDestination);

            // 2. Add Music to mix (if selected)
            if (this.cameraMusic) {
                if (!this.musicSourceNode) {
                    this.musicSourceNode = this.audioMixer.createMediaElementSource(this.$refs.cameraMusicPlayer);
                }
                this.musicSourceNode.connect(this.audioDestination);
                this.$refs.cameraMusicPlayer.currentTime = 0;
            }

            // 3. Attach mixed audio to the video stream
            this.audioDestination.stream.getAudioTracks().forEach(track => stream.addTrack(track));

            this.cameraRecorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
            this.cameraRecorder.ondataavailable = (e) => this.cameraChunks.push(e.data);
            this.cameraRecorder.onstop = () => {
                const blob = new Blob(this.cameraChunks, { type: 'video/webm' });
                const file = new File([blob], `reel_${Date.now()}.webm`, { type: 'video/webm' });
                if (this.cameraSource === 'post') {
                    this.postFile = file;
                    this.mediaType = 'video';
                    this.selectedMedia = URL.createObjectURL(file);
                } else {
                    this.storyFile = file;
                    this.storyMediaType = 'video';
                    this.storyMediaPreview = URL.createObjectURL(file);
                }
                this.closeCamera();
            };

            const duration = parseInt(this.cameraMode);
            let elapsed = 0;
            this.cameraRecorder.start();

            this.recordingTimer = setInterval(() => {
                elapsed += 100;
                this.recordingProgress = (elapsed / (duration * 1000)) * 100;
                this.recordingTimeRemaining = Math.max(0, Math.ceil(duration - (elapsed / 1000)));
                if (elapsed >= duration * 1000) this.stopCameraRecording();
            }, 100);
        },

        stopCameraRecording() {
            if (this.cameraRecorder && this.cameraRecorder.state !== 'inactive') this.cameraRecorder.stop();
            if (this.cameraMusic) this.$refs.cameraMusicPlayer.pause();
            clearInterval(this.recordingTimer);
            this.isCameraRecording = false;
        },

        async shareFile() {
            if (!this.postFile) return;
            if (navigator.canShare && navigator.canShare({ files: [this.postFile] })) {
                try {
                    await navigator.share({
                        files: [this.postFile],
                        title: 'Maiga Social Capture',
                    });
                } catch (err) {
                    if (err.name !== 'AbortError') this.showToast('Share Error', 'Could not save media.', 'error');
                }
            } else {
                this.showToast('Not Supported', 'Your browser does not support file saving/sharing.', 'info');
            }
        },

        async flipCamera() {
            this.facingMode = this.facingMode === 'user' ? 'environment' : 'user';
            this.closeCamera();
            this.openCamera();
        },

        // Message Info State
        showMsgInfo: false,
        messageInfoData: [],
        groupActivityData: [],
        async openMessageInfo(msg) {
            this.showMessageOptions = false;
            const data = await this.apiFetch(`/api/get_message_read_details?message_id=${msg.id}`);
            if (data) {
                this.messageInfoData = data; // Now contains delivered_at and read_details
                this.showMsgInfo = true;
            }
        },

        async fetchGroupActivity(groupId) {
            const data = await this.apiFetch(`/api/admin/group_activity_report?group_id=${groupId}`);
            if (data) {
                // Format for your chart library (e.g., Chart.js or simple CSS bars)
                this.groupActivityData = data;
            }
        },

        async fetchAdminDashboard() {
            const stats = await this.apiFetch('/api/admin/get_dashboard_stats');
            if (stats) {
                this.totalUsers = stats.total_users;
                // Other stats like maiga_users can be mapped here if needed by the UI
            }
            const settingsData = await this.apiFetch('/api/admin/get_settings');
            if (settingsData?.settings) {
                this.settings = settingsData.settings;
            }
            const flagged = await this.apiFetch('/api/admin/get_flagged_posts');
            if (Array.isArray(flagged)) this.flaggedPosts = flagged;

            // Fetch Chart Data
            const accStats = await this.apiFetch('/api/admin/get_account_type_stats');
            if (accStats) this.accountTypeStats = accStats;

            const postStats = await this.apiFetch('/api/admin/get_posts_per_day_stats');
            if (postStats) this.postsPerDayStats = postStats;

            const signupStats = await this.apiFetch('/api/admin/get_weekly_signups');
            if (signupStats) this.weeklySignups = signupStats;
        },

        async fetchAdminUsers(page = 1) {
            this.currentPage = page;
            const data = await this.apiFetch(`/api/admin/get_users?page=${page}&limit=${this.itemsPerPage}&search=${this.adminSearchQuery}&filter=${this.adminFilter}`);
            if (data) {
                this.adminUsers = data.users;
                this.totalUsers = data.total;
            }
        },
                get profileUrl() {
            return `${window.location.origin}/user/${this.user.username}`;
        },
        async copyProfileLink() {
            try {
                await navigator.clipboard.writeText(this.profileUrl);
                this.showToast('Copied', 'Profile link copied to clipboard', 'success');
            } catch (err) {
                this.showToast('Error', 'Failed to copy link', 'error');
            }
        },
        async shareProfileLink() {
            if (navigator.share) {
                try {
                    await navigator.share({
                        title: `${this.user.name} on Maiga Social`,
                        text: `Check out my profile on Maiga Social!`,
                        url: this.profileUrl
                    });
                } catch (err) { }
            } else {
                this.copyProfileLink();
            }
        },
        async downloadQRCode() {
            try {
                const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=1000x1000&data=${encodeURIComponent(this.profileUrl)}`;
                const response = await fetch(qrUrl);
                const blob = await response.blob();
                const url = window.URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = `${this.user.username}_maiga_qr.png`;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                window.URL.revokeObjectURL(url);
                this.showToast('Success', 'QR Code saved to gallery', 'success');
            } catch (err) {
                this.showToast('Error', 'Failed to download QR code', 'error');
            }
        },
        async shareApp() {
            const brand = this.user.account_type === 'ysu' ? 'YSU Social' : 'Maiga Social';
            if (navigator.share) {
                try {
                    await navigator.share({
                        title: brand,
                        text: `Join me on ${brand}, the best place to connect!`,
                        url: window.location.origin
                    });
                } catch (err) {}
            } else {
                try {
                    await navigator.clipboard.writeText(window.location.origin);
                    this.showToast('Copied', 'App link copied to clipboard', 'success');
                } catch (err) {}
            }
        },

        isRecording: false,
        mediaRecorder: null,
        audioChunks: [],
        recordingTimer: null,
        recordingDuration: 0,
        isRecordingComment: false,
        commentRecordingDuration: 0,
        commentMediaRecorder: null,
        isSendingComment: false,
        isRecordingPost: false,
        postRecordingDuration: 0,
        isSendingPost: false, // Added to fix ReferenceError
        showSuggestions: false, // Added to fix ReferenceError
        postMediaRecorder: null,
        isRecordingStoryReply: false,
        isSendingStoryReply: false,
        storyReplyMediaRecorder: null,
        storyReplyRecordingDuration: 0,
        commentAudioChunks: [],
        commentRecordingTimer: null,
        showMessageOptions: false,
        selectedMessageForOptions: null,
        recordAnalyser: null,
        recordAnimationId: null,
        visualizeStream(stream, canvasId) {
            const canvas = document.getElementById(canvasId);
            if (!canvas) return;
            const ctx = canvas.getContext('2d');
            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const source = audioContext.createMediaStreamSource(stream);
            this.recordAnalyser = audioContext.createAnalyser();
            this.recordAnalyser.fftSize = 64;
            source.connect(this.recordAnalyser);
            const dataArray = new Uint8Array(this.recordAnalyser.frequencyBinCount);

            const draw = () => {
                this.recordAnimationId = requestAnimationFrame(draw);
                this.recordAnalyser.getByteFrequencyData(dataArray);
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                const barWidth = (canvas.width / dataArray.length) * 2;
                let x = 0;
                for (let i = 0; i < dataArray.length; i++) {
                    const barHeight = (dataArray[i] / 255) * canvas.height;
                    ctx.fillStyle = this.darkMode ? '#60a5fa' : '#2563eb';
                    ctx.fillRect(x, canvas.height - barHeight, barWidth - 2, barHeight);
                    x += barWidth;
                }
            };
            draw();
        },
        showForwardModal: false,
        messageToForward: null,
        replyingTo: null,
        isCreatingPoll: false,
        newPoll: { question: '', options: ['', ''] },
        isSchedulingMessage: false,
        scheduledTime: '',
        scheduledMessages: [],
        isReelsMuted: true,
        postAudioChunks: [],
        postRecordingTimer: null,
        isProcessingMetadata: false,
        showWallpaperPicker: false,
        wallpaperTemplates: [],
        selectedWallpaper: null,
        wallpaperBrightness: 100,
        storyReplyAudioChunks: [],
        storyReplyRecordingTimer: null,
        hasInteractedWithVolume: false,
        reelVolume: 1,
        showVolumeSlider: false,
        showSwipeHint: false,
        reelHintTimer: null,
        volumeLongPressTimer: null,
        reelClickTimer: null,
        selectedMedia: null,
        mediaType: null,
        postFileList: [],
        selectedMediaList: [],
        newPostContent: '',
        homeSearchQuery: '',
        isSearchFocused: false,
        recentSearches: ['Exam Timetable', 'Library', 'Sports'],
        isCallChatOpen: false,
        isCallMinimized: false,
        isCalling: false,
        async logout() {
            if (!confirm('Are you sure you want to log out?')) return;

            // Clear PWA Session Marker
            if ('caches' in window) {
                const cache = await caches.open(`${this.user.account_type || 'maiga'}-offline-v5`);
                await cache.delete('/auth-session-active');
            }

            // Clear Persistent IDB Marker
            if (this.crypto && this.crypto.db) {
                await this.crypto._set('persistent_session', false);
            }

            await this.apiFetch('/api/logout');

            // Clear local application storage
            localStorage.removeItem('maiga_session_active');
            localStorage.clear();

            // Force clear browser cache storage (Service Worker caches)
            if ('caches' in window) {
                const cacheNames = await caches.keys();
                await Promise.all(cacheNames.map(name => caches.delete(name)));
            }

            // Redirect to YSU login if account_type is 'ysu', otherwise to default Maiga login
            window.location.replace(this.user.account_type === 'ysu' ? 'ysu.html' : 'index.html');
        },
        async checkForUpdates() {
            if (!('serviceWorker' in navigator)) return;
            const reg = await navigator.serviceWorker.getRegistration();
            if (reg) {
                this.showToast('Checking', 'Checking for app updates...', 'info');
                await reg.update();
                
                if (reg.waiting) {
                    this.showToast('Update Ready', 'A new version is available. Refreshing...', 'success');
                    reg.waiting.postMessage({ type: 'SKIP_WAITING' });
                    setTimeout(() => window.location.reload(), 1000);
                } else if (reg.installing) {
                    this.showToast('Updating', 'Downloading update...', 'info');
                } else {
                    this.showToast('Up to date', 'You are running the latest version.', 'success');
                }
            }
        },
        async installPwa() {
            if (!this.installPrompt) return;
            this.installPrompt.prompt();
            this.installPrompt = null;
        },
        sendWave(friend) {
            if (!friend || !friend.id) return;
            
            this.showToast('Waved!', `You waved at ${friend.name || 'user'} 👋`, 'success');

            this.apiFetch('/api/send_wave', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': CSRF_TOKEN
                },
                body: JSON.stringify({ user_id: friend.id })
            });
            this.startChatWithUser(friend);
        },
        deletePostMedia() {
            this.selectedMediaList.forEach(url => { if (url.startsWith('blob:')) URL.revokeObjectURL(url); });
            this.selectedMedia = null;
            this.mediaType = null;
            this.postFile = null;
            this.postFileList = [];
            this.selectedMediaList = [];
            this.saveCreatePostDraft();
        },
        removeMediaFromList(idx) {
            const url = this.selectedMediaList[idx];
            if (url && url.startsWith('blob:')) URL.revokeObjectURL(url);
            this.selectedMediaList.splice(idx, 1);
            this.postFileList.splice(idx, 1);
            if (this.selectedMediaList.length === 0) {
                this.deletePostMedia();
            } else {
                this.postFile = this.postFileList[0];
                this.selectedMedia = this.selectedMediaList[0];
            }
            this.saveCreatePostDraft();
        },
        compressImage(file, maxWidth = 1200, quality = 0.7) {
            return new Promise((resolve) => {
                this.compressionProgress = 0;
                // Corrected path to match your project structure
                const worker = new Worker('/routes/image-worker.js');
                
                worker.onmessage = (e) => {
                    if (e.data.type === 'progress') {
                        this.compressionProgress = e.data.value;
                    } else if (e.data.type === 'result') {
                        if (e.data.success) {
                            resolve(e.data.blob);
                        } else {
                            console.error('Worker compression failed, falling back to original:', e.data.error);
                            resolve(file);
                        }
                        worker.terminate();
                        this.compressionProgress = 0;
                    }
                };

                worker.onerror = (err) => {
                    console.error('Worker error:', err);
                    resolve(file);
                    worker.terminate();
                };

                worker.postMessage({ file, maxWidth, quality });
            });
        },
        isCallRecording: false,
        isRightSidebarCollapsed: false,
        callRecorder: null,
        callChunks: [],
        profileTab: 'posts',
        showFollowerList: null,
        batteryLevel: 100,
        isCharging: false,
        isPoorConnection: false,
        isReconnecting: false,
        connectionInterval: null,
        callType: null,
        isScreenSharing: false,
        localStream: null,
        callStatus: '',
        followLoading: [],
        isMicMuted: false,
        isCameraOff: false,
        isSpeakerOn: false,
        callDuration: 0,
        callTimer: null,
        dragInfo: { startX: 0, startY: 0, initialX: 0, initialY: 0 },
        minimizedCallTransform: { x: 0, y: 0 },
        swipeStart: { x: 0, y: 0 },
        swipingMsgId: null,
        swipingChatId: null,
        chatSwipeOffset: 0,
        // Removed duplicate swipeOffset, isDragging, isPaused declarations
        editingMessageId: null,
        isSearchingChat: false,
        isSendingMessage: false,
        showCommentStickers: false,
        showWallpaperPicker: false,
        chatSearchQuery: '',
        clearChatSearch() {
            this.chatSearchQuery = '';
            this.isSearchingChat = false;
            // Watcher will automatically trigger fetchMessages
        },
        createPostOffset: { x: 0, y: 0 },
        createPostStart: { x: 0, y: 0 },
        isCreatePostDragging: false,
        posts: [],
        reels: [],
        groups: [],
        chats: [],
        mutedChats: [],
        mediaPreviewUrl: null,
        mediaPreviewFile: null,
        mediaPreviewType: null,
        incomingCall: null,
        peerConnection: null,
        pendingRemoteDescription: null,
        pendingIceCandidates: [],
        currentCallId: null,
        archivedChats: [],
        activeHashtag: null,
        page: 1,
        isLoadingMore: false,
        searchResults: [],
        searchPostsResults: [],
        searchReelsResults: [],
        toasts: [],
        searchSuggestions: [],
        recentSearches: JSON.parse(localStorage.getItem('maiga_recent_searches') || '[]'),
        reportForm: { title: '', description: '', screenshot: null, preview: null, targetType: '', targetId: null, targetUserId: null, priority: 'low' },
        // Pull to Refresh
        pullStartY: 0,
        pullDistance: 0,
        isOffline: !navigator.onLine,
        isSocketConnected: false,
        isRefreshing: false,
        hasMoreFriends: false,
        handlePullStart(e) {
            if (this.$refs.mainContent && this.$refs.mainContent.scrollTop === 0 && window.scrollY === 0) {
                this.pullStartY = e.touches[0].clientY;
                this.touchStartX = e.touches[0].clientX;
            }
        },
        handlePullMove(e) {
            const touchX = e.touches[0].clientX;
            const touchY = e.touches[0].clientY;
            const deltaX = touchX - this.touchStartX;
            const deltaY = touchY - this.pullStartY;

            // Prevent tab swiping if interacting with horizontal scroll areas (like stories)
            if (e.target.closest('[data-no-swipe]') || e.target.closest('.no-scrollbar') || e.target.closest('.overflow-x-auto')) return;

            // Gesture Tab Navigation (Horizontal Swipe)
            // Only trigger if horizontal movement is significantly greater than vertical
            if (Math.abs(deltaX) > Math.abs(deltaY) * 2 && Math.abs(deltaX) > 40) {
                if (this.activeChat || this.isCreatingStory || this.isCreatingPost) return;
                
                const tabs = ['home', 'friends', 'reels'];
                let currentIndex = tabs.indexOf(this.activeTab);
                
                if (currentIndex !== -1) {
                    if (deltaX > 100) { // Swipe Right -> Previous Tab
                        if (currentIndex > 0) this.activeTab = tabs[currentIndex - 1];
                        this.touchStartX = touchX; // Reset to prevent multiple triggers
                    } else if (deltaX < -100) { // Swipe Left -> Next Tab
                        if (currentIndex < tabs.length - 1) this.activeTab = tabs[currentIndex + 1];
                        this.touchStartX = touchX;
                    }
                }
            }

            if (this.pullStartY > 0 && this.$refs.mainContent && this.$refs.mainContent.scrollTop === 0 && window.scrollY === 0) {
                const dist = touchY - this.pullStartY;
                if (dist > 0) {
                    this.isBouncing = false;
                    e.preventDefault(); // Prevent browser's default pull-to-refresh
                    this.pullDistance = Math.min(dist * 0.4, 150);

                    // Progressive Haptic Feedback
                    // Every 20px of pull, trigger a pulse that gets slightly longer
                    let currentStep = Math.floor(this.pullDistance / 20);
                    if (currentStep > (this.lastHapticStep || 0)) {
                        if (navigator.vibrate) {
                            navigator.vibrate(5 + (currentStep * 3)); 
                        }
                        this.lastHapticStep = currentStep;
                    }
                } else {
                    this.pullDistance = 0;
                    this.lastHapticStep = 0;
                }
            }
        },
        handlePullEnd() {
            this.isBouncing = true;
            if (this.pullDistance > 80) { // Increased threshold for better UX
                this.refreshAllData();
            } else {
                this.pullDistance = 0;
                this.pullStartY = 0;
                this.lastHapticStep = 0;
                setTimeout(() => { this.isBouncing = false; }, 500);
            }
        },
        checkConnection() {
            if (!this.isOffline && navigator.onLine) {
                this.showToast('Online', 'You are already online.', 'success');
                return;
            }
            this.showToast('Connecting', 'Checking connection...', 'info');
            
            fetch('/?t=' + Date.now(), { method: 'HEAD', cache: 'no-store' })
                .then(() => {
                    this.isOffline = false;
                    this.showToast('Back Online', 'Internet connection restored.', 'success');
                    this.refreshAllData();
                })
                .catch(() => {
                    this.isOffline = true;
                    this.showToast('Offline', 'Still offline. Please check your connection.', 'error');
                });
        },
        refreshAllData() {
            if (this.isRefreshing) return;
            this.isRefreshing = true;
            this.friendsPage = 1;

            const promises = [
                this.apiFetch('/api/get_posts?page=1').then(data => { if (Array.isArray(data)) { this.posts = data; this.page = 1; } }), // Fixed: this.homePosts to this.posts
                this.apiFetch('/api/get_chats').then(data => { if (Array.isArray(data)) this.chats = data; }),
                this.apiFetch('/api/get_groups').then(data => { if (Array.isArray(data)) { this.groups = data; this.updateUnreadCounts(); } }),
                this.apiFetch('/api/get_stories').then(data => this.processStories(Array.isArray(data) ? data : [])),
                this.apiFetch(`/api/friends/suggestions?page=1&limit=${this.friendsLimit}`).then(data => { 
                    if (data && Array.isArray(data.users)) { this.friends = data.users; this.hasMoreFriends = data.hasMore; localStorage.setItem('maiga_friends_cache', JSON.stringify(data.users)); } 
                }),
                this.apiFetch('/api/get_trending').then(data => { if (Array.isArray(data)) this.trendingTopics = data; })
        
            ];

            Promise.all(promises).finally(() => {
                this.showToast('Refreshed', 'Your feed is up to date.', 'success');
                // Use a timeout to make the animation feel smoother
                setTimeout(() => {
                    this.isRefreshing = false;
                    this.pullDistance = 0;
                    this.pullStartY = 0;
                }, 500);
            });
        },
        isLoading: true,
        loadProgress: 0,
        showLoadingRetry: false,
        showSkeletons: true,
        user: {
            id: 0,
            name: '',
            username: '',
            nickname: '',
            avatar: '',
            account_type: 'maiga',
            followerIds: [],
            followingIds: [],
            total_posts_count: 0
        },
        following: [],
        followingList: [],
        selectedLanguage: 'English',
        selectedTopic: null,
        showUserProfile: false,
        viewingUser: null,
        viewingPost: null, // ... other properties
        viewingStory: null,
        showSeenList: false, // ... other properties
        showCloseFriendsManager: false,
        newStoryText: '',
        newStoryContent: '',
        newStoryTextColor: '#ffffff',
        storyTextColors: ['#ffffff', '#000000', '#ff0000', '#00ff00', '#0000ff', '#ffff00', '#00ffff', '#ff00ff'],
        tempStory: null,
        closeFriends: [],
        touchStartY: 0,
        pressStartTime: 0,
        isPaused: false,
        showStoryShareOptions: false,
        isSharingStoryToChat: false,
        zoomScale: 1,
        lastScale: 1,
        startPinchDist: 0,
        uploadProgress: 0,
        isPostingStory: false,
        myStories: [],
        storyProgress: 0,
        storyTimer: null,
        blockedUsers: [],
        showGroupInfo: false,
        replyContent: '',
        privacySettings: {
            privateAccount: false,
            activityStatus: true,
            location: true
        },
        passwordForm: { current: '', new: '', confirm: '' },
        editUser: {},
        forumTopics: [], // Will fetch from backend
        notifications: [],
        reports: [],
        chats: [],
        chatMessages: {}, // Will populate via API
        reels: [],
        myReels: [],
        observer: null,
        viewedReels: new Set(),
        reelPage: 1,
        isLoadingMoreReels: false,
        
        // --- GLOBAL AUDIO PLAYER ---
        globalPlayer: {
            visible: false,
            minimized: true,
            playing: false,
            track: null, // { title, artist, cover, src }
            currentTime: 0,
            duration: 0,
            progress: 0,
            audioObj: null
        },

        initGlobalAudio() {
            if (this.globalPlayer.audioObj) return;
            this.globalPlayer.audioObj = new Audio();
            const p = this.globalPlayer;
            const a = p.audioObj;

            a.addEventListener('timeupdate', () => {
                p.currentTime = a.currentTime || 0;
                p.duration = a.duration || 0;
                p.progress = (a.duration > 0) ? (a.currentTime / a.duration) * 100 : 0;
            });
            a.addEventListener('ended', () => {
                p.playing = false;
                p.progress = 100;
            });
            a.addEventListener('play', () => p.playing = true);
            a.addEventListener('pause', () => p.playing = false);
            a.addEventListener('error', () => {
                this.showToast('Error', 'Unable to play audio track.', 'error');
                p.playing = false;
            });
        },

        playGlobalTrack(track) {
            this.initGlobalAudio();
            const p = this.globalPlayer;
            
            if (p.track && p.track.src === track.src) {
                this.toggleGlobalPlayback();
                return;
            }

            // Stop any inline audio
            if (this.activeAudioId) {
                const el = document.getElementById(this.activeAudioId);
                if (el) el.pause();
            }

            p.track = track;
            p.visible = true;
            p.minimized = true; 
            p.audioObj.src = track.src;
            p.audioObj.play().catch(e => { });
        },

        toggleGlobalPlayback() {
            if (!this.globalPlayer.audioObj) return;
            if (this.globalPlayer.playing) this.globalPlayer.audioObj.pause();
            else this.globalPlayer.audioObj.play();
        },

        seekGlobalAudio(event) {
            if (!this.globalPlayer.audioObj) return;
            const percent = event.target.value;
            const time = (percent / 100) * this.globalPlayer.audioObj.duration;
            this.globalPlayer.audioObj.currentTime = time;
        },

        closeGlobalPlayer() {
            if (this.globalPlayer.audioObj) {
                this.globalPlayer.audioObj.pause();
                this.globalPlayer.audioObj.currentTime = 0;
            }
            this.globalPlayer.visible = false;
            this.globalPlayer.playing = false;
            this.globalPlayer.track = null;
        },

        // --- INLINE AUDIO MANAGEMENT ---
        activeAudioId: null,
        
        toggleAudio(elementId) {
            const el = document.getElementById(elementId);
            if (!el) return;

            // Pause global player if running
            if (this.globalPlayer.playing) this.globalPlayer.audioObj.pause();

            if (this.activeAudioId === elementId) {
                el.pause();
            } else {
                if (this.activeAudioId) {
                    const prev = document.getElementById(this.activeAudioId);
                    if (prev) prev.pause();
                }
                el.play().catch(e => { });
            }
        },
        
        handleAudioPlay(elementId) {
            this.activeAudioId = elementId;
        },
        
        handleAudioPause(elementId) {
            if (this.activeAudioId === elementId) {
                this.activeAudioId = null;
            }
        },

        // --- REACTION LOGIC ---
        activeReactionPostId: null,
        reactionTimer: null,
        showGuideOverlay: false,

        startReactionTimer(postId) {
            this.reactionTimer = setTimeout(() => {
                this.activeReactionPostId = postId;
                if (navigator.vibrate) navigator.vibrate(50);
            }, 500);
        },

        stopReactionTimer() {
            if (this.reactionTimer) {
                clearTimeout(this.reactionTimer);
                this.reactionTimer = null;
            }
        },

        closeReactions(postId) {
            if (this.activeReactionPostId === postId) {
                this.activeReactionPostId = null;
            }
        },

        openConfirmModal(title, message, action) {
            this.confirmModal.title = title;
            this.confirmModal.message = message;
            this.confirmModal.confirmAction = action;
            this.confirmModal.show = true;
        },

        async mainInit() {
            // --- PWA Force Update Logic ---
            if ('serviceWorker' in navigator) {
                // Check the server for a new service worker version immediately
                navigator.serviceWorker.getRegistration().then(reg => {
                    if (reg) reg.update();
                });

                // Detect when the new service worker has activated and taken control
                let refreshing = false;
                navigator.serviceWorker.addEventListener('controllerchange', () => {
                    if (refreshing) return;
                    refreshing = true;
                    this.showToast('System Update', 'New version installed. Refreshing app...', 'success');
                    setTimeout(() => window.location.reload(), 1500);
                });
            }

            // Prevent back button to login page
            history.pushState(null, null, location.href);
            window.onpopstate = function () {
                history.go(1);
            };

            // Show retry button if loading takes more than 20 seconds
            const loadingRetryTimer = setTimeout(() => { this.showLoadingRetry = true; }, 20000);
            const incrementProgress = () => {
                this.loadProgress = Math.min(99, this.loadProgress + 5);
            };

            // --- RESILIENT SOCKET.IO INITIALIZATION ---
            if (typeof io !== 'undefined') {
                this.socket = io(API_BASE_URL, { transports: ['websocket', 'polling'] });
                this.isSocketConnected = this.socket.connected;
            } else {
                this.socket = { on: () => {}, emit: () => {}, connected: false };
            }

            // 2. Join a room based on the user's ID once connected and user is loaded
            this.socket.on('connect', () => {
                this.isSocketConnected = true;
                if (this.user && this.user.id) {
                    this.socket.emit('join_room', this.user.id); // This should be the user's actual ID from the backend
                    // Join group rooms for real-time updates
                    this.groups.forEach(g => {
                        this.socket.emit('join_group', g.id);
                    });
                }
            });

            this.socket.on('disconnect', () => { this.isSocketConnected = false; });
            this.socket.on('connect_error', () => { this.isSocketConnected = false; });

            // 3. Listen for incoming messages
            this.socket.on('receive_message', async (data) => {
                if (navigator.vibrate) {
                    if (data.group_id) {
                        navigator.vibrate([100, 50, 100]); // Short double pulse for groups
                    } else {
                        navigator.vibrate(200); // Longer single pulse for direct messages
                    }
                }
                if (this.isMessageSoundEnabled) {
                    document.getElementById('message-sound')?.play().catch(() => {}); // Play notification sound
                }

                // Make sure it's not our own message coming back
                if (data.sender_id.toString() === this.user.id.toString()) return;

                // Acknowledge delivery to the server
                this.socket.emit('message_received', { message_id: data.id });

                // Normalize message for Alpine templates (match fetchMessages format)
                const formattedMsg = {
                    ...data,
                    sender: 'them',
                    type: data.media_type || 'text',
                    time: new Date(data.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                    author: data.author || 'User'
                };

                const chatId = data.group_id ? data.group_id.toString() : data.sender_id.toString();
                this.chatMessages[chatId] = [...(this.chatMessages[chatId] || []), formattedMsg];

                // Smart scroll: Only scroll if user is already near the bottom
                this.$nextTick(() => {
                    const container = document.getElementById('messageContainer');
                    if (container) {
                        const threshold = 100; // pixels from bottom
                        const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
                        if (isNearBottom) {
                            container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
                        }
                    }
                });
                const chatInList = data.group_id
                    ? this.groups.find(g => g.id.toString() === chatId)
                    : this.chats.find(c => c.id.toString() === chatId);
                if (chatInList) {
                    const prefix = data.group_id ? `<span class="text-indigo-500 font-bold">${data.author.split(' ')[0]}:</span> ` : '';
                    const isCurrentChat = this.activeChat?.id.toString() === chatId;
                    
                    // Create a new object to ensure Alpine.js detects the change
                    const updatedChat = {
                        ...chatInList,
                        lastMsg: prefix + (data.media_type === 'text' ? data.content : `<i>Sent a ${data.media_type}</i>`),
                        lastMsgId: data.id,
                        lastMsgByMe: false,
                        lastMsgIsRead: false,
                        time: 'Just now',
                        lastMsgTimestamp: Date.now(),
                        unread: !isCurrentChat,
                        unreadCount: !isCurrentChat ? (chatInList.unreadCount || 0) + 1 : 0,
                        justReceived: true,
                        priorityReceived: data.priority
                    };

                    if (data.group_id) {
                        this.groups = [updatedChat, ...this.groups.filter(g => g.id.toString() !== chatId)];
                    } else {
                        this.chats = [updatedChat, ...this.chats.filter(c => c.id.toString() !== chatId)];
                    }
                    
                    setTimeout(() => {
                        if (data.group_id) {
                            this.groups = this.groups.map(g => g.id.toString() === chatId ? { ...g, justReceived: false } : g);
                        } else {
                            this.chats = this.chats.map(c => c.id.toString() === chatId ? { ...c, justReceived: false } : c);
                        }
                    }, 3000);
                    
                    if (!isCurrentChat) {
                        this.updateUnreadCounts();
                        if (data.priority === 'high' && (this.isRightSidebarCollapsed || !this.activeChat)) {
                            this.isAutoExpanding = true;
                            setTimeout(() => { this.isAutoExpanding = false; }, 3000);
                        }
                    }
                } else {
                    // Create new entry if it doesn't exist
                    const newEntry = {
                        id: chatId, // Ensure ID is string
                        name: data.group_name || data.author || 'Unknown Group', // Provide fallback
                        avatar: data.group_avatar || data.avatar || 'img/default-group.png', // Provide fallback
                        type: data.group_id ? 'group' : 'user',
                        lastMsg: (data.group_id ? `<span class="text-indigo-500 font-bold">${(data.author || 'User').split(' ')[0]}:</span> ` : '') + (data.media_type === 'text' ? data.content : `<i>Sent a ${data.media_type}</i>`),
                        lastMsgId: data.id,
                        lastMsgByMe: false,
                        lastMsgIsRead: false,
                        lastMsgTimestamp: Date.now(),
                        time: 'Just now',
                        unread: true,
                        unreadCount: 1,
                        status: 'online',
                        justReceived: true,
                        priorityReceived: data.priority
                    };
                    if (data.group_id) this.groups = [newEntry, ...this.groups];
                    else this.chats = [newEntry, ...this.chats];
                    
                    setTimeout(() => {
                        if (data.group_id) {
                            this.groups = this.groups.map(g => g.id.toString() === chatId ? { ...g, justReceived: false } : g);
                        } else {
                            this.chats = this.chats.map(c => c.id.toString() === chatId ? { ...c, justReceived: false } : c);
                        }
                    }, 3000);
                    
                    // Auto-expand for new high-priority chat
                    if (data.priority === 'high' && (this.isRightSidebarCollapsed || !this.activeChat)) {
                        this.isAutoExpanding = true;
                        setTimeout(() => { this.isAutoExpanding = false; }, 3000);
                    }
                    if (navigator.vibrate) navigator.vibrate(200);
                }
            });

             // --- Socket Call Listeners ---
            this.socket.on('incoming_call', (data) => {
                if (this.isCalling || this.incomingCall) {
                    this.socket.emit('call_busy', { to: data.from, callId: data.callId });
                    return;
                }

                const chatInList = this.chats.find(c => c.id == data.from);
                if (chatInList) chatInList.callInProgress = true;

                // Start vibration pattern (500ms on, 200ms off, 500ms on)
                if (navigator.vibrate) {
                    this.vibrationInterval = setInterval(() => {
                        navigator.vibrate([500, 200, 500]);
                    }, 2000);
                }

                this.incomingCall = {
                    id: data.callId.toString(),
                    caller_id: data.from,
                    name: data.name,
                    avatar: data.avatar,
                    type: data.type,
                    sdp: data.signal // Keep original object
                };
                document.getElementById('ringing-sound')?.play().catch(()=>{});
            });

            this.socket.on('call_accepted', async (signal) => {
                clearTimeout(this.callTimeoutTimer);
                this.callStatus = 'Connecting...';
                document.getElementById('ringing-sound')?.pause();

                this.pendingRemoteDescription = signal;

                if (!this.peerConnection) {
                    console.warn('call_accepted received before peerConnection was created; initializing peer connection now.');
                    this.setupPeerConnection();
                    if (this.localStream) {
                        this.localStream.getTracks().forEach(track => this.peerConnection.addTrack(track, this.localStream));
                    }
                }

                if (!this.peerConnection) {
                    console.error('Unable to process call_accepted: peerConnection unavailable.');
                    return;
                }

                await this.processPendingSignaling();
            });

            this.socket.on('ice_candidate', (candidate) => {
                if (!this.peerConnection || !this.peerConnection.remoteDescription?.type) {
                    this.pendingIceCandidates.push(candidate);
                    return;
                }
                this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => {
                    console.warn('Failed to add ICE candidate immediately:', e);
                });
            });

            this.socket.on('call_busy', () => {
                this.showToast('Line Busy', 'The user is currently in another call.', 'info');
                this.endCall(false, false);
            });

            this.socket.on('call_ended', () => {
                const chatInList = this.chats.find(c => c.id.toString() === this.activeChat?.id.toString());
                if (chatInList) chatInList.callInProgress = false;

                this.endCall(false, false);
                this.showToast('Info', 'Call ended.');
            });

            // Listen for typing events
            this.socket.on('display_typing', (data) => {
                if (data.sender_id.toString() === this.user.id.toString()) return;
                const cid = data.chat_id.toString();
                if (!this.typingUsers[cid]) this.typingUsers[cid] = [];
                if (!this.typingUsers[cid].includes(data.sender_name)) {
                    this.typingUsers[cid].push(data.sender_name);
                }
                // Clear after 3 seconds of inactivity
                clearTimeout(this[`typing_timeout_${cid}_${data.sender_id}`]);
                this[`typing_timeout_${cid}_${data.sender_id}`] = setTimeout(() => {
                    this.typingUsers[cid] = (this.typingUsers[cid] || []).filter(name => name !== data.sender_name);
                }, 3000);
            });
            
            this.socket.on('message_deleted', (data) => {
                if (!data || !data.message_id) return;
                for (const chatId in this.chatMessages) {
                    this.chatMessages[chatId] = this.chatMessages[chatId].filter(msg => msg.id.toString() !== data.message_id.toString());
                }
            });
            this.socket.on('message_delivered', (data) => {
                if (!data || !data.message_id) return;
                for (const chatId in this.chatMessages) {
                    const msg = this.chatMessages[chatId].find(m => m.id.toString() === data.message_id.toString());
                    if (msg) msg.delivered = true;
                }
            });
            this.socket.on('message_reacted', (data) => {
                if (!data || !data.message_id) return;
                for (const chatId in this.chatMessages) {
                    const msg = this.chatMessages[chatId].find(m => m.id.toString() === data.message_id.toString());
                    if (msg) msg.reactions = data.reactions || msg.reactions || [];
                }
            });
            this.socket.on('hide_typing', (data) => {
                if (!data || !data.sender_name) return;
                if (Array.isArray(this.typingUsers)) {
                    this.typingUsers = this.typingUsers.filter(name => name !== data.sender_name);
                }
            });

            this.socket.on('disappearing_mode_changed', (data) => {
                if (this.activeChat && this.activeChat.id.toString() === data.chat_id.toString()) {
                    this.showToast('Chat Update', `Disappearing messages ${data.active ? 'enabled' : 'disabled'} by ${data.user_name}`, 'info');
                }
            });

            // --- Notification Listener ---
            this.socket.on('new_notification', (data) => {
                this.notifications.unshift(data);
                
                if (data.type === 'system') {
                    document.getElementById('system-warning-sound')?.play().catch(()=>{});
                } else {
                    document.getElementById('notification-sound')?.play().catch(()=>{});
                }
                
                let toastType = data.type === 'system' ? 'error' : 'info';
                this.showToast(data.type === 'system' ? 'System Warning' : 'New Notification', data.content, toastType);
                
                // If it's a follow notification, you might want to refresh friend suggestions or follower count
                if (data.type === 'follow') {
                    // Optional: refresh follower count if viewing profile
                    if (this.activeTab === 'profile') this.apiFetch('/api/get_user').then(u => this.user = {...this.user, ...u});
                }
            });

            // --- User Status Listener (Online/Offline) ---
            this.socket.on('user_status', (data) => {
                const chat = this.chats.find(c => c.id.toString() === data.userId.toString());
                if (chat && chat.type !== 'group') { // Only update for direct chats
                    chat.status = data.status;
                    chat.last_seen = data.lastSeen;
                }

                // Update Friends/Suggestions List
                const friend = this.friends.find(f => f.id == data.userId);
                if (friend && friend.id.toString() === data.userId.toString()) {
                    friend.online = data.status === 'online';
                    friend.last_seen = data.lastSeen;
                }

                // Update Following List
                const following = this.followingList.find(f => f.id == data.userId);
                if (following && following.id.toString() === data.userId.toString()) {
                    following.online = data.status === 'online';
                    following.last_seen = data.lastSeen;
                }
            });

            // --- Message Edited Listener ---
            this.socket.on('message_edited', async (data) => {
                const chatId = data.group_id ? data.group_id.toString() : (data.sender_id.toString() === this.user.id.toString() ? data.receiver_id.toString() : data.sender_id.toString());
                const messages = this.chatMessages[chatId];
                if (!messages) return;

                const msg = messages.find(m => m.id.toString() === data.id.toString());
                if (msg) {
                    let content = data.content;
                    let type = data.media_type;

                    if (type === 'e2ee') {
                        try {
                            const privKey = await this.crypto.getPrivateKey();
                            content = await this.crypto.decrypt(content, privKey);
                            type = 'text';
                        } catch (e) {
                            content = '🔒 Encrypted Message (Edited)';
                            type = 'text';
                        }
                    }

                    msg.content = content;
                    msg.type = type;
                    msg.is_edited = true;
                    this.showToast('Info', 'A message was edited.');
                }
            });

            // --- Seen Status Listener ---
            this.socket.on('messages_seen', (data) => {
                // Someone viewed my messages
                // data.viewer_id is the person who read them
                const chatId = data.viewer_id.toString();
                if (this.chatMessages[chatId]) {
                    this.chatMessages[chatId].forEach(m => {
                        if (m.sender === 'me') m.read = true;
                    });
                }
            });

            // --- Read Receipt Listener ---
            this.socket.on('read_receipt', (data) => {
                for (let chatId in this.chatMessages) {
                    const msg = this.chatMessages[chatId].find(m => m.id.toString() === data.message_id.toString());
                    if (msg) {
                        msg.read = data.is_read;
                        msg.read_by = data.read_by;
                        
                        // Trigger temporary 'Read' text visibility
                        if (msg.sender === 'me' && data.is_read) {
                            msg.showReadStatus = true;
                            setTimeout(() => { msg.showReadStatus = false; }, 3000);
                        }
                    }
                }
                // Also update the read status in the chat list preview
                const chatInList = [...this.chats, ...this.groups].find(c => c && c.lastMsgId == data.message_id);
                if (chatInList) {
                    chatInList.lastMsgIsRead = data.is_read;
                }
            });

            // Offline Detection
            window.addEventListener('online', () => { 
                this.isOffline = false; 
                this.showToast('Back Online', 'Internet connection restored.', 'success'); 
            });
            window.addEventListener('offline', () => { 
                this.isOffline = true; 
            });
                       
            // Watch for changes to isFullScreen and save to localStorage
            this.$watch('isFullScreen', (value) => {
                localStorage.setItem('maiga_fullscreen', value);
            });
            
            // Unified Theme Logic
            this.applyTheme = () => {
                localStorage.setItem('theme', this.theme);
                const isDark = this.theme === 'dark' || (this.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
                this.darkMode = isDark;
                if (isDark) document.documentElement.classList.add('dark');
                else document.documentElement.classList.remove('dark');
            };
            this.applyTheme();
            this.$watch('theme', () => this.applyTheme());
            window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
                if (this.theme === 'system') this.applyTheme();
            });

            this.toggleTheme = () => {
                const modes = ['light', 'dark', 'system'];
                let idx = modes.indexOf(this.theme);
                this.theme = modes[(idx + 1) % modes.length];
            };

            // Watch for sidebar changes
            this.$watch('isLeftSidebarCollapsed', (value) => {
                localStorage.setItem('maiga_sidebar_collapsed', value);
            });

            // Watch for user profile modal closure
            this.$watch('showUserProfile', (val) => {
                if (!val) localStorage.removeItem('maiga_viewing_user_id');
            });
            
            // Background activity heartbeat and local time update
            setInterval(() => {
                this.updateLastSeen();
                this.currentTime = Date.now();
            }, 60000);
            
            // Haptic feedback when switching tabs
            this.$watch('activeTab', () => {
                if (navigator.vibrate) navigator.vibrate(10);
            });

             // Watch for changes to create post fields to save draft
            this.$watch('newPostContent', () => this.saveCreatePostDraft());
            this.$watch('newPostFeeling', () => this.saveCreatePostDraft());
            this.$watch('postBgStyleIndex', () => this.saveCreatePostDraft());

            
            // Auto-scroll to top when switching to home
            this.$watch('activeTab', (val) => {
                if (this.isMessaging) this.isMessaging = false;
                if (val === 'home') {
                    this.$refs.mainContent?.scrollTo({ top: 0, behavior: 'smooth' });
                }
                
                // Isolate Reels scroll: prevent outer container from scrolling when in reels tab
                if (this.$refs.mainContent) {
                    this.$refs.mainContent.style.overflowY = val === 'reels' ? 'hidden' : 'auto';
                }
            });
            
            // Listen for typing events
            this.socket.on('display_typing', (data) => {
                // Update chat list item
                const chat = this.chats.find(c => c.id.toString() === data.chat_id.toString()) || 
                             this.groups.find(g => g.id.toString() === data.chat_id.toString());
                if (chat) {
                    chat.isTyping = true;
                    clearTimeout(chat.typingTimeout);
                    chat.typingTimeout = setTimeout(() => chat.isTyping = false, 3000); // Clear after 3 seconds
                }

                // Update active chat header (only if not current user)
                if (this.activeChat && this.activeChat.id.toString() === data.chat_id.toString() && data.sender_id.toString() !== this.user.id.toString()) {
                    if (!this.typingUsers.includes(data.sender_name)) {
                        this.typingUsers.push(data.sender_name);
                    }
                    // Clear typing status after a delay if no new typing event
                    clearTimeout(this.typingIndicatorTimeout);
                    this.typingIndicatorTimeout = setTimeout(() => {
                        this.typingUsers = this.typingUsers.filter(id => id !== data.sender_id);
                        this.typingUsers = this.typingUsers.filter(name => name !== data.sender_name);
                    }, 3000);
                }
            });

            this.socket.on('hide_typing', (data) => {
                const chat = this.chats.find(c => c.id.toString() === data.chat_id.toString());
                if (chat) chat.isTyping = false;
                if (this.activeChat && this.activeChat.id.toString() === data.chat_id.toString()) {
                    this.typingUsers = this.typingUsers.filter(id => id !== data.sender_id);
                }
            });
            
            // Indicator Style Calculation
            this.getIndicatorStyle = () => {
                const tabs = ['home', 'friends', 'post', 'reels', 'profile'];
                const index = tabs.indexOf(this.activeTab === 'notifications' ? 'home' : this.activeTab);
                const width = 100 / tabs.length;
                return `width: ${width}%; left: ${index * width}%;`;
            };

            // Auto-sync Privacy, Language, and Stickers
            this.$watch('privacySettings', (value) => {
                this.apiFetch('/api/update_privacy', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(value)
                });
            }, { deep: true });

            this.$watch('selectedLanguage', (value) => {
                this.apiFetch('/api/update_language', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ language: value })
                });
            });

            this.$watch('recentlyUsedStickers', (value) => {
                this.apiFetch('/api/update_recent_stickers', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ stickers: value })
                });
            }, { deep: true });

            this.$watch('reels', () => {
                this.$nextTick(() => this.setupReelsObserver());
            });

            // Watch for chat search queries to filter messages
            this.$watch('chatSearchQuery', (val) => {
                if (this.activeChat) this.fetchMessages(this.activeChat, false);
            });
             
            this.$watch('chatStarFilter', (val) => {
                if (this.activeChat) this.fetchMessages(this.activeChat, false);
            });
            
            // Automatically mark as read and fetch messages when switching chats
            this.$watch('activeChat', (newChat, oldChat) => {
                // Save current message as a draft for the old chat
                if (oldChat) {
                    this.drafts[oldChat.id] = this.newMessage;
                }
                // Load draft for the new chat
                this.newMessage = newChat ? (this.drafts[newChat.id] || '') : '';
                if (newChat) {
                    localStorage.setItem('maiga_active_chat_id', newChat.id);
                    this.markAsRead(newChat);
                    this.fetchMessages(newChat, true);
                } else {
                    localStorage.removeItem('maiga_active_chat_id');
                }
            });

            // Re-join room if user data loads after socket connects
            this.$watch('user.id', (newId) => {
                if (newId && this.socket && this.socket.connected) {
                    this.socket.emit('join_room', newId);
                }
                // Load saved wallpaper settings for the user
                if (newId) {
                    this.loadSavedWallpaper();
                }
                if (newId) {
                    setTimeout(() => this.initPushNotifications(), 2000); // Wait for SW to be ready
                    // Fetch reels if already on profile page during load
                    if (this.activeTab === 'profile' && this.myReels.length === 0) {
                        this.apiFetch(`/api/get_reels?user_id=${newId}&page=1&limit=12`).then(d => { 
                            if (Array.isArray(d)) { this.myReels = d; this.hasMoreMyReels = d.length === 12; }
                        });
                    }
                    if (this.activeTab === 'profile' && this.myPosts.length === 0) {
                        this.apiFetch(`/api/get_posts?user_id=${newId}&page=1&limit=12`).then(d => { 
                            if (Array.isArray(d)) { this.myPosts = d; this.hasMoreMyPosts = d.length === 12; }
                        });
                    }
                }
            }, { immediate: true }); // Ensure this runs immediately if user.id is already set
            
            // Load tab-specific data when switching tabs
            this.$watch('activeTab', (newTab) => {
                localStorage.setItem('maiga_active_tab', newTab);
                if (newTab === 'saved' && this.savedPostList.length === 0) {
                    this.fetchSavedPosts();
                }
                if (newTab === 'profile' && this.myReels.length === 0 && this.user.id !== 0) {
                    this.apiFetch(`/api/get_reels?user_id=${this.user.id}&page=1&limit=12`).then(d => { 
                        if (Array.isArray(d)) { this.myReels = d; this.hasMoreMyReels = d.length === 12; }
                    });
                }
                if (newTab === 'profile' && this.myPosts.length === 0 && this.user.id !== 0) {
                    this.apiFetch(`/api/get_posts?user_id=${this.user.id}&page=1&limit=12`).then(d => { 
                        if (Array.isArray(d)) { this.myPosts = d; this.hasMoreMyPosts = d.length === 12; }
                    });
                }
                // Add other tab-specific loading here if needed
            });
            
            // If full screen was active on last visit, try to restore it
            if (this.isFullScreen) {
                // Re-trigger fullscreen on the first user interaction if the preference exists
                const triggerFs = () => {
                    if (!document.fullscreenElement) {
                        document.documentElement.requestFullscreen().catch(() => {});
                    }
                    window.removeEventListener('click', triggerFs);
                };
                window.addEventListener('click', triggerFs);
            }
            document.addEventListener('fullscreenchange', () => {
                this.isFullScreen = !!document.fullscreenElement;
            });
            this.editUser = { ...this.user };
            
            try {
                // USE THE NEW BATCH ENDPOINT instead of 5 separate calls
                const initData = await this.apiFetch('/api/get_init_data');
                
                if (initData) {
                    this.user = { ...this.user, ...initData.user };
                    this.user.total_posts_count = initData.total_posts_count || 0;
                    this.myPosts = initData.myPosts || [];
                    this.editUser = { ...this.user };
                    this.posts = initData.posts;
                    this.chats = initData.chats;
                    this.groups = initData.groups;
                    this.notifications = initData.notifications;
                    this.followingList = initData.following;
                    this.followerList = initData.followers || [];

                    // Set PWA Session Marker for direct-to-app launch
                    if ('caches' in window) {
                        const cache = await caches.open(`${this.user.account_type || 'maiga'}-offline-v5`);
                        await cache.put('/auth-session-active', new Response('active'));
                    }

                    this.loadProgress = 60; // Huge jump in progress
                }

                this.updateUnreadCounts();
                this.restoreScrollState();

                this.loadCreatePostDraft();

                // Restore viewing user profile if it was open before refresh
                const savedViewingUser = localStorage.getItem('maiga_viewing_user_id');
                if (savedViewingUser) {
                    this.openUserProfile(savedViewingUser);
                }

                // Restore active chat after lists are loaded
                const savedChatId = localStorage.getItem('maiga_active_chat_id');
                if (savedChatId) {
                    const chat = this.chats.find(c => c.id == savedChatId) || this.groups.find(g => g.id == savedChatId);
                    if (chat) this.activeChat = chat;
                }

                // Join group rooms for real-time updates after data is loaded
                if (this.socket && this.socket.connected) {
                    this.groups.forEach(g => this.socket.emit('join_group', g.id));
                }

                // Parallel non-critical fetches (Don't block the core UI load)
                this.apiFetch('/api/get_forum_topics').then(d => { if(Array.isArray(d)) { this.forumTopics = d; this.updateUnreadCounts(); } incrementProgress(); });
                this.apiFetch('/api/get_music_tracks').then(d => { if(Array.isArray(d)) this.musicTracks = d; incrementProgress(); });
                this.apiFetch('/api/get_stickers').then(d => { if(d) { this.editorStickers = d.editor || []; this.storyStickers = d.story || []; } incrementProgress(); });
                this.apiFetch('/api/get_trending').then(d => { this.trendingTopics = Array.isArray(d) ? d : []; incrementProgress(); });
                this.apiFetch('/api/get_animated_stickers').then(d => { if(Array.isArray(d)) this.animatedStickers = d; incrementProgress(); });
                this.apiFetch('/api/get_stories').then(d => { this.processStories(Array.isArray(d) ? d : []); incrementProgress(); });
                this.apiFetch('/api/get_notifications').then(d => { this.notifications = Array.isArray(d) ? d : []; incrementProgress(); });
                this.apiFetch(`/api/friends/suggestions?page=${this.friendsPage}&limit=${this.friendsLimit}`).then(data => { 
                    if (data && Array.isArray(data.users)) { this.friends = data.users; this.hasMoreFriends = data.hasMore; localStorage.setItem('maiga_friends_cache', JSON.stringify(data.users)); } incrementProgress();
                });

                this.apiFetch('/api/get_muted_chats').then(d => { if (Array.isArray(d)) this.mutedChats = d; incrementProgress(); });
                this.apiFetch('/api/get_pinned_chats').then(d => { if (Array.isArray(d)) this.pinnedChats = d; incrementProgress(); });
                this.apiFetch('/api/get_reels?page=1&limit=10').then(async d => { 
                    // Fixed: reels were not being mapped with initial properties
                    this.reels = (Array.isArray(d) ? d : []).filter(r => !this.hiddenReelDepts.includes(r.dept)).map(r => ({...r, showHeart: false, liked: !!r.liked, isExpanded: false, isLoading: true, progress: 0, showStatusIcon: false, lastAction: '', hasError: false}));
                    this.$nextTick(() => this.setupReelsObserver());
                    incrementProgress();
                    await this.restoreScrollState();
                });
                this.apiFetch('/api/get_trending_reels').then(d => { if (Array.isArray(d)) this.trendingReels = d; });
                this.apiFetch('/api/get_starred_messages').then(d => { if (Array.isArray(d)) this.starredMessages = d; incrementProgress(); });
                this.apiFetch('/api/get_blocked_users').then(d => { this.blockedUsers = Array.isArray(d) ? d : []; incrementProgress(); });
                this.apiFetch('/api/get_most_active_users').then(d => { if (Array.isArray(d)) this.mostActiveUsers = d.map(u => ({...u, id: u.id.toString()})); incrementProgress(); });

                if (this.user.is_admin) {
                    this.apiFetch('/api/admin/get_reports').then(d => { if (Array.isArray(d)) { this.reports = d; this.updateUnreadCounts(); } });
                    this.fetchAdminDashboard();
                    this.fetchAdminUsers(1);
                }
            } catch (err) {
                console.error("Critical data load failed", err);
            } finally {
                // Check for auto-answer or specific call landing
                const params = new URLSearchParams(window.location.search);
                const callId = params.get('callId');
                if (callId) {
                    this.apiFetch(`/api/check_incoming_call`).then(res => {
                        if (res?.incoming && res.call.id === callId) {
                            if (params.get('autoAnswer') === 'true') {
                                this.incomingCall = res.call;
                                this.$nextTick(() => this.acceptCall());
                            }
                        }
                    });
                }

                clearTimeout(loadingRetryTimer);
                this.loadProgress = 100;
                
                // Set loading states to false after a slight delay so user can see 100%
                setTimeout(() => {
                    this.isLoading = false;
                    this.showSkeletons = false;
                    this.dataLoaded = true; // Set flag to true after all critical data is loaded
                }, 500);
            }

            this.$watch('isPaused', val => {
                const video = document.querySelector('.story-video');
                if (video) val ? video.pause() : video.play();
            });

            // Setup cryptography - Fix for phone/non-secure context
            if (window.isSecureContext && window.crypto && window.crypto.subtle) {
                try {
                    await this.crypto.init(this);
                    
                    // Update CSRF tokens for any pending posts in IndexedDB
                    await this.crypto.refreshPendingTokens(CSRF_TOKEN);
                    
                    // Set Persistent Session Marker in IDB
                    if (this.dataLoaded || this.user.id !== 0) {
                        await this.crypto._set('persistent_session', true);
                    }

                    const hasKeys = await this.crypto.hasKeys();
                    if (!hasKeys) {
                        await this.crypto.generateAndStoreKeys();
                        this.showToast('Security', 'Encryption keys generated and stored securely.', 'success');
                    }
                } catch (e) { }
            }

            this.$watch('user.account_type', val => document.title = val === 'ysu' ? 'Ysu Social' : 'Maiga Social');
        },
        toggleFullScreen() {
            if (!document.fullscreenElement) {
                document.documentElement.requestFullscreen().catch(() => {});
            } else {
                if (document.exitFullscreen) {
                    document.exitFullscreen(); 
                }
            }
        },
        openUserProfile(userOrId) {
            let userId, username;
            if (typeof userOrId === 'object' && userOrId !== null) {
                userId = userOrId.id;
                username = userOrId.username;
                if (username) this.addToRecent(username);
            } else {
                userId = userOrId;
            }
            
            // Convert to string for consistent comparison
            if (!userId || userId == this.user.id) {
                this.activeTab = 'profile';
                return;
            }
            
            // Close other modals to prevent overlapping/z-index issues
            this.showFollowerList = null;
            this.viewingComments = null;
            this.showGroupInfo = false;
            localStorage.setItem('maiga_viewing_user_id', userId);

            this.viewingUser = null; // Show loading state
            this.showUserProfile = true;
            this.profileTab = 'posts'; // Reset tab to posts when opening a new profile

            // Fetch full user profile from API
            this.apiFetch(`/api/get_profile?user_id=${userId}`)
                .then(data => {
                    if (data && !data.error && data.id) { // Ensure ID is present
                        this.viewingUser = { ...data,
                            reels: [], // Initialize reels array
                            profilePostsPage: 1,
                            profilePostsLimit: 10,
                            isLoadingMoreProfilePosts: false }; // Initialize pagination state
                        // Use posts from profile data if provided, else fallback to fetch
                        if (data.posts) {
                            this.viewingUser.posts = data.posts;
                        } else {
                            this.viewingUser.posts = [];
                            this.apiFetch(`/api/get_posts?user_id=${userId.toString()}`) // Ensure string ID
                                .then(postsData => {
                                    if (postsData) this.viewingUser.posts = postsData;
                                }); // This fallback is now less critical as get_profile returns posts
                        }
                        // Fetch their reels (ensure string ID)
                        this.apiFetch(`/api/get_reels?user_id=${userId}`)
                            .then(reelsData => {
                                if (reelsData) this.viewingUser.reels = reelsData;
                            });
                    } else {
                        this.showUserProfile = false;
                        this.showToast('Error', 'Could not load user profile.', 'error');
                    }
                })
                .catch(err => {
                    this.showUserProfile = false;
                    this.showToast('Error', 'Network error loading profile.', 'error');
                });
            },
        openReelFromProfile(reel) {
            this.showUserProfile = false;
            // Prepend the reel to the main reels feed if it's not already there
            if (!this.reels.find(r => String(r.id) === String(reel.id))) {
                this.reels.unshift({...reel, showHeart: false, liked: !!reel.liked, isLoading: true, progress: 0, showStatusIcon: false, lastAction: '', hasError: false});
            }
            this.activeTab = 'reels';
            this.$nextTick(() => {
                const el = this.$refs.reelsContainer.querySelector(`[data-reel-id="${reel.id}"]`);
                if (el) el.scrollIntoView({ behavior: 'auto' });
            });
        },
        async loadMoreProfilePosts() {
            if (!this.viewingUser || this.viewingUser.isLoadingMoreProfilePosts || !this.viewingUser.hasMorePosts) {
                return;
            }

            this.viewingUser.isLoadingMoreProfilePosts = true;
            this.viewingUser.profilePostsPage++;

            const data = await this.apiFetch(`/api/get_profile?user_id=${this.viewingUser.id.toString()}&page=${this.viewingUser.profilePostsPage}&limit=${this.viewingUser.profilePostsLimit}`);
            
            if (data && !data.error && data.id) {
                if (Array.isArray(data.posts) && data.posts.length > 0) {
                    this.viewingUser.posts = [...this.viewingUser.posts, ...data.posts];
                }
                this.viewingUser.hasMorePosts = data.hasMorePosts;
            } else {
                // Revert page number if fetch fails
                this.viewingUser.profilePostsPage--;
                this.showToast('Error', 'Failed to load more posts.', 'error');
            }

            this.viewingUser.isLoadingMoreProfilePosts = false;
        },
        async loadMoreMyPosts() {
            if (this.isLoadingMoreMyPosts || !this.hasMoreMyPosts || this.user.id === 0) return;
            this.isLoadingMoreMyPosts = true;
            this.myPostsPage++;
            
            const data = await this.apiFetch(`/api/get_posts?user_id=${this.user.id}&page=${this.myPostsPage}&limit=12`);
            if (Array.isArray(data)) {
                this.myPosts = [...this.myPosts, ...data];
                this.hasMoreMyPosts = data.length === 12;
            } else {
                this.myPostsPage--;
                this.showToast('Error', 'Failed to load more posts.', 'error');
            }
            this.isLoadingMoreMyPosts = false;
        },
        async loadMoreMyReels() {
            if (this.isLoadingMoreMyReels || !this.hasMoreMyReels || this.user.id === 0) return;
            this.isLoadingMoreMyReels = true;
            this.myReelsPage++;
            
            const data = await this.apiFetch(`/api/get_reels?user_id=${this.user.id}&page=${this.myReelsPage}&limit=12`);
            if (Array.isArray(data)) {
                const mapped = data.map(r => ({...r, showHeart: false, liked: !!r.liked, isLoading: true, progress: 0, showStatusIcon: false, lastAction: '', hasError: false}));
                this.myReels = [...this.myReels, ...mapped];
                this.hasMoreMyReels = data.length === 12;
            } else {
                this.myReelsPage--;
                this.showToast('Error', 'Failed to load more reels.', 'error');
            }
            this.isLoadingMoreMyReels = false;
        },
        updateLastSeen() {
            if (this.socket && this.socket.connected) {
                this.socket.emit('update_last_seen');
            }
        },
        // sendTypingSignal was duplicated here (removed first instance)

        showToast(title, message, type = 'info') {
            const id = Date.now();
            this.toasts.push({ id, title, message, type, visible: true });
            setTimeout(() => {
                this.removeToast(id);
            }, 3000);
        },
        removeToast(id) {
            this.toasts = this.toasts.filter(t => t.id !== id);
        },
        processStories(data) {
            if (!Array.isArray(data)) return;
            
            const fetchedMyStories = [];
            const storiesByUser = new Map(); // For friends' stories
            
            data.forEach(story => {
                const storyObj = {
                    id: story.id,
                    type: story.type,
                    media: story.media,
                    time: new Date(story.created_at).getTime(),
                    seenBy: [], // Will be populated on view
                    viewCount: story.view_count || 0,
                    hasMusic: !!story.has_music,
                    audience: story.audience,
                    musicTrack: story.music_track,
                    seen: !!story.seen
                };

                // Check if story belongs to current user
                // Note: Ensure both IDs are compared as strings or numbers consistentnly
                if (String(story.user_id) === String(this.user.id)) {
                    fetchedMyStories.push(storyObj); // Ensure story.id is string
                } else {
                    const uid = story.user_id.toString();
                    if (!storiesByUser.has(uid)) {
                        storiesByUser.set(uid, {
                            id: uid,
                            name: (story.first_name || 'User') + ' ' + (story.surname || ''),
                            // Use story.avatar from DB, fallback to gender-based local defaults
                            avatar: story.avatar || (story.gender === 'female' ? 'img/female.png' : 'img/male.png'),
                            stories: []
                        });
                    }
                    storiesByUser.get(uid).stories.push(storyObj);
                }
            });

            this.myStories = fetchedMyStories;
            // Convert Map to Array for Alpine x-for
            this.following = Array.from(storiesByUser.values());
        },
        get userMediaPosts() {
           return (this.showUserProfile && this.viewingUser) ? (this.viewingUser.reels || []) : this.myReels;
        },
        get userLikedPosts() {
           return (this.posts || []).filter(p => p.myReaction !== null);
        },
        get filteredConnectionList() {
            if (!this.connectionSearchQuery?.trim()) {
                return this.connectionList;
            }
            const query = this.connectionSearchQuery.toLowerCase();
            return this.connectionList.filter(person =>
                person.name?.toLowerCase().includes(query) ||
                (person.username?.toLowerCase().includes(query)) ||
                (person.dept?.toLowerCase().includes(query))
            );
        },
        isFollowing(friendId) {
            if (!friendId) return false; // Ensure friendId is string for comparison
            return this.user.followingIds.some(id => id.toString() === friendId.toString());
        },
        isChatMuted(chatId, type) {
            return this.mutedChats.some(m => m.chat_id.toString() === chatId.toString() && m.type === type);
        },
        isPinned(chatId, type) {
            return (this.pinnedChats || []).some(p => p.chat_id == chatId && p.type == type);
        },
        toggleFollow(friendId) {
            if (this.followLoading.includes(friendId)) return;
            
            this.followLoading.push(friendId);
            const isCurrentlyFollowing = this.isFollowing(friendId);

            // --- Optimistic UI Update ---
            if (isCurrentlyFollowing) { // Ensure string comparison
                this.user.followingIds = this.user.followingIds.filter(id => id.toString() !== friendId.toString());
                if (this.viewingUser && this.viewingUser.id.toString() === friendId.toString()) {
                    this.viewingUser.followers_count--;
                }
            } else {
                this.user.followingIds.push(friendId.toString()); // Store as string
                if (this.viewingUser && this.viewingUser.id.toString() === friendId.toString()) {
                    this.viewingUser.followers_count++;
                }
            }
            // --- End Optimistic UI Update ---

            this.apiFetch('/api/toggle_follow', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': CSRF_TOKEN
                },
                body: JSON.stringify({ user_id: friendId })
            })
            .then(data => {
                if (!data || !data.success) {
                    // --- Revert on failure ---
                    if (isCurrentlyFollowing) { // Ensure string comparison
                        this.user.followingIds.push(friendId.toString());
                        if (this.viewingUser && this.viewingUser.id.toString() === friendId.toString()) this.viewingUser.followers_count++;
                    } else {
                        this.user.followingIds = this.user.followingIds.filter(id => id.toString() !== friendId.toString());
                        if (this.viewingUser && this.viewingUser.id.toString() === friendId.toString()) this.viewingUser.followers_count--;
                    }
                    this.showToast('Error', (data && data.error) || 'Failed to update follow status.', 'error');
                } else {
                    // Success, just refresh the full list for consistency
                    this.apiFetch('/api/get_connections?type=following').then(d => {
                        if (d) this.followingList = d;
                    });
                }
            })
            .catch(err => {
                // --- Revert on network error ---
                if (isCurrentlyFollowing) { // Ensure string comparison
                    this.user.followingIds.push(friendId.toString());
                    if (this.viewingUser && this.viewingUser.id.toString() === friendId.toString()) this.viewingUser.followers_count++;
                } else {
                    this.user.followingIds = this.user.followingIds.filter(id => id.toString() !== friendId.toString());
                    if (this.viewingUser && this.viewingUser.id.toString() === friendId.toString()) {
                        this.viewingUser.followers_count--;
                    }
                }
                this.showToast('Error', 'Network error', 'error');
            })
            .finally(() => {
                this.followLoading = this.followLoading.filter(id => id !== friendId);
            });
        },
        openFollowerList(type) { 
            this.showFollowerList = type;
            this.connectionSearchQuery = '';
            this.connectionList = [];
            const profileUserId = this.viewingUser?.id || this.user.id;
            this.apiFetch(`/api/get_connections?type=${encodeURIComponent(type)}&user_id=${profileUserId}`)
                .then(data => {
                    this.connectionList = Array.isArray(data) ? data : [];
                })
                .catch(() => { this.connectionList = []; });
        },
        removeFollower(followerId) {
            if (!confirm('Are you sure you want to remove this follower? They will no longer be following you.')) return;

            this.apiFetch('/api/remove_follower', {
                    method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': CSRF_TOKEN
                },
                body: JSON.stringify({ user_id: followerId })
            })
            .then(data => {
                if (data && data.success) {
                    this.connectionList = this.connectionList.filter(p => p.id.toString() !== followerId.toString());
                    this.user.followerIds = this.user.followerIds.filter(id => id.toString() !== followerId.toString());
                    this.showToast('Success', 'Follower removed.');
                } else {
                    this.showToast('Error', data.error || 'Failed to remove follower.', 'error');
                }
            });
        },
        async handlePostMedia(event) {
            const files = Array.from(event.target.files);
            if (files.length === 0) return;

            this.selectedMediaList.forEach(url => { if (url.startsWith('blob:')) URL.revokeObjectURL(url); });
            this.postFileList = [];
            this.selectedMediaList = [];

            const hasVideo = files.some(f => f.type.startsWith('video'));
            
            if (hasVideo) {
                const file = files.find(f => f.type.startsWith('video'));
                
                // Check file size (100MB limit)
                if (file.size > 100 * 1024 * 1024) {
                    this.showToast('Too Large', 'Video file exceeds 100MB limit.', 'error');
                    event.target.value = '';
                    return;
                }

                // Check duration (3 minutes / 180 seconds limit)
                const duration = await new Promise((resolve) => {
                    const video = document.createElement('video');
                    video.preload = 'metadata';
                    video.onloadedmetadata = () => {
                        window.URL.revokeObjectURL(video.src);
                        resolve(video.duration);
                    };
                    video.src = URL.createObjectURL(file);
                });

                if (duration > 180) {
                    this.showToast('Too Long', 'Videos cannot exceed 3 minutes.', 'error');
                    event.target.value = '';
                    return;
                }

                this.mediaType = 'video';
                this.postFile = file;
                this.selectedMedia = URL.createObjectURL(file);
                this.postFileList = [file];
                this.selectedMediaList = [this.selectedMedia];
            } else {
                this.mediaType = 'image';
                this.showToast('Processing', `Compressing ${files.length} image(s)...`, 'info');
                for (const file of files) {
                    try {
                        const compressedBlob = await this.compressImage(file);
                        const compressedFile = new File([compressedBlob], file.name, { type: 'image/jpeg' });
                        const url = URL.createObjectURL(compressedFile);
                        this.postFileList.push(compressedFile);
                        this.selectedMediaList.push(url);
                    } catch (e) {
                        const url = URL.createObjectURL(file);
                        this.postFileList.push(file);
                        this.selectedMediaList.push(url);
                    }
                }
                this.postFile = this.postFileList[0];
                this.selectedMedia = this.selectedMediaList[0];
            }
            this.saveCreatePostDraft();
            event.target.value = '';
        },
        handleEditingGroupAvatarChange(event) {
            const file = event.target.files[0];
            if (!file) return;
            this.editingGroup.avatarFile = file;
            const reader = new FileReader();
            reader.onload = (e) => {
                this.editingGroup.avatarPreview = e.target.result;
            };
            reader.readAsDataURL(file);
        },
        handleGroupAvatarChange(event) {
            const file = event.target.files[0];
            if (!file) return;
            this.newGroup.avatarFile = file;
            const reader = new FileReader();
            reader.onload = (e) => this.newGroup.avatarPreview = e.target.result;
            reader.readAsDataURL(file);
        },
         async handleOfflinePost(content, feeling, file) {
            let fileToSave = file;
            if (file && file.type.startsWith('image/')) {
                this.showToast('Offline', 'Compressing image for offline storage...', 'info');
                const compressedBlob = await this.compressImage(file);
                fileToSave = new File([compressedBlob], file.name, { type: 'image/jpeg' });
            }

            const pendingPost = {
                id: Date.now(), // Local temporary ID
                content: content,
                feeling: feeling,
                file: fileToSave, // Blobs/Files can be stored directly in IndexedDB
                csrfToken: CSRF_TOKEN,
                timestamp: Date.now()
            };

            try {
                await this.crypto.savePendingPost(pendingPost);
                this.pendingPosts.push({ ...pendingPost, pending: true, author: this.user.name, avatar: this.user.avatar, time: 'Pending Sync' });
                
                // Register Background Sync if supported
                if ('serviceWorker' in navigator && 'SyncManager' in window) {
                    const reg = await navigator.serviceWorker.ready;
                    await reg.sync.register('send-pending-posts');
                }

                this.showToast('Offline', 'Post saved! It will upload automatically when you are back online.', 'info');
                this.newPostContent = '';
                this.selectedMedia = null;
                this.isCreatingPost = false;
            } catch (err) {
                this.showToast('Error', 'Failed to save post locally.', 'error');
            }
        },
        async retrySync() {
            if (!('serviceWorker' in navigator)) return;
            const reg = await navigator.serviceWorker.ready;
            
            // 1. Re-register tags to wake up the browser sync manager
            if ('SyncManager' in window) {
                await reg.sync.register('send-pending-messages');
                await reg.sync.register('send-pending-posts');
            }

            // 2. Direct message to SW for immediate execution
            navigator.serviceWorker.controller?.postMessage({ type: 'MANUAL_SYNC' });
            this.showToast('Syncing', 'Attempting to upload pending items...', 'info');
        },
        async createPost() {
            if ((!this.newPostContent && !this.selectedMedia) || this.isUploadingPost || this.isUploadingReel) return;

            let finalContent = this.newPostContent;

            // If background style is selected and no other media is picked, bake text into a background image
            if (this.postBgStyleIndex !== -1 && !this.selectedMedia) {
                try {
                    const originalStoryIdx = this.textStoryStyleIndex;
                    this.textStoryStyleIndex = this.postBgStyleIndex;
                    // Reuse story generator logic for colorful posts
                    this.postFile = await this.generateFinalStoryImage(null, this.newPostContent, []);
                    this.mediaType = 'image';
                    this.textStoryStyleIndex = originalStoryIdx;

                    // Clear content so it's not posted twice (once at top, once in background)
                    finalContent = '';
                } catch (e) {
                    this.showToast('Error', 'Failed to generate background post.', 'error');
                    return;
                }
            }

            const isVideo = this.mediaType === 'video';
            
            const formData = new FormData();
            
            // Check for large files that might cause 502 Bad Gateway via Proxy
            if (this.postFile && this.postFile.size > 50 * 1024 * 1024) {
                this.showToast('Large File', 'Files over 50MB may fail via proxy. Please wait...', 'info');
            }

            formData.append('content', finalContent);
            formData.append('feeling', this.newPostFeeling);
            
            if (!navigator.onLine) {
                await this.handleOfflinePost(finalContent, this.newPostFeeling, this.postFile);
                return;
            }

            if (isVideo) this.isUploadingReel = true; else this.isUploadingPost = true;
            this.uploadProgress = 0;

            // Use list of files for multiple image support
            if (this.postFileList.length > 0) {
                this.postFileList.forEach(file => {
                    formData.append('media', file);
                });
            } else if (this.postFile) {
                formData.append('media', this.postFile);
            }
            if (this.editorMusic && this.editorSource === 'post') formData.append('music_track', this.editorMusic.src);

            const xhr = new XMLHttpRequest();
            xhr.open('POST', `${API_BASE_URL}/api/create_post`, true);
            xhr.setRequestHeader('X-CSRF-Token', CSRF_TOKEN);

            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable) {
                    this.uploadProgress = Math.round((e.loaded / e.total) * 100);
                    if (this.uploadProgress >= 100) this.isProcessingMetadata = true;
                }
            };

            xhr.onload = () => {
                if (xhr.status === 502 || xhr.status === 503) {
                    this.showToast('Server Error', 'The gateway is currently unavailable. Please try again in a moment.', 'error');
                    this.isUploadingPost = this.isUploadingReel = false;
                    return;
                }
                if (xhr.status === 200) {
                    const data = JSON.parse(xhr.responseText);
                    if (data && data.success) {
                        this.showToast('Success', 'Post created successfully!', 'success');
                        this.posts.unshift({ ...data.post, author: this.user.name, avatar: this.user.avatar });
                        this.newPostContent = '';
                        this.selectedMedia = null;
                        this.postBgStyleIndex = -1;
                        this.mediaType = null;
                        this.postFile = null;

                        if (isVideo) {
                            const newReel = { 
                                ...data.post, 
                                author: this.user.name, 
                                avatar: this.user.avatar, 
                                caption: data.post.content,
                                liked: false,
                                showHeart: false,
                                isLoading: true,
                                progress: 0,
                                showStatusIcon: false,
                                lastAction: '',
                                hasError: false
                            };
                            this.reels.unshift(newReel);
                            this.myReels.unshift(newReel);
                            this.activeTab = 'reels';
                            this.apiFetch('/api/get_reels').then(d => { if (d) this.reels = d; });
                            this.apiFetch(`/api/get_reels?user_id=${this.user.id.toString()}`).then(d => { if (Array.isArray(d)) this.myReels = d; });
                        } else {
                        this.isProcessingMetadata = false;
                            this.activeTab = 'home';
                        }
                        this.apiFetch('/api/get_trending').then(d => { if (d) this.trendingTopics = d; });
                        localStorage.removeItem('maiga_create_post_draft'); // Clear draft on successful post
                    } else {
                        this.showToast('Error', data.error || 'Failed to create post.', 'error');
                    }
                } else {
                    this.showToast('Error', 'Upload failed.', 'error');
                }
                this.isUploadingPost = false;
                this.isUploadingReel = false;
                this.uploadProgress = 0;
                this.isProcessingMetadata = false;
            };

            xhr.onerror = () => {
                this.showToast('Error', 'Network error.', 'error');
                this.isUploadingPost = false;
                this.isUploadingReel = false;
                this.isProcessingMetadata = false;
            };

            xhr.send(formData);
            this.isCreatingPost = false;
        },
        createGroup() {
            if (!this.newGroup.name.trim()) {
                this.showToast('Error', 'Group name is required.', 'error');
                return;
            }
            this.isSubmittingGroup = true;

            const formData = new FormData();
            formData.append('name', this.newGroup.name);
            formData.append('description', this.newGroup.description);
            formData.append('members', JSON.stringify(this.newGroup.members));
            formData.append('permissions', JSON.stringify(this.newGroup.permissions));
            formData.append('approve_members', this.newGroup.approve_members ? 1 : 0);
            if (this.newGroup.avatarFile) {
                formData.append('avatar', this.newGroup.avatarFile);
            }

            this.apiFetch('/api/create_group', {
                method: 'POST',
                headers: { 'X-CSRF-Token': CSRF_TOKEN },
                body: formData
            })
            .then(data => {
                if (data && data.success) {
                    this.groups.unshift({ ...data.group, id: data.group._id, lastMsg: 'Group created', time: 'Now', unread: false, members: this.newGroup.members, role: 'admin' });
                    this.isCreatingGroup = false;
                    this.activeChat = this.groups[0];
                    this.showToast('Success', 'Group created successfully!');
                    // Reset form
                    this.createGroupStep = 1;
                    this.newGroup = { name: '', description: '', members: [], avatarFile: null, avatarPreview: null, permissions: { can_edit_settings: false, can_send_messages: true, can_add_members: false }, approve_members: false };
                } else {
                    this.showToast('Error', data.error || 'Failed to create group.', 'error');
                }
            }).finally(() => {
                this.isSubmittingGroup = false;
            });
        },
        async sendMessage(mediaData = null, type = 'text', contentOverride = null, fileObject = null) {
            // Existing sendMessage logic

            if (!this.activeChat || this.isBlocked(this.activeChat?.id)) return;
            let content = contentOverride || this.newMessage;
            this.isSendingMessage = true;
            
            // Handle Edit
            if (this.editingMessageId) {
                await this.apiFetch('/api/edit_message', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF_TOKEN },
                    body: JSON.stringify({ message_id: this.editingMessageId, content: content, media_type: type })
                });
                this.fetchMessages(this.activeChat, false);
                this.newMessage = '';
                this.editingMessageId = null;
                this.isSendingMessage = false;

                return;
            }

            if (!content && type === 'text' && !mediaData) return;
            
            const formData = new FormData();
            formData.append('content', (type === 'text' || type === 'sticker' || type === 'call_log' || type === 'poll') ? content : '');
            formData.append('media_type', type);

            if (this.replyingTo) { // Ensure ID is string for comparison
                formData.append('reply_to_id', this.replyingTo.id);
            }

            if (this.activeChat.type === 'group') {
                formData.append('group_id', this.activeChat.id);
            } else {
                formData.append('receiver_id', this.activeChat.id);
            }

            // Handle media upload if it's not text
            // Note: For simplicity in this snippet, we assume mediaData is a base64 string for preview, 
            // but for real upload you'd attach the file object.
            // If using the file input refs or an audio blob:
            if (fileObject) {
                formData.append('media', fileObject);
            } else if (type === 'image' && this.$refs.imgInput.files[0]) {
                formData.append('media', this.$refs.imgInput.files[0]);
            } else if (type === 'video' && this.$refs.videoInput.files[0]) {
                formData.append('media', this.$refs.videoInput.files[0]);
            } else if (type === 'file' && this.$refs.fileInput.files[0]) { // Fixed: mediaData was not being handled for audio
                formData.append('media', this.$refs.fileInput.files[0]);
            }
            else if (type === 'audio' && mediaData) {
                formData.append('media', mediaData, 'voice_note.webm');
            }

            // Optimistic UI Update
            const messagePayload = {
                id: Date.now(),
                sender_id: this.user.id.toString(),
                receiver_id: this.activeChat.id,
                content: content, // This might be encrypted content or raw, careful with display
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                author: this.user.name,
                avatar: this.user.avatar,
                sender: 'me',
                type: type,
                pending: !navigator.onLine
            };
            this.chatMessages[this.activeChat.id] = [...(this.chatMessages[this.activeChat.id] || []), messagePayload];
            this.$nextTick(() => {
                const container = document.getElementById('messageContainer');
                if (container) container.scrollTo({ top: container.scrollHeight, behavior: 'auto' });
            });

            // Update chat list preview with pending state
            const chatInList = this.chats.find(c => c.id.toString() === this.activeChat.id.toString()) || this.groups.find(g => g.id.toString() === this.activeChat.id.toString());
            const now = Date.now();
            const previewText = type === 'text' ? content : `<i>Sent a ${type}</i>`;

            if (chatInList) {
                const prefix = this.activeChat.type === 'group'
                    ? `<span class="text-indigo-500 dark:text-indigo-400 font-bold">${this.user.name.split(' ')[0]}:</span> `
                    : `<span class="text-blue-600 dark:text-blue-400 font-bold">You:</span> `;
                chatInList.lastMsg = prefix + previewText;
                chatInList.lastMsgId = messagePayload.id;
                chatInList.lastMsgByMe = true;
                chatInList.lastMsgIsRead = false;
                    chatInList.lastMsgTimestamp = now;
                chatInList.time = 'Just now';
                chatInList.lastMsgTimestamp = now;
                chatInList.pending = !navigator.onLine;
            } else if (this.activeChat.type !== 'group') {
                // If it's a new chat not yet in the list, add it
                this.chats.unshift({
                    ...this.activeChat,
                    id: this.activeChat.id.toString(),
                    lastMsg: `<span class="text-blue-600 dark:text-blue-400 font-bold">You:</span> ${previewText}`,
                    lastMsgId: messagePayload.id,
                    lastMsgByMe: true,
                    lastMsgIsRead: false,
                    lastMsgTimestamp: now,
                    time: 'Just now',
                    lastMsgTimestamp: now,
                    unread: false,
                    unreadCount: 0,
                    pending: !navigator.onLine
                });
            }

            if (navigator.onLine) {
                this.apiFetch('/api/send_message', {
                    method: 'POST',
                    body: formData,
                    headers: { 'X-CSRF-Token': CSRF_TOKEN }
                }).then(data => {
                    if (data && data.success && chatInList) {
                        chatInList.lastMsgId = data.message_id.toString(); // Sync optimistic ID with DB ID
                        document.getElementById('sent-sound')?.play().catch(() => {});
                    } else if (data && data.success && !chatInList) {
                        document.getElementById('sent-sound')?.play().catch(() => {});
                    } else {
                        this.showToast('Error', 'Message failed to send.', 'error');
                    }
                }).catch(() => this.showToast('Error', 'Connection lost.', 'error'))
                .finally(() => { this.isSendingMessage = false; });
            } else if ('serviceWorker' in navigator && 'SyncManager' in window) {
                // Background Sync Logic
                const pendingMsg = {
                    chat_id: this.activeChat.id,
                    is_group: this.activeChat.type === 'group',
                    content: content,
                    media_type: type,
                    reply_to_id: this.replyingTo?.id || null,
                    timestamp: now
                };

                this.chatMessages[this.activeChat.id].find(m => m.id === messagePayload.id).pending = true;
                await this.crypto.savePendingMessage(pendingMsg);
                const reg = await navigator.serviceWorker.ready;
                await reg.sync.register('send-pending-messages');
                this.showToast('Offline', 'Message will be sent automatically when online.', 'info');
                this.isSendingMessage = false;
            } else {
                // Offline fallback when no background sync is available
                this.isSendingMessage = false;
                this.showToast('Offline', 'Message is pending and will be sent when you are back online.', 'info');
            }

            this.newMessage = '';
            this.replyingTo = null;
            // Clear draft when message is sent
            if (this.activeChat) {
                delete this.drafts[this.activeChat.id];
            }
            this.isSendingMessage = false;
        },
        sendTypingSignal: Alpine.debounce(function() { 
            if (!this.activeChat) return;
            this.socket.emit('typing', { 
                 group_id: this.activeChat.type === 'group' ? this.activeChat.id : null,
                receiver_id: this.activeChat.type !== 'group' ? this.activeChat.id : null,
                sender_id: this.user.id.toString()
            });
        }, 1000),

        sendLocation() {
            if (!navigator.geolocation) return this.showToast('Error', 'Geolocation not supported', 'error');
            this.showToast('Location', 'Fetching coordinates...', 'info');
            navigator.geolocation.getCurrentPosition(position => {
                const { latitude, longitude } = position.coords;
                const mapUrl = `https://www.google.com/maps?q=${latitude},${longitude}`;
                this.sendMessage(mapUrl, 'text', `📍 Shared Location: ${mapUrl}`);
                this.showChatOptions = false;
            }, () => this.showToast('Error', 'Unable to retrieve location', 'error'));
        },
        submitSupportTicket() {
            // Reusing the reporting modal for general support tickets
            this.openReportModal('support_ticket', { id: 'general' });
        },
        async openSupportChat() {
            // Create a support chat with admin
            const supportChat = {
                id: 'support-admin',
                name: 'Maiga Support',
                avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=MaigaSupport',
                type: 'support',
                lastMsg: 'How can we help you today?'
            };
            this.activeChat = supportChat;
            this.isMessaging = true;
        },
        handleMediaSelect(event, type) {
            const file = event.target.files[0];
            if (!file) return;
            
            this.mediaPreviewType = type;
            this.mediaPreviewFile = file;

            if (type === 'image' || type === 'video') {
                const reader = new FileReader();
                reader.onload = (e) => {
                    this.mediaPreviewUrl = e.target.result;
                };
                reader.readAsDataURL(file);
            } else {
                this.mediaPreviewUrl = 'file'; // Placeholder for non-visual files
            }
            // Clear input so same file can be selected again
            event.target.value = '';
        },
        selectWallpaper(url) {
            this.selectedWallpaper = url;
            this.customWallpaperFile = null; // Clear custom file if a template is selected
        },
        handleCustomWallpaperUpload(event) {
            const file = event.target.files[0];
            if (!file) return;
            
            const reader = new FileReader();
            reader.onload = (e) => {
                this.selectedWallpaper = e.target.result;
                this.customWallpaperFile = file;
            };
            reader.readAsDataURL(file);
            event.target.value = ''; // Clear input
        },
        applyWallpaper() {
            // Fixed: applyWallpaper was missing
            // This function applies the selected wallpaper and brightness
            // It saves the settings to local storage and updates the chat wallpaper
            localStorage.setItem('maiga_chat_wallpaper', this.selectedWallpaper);
            localStorage.setItem('maiga_chat_wallpaper_brightness', this.wallpaperBrightness);
            this.showWallpaperPicker = false;
            this.showToast('Success', 'Chat wallpaper applied!', 'success');
        },
        loadSavedWallpaper() {
            this.selectedWallpaper = localStorage.getItem('maiga_chat_wallpaper') || 'https://user-images.githubusercontent.com/15075759/28719144-86dc0f70-73b1-11e7-911d-60d70fcded21.png';
            this.wallpaperBrightness = parseInt(localStorage.getItem('maiga_chat_wallpaper_brightness') || '100', 10);
        },
        closeMediaPreview() {
            this.mediaPreviewUrl = null;
            this.mediaPreviewFile = null;
            this.mediaPreviewType = null;
        },
        sendMediaFromPreview() {
            if (!this.mediaPreviewFile) return;
            // Use the file object stored in state
            // Pass null for mediaData (base64) because we are passing fileObject
            this.sendMessage(null, this.mediaPreviewType, null, this.mediaPreviewFile);
            this.closeMediaPreview();
        },
        async toggleDisappearingMode() {
            if (!this.activeChat) return;
            const type = this.activeChat.type === 'group' ? 'group' : 'user'; // Ensure activeChat.id is string
            const data = await this.apiFetch('/api/toggle_disappearing_mode', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: this.activeChat.id, type: type })
            });
            if (data && data.success) {
                this.showToast('Success', `Disappearing messages ${data.active ? 'ON' : 'OFF'}`);
                this.showChatOptions = false;
            }
        },
        fetchMessages(chat, forceScroll = true) {
            const type = chat.type === 'group' ? 'group' : 'user';
            const chatId = chat.id.toString();
            let url = `/api/get_messages?chat_id=${chatId}&type=${type}`;
            if (this.chatSearchQuery) {
                url += `&search=${encodeURIComponent(this.chatSearchQuery)}`;
            }
            if (this.chatStarFilter) {
                url += `&starred=true`;
            }

            this.apiFetch(url)
                .then(async data => {
                    if (!data || !Array.isArray(data)) return;
                    const formattedMessages = await Promise.all(data.map(async m => {
                        let content = m.media || m.content;
                        let msgType = m.media_type || 'text';
                        // Ensure IDs are strings for consistency
                        return {
                        id: m.id.toString(),
                        sender_id: m.sender_id.toString(),
                        sender: m.sender_id.toString() === this.user.id.toString() ? 'me' : 'them',
                        type: msgType,
                        content: content,
                        created_at: m.created_at,
                        time: new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                        is_edited: !!m.is_edited,
                        pinned: !!m.is_pinned,
                        read: !!m.is_read,
                        read_by: m.read_by || [],
                        author: (m.first_name || m.author || 'User') + (m.surname ? ' ' + m.surname : ''),
                        avatar: m.avatar,
                        replyTo: m.replyTo,
                        // Poll specific data
                        question: m.question,
                        options: m.options ? m.options.map(opt => ({
                            id: opt._id || opt.id,
                            text: opt.text,
                            votes: opt.votes || [] // Ensure votes are handled correctly
                        })) : null,
                        poll_id: m.poll_id
                    }}));
                    this.chatMessages = { ...this.chatMessages, [chatId]: formattedMessages };
                    
                    data.forEach((m, idx) => {
                        this.chatMessages[chatId][idx].reactions = m.reactions || [];
                    });

                    if (forceScroll) {
                        this.$nextTick(() => {
                            const container = document.getElementById('messageContainer');
                            if (container) setTimeout(() => { container.scrollTop = container.scrollHeight; }, 50);
                        });
                    }
                });
        },
        async fetchBlockedUserDetails() {
            const data = await this.apiFetch('/api/get_blocked_user_details');
            if (data) {
                this.blockedUserDetails = data;
            }
        },
        markAsRead(chat) {
            if (!chat) return;
            const type = chat.type === 'group' ? 'group' : 'user'; // Ensure chat.id is string
            
            // Real-time 'seen' status update via socket
            this.socket.emit('mark_seen', { chat_id: chat.id, type: type });

            this.apiFetch('/api/mark_messages_read', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': CSRF_TOKEN
                }, // Ensure chat.id is string
                body: JSON.stringify({ chat_id: chat.id, type: type })
            });
            // Local update handled by polling or optimistic update if needed
            chat.unread = false;
            chat.unreadCount = 0;
            this.updateUnreadCounts();
        },
        updateUnreadCounts() {
            this.unreadGroupsCount = (this.groups || []).reduce((sum, g) => sum + (g.unreadCount || 0), 0);
            this.unreadForumsCount = (this.forumTopics || []).filter(t => t.isNew).length;
            this.unreadReportsCount = (this.reports || []).filter(r => r.status === 'open').length;
        },
        async markAllMessagesAsRead() {
            const data = await this.apiFetch('/api/mark_all_messages_read', { method: 'POST' });
            if (data?.success) {
                [...this.chats, ...this.groups].forEach(c => {
                    c.unread = false;
                    c.unreadCount = 0;
                });
                this.updateUnreadCounts();
                this.showToast('Success', 'All messages marked as read', 'success');
            }
        },
        async clearAllReports() {
            if (!confirm('Are you sure you want to dismiss all open reports? This action cannot be undone.')) return;
            this.isSubmittingReport = true;
            const data = await this.apiFetch('/api/admin/dismiss_all_reports', { method: 'POST' });
            if (data?.success) {
                this.reports = []; // Clear reports from the UI
                this.updateUnreadCounts();
                this.showToast('Success', 'All open reports dismissed.', 'success');
            } else {
                this.showToast('Error', data?.error || 'Failed to dismiss reports.', 'error');
            }
            this.isSubmittingReport = false;
        },
        async reactToMessage(emoji) {
            const msg = this.selectedMessageForOptions;
            if (!msg) return;
            this.showMessageOptions = false;

            const data = await this.apiFetch('/api/react_message', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message_id: msg.id, emoji })
            });
            if (data?.success) msg.reactions = data.reactions;
        },
        async openReactionsView(msg) {
            const data = await this.apiFetch(`/api/get_message_reactions?message_id=${msg.id}`);
            if (data) {
                this.messageReactions = data;
                this.showReactionsModal = true;
            }
        },
        markAsUnread(chat) {
            if (!chat) return;
            this.showChatOptions = false;
            this.activeChat = null; // Close chat to see the unread status
            this.isMessaging = true; // Go back to list
            
            this.apiFetch('/api/mark_chat_unread', {
                method: 'POST', // Ensure chat.id is string
                headers: { 
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': CSRF_TOKEN
                },
                body: JSON.stringify({ chat_id: chat.id })
            });
            chat.unread = true; // Optimistic update
            chat.unreadCount = 1;
        },
        sendSticker(sticker) {
            this.recordStickerUse(sticker);
            this.sendMessage(null, 'sticker', sticker);
            this.showStickerPicker = false;
            this.isSendingMessage = false;
        },
        handleSwipeStart(e, msgId) { // Ensure msgId is string for comparison
            this.swipeStart.x = e.touches[0].clientX;
            this.swipeStart.y = e.touches[0].clientY;
            this.swipingMsgId = msgId;
            this.swipeOffset = 0;
            this.touchStart(e, this.chatMessages[this.activeChat.id].find(m => m.id === msgId)); // Also trigger long press logic
        },
        handleSwipeMove(e) {
            if (!this.swipingMsgId) return;
            const dx = e.touches[0].clientX - this.swipeStart.x;
            const dy = e.touches[0].clientY - this.swipeStart.y;
            // Only allow horizontal swipe (right for reply) and prevent vertical scroll interference
            if (Math.abs(dx) > Math.abs(dy) && dx > 0 && Math.abs(dx) > 10) {
                this.swipeOffset = Math.min(dx, 80); // Cap at 80px
            }
        },
        handleSwipeEnd() {
            if (this.swipeOffset > 50) { // Threshold to trigger reply
                const msg = this.chatMessages[this.activeChat.id].find(m => m.id.toString() === this.swipingMsgId.toString());
                if (msg) this.replyToMessage(msg);
            }
            this.swipingMsgId = null;
            this.swipeOffset = 0;
            this.touchEnd();
        },
        handleChatSwipeStart(e, chatId) {
            this.swipeStart.x = e.touches[0].clientX;
            this.swipeStart.y = e.touches[0].clientY;
            this.swipingChatId = chatId;
            this.chatSwipeOffset = 0;
        },
        handleChatSwipeMove(e) {
            if (!this.swipingChatId) return;
            const dx = e.touches[0].clientX - this.swipeStart.x;
            const dy = e.touches[0].clientY - this.swipeStart.y;
            if (Math.abs(dx) > Math.abs(dy)) {
                if (e.cancelable) e.preventDefault();
                if (dx < 0) this.chatSwipeOffset = Math.max(dx, -100); // Swipe Left (Delete)
                else this.chatSwipeOffset = Math.min(dx, 100); // Swipe Right (Archive)
            }
        },
        handleChatSwipeEnd() {
            if (this.chatSwipeOffset < -70) {
                const chat = [...this.chats, ...this.groups, ...this.archivedChats].find(c => c.id.toString() === this.swipingChatId.toString());
                if (chat) this.deleteChat(chat);
            } else if (this.chatSwipeOffset > 70) {
                const chat = [...this.chats, ...this.groups, ...this.archivedChats].find(c => c.id.toString() === this.swipingChatId.toString());
                if (chat) this.markAsUnread(chat);
            }
            this.swipingChatId = null;
            this.chatSwipeOffset = 0;
        },
        touchStart(e, msg) {
            this.touchTimer = setTimeout(() => {
                this.openMessageOptions(msg);
            }, 500);
        },
        touchEnd() {
            clearTimeout(this.touchTimer);
        },
        openMessageOptions(msg) {
            this.selectedMessageForOptions = msg;
            this.showMessageOptions = true;
        },
        openMessageContextMenu(event, msg) {
            this.selectedMessageForOptions = msg;
            this.messageContextMenu.message = msg;
            this.messageContextMenu.x = event.clientX;
            this.messageContextMenu.y = event.clientY;
            this.messageContextMenu.show = true;
        },
        replyToMessage(msg = null) {
            this.replyingTo = msg || this.selectedMessageForOptions;
            this.showMessageOptions = false;
            this.$nextTick(() => document.querySelector('input[x-model="newMessage"]')?.focus());
        },
        togglePinMessage() {
            if (!this.selectedMessageForOptions || !this.activeChat) return;
            const chatId = this.activeChat.id.toString();
            const msg = this.selectedMessageForOptions;
            
            this.apiFetch('/api/toggle_pin_message', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': CSRF_TOKEN
                }, // Ensure msg.id is string
                body: JSON.stringify({ message_id: msg.id })
            }).then(() => {
                msg.pinned = !msg.pinned;
                this.showToast('Success', msg.pinned ? 'Message pinned' : 'Message unpinned');
            });

            this.showMessageOptions = false;
        },
        unpinMessage(msg) {
            if (msg) msg.pinned = false; // Ensure msg.id is string
        },
        scrollToMessage(msgId) {
            const el = document.getElementById('msg-' + msgId);
            if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                el.classList.add('bg-blue-50', 'dark:bg-blue-900/20');
                setTimeout(() => el.classList.remove('bg-blue-50', 'dark:bg-blue-900/20'), 1000);
            }
        },
        openForwardModal() {
            this.messageToForward = this.selectedMessageForOptions;
            this.showMessageOptions = false;
            this.showForwardModal = true;
        },
        forwardTo(friend) {
            if (!this.messageToForward) return; // Ensure friend.id is string
            if (!this.chatMessages[friend.id]) this.chatMessages[friend.id] = [];
            this.chatMessages[friend.id].push({
                id: Date.now(),
                sender: 'me',
                type: this.messageToForward.type,
                content: this.messageToForward.content,
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                read: false,
                forwarded: true
            });
            // Update chat list preview
            const chat = this.chats.find(c => c.id.toString() === friend.id.toString());
            if (chat) { chat.lastMsg = `Forwarded: ${this.messageToForward.type === 'text' ? this.messageToForward.content : 'Media'}`; chat.time = 'Now'; }
            this.showForwardModal = false;
            this.messageToForward = null;
            this.showToast('Sent', 'Message forwarded successfully', 'success');
        },
        blockActiveChatUser() {
            if (!this.activeChat || this.activeChat.type === 'group') return;
            // Ensure viewingUser is set so toggleBlock knows who to block
            this.viewingUser = { id: this.activeChat.id };
            this.toggleBlock();
            this.showChatOptions = false;
        },
        createPoll() {
            if (!this.newPoll.question.trim() || this.newPoll.options.filter(o => o.trim()).length < 2) {
                this.showToast('Error', 'Please enter a question and at least 2 options.', 'error');
                return; // Ensure activeChat.id is string
            }
            
            const payload = {
                question: this.newPoll.question,
                options: this.newPoll.options.filter(o => o.trim())
            };

            if (this.activeChat.type === 'group') {
                payload.group_id = this.activeChat.id;
            } else {
                payload.receiver_id = this.activeChat.id;
            }

            this.apiFetch('/api/create_poll', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': CSRF_TOKEN
                },
                body: JSON.stringify(payload)
            })
            .then(data => {
                if (data && data.success) {
                    this.fetchMessages(this.activeChat);
                    this.isCreatingPoll = false;
                    this.newPoll = { question: '', options: ['', ''] };
                } else {
                    this.showToast('Error', data.error || 'Failed to create poll', 'error');
                }
            });
        },
        votePoll(msgId, optionId) {
            // Find the message to get the poll_id
            const msg = this.chatMessages[this.activeChat.id].find(m => m.id.toString() === msgId.toString());
            if (!msg || !msg.poll_id) return;

            this.apiFetch('/api/vote_poll', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': CSRF_TOKEN
                }, // Ensure msg.poll_id and optionId are strings
                body: JSON.stringify({ poll_id: msg.poll_id, option_id: optionId })
            })
            .then(data => {
                if (data && data.success) {
                    this.fetchMessages(this.activeChat, false);
                }
            });
        },
        getTotalVotes(msg) {
            return msg.options.reduce((acc, curr) => acc + curr.votes.length, 0);
        },
        getPollPercentage(msg, optionId) {
            const total = this.getTotalVotes(msg);
            if (total === 0) return 0;
            const option = msg.options.find(o => o.id === optionId);
            return option ? Math.round((option.votes.length / total) * 100) : 0;
        },
        scheduleMessage() {
            if (!this.newMessage.trim() || !this.scheduledTime) return;
            this.scheduledMessages.push({ // Ensure activeChat.id is string
                chatId: this.activeChat.id,
                content: this.newMessage,
                type: 'text',
                dueTime: this.scheduledTime
            });
            this.newMessage = '';
            this.isSchedulingMessage = false;
            this.scheduledTime = '';
            this.showToast('Scheduled', 'Message scheduled successfully!', 'success');
        },
        sendScheduledMessage(msg, index) {
            if (!this.chatMessages[msg.chatId]) this.chatMessages[msg.chatId] = [];
            this.chatMessages[msg.chatId].push({ // Ensure msg.chatId is string
                id: Date.now(),
                sender: 'me',
                type: msg.type,
                content: msg.content,
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                read: false
            });
            
            // Update last message if this chat is in list
            const chat = this.chats.find(c => c.id.toString() === msg.chatId.toString()) || this.groups.find(g => g.id.toString() === msg.chatId.toString());
            if (chat) {
                chat.lastMsg = msg.content;
                chat.time = 'Now';
            }

            this.scheduledMessages.splice(index, 1);
            
            // If currently viewing this chat, scroll down
            if (this.activeChat && this.activeChat.id === msg.chatId) {
                this.$nextTick(() => {
                    const container = document.getElementById('messageContainer');
                    if (container) container.scrollTop = container.scrollHeight;
                });
            }
        },
        copyMessageText() {
            if (this.selectedMessageForOptions && this.selectedMessageForOptions.type === 'text') {
                navigator.clipboard.writeText(this.selectedMessageForOptions.content);
                this.showToast('Copied', 'Message copied to clipboard');
            }
            this.showMessageOptions = false;
        },
        reportMessage() {
            const msg = this.selectedMessageForOptions;
            if (!msg) return; // Ensure msg.id is string

            const reason = prompt("Why are you reporting this message? (e.g., Harassment, Spam, Hate Speech)");
            if (!reason) return;

            // For E2EE, we send the decrypted content context so admins can actually review it.
            this.apiFetch('/api/report_message', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message_id: msg.id,
                    reason: reason,
                    context: msg.content 
                })
            }).then(data => {
                if (data && data.success) {
                    this.showToast('Success', 'Message reported to administrators.', 'success');
                }
            });
            this.showMessageOptions = false;
        },
        blockAndResolveReport(report) {
            if (!confirm(`Are you sure you want to block ${report.reported_user.name} and resolve this report?`)) return;
            // Ensure report.id and user_id are strings
            this.apiFetch('/api/admin/block_and_resolve_report', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    report_id: report.id,
                    user_id: report.reported_user.id || report.reported_user._id
                })
            }).then(data => {
                if (data && data.success) {
                    this.reports = this.reports.filter(r => r.id !== report.id);
                    this.updateUnreadCounts();
                    this.showToast('Success', 'User blocked and report resolved.', 'success');
                }
            });
            this.showMessageOptions = false;
        },
        editMessage() {
            const msg = this.selectedMessageForOptions;
            if (!msg || msg.type !== 'text') return; // Ensure msg.id is string
            
            this.newMessage = msg.content;
            this.editingMessageId = msg.id;
            this.showMessageOptions = false;
            // Focus input
            this.$nextTick(() => document.querySelector('input[x-model="newMessage"]').focus());
        },
        deleteMessage(mode) {
            if (!this.selectedMessageForOptions || !this.activeChat) return;
            if (!confirm(mode === 'everyone' ? 'Delete for everyone?' : 'Delete for me?')) return;

            const chatId = this.activeChat.id.toString();
            const msgId = this.selectedMessageForOptions.id;

            this.apiFetch('/api/delete_message', {
                    method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': CSRF_TOKEN
                }, // Ensure msgId is string
                body: JSON.stringify({ message_id: msgId, mode: mode })
            })
            .then(data => {
                if (data && data.success) {
                    if (this.chatMessages[chatId]) {
                        this.chatMessages[chatId] = this.chatMessages[chatId].filter(m => m.id !== msgId);
                    }
                    this.showToast('Success', 'Message deleted');
                } else {
                    this.showToast('Error', data.error || 'Failed to delete');
                }
            });

            this.showMessageOptions = false;
        },
        openComments(item, type) {
        // Stop all video playback to prevent background audio from interfering with voice notes
        document.querySelectorAll('video').forEach(v => v.pause());

            this.fetchComments(item.id.toString(), item.user_id.toString()); // Ensure IDs are strings
            if (this.viewingComments) {
                this.viewingComments.type = type;
            }
        },
    closeComments() {
        this.viewingComments = null;
        // Automatically resume video playback for visible elements
        this.$nextTick(() => {
            document.querySelectorAll('video').forEach(v => {
                const rect = v.getBoundingClientRect();
                const isVisible = rect.top < window.innerHeight && rect.bottom > 0;
                // Only resume if it's visible and not part of the story viewer
                if (isVisible && !v.classList.contains('story-video')) {
                    v.play().catch(() => {});
                }
            });
        });
    },
        fetchComments(postId, postAuthorId) {
            this.viewingComments = { id: postId, type: 'post', list: [], post_author_id: postAuthorId };
            this.apiFetch(`/api/get_comments?post_id=${postId}`)
                .then(data => { // Ensure postId is string
                    if (this.viewingComments && this.viewingComments.id === postId) {
                        this.viewingComments.list = data || [];
                    }
                });
        },
        addComment(contentOrBlob = null, type = 'text') {
            if ((!this.commentInput.trim() && !contentOrBlob) || !this.viewingComments) return;
            
            const formData = new FormData(); formData.append('post_id', this.viewingComments.id.toString()); // Ensure ID is string
            if (this.replyingToComment) {
                formData.append('parent_comment_id', this.replyingToComment.id);
            }
            
            if (type === 'audio') {
                formData.append('media', contentOrBlob, 'comment_audio.webm');
                formData.append('media_type', 'audio');
            } else if (type === 'sticker') {
                formData.append('content', contentOrBlob);
                formData.append('media_type', 'sticker');
            } else {
                formData.append('content', this.commentInput);
                formData.append('media_type', 'text');
            }

            this.apiFetch('/api/add_comment', {
                method: 'POST',
                body: formData,
                headers: {
                    'X-CSRF-Token': CSRF_TOKEN
                }
            })
            .then(data => {
                if (data && data.success) { // Optimistic Update for instant feedback
                    const newComment = {
                        id: data.comment_id,
                        user_id: this.user.id,
                        content: data.content,
                        media: data.media,
                        media_type: data.media_type,
                        created_at: new Date().toISOString(),
                        author: this.user.name,
                        avatar: this.user.avatar,
                        text: data.content,
                        time: 'Just now',
                        replies: [],
                        parent_comment_id: this.replyingToComment ? this.replyingToComment.id : null
                    };

                    if (this.replyingToComment) {
                        const parent = this.viewingComments.list.find(c => c.id.toString() === this.replyingToComment.id.toString());
                        if (parent) {
                            if (!parent.replies) parent.replies = [];
                            parent.replies.push(newComment);
                        } else {
                            this.viewingComments.list.push(newComment);
                        }
                    } else {
                        this.viewingComments.list.push(newComment);
                    }

                    const item = this.viewingComments.type === 'post' 
                        ? this.posts.find(p => p.id.toString() === this.viewingComments.id.toString())
                        : this.reels.find(r => r.id.toString() === this.viewingComments.id.toString());
                    if(item) item.comments = (item.comments || 0) + 1;

                } else {
                    this.showToast('Error', data.error || 'Failed to add comment.', 'error');
                }
            })
            .catch(err => {
                this.showToast('Error', 'Could not send comment. Please check your connection.', 'error');
            })
            .finally(() => {
                this.commentInput = '';
                this.replyingToComment = null;
                this.isSendingComment = false;
            });
        },
        sendCommentSticker(sticker) {
            this.addComment(sticker, 'sticker');
            this.showCommentStickers = false;
        },
        async startCommentRecording() {
            if (this.isRecordingComment) return;
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true } });
                this.commentMediaRecorder = new MediaRecorder(stream);
                this.commentAudioChunks = [];
                this.commentMediaRecorder.addEventListener("dataavailable", event => {
                    // Fixed: commentAudioChunks was not being used
                    this.commentAudioChunks.push(event.data);
                });
                this.commentMediaRecorder.onstop = () => {
                    cancelAnimationFrame(this.recordAnimationId);
                    const audioBlob = new Blob(this.commentAudioChunks, { type: 'audio/webm' });
                    this.addComment(audioBlob, 'audio'); // Pass blob to addComment
                    this.commentAudioChunks = [];
                    stream.getTracks().forEach(track => track.stop());
                };
                this.commentMediaRecorder.start();
                this.visualizeStream(stream, 'comment-record-waveform');
                this.isSendingComment = true; // Disable post button while recording
                this.isRecordingComment = true;
                this.commentRecordingDuration = 0;
                this.commentRecordingTimer = setInterval(() => { this.commentRecordingDuration++; }, 1000);
            } catch (err) {
                this.isSendingComment = false; // Fixed: Reset on error
                this.showToast('Error', 'Could not access microphone. Check permissions.', 'error');
            }
        },
        stopCommentRecording() {
            if (!this.isRecordingComment || !this.commentMediaRecorder) return;
            this.commentMediaRecorder.stop();
            cancelAnimationFrame(this.recordAnimationId);
            this.isRecordingComment = false;
            clearInterval(this.commentRecordingTimer);
            
        },
        deleteComment(commentId) {
            if (!confirm('Delete this comment?')) return;
            this.apiFetch('/api/delete_comment', { // Ensure commentId is string
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ comment_id: commentId })
            })
            .then(data => {
                if (data && data.success) {
                    this.fetchComments(this.viewingComments.id, this.viewingComments.post_author_id);
                }
            });
        },
        startReportChat(report) {
            // This is a placeholder. In a real app, you'd open a chat with a support agent.
            const chat = {
                id: 'report-' + report.id,
                name: `Help Center: ${report.reporter.name}`,
                avatar: report.reporter.avatar,
                lastMsg: report.details
            };
            this.activeChat = chat;
        },
        openShareModal(post) {
            this.sharingPost = post;
            this.showShareModal = true;
        },
        sharePost() { // Ensure sharingPost.id is string
            if (!this.sharingPost) return;
            this.apiFetch('/api/share_post', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': CSRF_TOKEN
                },
                body: JSON.stringify({ post_id: this.sharingPost.id.toString() })
            })
            .then(data => {
                if (data && data.success) {
                    this.showToast('Success', 'Post shared to your feed!', 'success');
                    this.showShareModal = false;
                    
                    // Update original post/reel share count (ensure string comparison)
                    const post = this.posts.find(p => p.id === this.sharingPost.id);
                    if (post) post.shares++;
                    
                    const reel = this.reels.find(r => r.id === this.sharingPost.id);
                    if (reel) this.triggerShareAnimation(reel);
                }
            });
        },
        sharePostToStory() {
            if (!this.sharingPost) return; // Ensure sharingPost.id is string
            this.myStories.push({
                id: Date.now(),
                type: this.sharingPost.media_type || 'text',
                media: this.sharingPost.media || this.sharingPost.avatar,
                time: Date.now(),
                seenBy: [],
                audience: 'public',
                hasMusic: false
            });
            this.showShareModal = false;
            this.sharingPost.shares++;
            this.showToast('Shared', 'Post shared to your story!', 'success');
        },
        async copyPostLink() {
            if (!this.sharingPost) return; // Ensure sharingPost.id is string
            const url = `${window.location.origin}/post/${this.sharingPost.id}`;
            await navigator.clipboard.writeText(url);
            this.showToast('Copied', 'Link copied to clipboard!', 'success');
            
            this.apiFetch('/api/increment_share', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ post_id: this.sharingPost.id.toString() })
            });

            this.triggerShareAnimation(this.sharingPost);
            this.showShareModal = false;
        },
        triggerShareAnimation(item) {
            item.shares++;
            item.isAnimatingShare = true;
            if (navigator.vibrate) navigator.vibrate(10);
            setTimeout(() => { item.isAnimatingShare = false; }, 1000);
        },
        handleReelClick(reel, event) {
            if (this.isSpeedingUp) {
                return;
            }
            const now = Date.now();
            if (now - this.lastReelClick < 300) {
                clearTimeout(this.reelClickTimer);

                // Stop the hint timer if the user is interacting
                clearTimeout(this.reelHintTimer);
                this.showSwipeHint = false;

                // 1. Capture coordinates immediately before async nextTick call.
                // Browser nullifies event.currentTarget after handler execution.
                const rect = event.currentTarget.getBoundingClientRect();
                const x = (event.clientX || event.touches?.[0]?.clientX) - rect.left;
                const y = (event.clientY || event.touches?.[0]?.clientY) - rect.top;

                // 2. Re-trigger animation
                reel.showHeart = false;
                this.$nextTick(() => {
                    reel.showHeart = true;
                    reel.heartX = x;
                    reel.heartY = y;
                    if (navigator.vibrate) navigator.vibrate(30);
                    clearTimeout(reel.heartTimer);
                    reel.heartTimer = setTimeout(() => reel.showHeart = false, 800);
                });

                // 3. Only count the like once (TikTok logic: double tap doesn't unlike)
                if (!reel.liked) { // Ensure reel.id is string
                    this.likeReel(reel);
                }
            } else {
                // Single tap (wait to see if it's double)
                this.reelClickTimer = setTimeout(() => {
                    const video = document.getElementById('reel-video-' + reel.id);
                    if (video) {
                        const isPaused = video.paused;
                        isPaused ? video.play().catch(error => console.error("Playback error:", error)) : video.pause();
                        reel.lastAction = isPaused ? 'play' : 'pause';
                        reel.showStatusIcon = true;
                        setTimeout(() => reel.showStatusIcon = false, 800);
                    }
                }, 300);
            }
            this.lastReelClick = now;
        },

         handleReelWheel(e) {
            if (this.isScrollingReel) return;
            this.isScrollingReel = true;
            const direction = e.deltaY > 0 ? 1 : -1;
            this.scrollReel(direction);
            setTimeout(() => { this.isScrollingReel = false; }, 600);
       
        },
        handleReelTouchStart(e) {
        this.reelTouchStartY = e.touches[0].clientY;
    },
    handleReelTouchEnd(e) {
        const touchEndY = e.changedTouches[0].clientY;
        const deltaY = this.reelTouchStartY - touchEndY;
        if (Math.abs(deltaY) > 50) {
            this.scrollReel(deltaY > 0 ? 1 : -1);
        }
    },

        startReelHold(reel) {
            this.reelForwardSearchQuery = '';
            this.selectedReel = reel;
            // 1. Long Press Menu timer (TikTok style)
            this.reelMenuTimer = setTimeout(() => {
                if (!this.isSpeedingUp) {
                    this.showReelMenu = true;
                    if (navigator.vibrate) navigator.vibrate([50, 30, 50]);
                }
            }, 700); // 700ms for menu

            // 2. 2x Speed timer
            this.speedTimer = setTimeout(() => { // Ensure reel.id is string
                const video = document.getElementById('reel-video-' + reel.id);
                if (video && !this.showReelMenu) {
                    video.playbackRate = 2;
                    this.isSpeedingUp = true;
                    if (navigator.vibrate) navigator.vibrate(50);
                }
            }, 500); // Start speeding up slightly before menu potentially pops
        },

        stopReelHold(reel) {
            clearTimeout(this.speedTimer);
            clearTimeout(this.reelMenuTimer);
            if (this.isSpeedingUp) {
                const video = document.getElementById('reel-video-' + reel.id);
                if (video) video.playbackRate = 1;
                // Small delay before resetting flag to allow handleReelClick to catch it
                setTimeout(() => { this.isSpeedingUp = false; }, 100);
            }
        },

        sendReelForward(person, reel) {
            if (!person || !reel) return;
            const msg = `Check out this reel from @${reel.author}: ${reel.media}`;
            this.sendMessage(reel.media, 'video', `Check out this reel:`, null); // Sending video type message
            this.showToast('Forwarded', `Sent to ${person.name.split(' ')[0]}`, 'success');
        },

        startVolumeLongPress() {
            this.volumeLongPressTimer = setTimeout(() => {
                this.showVolumeSlider = true;
                if (navigator.vibrate) navigator.vibrate(50);
            }, 600);
        },
        openUserStory(userId) {
            if (!userId) return;
            if (userId == this.user.id && this.myStories.length > 0) return this.viewStory(this.myStories);
            
            const creator = this.following.find(f => f.id == userId);
            if (creator && creator.stories.length > 0) {
                this.viewStory(creator.stories, creator);
            }
        },
        endVolumeLongPress() {
            clearTimeout(this.volumeLongPressTimer);
        },
        updateReelVolume() {
            if (this.reelVolume > 0) { // Ensure reel.id is string
                this.isReelsMuted = false;
                this.hasInteractedWithVolume = true;
            }
        },
        // Specifically for double-tap (Add only)
        likeReel(reel) {
            if (reel.liked) return;
            
            // Trigger haptic feedback (Success vibration)
            if (navigator.vibrate) navigator.vibrate([30, 50, 30]);

            reel.liked = true;
            reel.likes++;

            this.apiFetch('/api/toggle_reaction', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': CSRF_TOKEN
                },
                body: JSON.stringify({ post_id: reel.id.toString(), reaction: 'like' })
            }).catch(() => {
                // Revert on network failure
                reel.liked = false;
                reel.likes--;
            });
        },

        async markNotificationsRead() {
            if (this.unreadNotificationsCount === 0) return;
            this.notifications.forEach(n => n.is_read = true);
            await this.apiFetch('/api/mark_notifications_read', { // Ensure notification IDs are strings
                method: 'POST'
            });
        },
        get unreadNotificationsCount() {
            return (this.notifications || []).filter(n => !n.is_read).length;
        },
        get missedCallsCount() {
            return (this.callHistory || []).filter(c => c.status === 'missed' || c.is_missed || c.type === 'missed').length;
        },
        get activeChatPinnedMsg() {
            const messages = this.chatMessages?.[this.activeChat?.id] || [];
            return messages.find(m => m.pinned || m.is_pinned) || null;
        },
        get starredMessagesInActiveChat() {
            return (this.chatMessages?.[this.activeChat?.id] || []).filter(m => m.starred || m.is_starred);
        },
        get didYouMeanFriend() {
            return (this.searchSuggestions || []).find(item => item.type === 'user') || null;
        },

        get homePosts() {
            return this.posts;
        },
        get totalUnreadChats() {
            const chatUnread = (this.chats || []).reduce((sum, c) => sum + (c.unreadCount || 0), 0);
           return chatUnread + this.unreadGroupsCount;
        },
        getChatTimestamp(chat) {
            if (!chat) return 0;
            if (typeof chat.lastMsgTimestamp === 'number') return chat.lastMsgTimestamp;
            const timeField = chat.lastMsgTimestamp || chat.last_message_time || chat.updated_at || chat.created_at || chat.time;
            if (typeof timeField === 'number' && !isNaN(timeField)) return timeField;
            if (typeof timeField === 'string') {
                const normalized = timeField.trim();
                if (normalized === 'Just now' || normalized === 'Now') return Date.now();
                const parsed = Date.parse(normalized);
                if (!isNaN(parsed)) return parsed;
            }
            return 0;
        },
        get sortedChats() {
           let all = [...(this.chats || []), ...(this.groups || [])].filter(Boolean);
            if (this.showOnlyUnread) {
                all = all.filter(c => c.unreadCount > 0);
            }

            if (this.chatListSearchQuery && this.chatListSearchQuery.trim()) {
                const q = this.chatListSearchQuery.toLowerCase();
                all = all.filter(c => {
                    const nameMatch = c.name && c.name.toLowerCase().includes(q);
                    // Strip HTML tags (like "You:") before searching message content
                    const cleanMsg = (c.lastMsg || '').replace(/<[^>]*>?/gm, '').toLowerCase();
                    const msgMatch = cleanMsg.includes(q);
                    return nameMatch || msgMatch;
                });
            }         
               return all.sort((a, b) => {
                 const aPinned = this.isPinned(a.id, a.type || 'user');
                const bPinned = this.isPinned(b.id, b.type || 'user');
                if (aPinned && !bPinned) return -1;
                if (!aPinned && bPinned) return 1;
            
                // Prioritize unread messages
                if (a.unread && !b.unread) return -1;
                if (!a.unread && b.unread) return 1;
            
                // Then sort by timestamp
                const aTimestamp = this.getChatTimestamp(a);
                const bTimestamp = this.getChatTimestamp(b);
                return bTimestamp - aTimestamp;
            });
        },
        get onlineContacts() {
            // Sort online contacts by last message timestamp to show most active first
            // Filter out groups from online contacts
            return (this.chats || []).filter(chat => chat.status === 'online' && chat.type !== 'group').slice(0, 10);
        },
        searchUsers() {
            this.searchResults = [];
            this.searchPostsResults = [];
            this.searchReelsResults = [];
            this.searchSuggestions = [];
            if (this.homeSearchQuery.length < 2) {
                return;
            }
            this.addToRecent(this.homeSearchQuery);
            this.fetchGlobalSuggestions();
              
            if (this.homeSearchTab === 'users') {
                this.apiFetch(`/api/search_users?q=${encodeURIComponent(this.homeSearchQuery)}`)
                    .then(data => { if (data) this.searchResults = data; });
            } else if (this.homeSearchTab === 'posts') {
                this.apiFetch(`/api/search_posts?q=${encodeURIComponent(this.homeSearchQuery)}`)
                    .then(data => { if (data) this.searchPostsResults = data; });
            } else if (this.homeSearchTab === 'reels') {
                this.apiFetch(`/api/search_reels?q=${encodeURIComponent(this.homeSearchQuery)}`)
                    .then(data => { if (data) this.searchReelsResults = data; });
            }
        },
        setSearchTab(tab) {
            this.homeSearchTab = tab;
            if (this.homeSearchQuery.length >= 2) {
                this.searchUsers();
            }
        },
        async fetchGlobalSuggestions() {
            const q = encodeURIComponent(this.homeSearchQuery);
            const [u, p, r] = await Promise.all([
                this.apiFetch(`/api/search_users?q=${q}`).then(res => (res || []).slice(0, 2).map(i => ({...i, type: 'user'}))),
                this.apiFetch(`/api/search_posts?q=${q}`).then(res => (res || []).slice(0, 2).map(i => ({...i, type: 'post'}))),
                this.apiFetch(`/api/search_reels?q=${q}`).then(res => (res || []).slice(0, 2).map(i => ({...i, type: 'reel'})))
            ]);
            this.searchSuggestions = [...u, ...p, ...r]; // Ensure IDs are strings
        },
        get recommendedSearchTerms() {
            // Fallback suggestions when no results are found
            return [
                { term: 'Campus News', icon: 'fa-newspaper' },
                { term: 'Exam Schedule', icon: 'fa-calendar-days' },
                { term: 'Sports Club', icon: 'fa-trophy' }
            ];
        },
        clearRecentSearches() {
            this.recentSearches = [];
            localStorage.removeItem('maiga_recent_searches');
        },
        addToRecent(term) {
            if (!term || term.trim() === "" || term.length < 3) return;
            this.recentSearches = [term, ...this.recentSearches.filter(t => t !== term)].slice(0, 5);
            localStorage.setItem('maiga_recent_searches', JSON.stringify(this.recentSearches));
        },
        openUserProfileByName(name) {
            // Search by username
            const user = this.friends.find(f => f.username && f.username.toLowerCase() === name.toLowerCase()); // Ensure user.id is string
            if (user) {
                this.openUserProfile(user);
            } else {
                // Fallback to API search if not in local list
                this.apiFetch(`/api/search_users?q=${encodeURIComponent(name)}`)
                    .then(data => {
                        const foundUser = data && data.find(u => u.username && u.username.toLowerCase() === name.toLowerCase());
                        if (foundUser) {
                            this.openUserProfile(foundUser.id);
                        } else {
                            this.showToast('User not found', `Could not find user @${name}`, 'error');
                        }
                    });
            }
        },
        async clearCallHistory() {
            if (!confirm('Clear all call logs?')) return;
            const data = await this.apiFetch('/api/clear_call_history', { method: 'POST' }); // Ensure call IDs are strings
            if (data?.success) this.callHistory = [];
        },
        callback(call) {
            const otherUser = call.caller._id == this.user.id ? call.receiver : call.caller;
            this.activeChat = { id: otherUser._id, name: otherUser.name, avatar: otherUser.avatar };
            this.startCall(call.type);
        },
        async deleteCallLog(callId) {
            const data = await this.apiFetch('/api/delete_call_log', {
                method: 'POST', // Ensure callId is string
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ call_id: callId })
            });
            if (data?.success) this.callHistory = this.callHistory.filter(c => c._id !== callId);
        },
        async handleNotificationClick(notif) {
            this.apiFetch('/api/mark_notifications_read', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ notification_ids: [notif.id.toString()] })
            });
            notif.is_read = true;
            
            if (notif.type === 'like' || notif.type === 'mention') {
                const post = await this.apiFetch(`/api/get_post?post_id=${notif.post_id || notif.related_id}`);
                if (post) this.viewingPost = post;
            } else if (notif.type === 'follow') {
                this.openUserProfile(notif.trigger_user_id);
            }
        },
        downloadEditedMedia() {
            const a = document.createElement('a');
            a.href = this.editorPreviewUrl;
            a.download = `edited_maiga_${Date.now()}.jpg`;
            a.click();
        },
        cancelCrop() { this.stopCrop(); },
        openHashtag(tag) {
            this.activeHashtag = tag;
            this.activeTab = 'home';
            this.homeSearchTab = 'posts';
            this.homeSearchQuery = '#' + tag;
            this.refreshHomeFeed(false);
            this.showToast('Filtering', `Showing posts for #${tag}`, 'info');
        },
        formatRecordingTime(seconds) {
            const m = Math.floor(seconds / 60);
            const s = seconds % 60;
            return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
        },
        async startRecording() {
            if (this.isRecording || !this.activeChat || this.isBlocked(this.activeChat.id)) return;
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true } });
                this.mediaRecorder = Alpine.raw(new MediaRecorder(stream));
                this.audioChunks = [];
                this.mediaRecorder.addEventListener("dataavailable", event => {
                    this.audioChunks.push(event.data);
                });
                this.mediaRecorder.onstop = () => {
                    cancelAnimationFrame(this.recordAnimationId);
                    const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' });
                    this.sendMessage(audioBlob, 'audio');
                    this.audioChunks = [];
                    stream.getTracks().forEach(track => track.stop());
                };
                this.mediaRecorder.start();
                this.visualizeStream(stream, 'post-record-waveform');
                this.isRecording = true;
                this.recordingDuration = 0;
                this.recordingTimer = setInterval(() => { this.recordingDuration++; }, 1000);
            } catch (err) {
                this.isSendingPost = false; // Ensure reset on error
                this.showToast('Error', 'Could not access microphone. Check permissions.', 'error');
            }
        },
        stopRecording() {
            if (!this.isRecording || !this.mediaRecorder) return;
            this.mediaRecorder.stop();
            cancelAnimationFrame(this.recordAnimationId);
            this.isRecording = false;
            clearInterval(this.recordingTimer);
        },
        async startPostRecording() {
            if (this.isRecordingPost || this.isSendingPost) return;
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true } });
                this.postMediaRecorder = Alpine.raw(new MediaRecorder(stream));
                this.postAudioChunks = [];
                this.postMediaRecorder.ondataavailable = e => this.postAudioChunks.push(e.data);
                this.postMediaRecorder.onstop = () => {
                    cancelAnimationFrame(this.recordAnimationId);
                    const blob = new Blob(this.postAudioChunks, { type: 'audio/webm' });
                    this.postFile = new File([blob], `voice_post_${Date.now()}.webm`, { type: 'audio/webm' });
                    this.mediaType = 'audio';
                    this.selectedMedia = URL.createObjectURL(blob);
                    this.saveCreatePostDraft();
                    this.postAudioChunks = [];
                    stream.getTracks().forEach(t => t.stop());
                };
                this.postMediaRecorder.start();
                this.visualizeStream(stream, 'post-record-waveform');
                this.isRecordingPost = true;
                this.postRecordingDuration = 0;
                this.postRecordingTimer = setInterval(() => this.postRecordingDuration++, 1000);
            } catch (e) { this.showToast('Error', 'Mic access failed', 'error'); }
        },
        stopPostRecording() {
            if (!this.isRecordingPost || !this.postMediaRecorder) return;
            this.postMediaRecorder.stop();
            this.isRecordingPost = false;
            clearInterval(this.postRecordingTimer);
        },
        saveProfile() {
             const formData = new FormData(); // Fixed: user.nickname to user.name
            formData.append('name', this.editUser.name);
            formData.append('username', this.editUser.username);
            formData.append('gender', this.editUser.gender);
            formData.append('bio', this.editUser.bio || '');
            
            this.isSavingProfile = true; // Disable button
            const avatarFile = this.avatarFileToUpload || this.$refs.profileAvatarInput.files[0];
            if (avatarFile) {
                formData.append('avatar', avatarFile);
            }
            
            const bannerFile = this.bannerFile || this.$refs.profileBannerInput.files[0];
            if (bannerFile) {
                formData.append('banner', bannerFile);
            }


            this.apiFetch('/api/update_profile', {
                method: 'POST',
                body: formData,
                headers: {
                    'X-CSRF-Token': CSRF_TOKEN
                }
            }).then(data => {
                if (data && data.success) {
                    this.showToast('Success', 'Profile updated successfully.');
                    // Refresh user data to get new avatar URL if changed
                    
                    this.apiFetch(`/api/get_user?t=${Date.now()}`) // Cache-bust avatar refresh
                        .then(userData => {
                            if(userData) {
                                this.user = { ...this.user, ...userData };
                                if (userData.first_name && userData.surname) {
                                    this.user.name = userData.first_name + ' ' + userData.surname;
                                }
                                this.editUser = { ...this.user };
                            }
                        });
                    this.isEditingProfile = false;
                } else {
                    this.showToast('Error', data?.error || 'Failed to update profile.', 'error');
                }
            }).finally(() => {
                this.isSavingProfile = false;
            })
            .catch(err => {
                this.showToast('Error', 'Network error.', 'error');
            });
        },

        async deleteProfilePicture() {
            const data = await this.apiFetch('/api/delete_profile_picture', { method: 'POST' });
            if (data?.success) {
                this.showToast('Success', 'Profile picture deleted.', 'success');
                this.viewingPost = null;
                this.editUser.avatar = (this.user.gender === 'female' ? '/img/female.png' : '/img/male.png');
                // Refresh user data to get new avatar URL if changed
                this.apiFetch(`/api/get_user?t=${Date.now()}`)
                    .then(userData => {
                        if(userData) {
                            this.user = { ...this.user, ...userData };
                            this.editUser = { ...this.user };
                        }
                    });
            } else {
                this.showToast('Error', data?.error || 'Failed to delete.', 'error');
            }
        },

        toggleReelLike(reel) {
            // Optimistic update
            reel.liked = !reel.liked;
            reel.likes += reel.liked ? 1 : -1;
            if (reel.liked) reel.showHeart = true;
            if (reel.showHeart) setTimeout(() => reel.showHeart = false, 600);

            this.apiFetch('/api/toggle_reaction', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': CSRF_TOKEN
                },
                body: JSON.stringify({ post_id: reel.id, reaction: 'like' })
            })
            .then(data => {
                if (!data || !data.success) {
                    // Revert optimistic update on failure
                    reel.liked = !reel.liked;
                    reel.likes += reel.liked ? 1 : -1;
                    this.showToast('Error', 'Could not save like.', 'error');
                }
            })
            .catch(err => {
                // Revert optimistic update on network error
                reel.liked = !reel.liked;
                reel.likes += reel.liked ? 1 : -1;
                this.showToast('Error', 'Network error. Could not save like.', 'error');
            });
        },
        saveReel(reel) {
            this.toggleSave(reel);
            this.showReelOptions = false;
        },
        savePost(post) {
            this.toggleSave(post);
            this.showPostOptions = false;
        },
        async downloadMediaUrl(url, filename) {
            if (!url) return;
            try {
                const response = await fetch(url, { mode: 'cors' });
                if (!response.ok) throw new Error('Download failed');

                const blob = await response.blob();
                const objectUrl = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = objectUrl;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
                this.showToast('Downloading', 'Download started...', 'success');
            } catch (err) {
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                this.showToast('Downloading', 'Download started (fallback).', 'success');
            }
        },
        async downloadReel(reel) {
            if (!reel?.media) return;
            await this.downloadMediaUrl(reel.media, `reel_${reel.id}.mp4`);
            this.showReelOptions = false;
        },
        async downloadPostMedia(post) {
            if (!post?.media) return;
            const ext = post.mediaType === 'video' ? 'mp4' : 'jpg';
            await this.downloadMediaUrl(post.media, `post_${post.id}.${ext}`);
            this.showPostOptions = false;
        },
        markInterested(reel) {
            this.showToast('Feedback', 'Thanks! We will show more like this.', 'success');
            this.showReelOptions = false;
        },
        
        async changePassword() {
            this.isChangingPassword = true;
            if (!this.passwordForm.current || !this.passwordForm.new || !this.passwordForm.confirm) {
                this.showToast('Error', 'Please fill in all fields.', 'error');
                return;
            }
            if (this.passwordForm.new !== this.passwordForm.confirm) {
                this.showToast('Error', 'New passwords do not match.', 'error');
                return;
            }
            if (this.passwordForm.new.length < 6) {
                this.showToast('Error', 'Password must be at least 6 characters.', 'error');
                return;
            }

            // Fixed: change_password route was missing
            // This route is now in auth.js
            const data = await this.apiFetch('/api/change_password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    current_password: this.passwordForm.current,
                    new_password: this.passwordForm.new
                })
            })
            .then(data => {
                if (data && data.success) {
                    this.showToast('Success', 'Password changed successfully.');
                    this.passwordForm = { current: '', new: '', confirm: '' };
                    this.activeTab = 'settings';
                } else {
                    this.isChangingPassword = false;
                    this.showToast('Error', data.error || 'Failed to change password.', 'error');
                }
            })
            .catch(err => {
                this.showToast('Error', 'Network error.', 'error');
            });
        },
        get savedPosts() {
            // Use the dedicated savedPostList if available, otherwise fallback to filtering
            return this.savedPostList.length > 0 ? this.savedPostList : this.posts.filter(p => p.saved);
        },
        fetchSavedPosts() {
            this.apiFetch('/api/saved_posts')
                .then(data => {
                    if (Array.isArray(data)) this.savedPostList = data;
                }); // Fixed: savedPosts getter was not using savedPostList
        },
        fetchCallHistory() {
            this.apiFetch('/api/get_call_history')
                .then(data => {
                    if (Array.isArray(data)) this.callHistory = data;
                });
        },
        get userPosts() {
            return this.myPosts;
        },
        addToRecent(term) {
            if (!term) return;
            this.recentSearches = this.recentSearches.filter(t => t !== term);
            this.recentSearches.unshift(term);
            if (this.recentSearches.length > 5) this.recentSearches.pop();
            },
        redial() {
            if (!this.lastBusyCall) return;
            this.startCall(this.lastBusyCall.type);
            this.lastBusyCall = null;  
        },
        toggleSelectAll() {
            if (this.newGroup.members.length === this.filteredFollowingForGroup.length) {
                this.newGroup.members = [];
            } else {
                this.newGroup.members = this.filteredFollowingForGroup.map(f => f.id);
            }
        },
        toggleNewGroupMember(friendId) {
            const index = this.newGroup.members.indexOf(friendId);
            if (index > -1) {
                this.newGroup.members.splice(index, 1);
            } else {
                this.newGroup.members.push(friendId);
            }
        },
        deleteGroup(groupId) {
            if (!confirm('Are you sure you want to delete this group? This action cannot be undone.')) return; // Fixed: deleteGroup route was missing
            
            this.apiFetch('/api/delete_group', {
                    method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ group_id: groupId })
            })
            .then(data => {
                if (data && data.success) {
                    this.groups = this.groups.filter(g => g.id !== groupId);
                    this.updateUnreadCounts();
                    this.activeChat = null;
                    this.showGroupInfo = false;
                    this.showToast('Success', 'Group deleted successfully.', 'success');
                } else {
                    this.showToast('Error', data.error || 'Failed to delete group.', 'error');
                }
            });
        },
        postReply() {
            if (!this.replyContent.trim()) return;
            this.selectedTopic.repliesList.push({
                id: Date.now(),
                author: this.user.name,
                text: this.replyContent,
                time: 'Just now'
            });
            this.selectedTopic.replies++;
            this.replyContent = '';
        },
        deleteReply(reply) {
            this.selectedTopic.repliesList = this.selectedTopic.repliesList.filter(r => r.id !== reply.id);
            this.selectedTopic.replies--;
        },
        toggleLike(reply) {
            reply.liked = !reply.liked; // Fixed: toggleLike was not connected to backend
            reply.likes = reply.likes || 0;
            reply.likes += reply.liked ? 1 : -1;
        },
        revokeGroupInviteLink(group) {
            if (!confirm('Are you sure you want to revoke this invite link? The old link will no longer work.')) return;

            this.apiFetch('/api/revoke_group_invite_link', {
                method: 'POST', // Fixed: toggleGroupInviteLink route was missing
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF_TOKEN },
                body: JSON.stringify({ group_id: group.id })
            })
            .then(res => res.json())
            .then(data => {
                if (data.success) {
                    group.invite_link_code = data.new_code;
                    this.showToast('Success', 'Invite link has been revoked and a new one generated.');
                } else {
                    this.showToast('Error', data.error || 'Failed to revoke link.', 'error');
                }
            });
        },
        handleMemberClick(member) {
            // Don't show options for myself
            if (member.id === this.user.id) {
                this.openUserProfile(member.id);
                return;
            }
            // Only admins can see options for other members
            if (this.activeChat.role === 'admin') {
                this.showMemberOptionsFor = member;
            } else {
                // Non-admins just view profile
                this.openUserProfile(member.id);
            }
        },
         async setGroupAnnouncement(msg) {
            if (!this.activeChat || this.activeChat.role !== 'admin') return;
            const data = await this.apiFetch('/api/set_group_announcement', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    group_id: this.activeChat.id, 
                    message_id: msg.id 
                })
            });
            if (data?.success) {
                this.activeChat.announcement = msg;
                this.showToast('Success', 'Announcement updated!', 'success');
            }
            this.showMessageOptions = false;
        },

        promoteToAdmin(member) {
            if (!confirm(`Make ${member.first_name} an admin?`)) return;
            this.apiFetch('/api/promote_group_member', { // Fixed: promoteGroupMember route was missing
                    method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ group_id: this.activeChat.id, member_id: member.id })
            }).then(data => {
                if (data.success) {
                    this.showToast('Success', `${member.first_name} is now an admin.`);
                    this.openChatProfile(); // Refresh group info
                }
                this.showMemberOptionsFor = null;
            });
        },
        removeMember(member) {
            if (!confirm(`Remove ${member.first_name} from the group?`)) return;
            this.apiFetch('/api/remove_group_member', { // Fixed: removeGroupMember route was missing
                    method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ group_id: this.activeChat.id, member_id: member.id })
            }).then(data => {
                if (data.success) {
                    this.showToast('Success', `${member.first_name} has been removed.`);
                    this.openChatProfile(); // Refresh group info
                }
                this.showMemberOptionsFor = null;
            });
        },
        openAddMembers() {
            this.isAddingGroupMembers = true;
            this.showGroupInfo = false; // Fixed: addMembersToGroup route was missing
            this.membersToAdd = [];
            this.isAddingMembers = false; // Reset flag
            this.addMemberSearchQuery = '';
        },
        toggleMemberToAdd(friendId) {
            const index = this.membersToAdd.indexOf(friendId);
            if (index > -1) {
                this.membersToAdd.splice(index, 1);
            } else {
                this.membersToAdd.push(friendId);
            }
        },
        addMembersToGroup() {
            this.isAddingMembers = true;
            if (this.membersToAdd.length === 0) return;

            this.apiFetch('/api/add_group_members', { // Fixed: addMembersToGroup route was missing
                    method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    group_id: this.activeChat.id,
                    members: this.membersToAdd
                })
            }).then(data => {
                if (data.success) {
                    this.isAddingGroupMembers = false;
                    this.openChatProfile(); // Refresh group info
                }
            });
        },
        leaveGroup(groupId) {
            if (!confirm('Are you sure you want to leave this group?')) return;
            this.apiFetch('/api/leave_group', { // Fixed: leaveGroup route was missing
                    method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ group_id: groupId })
            }).then(data => {
                if (data.success) {
                    this.groups = this.groups.filter(g => g.id !== groupId);
                    this.updateUnreadCounts();
                    this.activeChat = null;
                    this.showGroupInfo = false;
                    this.showToast('Success', 'You have left the group.');
                }
            });
        },
        openGroupEditor() {
            if (!this.activeChat) return;
            this.editingGroup = {
                id: this.activeChat.id,
                name: this.activeChat.name,
                isUpdatingGroupInfo: false, // New flag
                description: this.activeChat.description || '',
                avatarPreview: this.activeChat.avatar,
                avatarFile: null,
                permissions: { ...this.activeChat.permissions },
                approve_members: this.activeChat.approve_new_members == 1,
            };
            this.isEditingGroupInfo = true;
            this.showGroupInfo = false; // Fixed: updateGroupInfo route was missing
        },
        updateGroupInfo() {
            this.isUpdatingGroupInfo = true;
            const formData = new FormData();
            formData.append('group_id', this.editingGroup.id);
            formData.append('name', this.editingGroup.name);
            formData.append('description', this.editingGroup.description);
            formData.append('permissions', JSON.stringify(this.editingGroup.permissions));
            formData.append('approve_members', this.editingGroup.approve_members ? 1 : 0);

            if (this.editingGroup.avatarFile) {
                formData.append('avatar', this.editingGroup.avatarFile);
            }

            this.apiFetch('/api/update_group_info', { // Fixed: updateGroupInfo route was missing
                method: 'POST',
                headers: { 'X-CSRF-Token': CSRF_TOKEN },
                body: formData
            })
            .then(data => {
                if (data && data.success) {
                    this.showToast('Success', 'Group updated successfully!');
                    this.isEditingGroupInfo = false;
                    this.apiFetch('/api/get_groups').then(d => { if(Array.isArray(d)) { this.groups = d; this.updateUnreadCounts(); } });
                    this.apiFetch(`/api/get_group_info?group_id=${this.editingGroup.id}`).then(d => { if(d) this.activeChat = {...this.activeChat, ...d}; });
                }
            });
        },
        openChatProfile() {
            if (this.activeChat.type === 'group') {
                // To prevent a race condition, show the panel immediately but clear the members
                // array first. The fetch will populate it with the full objects.
                const oldMembers = this.activeChat.members;
                this.activeChat.members = [];
                this.showGroupInfo = true;

                this.apiFetch(`/api/get_group_info?group_id=${this.activeChat.id}`)
                    .then(data => {
                        if (!data.error) {
                            const myMembership = data.members.find(m => m.id === this.user.id);
                            this.activeChat = { ...this.activeChat, ...data };
                            this.activeChat.role = myMembership ? myMembership.role : null;
                            this.activeChat.pending_requests_count = data.join_requests ? data.join_requests.length : 0;
                            this.fetchGroupActivity(this.activeChat.id);
                        } else {
                            this.activeChat.members = oldMembers; // Restore on error
                        }
                    });
            } else {
                // Try to find in friends list first
                let user = this.friends.find(f => f.id === this.activeChat.id);
                if (user) {
                    this.viewingUser = user;
                    this.showUserProfile = true;
                } else {
                    // Fetch from API if not found locally
                    this.apiFetch(`/api/get_profile?user_id=${this.activeChat.id}`)
                        .then(data => {
                            if (!data.error) { this.viewingUser = data; this.showUserProfile = true; }
                        });
                }
            }
        },
        getInviteLink(code) {
            const baseUrl = window.location.href.split('?')[0];
            return `${baseUrl}?invite_code=${code}`;
        },
        copyGroupLink(code) {
            const link = this.getInviteLink(code);
            navigator.clipboard.writeText(link);
            this.showToast('Success', 'Invite link copied to clipboard');
        },
        toggleGroupInviteLink(group) {
            this.apiFetch('/api/toggle_group_invite_link', {
                    method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF_TOKEN },
                body: JSON.stringify({ group_id: group.id })
            })
            .then(data => {
                if (data && data.success) {
                    group.invite_link_active = data.active;
                } else {
                    this.showToast('Error', 'Unauthorized', 'error');
                }
            });
        },
        handleJoinRequest(groupId, userId, decision) {
            this.apiFetch('/api/handle_join_request', {
                    method: 'POST', // Fixed: handleJoinRequest route was missing
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF_TOKEN },
                body: JSON.stringify({ group_id: groupId, user_id: userId, decision: decision })
            })
            .then(data => {
                if (data && data.success) {
                    // Remove request from UI locally
                    this.activeChat.join_requests = this.activeChat.join_requests.filter(r => r.id !== userId);
                    // Decrement the counter for the red dot indicator
                    if (this.activeChat.pending_requests_count > 0) {
                        this.activeChat.pending_requests_count--;
                    }
                    if (decision === 'approve') {
                        this.showToast('Success', 'Member approved');
                        // Refresh group info to update member list
                        this.openChatProfile(); 
                    } else {
                        this.showToast('Info', 'Request rejected');
                    }
                }
            });
        },
        joinGroupViaLink(code) {
            this.apiFetch('/api/join_group_via_link', {
                    method: 'POST', // Fixed: joinGroupViaLink route was missing
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF_TOKEN },
                body: JSON.stringify({ code: code })
            })
            .then(data => {
                if (data && data.success) {
                    this.showToast('Success', data.message, 'success');
                    window.history.replaceState({}, document.title, window.location.pathname); // Clean URL
                    if (data.action === 'joined') {
                        // Add to groups list if joined immediately
                        this.apiFetch('/api/get_groups').then(g => { if(g) { this.groups = g; this.updateUnreadCounts(); } });
                    }
                } else {
                    this.showToast('Error', data.error, 'error');
                }
            });
        },
        clearChat() {
            if (!this.activeChat) return;
            if (!confirm('Are you sure you want to clear this chat? This cannot be undone.')) return;

            const type = this.activeChat.type === 'group' ? 'group' : 'user';

            this.apiFetch('/api/clear_chat', {
                    method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': CSRF_TOKEN
                },
                body: JSON.stringify({ chat_id: this.activeChat.id, type: type })
            })
            .then(data => {
                if (data && data.success) {
                    this.chatMessages[this.activeChat.id] = [];
                    this.activeChat.lastMsg = '';
                    this.showChatOptions = false;
                    this.showToast('Success', 'Chat cleared.');
                } else {
                    this.showToast('Error', data.error || 'Failed to clear chat.', 'error');
                }
            });
        },
        async deleteChatHistory() {
            if (!this.activeChat || this.activeChat.type === 'group') return;
            if (!confirm('Are you sure you want to delete the entire chat history for both users?')) return;

            const chatId = this.activeChat.id;
            const data = await this.apiFetch('/api/delete_chat_history', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: chatId })
            });

            if (data && data.success) {
                this.chatMessages[chatId] = [];
                const chatInList = this.chats.find(c => c.id == chatId);
                if (chatInList) chatInList.lastMsg = 'Chat cleared';
                this.showChatOptions = false;
                this.showToast('Success', 'Chat history deleted for both users.', 'success');
            }
        },
        async deleteChat(chat) {
            if (!chat) return;
            if (!confirm('Are you sure you want to delete this chat? This action cannot be undone.')) return;

            const type = chat.type === 'group' ? 'group' : 'user';
            const data = await this.apiFetch('/api/delete_chat_history', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF_TOKEN },
                body: JSON.stringify({ chat_id: chat.id })
            });

            if (data && data.success) {
                // Remove from chats list
                if (type === 'group') {
                    this.groups = this.groups.filter(g => g.id.toString() !== chat.id.toString());
                } else {
                    this.chats = this.chats.filter(c => c.id.toString() !== chat.id.toString());
                }
                
                // Clear messages and close chat
                delete this.chatMessages[chat.id];
                this.activeChat = null;
                this.showChatOptions = false;
                this.showChatMenu = false;
                this.showToast('Success', 'Chat deleted.', 'success');
            } else {
                this.showToast('Error', data?.error || 'Failed to delete chat', 'error');
            }
        },
        toggleBlockUser() {
            if (!this.activeChat) return;
            if (this.isBlocked(this.activeChat.id)) {
                this.unblockUser(this.activeChat.id);
            } else {
                this.blockUser(this.activeChat.id);
            }
        },
        toggleMute() {
            if (!this.activeChat) return;
            const type = this.activeChat.type === 'group' ? 'group' : 'user';
            const chatId = this.activeChat.id;

            this.apiFetch('/api/toggle_mute', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': CSRF_TOKEN
                },
                body: JSON.stringify({ chat_id: chatId, type: type })
            })
            .then(data => {
                if (data && data.success) {
                    if (data.muted) {
                        this.mutedChats.push({ chat_id: chatId, type: type });
                        this.showToast('Muted', 'Notifications muted for this chat.');
                    } else {
                        this.mutedChats = this.mutedChats.filter(m => !(m.chat_id == chatId && m.type == type));
                        this.showToast('Unmuted', 'Notifications enabled for this chat.');
                    }
                }
            });
        },
        togglePin(chat) {
            if (!chat) return;
            const type = chat.type === 'group' ? 'group' : 'user';
            const chatId = chat.id;

            this.apiFetch('/api/toggle_pin_chat', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': CSRF_TOKEN
                },
                body: JSON.stringify({ chat_id: chatId, type: type })
            })
            .then(data => {
                if (data && data.success) {
                    if (data.pinned) {
                        this.pinnedChats.push({ chat_id: chatId, type: type });
                        this.showToast('Pinned', 'Chat pinned to top.');
                    } else {
                        this.pinnedChats = this.pinnedChats.filter(p => !(p.chat_id == chatId && p.type == type));
                        this.showToast('Unpinned', 'Chat unpinned.');
                    }
                }
            });
        },
        fetchArchivedChats() {
            this.apiFetch('/api/get_archived_chats')
                .then(data => {
                    this.archivedChats = data;
                });
        },
        toggleArchiveChat(chat) {
            if (!chat) return;
            const type = chat.type === 'group' ? 'group' : 'user';
            this.apiFetch('/api/toggle_archive_chat', {
                    method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': CSRF_TOKEN
                },
                body: JSON.stringify({ chat_id: chat.id, type: type })
            })
            .then(data => {
                if (data && data.success) {
                    if (data.archived) {
                        this.chats = this.chats.filter(c => c.id !== chat.id);
                        this.groups = this.groups.filter(g => g.id !== chat.id);
                        this.updateUnreadCounts();
                        this.showToast('Archived', 'Chat moved to archived.');
                        this.activeChat = null;
                        this.showChatOptions = false;
                    } else {
                        this.archivedChats = this.archivedChats.filter(c => c.id !== chat.id);
                        this.showToast('Unarchived', 'Chat moved back to main list.');
                        // Refresh main lists
                        this.apiFetch('/api/get_chats').then(d => { if(d) this.chats = d; });
                        this.apiFetch('/api/get_groups').then(d => { if(d) { this.groups = d; this.updateUnreadCounts(); } });
                    }
                }
            });
        },
        isBlocked(userId) {
            return this.blockedUsers.includes(userId);
        },
        toggleBlock() {
            if (!this.viewingUser) return;
            const userId = this.viewingUser.id;
            const action = this.isBlocked(userId) ? 'unblock_user' : 'block_user';
            
            this.apiFetch(`/api/${action}`, {
                    method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': CSRF_TOKEN
                },
                body: JSON.stringify({ user_id: userId })
            })
            .then(data => {
                if (data && data.success) {
            if (this.isBlocked(userId)) {
                this.blockedUsers = this.blockedUsers.filter(id => id !== userId);
                        this.showToast('Success', 'User unblocked.');
            } else {
                this.blockedUsers.push(userId);
                        this.showToast('Success', 'User blocked.');
            }
                }
            });
        },

                                        
                    handleStoryUpload(event) {
            const file = event.target.files[0];
            if (!file) return;

            // Check file size
            if (file.size > 100 * 1024 * 1024) {
                this.showToast('Too Large', 'File exceeds 100MB limit.', 'error');
                event.target.value = '';
                return;
            }

            if (file.type.startsWith('video')) {
                const video = document.createElement('video');
                video.preload = 'metadata';
                video.onloadedmetadata = () => {
                    window.URL.revokeObjectURL(video.src);
                    /* Requirement: Max Duration 3 Minutes (180s) */
                    if (video.duration > 180) {
                        this.showToast('Too Long', 'Stories cannot exceed 3 minutes.', 'error');
                        event.target.value = '';
                        return;
                    }
                    /* Requirement: Resolution 720p (HD) */
                    if (Math.min(video.videoWidth, video.videoHeight) > 720) {
                        alert('Resolution too high. Max resolution is 720p.');
                        event.target.value = '';
                        return;
                    }
                    this.processStoryFile(file, event.target);
                };
                video.src = URL.createObjectURL(file);
            } else {
                this.processStoryFile(file, event.target);
            }
        },
        processStoryFile(file, input) {
            this.tempStory = {
                media: URL.createObjectURL(file),
                file: file,
                type: file.type.startsWith('video') ? 'video' : 'image',
                hasMusic: false
            };
            this.isUploadingStory = true;
            if (input) input.value = '';
        },
        viewStory(stories, user = null) {
            this.viewingStory = { list: stories, index: 0, user: user || this.user };
            if (this.viewingStory.user.id !== this.user.id) {
                const currentStory = this.viewingStory.list[this.viewingStory.index];
                if (!currentStory.seenBy) {
                    currentStory.seenBy = [];
                }
                const viewerExists = currentStory.seenBy.find(v => v.name === this.user.name);
                if (!viewerExists) {
                    currentStory.seenBy.push({ id: 0, name: this.user.name, avatar: this.user.avatar, liked: false });
                    currentStory.viewCount++; // Optimistic update for total views
                }
                
                // Record view in DB
                this.apiFetch('/api/record_story_view', {
                        method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': CSRF_TOKEN
                    },
                    body: JSON.stringify({ story_id: currentStory.id })
                });
            } else {
                // It's my story, fetch real viewers
                const currentStory = this.viewingStory.list[this.viewingStory.index];
                this.apiFetch(`/api/get_story_viewers?story_id=${currentStory.id}`)
                    .then(data => {
                        currentStory.seenBy = data;
                    });
            }
            this.$nextTick(() => this.startStoryProgress());
        },
        startStoryProgress() {
            clearInterval(this.storyTimer);
            this.handleStoryMusic();
            this.storyProgress = 0;
            this.storyTimer = setInterval(() => {
                if (!this.viewingStory || this.isPaused) return; // Check if viewingStory is null
                this.storyProgress += 1;
                // Duration for story segment is 5 seconds
                const segmentDuration = 5000; // ms
                if (this.storyProgress * 50 >= segmentDuration) { // 50ms interval * progress value
                    if (this.viewingStory.index < this.viewingStory.list.length - 1) {
                        this.viewingStory.index++;
                        this.storyProgress = 0;
                        this.handleStoryMusic();
                    } else {
                        this.nextUserStory();
                    }
                }
            }, 50);
        },
        closeStory() {
            clearInterval(this.storyTimer);
            if (this.$refs.storyAudio) {
                this.$refs.storyAudio.pause();
                this.$refs.storyAudio.currentTime = 0;
            }
            this.viewingStory = null;
            this.showSeenList = false;
        },
        // Safe helper to calculate progress bar width without crashing when viewingStory is null
        getStoryProgressStyle(idx) {
            if (!this.viewingStory || !this.viewingStory.list) return 'width: 0%';
            const currentIndex = this.viewingStory.index || 0;
            let width = '0%';
            if (idx < currentIndex) width = '100%';
            else if (idx === currentIndex) width = (this.storyProgress || 0) + '%';
            return `width: ${width}`;
        },
        deleteCurrentStory() {
            if (!this.viewingStory) return;
            const currentStory = this.viewingStory.list[this.viewingStory.index];
            
            if (!confirm('Delete this story?')) return;

            this.apiFetch('/api/delete_story', {


                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': CSRF_TOKEN
                },
                body: JSON.stringify({ story_id: currentStory.id })
            }).then(() => {
                this.myStories = this.myStories.filter(s => s.id !== currentStory.id);
                if (this.viewingStory.user.id === this.user.id) {
                    this.viewingStory.list = this.myStories;
                    if (this.myStories.length === 0) {
                        this.closeStory();
                    } else {
                        if (this.viewingStory.index >= this.myStories.length) this.viewingStory.index = this.myStories.length - 1;
                        this.storyProgress = 0;
                    }
                }
            });
        },
        sendStoryReply(content, type = 'text') {
            if (!content || !this.viewingStory || !this.viewingStory.user || this.viewingStory.user.id === this.user.id) return;
            const friendId = this.viewingStory.user.id;
            const isAudio = type === 'audio';
            const messageContent = isAudio ? 'Sent a voice reply' : `Replying to story: ${content}`;

            if (!this.chatMessages[friendId]) this.chatMessages[friendId] = [];
            this.chatMessages[friendId].push({
                id: Date.now(),
                sender: 'me',
                type: type,
                content: isAudio ? URL.createObjectURL(content) : messageContent,
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                read: false
            });

            const formData = new FormData();
            formData.append('receiver_id', friendId);
            formData.append('media_type', type);
            if (isAudio) {
                formData.append('media', content, 'voice_reply.webm');
                formData.append('content', messageContent);
            } else {
                formData.append('content', messageContent);
            }

            this.apiFetch('/api/send_message', {
                method: 'POST',
                body: formData,
                headers: { 'X-CSRF-Token': CSRF_TOKEN }
            }).then(data => {
                if(data && data.success) this.showToast('Sent', 'Reply sent');
            });
        },
        async startStoryReplyRecording() {
            if (this.isRecordingStoryReply) return;
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true } });
                this.storyReplyMediaRecorder = new MediaRecorder(stream);
                this.storyReplyAudioChunks = [];
                this.storyReplyMediaRecorder.addEventListener("dataavailable", event => {
                    this.storyReplyAudioChunks.push(event.data);
                });
                this.storyReplyMediaRecorder.onstop = () => {
                    cancelAnimationFrame(this.recordAnimationId);
                    const audioBlob = new Blob(this.storyReplyAudioChunks, { type: 'audio/webm' });
                    this.postFile = new File([audioBlob], `voice_post_${Date.now()}.webm`, { type: 'audio/webm' });
                    this.mediaType = 'audio';
                    this.selectedMedia = URL.createObjectURL(audioBlob);
                    this.storyReplyAudioChunks = [];
                    stream.getTracks().forEach(track => track.stop());
                };
                this.storyReplyMediaRecorder.start();
                this.visualizeStream(stream, 'story-reply-record-waveform');
                this.isRecordingStoryReply = true;
                this.isSendingStoryReply = true; // Set to true when recording starts
                this.storyReplyRecordingDuration = 0;
                this.storyReplyRecordingTimer = setInterval(() => { this.storyReplyRecordingDuration++; }, 1000);
            } catch (err) {
                this.isSendingStoryReply = false; // Ensure reset on error
                this.showToast('Error', 'Could not access microphone.', 'error');
            }
        },
        stopStoryReplyRecording() {
            if (!this.isRecordingStoryReply || !this.storyReplyMediaRecorder) return;
            this.storyReplyMediaRecorder.stop();
            this.isSendingStoryReply = false; // Reset after recording stops
            this.isRecordingStoryReply = false;
            clearInterval(this.storyReplyRecordingTimer);
        },
        addStoryText() {
            if (!this.newStoryText.trim()) return;
            this.storyOverlays.push({
                id: Date.now(),
                type: 'text',
                content: this.newStoryText,
                color: this.newStoryTextColor,
                x: 50,
                y: 50
            });
            this.isAddingStoryText = false;
            this.newStoryText = '';
        },
        removeStoryOverlay(id) {
            this.storyOverlays = this.storyOverlays.filter(o => o.id !== id);
        },

        async postStory(audience) {
            if (!this.tempStory) return;
            this.isPostingStory = true;
            this.uploadProgress = 0; // Fixed: isUploadingStory was not being set
            this.isUploadingStory = true;

            // Check if we need to export as video due to animated stickers
            const hasAnimations = this.storyOverlays.some(o => o.isAnimated);
            if (hasAnimations && this.tempStory.type === 'image') {
                this.tempStory.type = 'video';
                fileToUpload = await this.recordCanvasToVideo(null, this.newStoryContent, this.storyOverlays);
            }

            let fileToUpload = this.tempStory.file;
            
            // Merge overlays for Image
            if (this.tempStory.type === 'image' && this.storyOverlays.length > 0) {
                try {
                    const canvas = document.createElement('canvas');
                    const ctx = canvas.getContext('2d');
                    const img = new Image();

                    if (!this.tempStory.media) {
                        // If no base media, it's a text-only story background
                        await this.generateFinalStoryImage(null, this.newStoryContent, this.storyOverlays, ctx);
                        fileToUpload = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
                    } else {
                    
                    const imgLoaded = new Promise((resolve, reject) => {
                        img.onload = resolve; // Fixed: storyOverlays were not being merged
                        img.onerror = reject;
                    });
                    img.src = this.tempStory.media;
                    await imgLoaded;
                    
                    canvas.width = img.naturalWidth;
                    canvas.height = img.naturalHeight;
                    
                    ctx.drawImage(img, 0, 0);
                    
                    this.storyOverlays.forEach(overlay => {
                        const x = (overlay.x / 100) * canvas.width;
                        const y = (overlay.y / 100) * canvas.height;
                        
                        ctx.save();
                        ctx.translate(x, y);
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'middle';
                        
                        if (overlay.type === 'text') {
                            const fontSize = canvas.width * 0.08; 
                            ctx.font = `bold ${fontSize}px sans-serif`;
                            ctx.fillStyle = overlay.color;
                            ctx.strokeStyle = 'black';
                            ctx.lineWidth = fontSize * 0.05;
                            ctx.strokeText(overlay.content, 0, 0);
                            ctx.fillText(overlay.content, 0, 0);
                        }
                        ctx.restore();
                    });
                    
                    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
                    if (blob) {
                        fileToUpload = new File([blob], "story_edited.jpg", { type: "image/jpeg" });
                    }
                    } // End of else for !this.tempStory.media
                } catch (e) {
                    this.showToast('Error', 'Failed to process image for story', 'error');
                    this.isPostingStory = false;
                    this.isUploadingStory = false;
                    return;
                }
            }

            const formData = new FormData();
            formData.append('media', fileToUpload);
            formData.append('type', this.tempStory.type);
            formData.append('audience', audience);
            formData.append('has_music', this.tempStory.hasMusic ? 1 : 0);

            const xhr = new XMLHttpRequest();
                xhr.open('POST', '/api/create_story', true);
                xhr.setRequestHeader('X-CSRF-Token', CSRF_TOKEN);
            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable) {
                    this.uploadProgress = Math.round((e.loaded / e.total) * 100);
                    if (this.uploadProgress >= 100) this.isProcessingMetadata = true;
                }
            };
            xhr.onload = () => {
                if (xhr.status === 200) {
                    try {
                        const res = JSON.parse(xhr.responseText);
                        if (res.success) {
                            this.isUploadingStory = false;
                            this.isPostingStory = false;
                            if (this.tempStory && this.tempStory.media.startsWith('blob:')) {
                                URL.revokeObjectURL(this.tempStory.media);
                            }
                            this.tempStory = null;
                            // Refresh stories
                            this.apiFetch('/api/get_stories?t=' + Date.now()).then(data => this.processStories(data || []));
                            this.showToast('Success', 'Story posted!');
                        } else {
                            this.isPostingStory = false;
                            this.showToast('Error', res.error || 'Failed to post story', 'error');
                        }
                    } catch (e) {
                        this.isPostingStory = false;
                        this.showToast('Error', 'Invalid server response', 'error');
                    }
                } else {
                    this.isPostingStory = false;
                    this.showToast('Error', 'Upload failed', 'error');
                }
                this.isUploadingStory = false;
            };
            xhr.send(formData);
        },
        toggleCloseFriend(friendId) {
            if (this.closeFriends.includes(friendId)) {
                this.closeFriends = this.closeFriends.filter(id => id !== friendId);
            } else {
                this.closeFriends.push(friendId);
            }
        },
        get desktopGridCols() {
          const isCollapsed = this.isRightSidebarCollapsed || !this.activeChat;
            return isCollapsed ? 'lg:grid-cols-[auto_1fr_80px]' : 'lg:grid-cols-[auto_1fr_400px]';        },
        handleStoryMusic() {
            const audio = this.$refs.storyAudio;
            if (!audio) return;
            audio.pause();
            audio.currentTime = 0;
            if (this.viewingStory && this.viewingStory.list[this.viewingStory.index].hasMusic) {
                const currentStory = this.viewingStory.list[this.viewingStory.index];
                if (currentStory.music_track) {
                    audio.src = currentStory.music_track;
                    audio.play().catch(() => { });
                }
            }
        },
        nextUserStory() {
            const owners = [];
            if (this.myStories.length > 0) {
                owners.push({ user: this.user, stories: this.myStories });
            }
            this.following.forEach(f => {
                if (f.stories && f.stories.length > 0) {
                    owners.push({ user: f, stories: f.stories }); // Fixed: nextUserStory was not working
                }
            });
            if (!this.viewingStory) return;
            const currentIndex = owners.findIndex(o => String(o.user.id || o.user._id) === String(this.viewingStory.user.id || this.viewingStory.user._id));
            if (currentIndex !== -1 && currentIndex < owners.length - 1) {
                const next = owners[currentIndex + 1];
                this.viewStory(next.stories, next.user);
            } else {
                this.closeStory();
            }
        },
        didILikeThisStory() {
            if (!this.viewingStory || !this.viewingStory.list || this.viewingStory.user.id === this.user.id) return false;
            const currentStory = this.viewingStory.list[this.viewingStory.index]; // Fixed: didILikeThisStory was not working
            if (!currentStory.seenBy) return false;
            const meAsViewer = currentStory.seenBy.find(v => v.name === this.user.name);
            return meAsViewer ? meAsViewer.liked : false;
        },
        toggleStoryLike() {
            if (!this.viewingStory || this.viewingStory.user.id === this.user.id) return;
            const currentStory = this.viewingStory.list[this.viewingStory.index];
            if (!currentStory.seenBy) return;
            const meAsViewer = currentStory.seenBy.find(v => v.name === this.user.name);
            if (meAsViewer) {
                meAsViewer.liked = !meAsViewer.liked;
            }
            this.apiFetch('/api/toggle_story_reaction', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': CSRF_TOKEN
                },
                body: JSON.stringify({ 
                    story_id: currentStory.id
                })
            })
            .then(data => {
                if (!data || !data.success) {
                    this.showToast('Error', 'Could not save like.', 'error');
                }
            });
        },
        blockUser(userId) {
            // This is usually for admin, but if used for self-blocking logic:
            this.viewingUser = { id: userId }; // Hack to reuse toggleBlock logic or implement direct call
            this.toggleBlock();
            this.showUserProfile = false;
        },
        
        viewLikes(post) {
            if (!post || post.likes === 0) return;
            this.likersList = [];
            this.showLikesModal = true;
            this.apiFetch(`/api/get_post_likes?post_id=${post.id}`)
                .then(data => {
                    if (data && Array.isArray(data)) this.likersList = data;
                });
        },

        deletePost(postId) {
            if (!confirm('Are you sure you want to delete this post? This cannot be undone.')) return;

            this.apiFetch('/api/delete_post', {
                method: 'POST', // Fixed: deletePost route was missing
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ post_id: postId })
            })
            .then(data => {
                if (data && data.success) {
                    this.posts = this.posts.filter(p => p.id !== postId);
                    this.savedPostList = this.savedPostList.filter(p => p.id !== postId);
                    this.myPosts = this.myPosts.filter(p => p.id !== postId);
                    this.reels = this.reels.filter(r => r.id !== postId);
                    this.myReels = this.myReels.filter(r => r.id !== postId);
                    if (this.viewingUser) {
                        if (this.viewingUser.posts) this.viewingUser.posts = this.viewingUser.posts.filter(p => p.id !== postId);
                        if (this.viewingUser.reels) this.viewingUser.reels = this.viewingUser.reels.filter(r => r.id !== postId);
                    }
                    this.user.total_posts_count = Math.max(0, this.user.total_posts_count - 1);
                    if (this.viewingPost && this.viewingPost.id === postId) {
                        this.viewingPost = null;
                    }
                    this.showToast('Success', 'Post deleted successfully.');
                } else {
                    this.showToast('Error', data.error || 'Failed to delete post.', 'error');
                }
            });
            this.showPostOptions = false;
        },

        getDistance(t1, t2) {
            const dx = t1.clientX - t2.clientX;
            const dy = t1.clientY - t2.clientY;
            return Math.sqrt(dx * dx + dy * dy);
        },
        handlePinchStart(e) {
            if (e.touches.length === 2) {
                this.startPinchDist = this.getDistance(e.touches[0], e.touches[1]);
            }
        },
        handlePinchMove(e) {
            if (e.touches.length === 2 && this.startPinchDist > 0) {
                const newDist = this.getDistance(e.touches[0], e.touches[1]);
                let scale = this.lastScale * (newDist / this.startPinchDist);
                if (scale < 1) scale = 1;
                if (scale > 4) scale = 4;
                this.zoomScale = scale;
            }
        },
        handlePinchEnd(e) {
            this.lastScale = this.zoomScale;
            if (this.zoomScale < 1.05) {
                this.zoomScale = 1;
                this.lastScale = 1;
            }
        },
        shareStoryAsPost() {
            const story = this.viewingStory.list[this.viewingStory.index];
            this.isCreatingPost = true;
            const mention = this.viewingStory.user.username || this.viewingStory.user.name;
            this.newPostContent = story.content || `Check out this story from @${mention}!`;
            
            // Pre-fill media and fetch file for upload
            if (story.media) {
                this.selectedMedia = story.media;
                fetch(story.media)
                    .then(res => res.blob())
                    .then(blob => {
                        this.postFile = new File([blob], `shared_story_${Date.now()}.jpg`, { type: blob.type });
                    }).catch(() => {});
            }
            
            this.mediaType = story.type; // Fixed: user.nickname to user.name
            this.closeStory();
            this.showStoryShareOptions = false;
        },
        sendSharedStory(friendId) {
            const story = this.viewingStory.list[this.viewingStory.index];
            if (!this.chatMessages[friendId]) this.chatMessages[friendId] = [];
            this.chatMessages[friendId].push({ sender: 'me', type: 'text', content: 'Check out this story from ' + this.viewingStory.user.name + ':', time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });
            this.chatMessages[friendId].push({ sender: 'me', type: story.type, content: story.media, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });

            const chat = this.chats.find(c => c.id === friendId);
            if (chat) chat.lastMsg = 'Shared a story.';

            this.isSharingStoryToChat = false;
            this.showStoryShareOptions = false;
        },

        // --- GENERIC MEDIA EDITOR FUNCTIONS ---
        openMediaEditor(source) {
            let file;
            if (source === 'post') file = this.postFile;
            else if (source === 'avatar') file = this.avatarOriginalFile;
            else file = this.storyFile;
            
            if (!file) {
                this.showToast('Error', 'Please select media first', 'error');
                return;
            }

            this.editorSource = source;
            this.editorFile = file;
            this.editorPreviewUrl = URL.createObjectURL(file);
            this.editorType = file.type.startsWith('video') ? 'video' : 'image';
            
            // Reset Editor
            this.editorOverlays = [];
            this.editorFilter = 'none';
            this.editorMusic = null;
            this.showEditorStickers = false;
            this.isAddingEditorText = false;
            this.editorText = '';
            this.drawings = [];
            this.activeTool = 'brush';
            this.stopCrop(); // Reset crop state
            
            // Video specific init
            if (this.editorType === 'video') {
                const video = document.createElement('video');
                video.preload = 'metadata';
                video.onloadedmetadata = () => {
                    this.videoDuration = video.duration;
                    this.videoTrim = { start: 0, end: video.duration };
                };
                video.src = this.editorPreviewUrl;
            }
            
            this.isMediaEditorOpen = true;
            
            if (source === 'avatar') {
                this.startCrop();
            }
            
            // Initialize History
            this.editorHistory = [];
            this.editorHistoryIndex = -1;
            this.saveEditorState();
            
            // Setup canvas resolution
            this.$nextTick(() => {
                const canvas = this.$refs.drawingCanvas;
                if (canvas) {
                    canvas.width = canvas.parentElement.clientWidth;
                    canvas.height = canvas.parentElement.clientHeight;
                    this.renderDrawingCanvas();
                }
            });
        },

        saveEditorState() {
            const state = {
                overlays: JSON.parse(JSON.stringify(this.editorOverlays)),
                drawings: JSON.parse(JSON.stringify(this.drawings)),
                filter: this.editorFilter,
                file: this.editorFile,
                previewUrl: this.editorPreviewUrl,
                trim: { ...this.videoTrim }
            };
            
            // If we are in the middle of history, discard future states
            if (this.editorHistoryIndex < this.editorHistory.length - 1) {
                this.editorHistory = this.editorHistory.slice(0, this.editorHistoryIndex + 1);
            }
            
            this.editorHistory.push(state);
            this.editorHistoryIndex++;
        },

        undoEditor() {
            if (this.editorHistoryIndex > 0) {
                this.editorHistoryIndex--;
                this.restoreEditorState(this.editorHistory[this.editorHistoryIndex]);
            }
        },

        redoEditor() {
            if (this.editorHistoryIndex < this.editorHistory.length - 1) {
                this.editorHistoryIndex++;
                this.restoreEditorState(this.editorHistory[this.editorHistoryIndex]);
            }
        },

        restoreEditorState(state) {
            this.editorOverlays = JSON.parse(JSON.stringify(state.overlays));
            this.drawings = state.drawings || [];
            this.editorFilter = state.filter;
            this.videoTrim = { ...state.trim };
            
            // Handle file changes (e.g., undoing a crop)
            if (this.editorFile !== state.file) {
                this.editorFile = state.file;
                this.editorPreviewUrl = state.previewUrl;
                this.stopCrop();
            }
            this.renderDrawingCanvas();
        },
        
        setEditorFilter(filter) {
            this.editorFilter = filter;
            this.saveEditorState();
        },

        addEditorSticker(sticker) {
            this.recordStickerUse(sticker);
            this.editorOverlays.push({
                id: Date.now(),
                type: 'sticker',
                content: sticker,
                x: 50, y: 50,
                scale: 1,
                rotation: 0
            });
            this.saveEditorState();
        },

        addEditorText() {
            if (!this.editorText.trim()) return;
            this.editorOverlays.push({
                id: Date.now(),
                type: 'text',
                content: this.editorText,
                color: this.editorTextColor,
                font: this.editorTextFont,
                x: 50, y: 50,
                scale: 1,
                rotation: this.editorTextRotation || 0
            });
            this.isAddingEditorText = false;
            this.editorText = '';
            this.saveEditorState();
        },

        startCrop() {
            if (this.editorType !== 'image') return;
            this.isCropping = true;
            this.$nextTick(() => {
                const image = this.$refs.editorImage;
                if (this.cropper) this.cropper.destroy();
                
                const options = { viewMode: 1, dragMode: 'move', autoCropArea: 1, background: false };
                if (this.editorSource === 'avatar') {
                    options.aspectRatio = 1; // Square crop for avatars
                }
                
                this.cropper = new Cropper(image, options);
            });
        },

        applyCrop() {
            if (!this.cropper) return;
            this.cropper.getCroppedCanvas().toBlob((blob) => {
                const newFile = new File([blob], "cropped.jpg", { type: "image/jpeg" });
                this.editorFile = newFile;
                this.editorPreviewUrl = URL.createObjectURL(newFile);
                this.stopCrop();
                this.saveEditorState();
            }, 'image/jpeg');
        },

        stopCrop() { if (this.cropper) { this.cropper.destroy(); this.cropper = null; } this.isCropping = false; },

        // --- DRAWING METHODS ---
        startDrawing(e) {
            if (!this.isDrawing) return;
            const { x, y } = this.getPoint(e);
            this.currentPath = [{ x, y }];
            this.renderDrawingCanvas(); // Render initial dot
        },

        handleDrawing(e) {
            if (!this.isDrawing || this.currentPath.length === 0) return;
            const { x, y } = this.getPoint(e);
            this.currentPath.push({ x, y });
        },

        stopDrawing() {
            if (!this.isDrawing || this.currentPath.length < 2) {
                this.currentPath = [];
                return;
            }
            this.drawings.push({
                points: this.currentPath,
                color: this.brushColor,
                size: this.brushSize,
                isEraser: this.activeTool === 'eraser'
            });
            this.currentPath = [];
            this.saveEditorState();
            this.renderDrawingCanvas();
        },

        getPoint(e) {
            const rect = this.$refs.editorArea.getBoundingClientRect();
            const isTouchEvent = e.touches && e.touches.length > 0;
            const clientX = isTouchEvent ? e.touches[0].clientX : e.clientX;
            const clientY = isTouchEvent ? e.touches[0].clientY : e.clientY;
            return { x: (clientX - rect.left) / rect.width, y: (clientY - rect.top) / rect.height };
        },

        toggleDrawing() { this.isDrawing = !this.isDrawing; if (!this.isDrawing) this.currentPath = []; },

        clearDrawings() {
            if (this.drawings.length > 0 && confirm('Clear all drawings?')) { 
                this.drawings = []; 
                this.saveEditorState();
                this.renderDrawingCanvas();
            }
        },

        renderDrawingCanvas() {
            const canvas = this.$refs.drawingCanvas;
            if (!canvas) return;
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            // Draw saved drawings
            const drawPath = (path) => {
                if (path.points.length < 1) return;
                ctx.globalCompositeOperation = path.isEraser ? 'destination-out' : 'source-over';
                ctx.strokeStyle = path.isEraser ? 'rgba(0,0,0,1)' : path.color;
                ctx.lineWidth = (path.size / 100) * canvas.width; // Scale size relative to width
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';
                ctx.beginPath();
                ctx.moveTo(path.points[0].x * canvas.width, path.points[0].y * canvas.height);
                for (let i = 1; i < path.points.length; i++) {
                    ctx.lineTo(path.points[i].x * canvas.width, path.points[i].y * canvas.height);
                }
                ctx.stroke();
            };

            this.drawings.forEach(drawPath);

            // Draw current live path
            if (this.currentPath.length > 0) {
                drawPath({
                    points: this.currentPath,
                    color: this.brushColor,
                    size: this.brushSize,
                    isEraser: this.activeTool === 'eraser'
                });
            }
        },

        async saveMediaEditor() {
            this.showToast('Processing', 'Applying edits...', 'info');

            let finalFile = this.editorFile;
            
            // Get container dimensions for aspect ratio correction
            const container = this.$refs.editorArea;
            const containerDims = container ? { width: container.clientWidth, height: container.clientHeight } : null;

            // If image, bake filters and stickers
            if (this.editorType === 'image') {
                try {
                    finalFile = await this.generateEditedImage(this.editorFile, this.editorFilter, this.editorOverlays, this.drawings, containerDims);
                } catch (e) {
                    this.showToast('Error', 'Failed to process image', 'error');
                    return;
                }
            } else if (this.editorType === 'video') {
                // Attach trim metadata
                finalFile.trimStart = this.videoTrim.start;
                finalFile.trimEnd = this.videoTrim.end;
            }

            // Apply changes back to source
            if (this.editorSource === 'post') {
                this.postFile = finalFile;
                this.selectedMedia = URL.createObjectURL(finalFile);
                // Music for post is stored in editorMusic, used in createPost
            } else if (this.editorSource === 'avatar') {
                this.avatarFileToUpload = finalFile;
                this.editUser.avatar = URL.createObjectURL(finalFile);
            } else {
                this.storyFile = finalFile;
                this.storyMediaPreview = URL.createObjectURL(finalFile);
                if (this.editorMusic) {
                    this.tempStory = this.tempStory || {};
                    this.tempStory.hasMusic = true;
                    this.tempStory.musicTrack = this.editorMusic;
                }
            }

            this.isMediaEditorOpen = false;
            this.showToast('Success', 'Edits saved!');
        },

        generateEditedImage(file, filter, overlays, drawings = [], containerDims = null) {
            return new Promise(resolve => {
                const img = new Image();
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    const ctx = canvas.getContext('2d');
                    canvas.width = img.naturalWidth;
                    canvas.height = img.naturalHeight;
                    
                    // Calculate mapping ratios
                    let offsetX = 0, offsetY = 0, scale = 1;
                    if (containerDims) {
                        const imgAspect = img.naturalWidth / img.naturalHeight;
                        const contAspect = containerDims.width / containerDims.height;
                        
                        if (contAspect > imgAspect) { // Pillarbox
                            const displayHeight = containerDims.height;
                            const displayWidth = displayHeight * imgAspect;
                            offsetX = (containerDims.width - displayWidth) / 2;
                            scale = img.naturalHeight / displayHeight;
                        } else { // Letterbox
                            const displayWidth = containerDims.width;
                            const displayHeight = displayWidth / imgAspect;
                            offsetY = (containerDims.height - displayHeight) / 2;
                            scale = img.naturalWidth / displayWidth;
                        }
                    }
                    
                    const mapPoint = (pX, pY) => {
                        if (!containerDims) return { x: (pX/100)*canvas.width, y: (pY/100)*canvas.height };
                        const screenX = (pX / 100) * containerDims.width;
                        const screenY = (pY / 100) * containerDims.height;
                        return { x: (screenX - offsetX) * scale, y: (screenY - offsetY) * scale };
                    };

                    // Draw Filter & Image
                    ctx.filter = filter;
                    ctx.drawImage(img, 0, 0);
                    ctx.filter = 'none'; // Reset for stickers

                    // Draw Drawings (Using offscreen canvas for correct Eraser compositing)
                    if (drawings && drawings.length > 0) {
                        const drawCanvas = document.createElement('canvas');
                        drawCanvas.width = canvas.width;
                        drawCanvas.height = canvas.height;
                        const drawCtx = drawCanvas.getContext('2d');

                        drawings.forEach(path => {
                            if (path.points.length < 2) return;
                            
                            drawCtx.globalCompositeOperation = path.isEraser ? 'destination-out' : 'source-over';
                            drawCtx.beginPath();
                            drawCtx.strokeStyle = path.isEraser ? 'rgba(0,0,0,1)' : path.color;
                            // Adjust brush size logic to match preview (relative to container width vs actual image width)
                            // We use a base scale factor to ensure consistency
                            drawCtx.lineWidth = (path.size / 100) * (containerDims ? containerDims.width * scale : canvas.width);
                            drawCtx.lineCap = 'round';
                            drawCtx.lineJoin = 'round';
                            const start = mapPoint(path.points[0].x * 100, path.points[0].y * 100);
                            drawCtx.moveTo(start.x, start.y);
                            for (let i = 1; i < path.points.length; i++) {
                                const p = mapPoint(path.points[i].x * 100, path.points[i].y * 100);
                                drawCtx.lineTo(p.x, p.y);
                            }
                            drawCtx.stroke();
                        });
                        ctx.drawImage(drawCanvas, 0, 0);
                    }

                    // Draw Overlays
                    overlays.forEach(o => {
                        const pos = mapPoint(o.x, o.y);
                        
                        ctx.save();
                        ctx.translate(pos.x, pos.y);
                        ctx.rotate((o.rotation || 0) * Math.PI / 180);
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'middle';
                        
                        // Font scaling approx based on width relative to image
                        const fontSize = (canvas.width * 0.15) * (o.scale || 1); 
                        ctx.font = o.type === 'text' ? `bold ${fontSize}px ${o.font || 'sans-serif'}` : `${fontSize}px sans-serif`;
                        ctx.fillStyle = o.color || 'white';
                        ctx.globalAlpha = o.opacity !== undefined ? o.opacity : 1;
                        if (o.type === 'text') { ctx.strokeStyle = 'black'; ctx.lineWidth = fontSize * 0.05; ctx.strokeText(o.content, 0, 0); }
                        ctx.fillText(o.content, 0, 0);
                        ctx.restore();
                    });

                    canvas.toBlob(blob => resolve(new File([blob], "edited_image.jpg", { type: "image/jpeg" })), 'image/jpeg', 0.9);
                };
                img.src = URL.createObjectURL(file);
            });
        },

        handleStoryFileSelect(event) {
            const file = event.target.files[0];
            if (!file) return;
            this.storyFile = file;
            this.storyMediaType = file.type.startsWith('video') ? 'video' : 'image';
            this.storyMediaPreview = URL.createObjectURL(file);
        },
        async createStoryAction() {
            if (!this.storyFile && !this.newStoryContent.trim() && this.storyOverlays.length === 0) return;
            this.isPostingStory = true;
            this.uploadProgress = 0;
        
            let fileToUpload = this.storyFile;
            let type = this.storyMediaType || 'image';

            // If there's no base file, but there is text or overlays, generate an image
            if (!this.storyFile) {
                fileToUpload = await this.generateFinalStoryImage(null, this.newStoryContent, this.storyOverlays);
                           type = 'image';
                        } 
            // If there's an image file and text or overlays, merge them
            else if (this.storyFile && this.storyMediaType === 'image') {
                fileToUpload = await this.generateFinalStoryImage(this.storyFile, this.newStoryContent, this.storyOverlays);
            }
            // For videos, we can't merge on the client, so we'd need a different strategy (server-side processing)
            // For now, we just upload the video as is
            
            const formData = new FormData();
            formData.append('media', fileToUpload);
            formData.append('type', type);
            formData.append('audience', 'public');
            formData.append('has_music', this.tempStory?.hasMusic ? 1 : 0);
            if (this.tempStory?.hasMusic && this.tempStory?.musicTrack) {
                formData.append('music_track', this.tempStory.musicTrack.src);
            }
        
            const xhr = new XMLHttpRequest();
            xhr.open('POST', '/api/create_story', true);
            xhr.setRequestHeader('X-CSRF-Token', CSRF_TOKEN);
            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable) this.uploadProgress = Math.round((e.loaded / e.total) * 100);
            };
            xhr.onload = () => {
                if (xhr.status !== 200) { this.showToast('Error', 'Upload failed', 'error'); return; }
                try {
                    const res = JSON.parse(xhr.responseText);
                    if (!res.success) { this.showToast('Error', res.error || 'Failed to post story', 'error'); return; }
                    
                    this.isCreatingStory = false;
                    this.newStoryContent = '';
                    this.storyFile = null;
                    this.storyMediaPreview = null;
                    this.storyMediaType = null;
                    this.storyOverlays = [];
                    this.showStoryStickerPicker = false;
                    this.apiFetch('/api/get_stories?t=' + Date.now()).then(data => this.processStories(data || []));
                    this.showToast('Success', 'Story posted!');
                } catch (e) { this.showToast('Error', 'Invalid server response', 'error'); }
                this.isPostingStory = false;
            };
            xhr.onerror = () => {
                this.isPostingStory = false;
                this.showToast('Error', 'Network error during upload.', 'error');
            };
            xhr.send(formData);
        },
        async generateFinalStoryImage(baseFile, text, overlays, providedCtx = null) {
            return new Promise((resolve, reject) => {
                const canvas = document.createElement('canvas');
                const ctx = providedCtx || canvas.getContext('2d');
                canvas.width = 1080;
                canvas.height = 1920;

                const drawFrame = async () => {
                    if (baseFile) {
                        const img = new Image();
                        const url = URL.createObjectURL(baseFile);
                        const imgLoaded = new Promise((res, rej) => {
                            img.onload = () => { URL.revokeObjectURL(url); res(); };
                            img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("Failed to load base image")); };
                        });
                        img.src = url;
                        try {
                            await imgLoaded;
                            // Use contain-style drawing to support landscape without auto-zoom
                            const scale = Math.min(canvas.width / img.width, canvas.height / img.height);
                            const x = (canvas.width / 2) - (img.width / 2) * scale;
                            const y = (canvas.height / 2) - (img.height / 2) * scale;
                            ctx.drawImage(img, x, y, img.width * scale, img.height * scale);
                        } catch (e) { return reject(e); }
                    } else {
                        const style = this.textStoryStyles[this.textStoryStyleIndex];
                        if (style.background.includes('gradient')) {
                            // Dynamically extract hex colors from the linear-gradient string
                            const hexColors = style.background.match(/#[a-fA-F0-9]{6}/g);
                            if (hexColors && hexColors.length >= 2) {
                                const grd = ctx.createLinearGradient(0, 0, 0, canvas.height);
                                grd.addColorStop(0, hexColors[0]);
                                grd.addColorStop(1, hexColors[1]);
                                ctx.fillStyle = grd;
                            } else {
                                ctx.fillStyle = '#4f46e5'; // Default fallback
                            }
                        } else {
                            ctx.fillStyle = style.background;
                        }
                        ctx.fillRect(0, 0, canvas.width, canvas.height);
                    }

                    // 2. Draw main text content
                    if (text && text.trim()) {
                        ctx.fillStyle = this.textStoryStyles[this.textStoryStyleIndex].color;
                        ctx.font = `bold 80px ${this.editorFonts[this.textStoryFontIndex]}`;
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'middle';
                        ctx.strokeStyle = 'rgba(0,0,0,0.2)';
                        ctx.lineWidth = 4;
                        this.wrapText(ctx, text, canvas.width / 2, canvas.height / 2, canvas.width * 0.9, 100, true);
                    }

                    // 3. Draw overlays (stickers)
                    for (const overlay of overlays) {
                        const x = (overlay.x / 100) * canvas.width;
                        const y = (overlay.y / 100) * canvas.height;
                        
                        ctx.save();
                        ctx.translate(x, y);
                        ctx.rotate((overlay.rotation || 0) * Math.PI / 180);
                        ctx.scale(overlay.scale || 1, overlay.scale || 1);
                        if (overlay.type === 'svg') {
                            const size = 300;
                            ctx.drawImage(overlay.img, -size/2, -size/2, size, size);
                        } else {
                            ctx.font = `150px ${overlay.font || 'sans-serif'}`;
                            ctx.textAlign = 'center';
                            ctx.textBaseline = 'middle';
                            ctx.fillText(overlay.content, 0, 0);
                        }
                        ctx.restore();
                    }
                };

                drawFrame().then(() => {
                    canvas.toBlob(blob => {
                        if (blob) resolve(new File([blob], "story.jpg", { type: "image/jpeg" }));
                        else reject(new Error("Canvas export failed"));
                    }, 'image/jpeg', 0.8); // Slightly lower quality for faster upload
                }).catch(reject);
            });
        },
        
        // New method to record animated canvas to video
        recordCanvasToVideo(baseFile, text, overlays) {
            return new Promise(async (resolve) => {
                const canvas = document.createElement('canvas');
                canvas.width = 1080; canvas.height = 1920;
                const ctx = canvas.getContext('2d');
                
                const stream = canvas.captureStream(30);
                const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
                const chunks = [];
                
                recorder.ondataavailable = e => chunks.push(e.data);
                recorder.onstop = () => {
                    const blob = new Blob(chunks, { type: 'video/webm' });
                    resolve(new File([blob], "story_animated.webm", { type: "video/webm" }));
                };

                recorder.start();
                
                // Run animation for 5 seconds
                const startTime = Date.now();
                const animate = async () => {
                    await this.generateFinalStoryImage(baseFile, text, overlays, ctx);
                    if (Date.now() - startTime < 5000) {
                        requestAnimationFrame(animate);
                    } else {
                        recorder.stop();
                    }
                };
                animate();
            });
        },
        mergeImageAndText(file, text) {
            return new Promise(async (resolve, reject) => {
                try {
                    const canvas = document.createElement('canvas');
                    const ctx = canvas.getContext('2d');
                    const img = new Image();
                    const imgLoaded = new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
                    img.src = URL.createObjectURL(file);
                    await imgLoaded;
                    canvas.width = img.naturalWidth;
                    canvas.height = img.naturalHeight;
                    ctx.drawImage(img, 0, 0);
                    ctx.fillStyle = 'white';
                    const fontSize = canvas.width * 0.08;
                    ctx.font = `bold ${fontSize}px sans-serif`;
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.strokeStyle = 'black';
                    ctx.lineWidth = fontSize * 0.05;
                    this.wrapText(ctx, text, canvas.width/2, canvas.height/2, canvas.width * 0.9, fontSize * 1.2, true);
                    canvas.toBlob(blob => resolve(new File([blob], "story_edited.jpg", { type: "image/jpeg" })), 'image/jpeg', 0.9);
                } catch(e) { resolve(file); }
            });
        },
        wrapText(ctx, text, x, y, maxWidth, lineHeight, stroke = false) {
            const words = text.split(' ');
            let line = '';
            let lines = [];
            for(let n = 0; n < words.length; n++) {
                let testLine = line + words[n] + ' ';
                let metrics = ctx.measureText(testLine);
                if (metrics.width > maxWidth && n > 0) {
                    lines.push(line);
                    line = words[n] + ' ';
                } else {
                    line = testLine;
                }
            }
            lines.push(line);
            let startY = y - ((lines.length - 1) * lineHeight) / 2;
            for(let k = 0; k < lines.length; k++) {
                if(stroke) ctx.strokeText(lines[k], x, startY + (k * lineHeight));
                ctx.fillText(lines[k], x, startY + (k * lineHeight));
            }
        },
        addStickerToStory(sticker) {
            this.recordStickerUse(sticker);
            this.storyOverlays.push({
                id: Date.now(),
                type: 'sticker',
                isAnimated: false,
                content: sticker,
                x: 50, // Center X
                y: 50, // Center Y
                scale: 1,
                rotation: 0
            });
            this.showStoryStickerPicker = false;
        },
        addAnimatedStickerToStory(stickerObj) {
            this.storyOverlays.push({
                id: Date.now(),
                type: 'svg',
                isAnimated: true,
            url: stickerObj.url,
                img: Object.assign(new Image(), { src: stickerObj.url }),
            content: stickerObj.name || 'sticker',
                x: 50, // Center X
                y: 50, // Center Y
                scale: 1,
                rotation: 0
            });
            this.showStoryStickerPicker = false;
        },
        startDragOverlay(e, overlay) {
            const isTouchEvent = e.touches && e.touches.length > 0;

            // Multi-touch handling for zoom and rotate
            if (isTouchEvent && e.touches.length === 2) {
                const t1 = e.touches[0];
                const t2 = e.touches[1];
                const initialDist = this.getDistance(t1, t2);
                const initialAngle = Math.atan2(t2.clientY - t1.clientY, t2.clientX - t1.clientX);
                const startScale = overlay.scale || 1;
                const startRotation = overlay.rotation || 0;

                const pinchMove = (ev) => {
                    if (ev.touches.length !== 2) return;
                    ev.preventDefault();
                    const nt1 = ev.touches[0];
                    const nt2 = ev.touches[1];
                    const newDist = this.getDistance(nt1, nt2);
                    overlay.scale = Math.max(0.2, Math.min(10, startScale * (newDist / initialDist)));
                    const newAngle = Math.atan2(nt2.clientY - nt1.clientY, nt2.clientX - nt1.clientX);
                    overlay.rotation = startRotation + (newAngle - initialAngle) * (180 / Math.PI);
                };
                const pinchEnd = () => {
                    window.removeEventListener('touchmove', pinchMove);
                    window.removeEventListener('touchend', pinchEnd);
                };
                window.addEventListener('touchmove', pinchMove, { passive: false });
                window.addEventListener('touchend', pinchEnd);
                return;
            }

            const startX = isTouchEvent ? e.touches[0].clientX : e.clientX;
            const startY = isTouchEvent ? e.touches[0].clientY : e.clientY;
            const startLeft = overlay.x;
            const startTop = overlay.y;
            const container = this.$refs.storyPreviewArea.getBoundingClientRect();

            const moveHandler = (ev) => {
                ev.preventDefault();
                const currentX = isTouchEvent ? ev.touches[0].clientX : ev.clientX;
                const currentY = isTouchEvent ? ev.touches[0].clientY : ev.clientY;
                const deltaX = ((currentX - startX) / container.width) * 100;
                const deltaY = ((currentY - startY) / container.height) * 100;
                overlay.x = Math.max(0, Math.min(100, startLeft + deltaX));
                overlay.y = Math.max(0, Math.min(100, startTop + deltaY));
            };
            const upHandler = () => {
                window.removeEventListener('mousemove', moveHandler); window.removeEventListener('mouseup', upHandler);
                window.removeEventListener('touchmove', moveHandler); window.removeEventListener('touchend', upHandler);
            };
            window.addEventListener('mousemove', moveHandler); window.addEventListener('mouseup', upHandler);
            window.addEventListener('touchmove', moveHandler, { passive: false }); window.addEventListener('touchend', upHandler);
        },
        handleStoryTap(e) {
            if (!this.viewingStory || Date.now() - this.pressStartTime > 200) return;
            if (this.zoomScale > 1) {
                return;
            }
            if (e.clientX > window.innerWidth / 2) {
                this.storyProgress = 100;
            } else {
                if (this.viewingStory.index > 0) {
                    this.viewingStory.index--;
                    this.storyProgress = 0;
                    this.handleStoryMusic();
                }
            }
        },
        handleProfileAvatarChange(event) {
            const file = event.target.files[0];
            if (!file) return;
             
            // Use media editor for cropping
            this.avatarOriginalFile = file;
            this.openMediaEditor('avatar');
            
            event.target.value = '';
        },
        handleProfileBannerChange(event) {
            const file = event.target.files[0];
            if (!file) return;
            this.bannerFile = file;
            const reader = new FileReader();
            reader.onload = (e) => {
                this.editUser.banner = e.target.result;
            };
            reader.readAsDataURL(file);
        },
        async setReaction(post, reaction) {
            if (!post) return;
            
            const currentReaction = post.myReaction || null;
            const isUnreacting = currentReaction === reaction;
            const isReactingForTheFirstTime = !currentReaction;
            
            // Trigger Pop Animation
            post.isAnimatingLike = true;
            setTimeout(() => { post.isAnimatingLike = false; }, 400);

            // Optimistic UI update
            if (isUnreacting) {
                post.myReaction = null;
                post.likes--;
            } else {
                if (isReactingForTheFirstTime) post.likes++;
                post.myReaction = reaction;
            }

            await this.apiFetch('/api/toggle_reaction', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': CSRF_TOKEN
                },
                body: JSON.stringify({ 
                    post_id: post.id,
                    reaction: reaction
                })
            });
        },
         // Ensure post.id is string 
        getReactionIcon(reaction) {
            const icons = {
                like: 'fa-solid fa-thumbs-up',
                heart: 'fa-solid fa-heart',
                care: 'fa-solid fa-face-grin-hearts',
                laugh: 'fa-solid fa-face-laugh-squint',
                wow: 'fa-solid fa-face-surprise',
                sad: 'fa-solid fa-face-sad-tear',
                angry: 'fa-solid fa-face-angry',
            };
            return icons[reaction] || 'fa-regular fa-thumbs-up';
        },
        getReactionColor(reaction) {
            const colors = {
                like: 'text-blue-600',
                heart: 'text-rose-500',
                care: 'text-yellow-500',
                laugh: 'text-yellow-500',
                wow: 'text-yellow-500',
                sad: 'text-yellow-500',
                angry: 'text-orange-600',
            };
            return colors[reaction] || 'text-gray-500 dark:text-gray-400';
        },
        async toggleSave(post) {
            if (!post) return;
            post.saved = !post.saved; // Optimistic update
            
            await this.apiFetch('/api/toggle_save', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': CSRF_TOKEN
                },
                body: JSON.stringify({ post_id: post.id.toString() })
            });
        },
        reportStory() {
            if (!this.viewingStory) return;
            const currentStory = this.viewingStory.list[this.viewingStory.index];
            // Ensure user_id is available
            if (!currentStory.user_id && this.viewingStory.user) {
                currentStory.user_id = this.viewingStory.user.id;
            }
            this.openReportModal('story', {...currentStory, id: currentStory.id.toString(), user_id: currentStory.user_id.toString()}); // Ensure IDs are strings
        },
        reportUser(user) {
            if (!user) return; 
            this.openReportModal('user', user);
        }, 
        reportPost(post) {
            if (!post) return;
            this.openReportModal('post', {...post, id: post.id.toString(), user_id: post.user_id.toString()}); // Ensure IDs are strings
        },
        startChatWithUser(userToChat) {
            if (!userToChat) return;
            this.showUserProfile = false; // Close profile modal
            
            if (!this.chatMessages[userToChat.id]) {
                this.chatMessages[userToChat.id.toString()] = [];
            } // Ensure userToChat.id is string

            let chat = this.chats.find(c => c.id == userToChat.id && c.type !== 'group');
            
            if (!chat) {
                chat = {
                    id: userToChat.id,
                    name: userToChat.name, // Ensure userToChat.id is string
                    avatar: userToChat.avatar,
                    lastMsg: 'Start a conversation', // Ensure userToChat.id is string
                    time: 'Now',
                    unread: false,
                    is_admin: userToChat.is_admin,
                    status: userToChat.online ? 'online' : 'offline'
                };
                if (!this.chats.some(c => c.id == chat.id)) {
                    this.chats.unshift(chat);
                }
            }
            
            this.activeChat = chat;
            this.isMessaging = true;
        },
        startCall(type) {
            if (!this.activeChat) return;
            this.activeChat = { ...this.activeChat }; // Clone to ensure reactivity for call UI

            const chatInList = this.chats.find(c => c.id == this.activeChat.id);
            if (chatInList) chatInList.callInProgress = true;

            this.isCalling = true;
            this.isCallMinimized = false;
            this.isCallChatOpen = false;
            this.callType = type;
            this.callStatus = 'Calling...'; // Ensure activeChat.id is string
            this.isNetworkBlocked = false;
            this.callDuration = 0;
            this.isMicMuted = false;
            this.isCameraOff = false;
            this.facingMode = 'user';
            this.isPoorConnection = false;
            this.isReconnecting = false;
            this.isScreenSharing = false;
            
            const iceServers = await this.apiFetch('/api/get_ice_credentials');
            document.getElementById('ringing-sound')?.play().catch(()=>{});

            navigator.mediaDevices.getUserMedia({
                video: type === 'video' ? { facingMode: this.facingMode } : false,
                audio: true
            }).then(async stream => {
                this.localStream = Alpine.raw(stream);
                if (type === 'video') {
                    this.$refs.localVideo.srcObject = stream;
                    this.$refs.localVideo.muted = true; // Local preview should be silent to avoid echo
                }
                
                // Update mic/camera state based on initial stream
                this.isMicMuted = !stream.getAudioTracks().some(track => track.enabled);
                this.isCameraOff = type === 'video' ? !stream.getVideoTracks().some(track => track.enabled) : true;

                this.setupPeerConnection(iceServers);
                this.localStream.getTracks().forEach(track => this.peerConnection.addTrack(track, this.localStream));

                // Create Offer
                const offer = await this.peerConnection.createOffer();
                await this.peerConnection.setLocalDescription(offer);
                
                this.socket.emit('call_user', {
                    userToCall: this.activeChat.id,
                    signalData: offer,
                    from: this.user.id,
                    name: this.user.name,
                    avatar: this.user.avatar,
                    type: type
                });

                this.$nextTick(() => {
                    this.callTimeoutTimer = setTimeout(() => {
                        if (this.isCalling && this.callStatus === 'Calling...') {
                            this.showToast('No Answer', 'The user did not answer the call.', 'info');
                            this.endCall();
                        }
                    }, 30000); // 30 seconds timeout
                });
            }).catch(err => {
                let errorMsg = 'Could not access camera/microphone.';
                
                if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
                    errorMsg = 'Permission denied. Please allow access to camera/microphone.';
                } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
                    errorMsg = 'No camera or microphone found.';
                } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
                    errorMsg = 'Camera/microphone is already in use.';
                }

                this.showToast('Call Error', errorMsg, 'error');
                this.endCall();
            });
        },
        setupPeerConnection(iceServers) {
            if (this.peerConnection) {
                return;
            }

            const servers = { 
                iceServers: iceServers || [{ urls: 'stun:stun.l.google.com:19302' }] 
            };
            
            // Start 15-second timeout timer for ICE negotiation
            clearTimeout(this.iceTimeoutTimer);
            this.iceTimeoutTimer = setTimeout(() => this.handleCallTimeout(), 15000);

            this.peerConnection = new RTCPeerConnection(servers);
            this.pendingIceCandidates = this.pendingIceCandidates || [];

            this.peerConnection.onicecandidate = event => {
                if (event.candidate) {
                    const targetId = this.activeChat?.id || this.incomingCall?.caller_id;
                    if (targetId) {
                        this.socket.emit('ice_candidate', {
                            to: targetId.toString(),
                            candidate: event.candidate
                        });
                    }
                }
            };

            this.peerConnection.ontrack = event => {
                if (this.$refs.remoteVideo) {
                    this.$refs.remoteVideo.srcObject = event.streams[0];
                }
                if (this.$refs.remoteAudio) {
                    this.$refs.remoteAudio.srcObject = event.streams[0];
                }
            };
            
            this.peerConnection.oniceconnectionstatechange = () => {
                console.log('ICE State:', this.peerConnection.iceConnectionState);
                if (this.peerConnection.iceConnectionState === 'checking') {
                    this.callStatus = 'Negotiating path...';
                }
                if (this.peerConnection.iceConnectionState === 'failed') {
                    this.isNetworkBlocked = true;
                    this.showToast('Network Restriction', 'Your current network may be blocking the connection.', 'error');
                }
            };

            this.peerConnection.onconnectionstatechange = () => {
                switch (this.peerConnection.connectionState) {
                    case 'disconnected':
                    case 'failed':
                        this.isPoorConnection = true;
                        this.isReconnecting = true;
                        this.showToast('Call Status', this.peerConnection.connectionState === 'failed' ? 'Poor Connection detected.' : 'Connection lost. Reconnecting...', 'error');
                        break;
                    case 'connected':
                        this.isReconnecting = false;
                        this.isPoorConnection = false;
                        this.isPoorConnection = false;
                        this.callStatus = 'Connected';
                        // SUCCESS: Clear the timeout timer
                        clearTimeout(this.iceTimeoutTimer);
                        this.showToast('Call Status', 'Connected!', 'success');
                        clearInterval(this.callTimer);
                        this.callTimer = setInterval(() => { this.callDuration++; }, 1000);
                        break;
                    case 'new':
                    case 'connecting':
                        this.callStatus = 'Connecting...';
                        break;
                }
            };

            this.processPendingSignaling();
        },
        handleCallTimeout() {
            if (this.isCalling && this.callStatus !== 'Connected') {
                this.showToast('Call Failed', 'Connection timeout. The network might be blocking the call.', 'error');
                this.endCall(true, true);
            }
        },
        async processPendingSignaling() {
            if (!this.peerConnection) {
                return;
            }

            if (this.pendingRemoteDescription) {
                try {
                    const desc = new RTCSessionDescription(
                        typeof this.pendingRemoteDescription === 'string' 
                        ? JSON.parse(this.pendingRemoteDescription) 
                        : this.pendingRemoteDescription
                    );
                    await this.peerConnection.setRemoteDescription(desc);
                    this.pendingRemoteDescription = null;
                    console.log("Remote Description Set Successfully");
                } catch (error) {
                    console.error('Failed to apply remote description:', error);
                }
            }

            // CRITICAL: Flush candidates only AFTER remote description is set
            if (this.peerConnection.remoteDescription && this.pendingIceCandidates.length > 0) {
                const queuedCandidates = [...this.pendingIceCandidates];
                this.pendingIceCandidates = [];
                for (const candidate of queuedCandidates) {
                    await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch(error => {
                        console.warn('Failed to add queued ICE candidate:', error);
                    });
                }
            }
        },
        pollCallStatus() {
            // Polling deprecated in favor of Socket events (call_accepted, call_ended)
        },
        acceptCall() {
            const callData = this.incomingCall;
            this.incomingCall = null;
            document.getElementById('ringing-sound')?.pause();
            clearInterval(this.vibrationInterval);
            if (navigator.vibrate) navigator.vibrate(0); // Stop vibration
            clearTimeout(this.callTimeoutTimer);
            this.isNetworkBlocked = false;

            const chatInList = this.chats.find(c => c.id.toString() === callData.caller_id.toString());
            if (chatInList) chatInList.callInProgress = true;

            let caller = this.friends.find(f => f.id == callData.caller_id) || { id: callData.caller_id, name: callData.name, avatar: callData.avatar };
            this.activeChat = caller;
            this.isCalling = true;
            this.callType = callData.type;
            this.currentCallId = callData.id;
            this.callStatus = 'Connecting...';
            this.callDuration = 0;
              
            const iceServers = await this.apiFetch('/api/get_ice_credentials');
            this.setupPeerConnection(iceServers);


            navigator.mediaDevices.getUserMedia({
                video: this.callType === 'video',
                audio: true
           }).then(async stream => {
                this.localStream = Alpine.raw(stream);
                if (this.callType === 'video') {
                    this.$refs.localVideo.srcObject = stream;
                    this.$refs.localVideo.muted = true; // Mute local preview
                }
                
                this.localStream.getTracks().forEach(track => this.peerConnection.addTrack(track, this.localStream));

                // Set the offer first
                this.pendingRemoteDescription = callData.sdp;
                await this.processPendingSignaling();

                const answer = await this.peerConnection.createAnswer();
                await this.peerConnection.setLocalDescription(answer);
                
                this.socket.emit('answer_call', {
                    callId: callData.id,
                    to: callData.caller_id,
                    signal: answer
                });
            }).catch(err => {
                this.showToast('Call Error', 'Failed to access camera/mic.', 'error');
                this.endCall();
            });
        },
        rejectCall() {
            if (!this.incomingCall) return;
            this.socket.emit('reject_call', { callId: this.incomingCall.id.toString(), to: this.incomingCall.caller_id.toString() });
            clearInterval(this.vibrationInterval);
            if (navigator.vibrate) navigator.vibrate(0);
            this.incomingCall = null;
            document.getElementById('ringing-sound')?.pause();
            this.activeChat = null; // Restore bottom nav visibility
        },
        endCall(shouldLog = true, shouldEmit = true) {
            if (!this.isCalling && !this.incomingCall) return;

            clearInterval(this.vibrationInterval);
            if (navigator.vibrate) navigator.vibrate(0);
            clearTimeout(this.callTimeoutTimer);
            clearTimeout(this.iceTimeoutTimer);

            if (this.isCallRecording && this.callRecorder && this.callRecorder.state !== 'inactive') {
                this.callRecorder.stop();
                this.isCallRecording = false;
            }
            
            // Notify via Socket (ensure activeChat.id is string)
            const chatInList = this.chats.find(c => c.id.toString() === this.activeChat?.id.toString());
            if (chatInList) chatInList.callInProgress = false;

            if (this.activeChat && shouldEmit) {
                this.socket.emit('end_call', { // Ensure activeChat.id and currentCallId are strings
                    callId: this.currentCallId, 
                    to: this.activeChat.id, 
                    duration: this.callDuration 
                });
            }

            const wasConnected = this.callStatus === 'Connected';
            this.isCalling = false;
            clearInterval(this.callTimer);
            clearInterval(this.connectionInterval);
            this.isPoorConnection = false;
            this.isReconnecting = false;
            this.isNetworkBlocked = false;
            const ringingSound = document.getElementById('ringing-sound');
            if (ringingSound) {
                ringingSound.pause();
                ringingSound.currentTime = 0;
            }
            this.localStream?.getTracks().forEach(track => track.stop());
            this.localStream = null;
            if (this.peerConnection) this.peerConnection.close();
            this.peerConnection = null;
            this.pendingRemoteDescription = null;
            this.pendingIceCandidates = [];
            this.currentCallId = null;
            this.$refs.remoteVideo.pause();
            this.$refs.remoteVideo.srcObject = null;

            if (this.activeChat && shouldLog) { // Ensure activeChat.id is string
                if (!this.chatMessages[this.activeChat.id]) this.chatMessages[this.activeChat.id] = [];
                
                let messageContent = '';
                if (wasConnected) {
                    messageContent = `${this.callType === 'voice' ? 'Voice' : 'Video'} call ended • ${this.formatRecordingTime(this.callDuration)}`;
                } else {
                    messageContent = `Missed ${this.callType === 'voice' ? 'voice' : 'video'} call`;
                }

                // Send call log to chat
                this.sendMessage(null, 'call_log', messageContent);
            }
            
            this.callStatus = '';
            this.callDuration = 0;
            this.isCallMinimized = false;
            
            if (!this.isMessaging) {
                this.activeChat = null; // Restore bottom nav if not in Messaging tab
            }
            this.isCallChatOpen = false;
            this.minimizedCallTransform = { x: 0, y: 0 };
        },
        toggleSpeaker() {
            this.isSpeakerOn = !this.isSpeakerOn;
            // This is a simplified toggle for UI/UX purposes.
            // A real implementation would use setSinkId() on the audio/video element.
            if (this.$refs.remoteAudio) this.$refs.remoteAudio.muted = !this.isSpeakerOn;
            if (this.$refs.remoteVideo) this.$refs.remoteVideo.muted = !this.isSpeakerOn;
        },
        toggleCallRecording() {
            if (this.isCallRecording) {
                this.callRecorder.stop();
                this.isCallRecording = false;
            } else {
                if (!this.localStream) return;
                try {
                    this.callChunks = [];
                    this.callRecorder = Alpine.raw(new MediaRecorder(this.localStream));
                    this.callRecorder.ondataavailable = (e) => {
                        if (e.data.size > 0) this.callChunks.push(e.data);
                    };
                    this.callRecorder.onstop = () => {
                        const blob = new Blob(this.callChunks, { type: this.callType === 'video' ? 'video/webm' : 'audio/webm' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.style.display = 'none';
                        a.href = url;
                        a.download = `call_recording_${Date.now()}.webm`;
                        document.body.appendChild(a);
                        a.click();
                        window.URL.revokeObjectURL(url);
                        document.body.removeChild(a);
                    };
                    this.callRecorder.start();
                    this.isCallRecording = true;
                } catch (err) {
                    this.showToast('Error', 'Could not start recording.', 'error');
                }
            }
        },
        updateBatteryStatus(battery) {
            this.batteryLevel = battery.level * 100;
            this.isCharging = battery.charging;
        },
        switchCamera() {
            if (this.callType !== 'video' || this.isScreenSharing) return;
            this.facingMode = this.facingMode === 'user' ? 'environment' : 'user';
            if (this.localStream) {
                this.localStream.getTracks().forEach(track => track.stop());
            }
            navigator.mediaDevices.getUserMedia({
                video: { facingMode: this.facingMode },
                audio: true
            }).then(stream => {
                this.localStream = Alpine.raw(stream);
                this.$refs.localVideo.srcObject = stream;
                if (this.isMicMuted) stream.getAudioTracks().forEach(track => track.enabled = false);
            }).catch(err => {
                this.showToast('Error', 'Could not switch camera.', 'error');
            });
        },
        toggleScreenShare() {
            if (this.callType !== 'video') return;
            if (this.isScreenSharing) {
                this.isScreenSharing = false;
                if (this.localStream) this.localStream.getTracks().forEach(track => track.stop());
                navigator.mediaDevices.getUserMedia({ video: { facingMode: this.facingMode }, audio: true }).then(stream => {
                    this.localStream = Alpine.raw(stream);
                    this.$refs.localVideo.srcObject = stream;
                    if (this.isMicMuted) stream.getAudioTracks().forEach(track => track.enabled = false);
                });
            } else {
                navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }).then(stream => {
                    this.isScreenSharing = true;
                    if (this.localStream) this.localStream.getTracks().forEach(track => track.stop());
                    this.localStream = Alpine.raw(stream);
                    this.$refs.localVideo.srcObject = stream;
                    stream.getVideoTracks()[0].onended = () => { if (this.isScreenSharing) this.toggleScreenShare(); };
                }).catch(err => { });
            }
        },
        dragStart(event) {
            this.isDragging = true;
            const touch = event.touches ? event.touches[0] : null;
            this.dragInfo.startX = touch ? touch.clientX : event.clientX;
            this.dragInfo.startY = touch ? touch.clientY : event.clientY;
            this.dragInfo.initialX = this.minimizedCallTransform.x;
            this.dragInfo.initialY = this.minimizedCallTransform.y;
        },
        dragMove(event) {
            if (!this.isDragging) return;
            const touch = event.touches ? event.touches[0] : null;
            const currentX = touch ? touch.clientX : event.clientX;
            const currentY = touch ? touch.clientY : event.clientY;
            const dx = currentX - this.dragInfo.startX;
            const dy = currentY - this.dragInfo.startY;
            this.minimizedCallTransform.x = this.dragInfo.initialX + dx;
            this.minimizedCallTransform.y = this.dragInfo.initialY + dy;
        },
        dragEnd() {
            this.isDragging = false;
        },
        startCreatePostDrag(e) {
            if (window.innerWidth >= 1024) {
                this.isCreatePostDragging = true;
                this.createPostStart.x = e.clientX - this.createPostOffset.x;
                this.createPostStart.y = e.clientY - this.createPostOffset.y;
            }
        },
        handleCreatePostDrag(e) {
            if (this.isCreatePostDragging) {
                this.createPostOffset.x = e.clientX - this.createPostStart.x;
                this.createPostOffset.y = e.clientY - this.createPostStart.y;
            }
        },
        stopCreatePostDrag() {
            this.isCreatePostDragging = false;
        },
        saveCreatePostDraft() {
            localStorage.setItem('maiga_create_post_draft', JSON.stringify({
                newPostContent: this.newPostContent,
                newPostFeeling: this.newPostFeeling,
                postBgStyleIndex: this.postBgStyleIndex,
                selectedMedia: this.selectedMedia, // This will be a Data URL or Blob URL
                mediaType: this.mediaType
            }));
        },
        loadCreatePostDraft() {
            const savedDraft = localStorage.getItem('maiga_create_post_draft');
            if (savedDraft) {
                const draft = JSON.parse(savedDraft);
                this.newPostContent = draft.newPostContent || '';
                this.newPostFeeling = draft.newPostFeeling || '';
                this.postBgStyleIndex = draft.postBgStyleIndex !== undefined ? draft.postBgStyleIndex : -1;
                this.selectedMedia = draft.selectedMedia || null;
                this.mediaType = draft.mediaType || null;

                // Only auto-open the modal if there is actual content in the draft
                if ((this.newPostContent && this.newPostContent.trim()) || this.selectedMedia) {
                    this.isCreatingPost = true;
                    // Reconstruct postFile if selectedMedia exists and is a data URL
                    if (this.selectedMedia && this.selectedMedia.startsWith('data:')) {
                        fetch(this.selectedMedia)
                            .then(res => res.blob())
                            .then(blob => {
                                this.postFile = new File([blob], `draft_${Date.now()}.jpg`, { type: blob.type });
                            });
                    }
                }
            }
        },
        setupReelsObserver() {
            if (this.observer) this.observer.disconnect();
            if (!this.$refs.reelsContainer) return;

            const options = {
                root: this.$refs.reelsContainer,
                threshold: 0.8, // Be stricter about what counts as "active"
            };

            this.observer = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    const video = entry.target.querySelector('video');
                    if (!video) return;

                    const reelId = entry.target.dataset.reelId; // Ensure reel.id is string
                    const reel = this.reels.find(r => r.id == reelId);

                    if (entry.isIntersecting) {
                        // Ensure all other videos are paused before playing this one
                        document.querySelectorAll('video[id^="reel-video-"]').forEach(v => {
                            if (v !== video) { v.pause(); v.muted = true; }
                        });
                        
                        video.muted = this.isReelsMuted;
                        video.play().catch(error => {
                            if (error && error.name === 'AbortError') return;
                        });

                        // PREFETCH LOGIC: Fetch the next 2 reels to ensure instant playback on swipe
                        const currentIndex = this.reels.findIndex(r => r.id == reelId);
                        for (let i = 1; i <= 2; i++) {
                            const nextReel = this.reels[currentIndex + i];
                            if (nextReel && nextReel.media) {
                                const link = document.createElement('link');
                                link.rel = 'prefetch';
                                link.href = nextReel.media;
                                document.head.appendChild(link);
                            }
                        }

                        // Swipe Hint Logic
                        clearTimeout(this.reelHintTimer);
                        this.showSwipeHint = false;
                        this.reelHintTimer = setTimeout(() => {
                            if (this.activeTab === 'reels') this.showSwipeHint = true;
                        }, 15000); // Show hint after 15 seconds

                        // Endless Reels Logic: Trigger load more when reaching the last element
                        if (entry.target === this.$refs.reelsContainer.lastElementChild) {
                            this.loadMoreReels();
                        }

                        // Increment view count after 2 seconds of consistent viewing
                        if (reel && !this.viewedReels.has(reel.id)) {
                            clearTimeout(reel.viewTimer);
                            reel.viewTimer = setTimeout(() => {
                                if (entry.isIntersecting) {
                                    this.viewedReels.add(reel.id.toString());
                                    reel.views = (reel.views || 0) + 1;
                                    this.apiFetch('/api/increment_reel_view', {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF_TOKEN },
                                        body: JSON.stringify({ post_id: reel.id.toString() })
                                    });
                                }
                            }, 2000);
                        }
                        if (reel) reel.seen = true;
                    } else {
                        video.pause();
                        video.muted = true;
                        video.currentTime = 0;
                    }
                });
            }, options);

            // New logic for loading more
             const lastReel = this.$refs.reelsContainer.querySelector('.snap-start:last-child');
            if (lastReel) {
                this.observer.observe(lastReel);
            }



             this.$refs.reelsContainer.querySelectorAll('.snap-start').forEach(reel => {
                this.observer.observe(reel);
            });
        },
        stopAllReels() {
            document.querySelectorAll('video[id^="reel-video-"]').forEach(video => {
                video.pause();
            });
        },
        scrollToNextReel(index) {
            if (index < this.reels.length - 1) {
                const reelHeight = this.$refs.reelsContainer.clientHeight;
                this.$refs.reelsContainer.scrollTo({ top: reelHeight * (index + 1), behavior: 'smooth' });
            }
        },
        refreshHomeFeed(withAnimation = true) {
            this.page = 1;
            this.hasMorePosts = true;
            localStorage.setItem('maiga_home_page', '1');
            let url = '/api/get_posts?page=1';
            if (this.activeHashtag) {
                url += `&hashtag=${encodeURIComponent(this.activeHashtag)}`;
            }
            
            return this.apiFetch(url)
                .then(data => {
                    if (data) this.posts = data;
                }).finally(() => {
                if (!withAnimation) return;
                this.isRefreshing = false;
                this.pullStartY = 0;
                this.pullDistance = 0;
            }).catch(() => this.isRefreshing = false);
        },
        loadMorePosts() {
            if (this.isLoadingMore || !this.hasMorePosts) return Promise.resolve();
            this.isLoadingMore = true;
            this.page++;
            localStorage.setItem('maiga_home_page', String(this.page));
            let url = `/api/get_posts?page=${this.page}`;
            if (this.activeHashtag) {
                url += `&hashtag=${encodeURIComponent(this.activeHashtag)}`;
            }

            return this.apiFetch(url)
                .then(data => {
                    if (data && data.length > 0) {
                        this.posts = [...this.posts, ...data];
                        if (data.length < 20) this.hasMorePosts = false; // If we got fewer than 20 posts, no more available
                    } else {
                        this.hasMorePosts = false;
                    }
                }).catch(() => {
                    this.page = Math.max(1, this.page - 1);
                }).finally(() => {
                    this.isLoadingMore = false;
                });
        },
        loadMoreReels() {
            if (this.isLoadingMoreReels) return Promise.resolve();
            this.isLoadingMoreReels = true;
            this.reelPage++;
            localStorage.setItem('maiga_reel_page', String(this.reelPage));
            return this.apiFetch(`/api/get_reels?page=${this.reelPage}&limit=5`)
                .then(data => {
                    if (data && data.length > 0) {
                        const mapped = data.filter(r => !this.hiddenReelDepts.includes(r.dept)).map(r => ({...r, showHeart: false, liked: !!r.liked, isExpanded: false, isLoading: true, progress: 0, showStatusIcon: false, lastAction: '', hasError: false}));
                        this.reels = [...this.reels, ...mapped];
                    }
                }).catch(() => {
                    this.reelPage = Math.max(1, this.reelPage - 1);
                }).finally(() => {
                    this.isLoadingMoreReels = false;
                });
        },
        async loadMoreFriends() {
            if (this.isLoadingMoreFriends || !this.hasMoreFriends) return;
            this.isLoadingMoreFriends = true;
            this.friendsPage++;

            const data = await this.apiFetch(`/api/friends/suggestions?page=${this.friendsPage}&limit=${this.friendsLimit}`);
            
            if (data && Array.isArray(data.users)) {
                this.friends = [...this.friends, ...data.users];
                this.hasMoreFriends = data.hasMore;
                localStorage.setItem('maiga_friends_cache', JSON.stringify(this.friends));
            } else {
                this.friendsPage--; // Revert page number on error
                this.showToast('Error', 'Failed to load more suggestions.', 'error');
            }

            this.isLoadingMoreFriends = false;
        },

        async fetchSecurityData() {
            const data = await this.apiFetch('/api/get_security_data');
            if (data) this.loginSessions = data;
        },
        handleScroll(el) {
            // Contextual Header Logic
            let st = el.scrollTop;
            this.hasScrolled = st > 10;
            this.lastScrollTop = st <= 0 ? 0 : st;

            this.hasScrolled = el.scrollTop > 10;
            this.showScrollTop = (el.scrollTop > 300);
            localStorage.setItem('maiga_home_scroll', String(el.scrollTop));
            // More aggressive loading - trigger when within 200px of bottom instead of 100px
            if (el.scrollTop + el.clientHeight >= el.scrollHeight - 200) {
                this.loadMorePosts();
            }
        },
        handleReelsScroll(el) {
            if (!el) return;
            localStorage.setItem('maiga_reel_scroll', String(el.scrollTop));
            if (el.scrollTop + el.clientHeight >= el.scrollHeight - 100) {
                this.loadMoreReels();
            }
        },
        async restoreScrollState() {
            if (this.restoreStateRan) return;

            const savedHomeScroll = parseInt(localStorage.getItem('maiga_home_scroll') || '0', 10);
            const savedHomePage = parseInt(localStorage.getItem('maiga_home_page') || '1', 10);
            const savedReelScroll = parseInt(localStorage.getItem('maiga_reel_scroll') || '0', 10);
            const savedReelPage = parseInt(localStorage.getItem('maiga_reel_page') || '1', 10);
            const savedActiveTab = localStorage.getItem('maiga_active_tab');
            const needReelsRestore = savedReelPage > 1 || savedReelScroll > 0;



            if (!this.posts.length) return;
            if (needReelsRestore && !this.reels.length) return;

            this.restoreStateRan = true;

            while (this.page < savedHomePage && this.hasMorePosts) {
                await this.loadMorePosts();
            }

            this.$nextTick(() => {
                if (this.$refs.mainContent && savedHomeScroll > 0) {
                    this.$refs.mainContent.scrollTop = savedHomeScroll;
                }
            });

            if (needReelsRestore) {
                while (this.reelPage < savedReelPage) {
                    await this.loadMoreReels();
                }
                this.$nextTick(() => {
                    if (this.$refs.reelsContainer && savedReelScroll > 0) {
                        this.$refs.reelsContainer.scrollTop = savedReelScroll;
                    }
                });
            }
        },
        scrollReel(direction) {
            if (this.activeTab !== 'reels') return;
            const container = this.$refs.reelsContainer;
            const reelHeight = container.getBoundingClientRect().height;
            const currentIndex = Math.round(container.scrollTop / reelHeight);
            const nextIndex = Math.max(0, Math.min(this.reels.length - 1, currentIndex + direction));
            container.scrollTo({
                top: reelHeight * nextIndex,
                behavior: 'auto'
            });
        },
        shareReel(reel) {
            if (navigator.share) {
                navigator.share({ // Ensure reel.id is string
                    title: 'Check out this reel on Maiga Social!',
                    text: reel.caption,
                    url: window.location.href
                }).then(() => {
                    this.triggerShareAnimation(reel);
                    this.showToast('Shared', 'Reel shared successfully!', 'success');
                }).catch((error) => console.log('Error sharing', error));
            } else {
                this.sharingPost = { ...reel, media_type: 'video' };
                this.showShareModal = true;
            }
        },
        markNotInterested(reel) {
            if (reel.dept) {
                this.hiddenReelDepts.push(reel.dept);
                localStorage.setItem('maiga_hidden_depts', JSON.stringify(this.hiddenReelDepts));
                this.reels = this.reels.filter(r => r.dept !== reel.dept);
                this.showToast('Preference Saved', `Hiding similar reels from ${reel.dept}.`, 'success');
            } else {
                this.reels = this.reels.filter(r => r.id.toString() !== reel.id.toString());
                this.showToast('Feedback', 'We will show less like this.', 'info');
            }
            this.showReelOptions = false;
            this.showReelMenu = false;
        },
        reportReel(reel) {
            if (!reel || (!reel.user_id && (!reel.user || !reel.user.id))) {
                this.showToast('Error', 'Cannot report this reel.', 'error');
                this.showReelOptions = false;
                return;
            }
            this.openReportModal('reel', reel);
        },
        openReportModal(type, target) {
            this.reportForm = {
                title: '', description: '', screenshot: null, preview: null,
                targetType: type,
                priority: 'low',
                targetId: target.id.toString(),
                targetUserId: type === 'user' ? target.id.toString() : (target.user_id?.toString() || (target.user ? (target.user.id || target.user._id).toString() : null))
            };
            this.showPostOptions = false;
            this.showReelOptions = false;
            this.showStoryShareOptions = false;
            this.showUserProfile = false;
            this.isReporting = true;
        },
        handleReportScreenshot(event) {
            const file = event.target.files[0];
            if (!file) return;
            this.reportForm.screenshot = file;
            const reader = new FileReader();
            reader.onload = (e) => { this.reportForm.preview = e.target.result; };
            reader.readAsDataURL(file);
        },
        submitReport() {
            if (!this.reportForm.title || !this.reportForm.description) {
                this.showToast('Error', 'Please fill in all fields.', 'error');
                return;
            }
            this.isSubmittingReport = true;
            const formData = new FormData();
            formData.append('user_id', this.reportForm.targetUserId);
            formData.append('reason', this.reportForm.title);
            formData.append('details', this.reportForm.description + `\n(Reported ${this.reportForm.targetType} ID: ${this.reportForm.targetId.toString()})`);
            formData.append('priority', this.reportForm.priority);
            if (this.reportForm.screenshot) {
                formData.append('screenshot', this.reportForm.screenshot);
            }

            this.apiFetch('/api/report_user', {
                method: 'POST',
                headers: { 'X-CSRF-Token': CSRF_TOKEN },
                body: formData
            }).then(data => {
                if (data && data.success) {
                    this.showToast('Report Submitted', 'Thank you for your report.', 'success');
                    this.isReporting = false;
                } else {
                    this.showToast('Error', data.error || 'Failed to submit report.', 'error');
                }
            }).catch(err => {
                this.showToast('Error', 'Network error during upload.', 'error');
            }).finally(() => { 
                this.isSubmittingReport = false; 
            });
        },
         isCallMenuOpen: false,
        startVoiceSearch() {
            if (!('webkitSpeechRecognition' in window)) {
                this.showToast('Error', 'Voice search not supported in your browser.', 'error');
                return;
            }

            const recognition = new webkitSpeechRecognition();
            recognition.continuous = false;
            recognition.interimResults = false;
            recognition.lang = 'en-US';

            recognition.onstart = () => {
                this.showToast('Voice Search', 'Listening...', 'info');
            };

            recognition.onresult = (event) => {
                this.isSearchFocused = true; // Ensure search bar stays focused
                const transcript = event.results[0][0].transcript;
                this.homeSearchQuery = transcript;
                this.showToast('Voice Search', `Recognized: "${transcript}"`, 'success');
            };

            recognition.onerror = (event) => {
                this.showToast('Error', `Voice search error: ${event.error}`, 'error');
            };

            recognition.onend = () => {
                // Optional: Add a toast to indicate listening has stopped if needed
            };

            recognition.start();
        },
        async initPushNotifications() {
            if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
            if (Notification.permission === 'denied') {
                console.info('Push notification permission has been denied by the user.');
                return;
            }

            if (Notification.permission === 'default') {
                try {
                    const permission = await Notification.requestPermission();
                    if (permission !== 'granted') {
                        console.info('Push notification permission not granted:', permission);
                        return;
                    }
                } catch (err) {
                    console.warn('Notification permission request failed:', err);
                    return;
                }
            }

            // Register Service Worker if not already done
            try {
                const appType = this.user.account_type || 'maiga';
                await navigator.serviceWorker.register(`/sw.js?app=${appType}`);
                const registration = await navigator.serviceWorker.ready;

                const vapidResp = await fetch(`${API_BASE_URL}/api/vapid_public_key`);
                if (!vapidResp.ok) {
                    console.warn('VAPID key endpoint not found. Push notifications disabled.');
                    return;
                }

                const { publicKey } = await vapidResp.json();
                if (!publicKey || publicKey.includes('REPLACE')) return;

                const convertedVapidKey = this.urlBase64ToUint8Array(publicKey);

                let subscription = await registration.pushManager.getSubscription();
                if (!subscription) {
                    subscription = await registration.pushManager.subscribe({
                        userVisibleOnly: true,
                        applicationServerKey: convertedVapidKey
                    });
                }

                if (!subscription) {
                    console.warn('Push subscription failed or was not created.');
                    return;
                }

                await this.apiFetch('/api/subscribe', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF_TOKEN },
                    body: JSON.stringify(subscription)
                });

                console.info('Push notifications are enabled for this user.');
            } catch (e) {
                console.warn('Service Worker or Push registration failed:', e);
            }
        },
        async enablePushNotifications() {
            this.pushPermission = Notification.permission || 'default';
            if (!this.supportsPush) {
                this.showToast('Unsupported', 'Push notifications are not supported in this browser.', 'error');
                return;
            }
            if (this.pushPermission === 'denied') {
                this.showToast('Notifications Blocked', 'Please enable notifications in your browser settings.', 'error');
                return;
            }
            await this.initPushNotifications();
            this.pushPermission = Notification.permission || 'default';
            if (this.pushPermission === 'granted') {
                this.showToast('Notifications Enabled', 'You will now receive push updates.', 'success');
            }
        },
        urlBase64ToUint8Array(base64String) {
            const padding = '='.repeat((4 - base64String.length % 4) % 4);
            const base64 = (base64String + padding)
                .replace(/-/g, '+')
                .replace(/_/g, '/');

            const rawData = window.atob(base64);
            const outputArray = new Uint8Array(rawData.length);

            for (let i = 0; i < rawData.length; ++i) {
                outputArray[i] = rawData.charCodeAt(i);
            }
            return outputArray;
        },
        // --- E2EE CRYPTO HELPERS ---
        crypto: {
            db: null,
            dbName: 'maiga_crypto',
            storeName: 'keys',
            keyAlgo: {
                name: "RSA-OAEP",
                modulusLength: 2048,
                publicExponent: new Uint8Array([1, 0, 1]),
                hash: "SHA-256",
            },
            aesAlgo: { name: "AES-GCM", length: 256 },
            app: null,

            async init(appInstance) {
                this.app = appInstance;
                return new Promise((resolve, reject) => {
                    const request = indexedDB.open(this.dbName, 3); // Standardized to v3
                    request.onupgradeneeded = e => {
                        this.db = e.target.result;
                        if (!this.db.objectStoreNames.contains(this.storeName)) {
                            this.db.createObjectStore(this.storeName, { keyPath: 'id' });
                        }
                        if (!this.db.objectStoreNames.contains('pending_messages')) {
                            this.db.createObjectStore('pending_messages', { keyPath: 'id', autoIncrement: true });
                        }
                        if (!this.db.objectStoreNames.contains('pending_posts')) {
                            this.db.createObjectStore('pending_posts', { keyPath: 'id', autoIncrement: true });
                        }
                    };
                    request.onsuccess = e => { 
                        this.db = e.target.result; 
                        // Load existing pending items into UI on init
                        this.loadPendingUI();
                        resolve(); };
                    request.onerror = e => { reject(e.target.error); };
                });
            },

             async loadPendingUI() {
                const txPosts = this.db.transaction('pending_posts', 'readonly');
                const storePosts = txPosts.objectStore('pending_posts');
                storePosts.getAll().onsuccess = (e) => {
                    this.app.pendingPosts = e.target.result.map(p => ({ ...p, pending: true, author: this.app.user.name, avatar: this.app.user.avatar, time: 'Waiting for network...' }));
                };
            },

            async refreshPendingTokens(newToken) {
                return new Promise((resolve) => {
                    const tx = this.db.transaction('pending_posts', 'readwrite');
                    const store = tx.objectStore('pending_posts');
                    store.getAll().onsuccess = (e) => {
                        e.target.result.forEach(post => {
                            post.csrfToken = newToken;
                            store.put(post);
                        });
                        resolve();
                    };
                });
            },

            async _get(key) {
                return new Promise((resolve, reject) => {
                    const tx = this.db.transaction(this.storeName, 'readonly');
                    const store = tx.objectStore(this.storeName);
                    const request = store.get(key);
                    request.onsuccess = e => resolve(e.target.result?.value);
                    request.onerror = e => reject(e.target.error);
                });
            },

            async _set(key, value) {
                return new Promise((resolve, reject) => {
                    const tx = this.db.transaction(this.storeName, 'readwrite');
                    const store = tx.objectStore(this.storeName);
                    store.put({ id: key, value: value });
                    tx.oncomplete = () => resolve();
                    tx.onerror = e => reject(e.target.error);
                });
            },

            async savePendingMessage(msg) {
                return new Promise((resolve, reject) => {
                    const tx = this.db.transaction('pending_messages', 'readwrite');
                    const store = tx.objectStore('pending_messages');
                    store.add(msg);
                    tx.oncomplete = () => resolve();
                    tx.onerror = e => reject(e.target.error);
                });
            },

            async savePendingPost(post) {
                return new Promise((resolve, reject) => {
                    const tx = this.db.transaction('pending_posts', 'readwrite');
                    const store = tx.objectStore('pending_posts');
                    store.add(post);
                    tx.oncomplete = () => resolve();
                    tx.onerror = e => reject(e.target.error);
                });
            },

            async hasKeys() {
                return !!(await this._get('privateKey'));
            },

            async generateAndStoreKeys() {
                const keyPair = await window.crypto.subtle.generateKey(this.keyAlgo, true, ["encrypt", "decrypt"]);
                await this._set('privateKey', keyPair.privateKey);
                await this._set('publicKey', keyPair.publicKey);
                
                const publicKeyJwk = await window.crypto.subtle.exportKey("jwk", keyPair.publicKey);
                await this.uploadPublicKey(publicKeyJwk);
            },

            async uploadPublicKey(jwk) {
                await this.app.apiFetch('/api/update_public_key', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF_TOKEN },
                    body: JSON.stringify({ public_key: JSON.stringify(jwk) })
                });
            },

            getPrivateKey() { return this._get('privateKey'); },
            getPublicKey() { return this._get('publicKey'); },

            async fetchPublicKey(userId) {
                const data = await this.app.apiFetch(`/api/get_public_key?user_id=${userId}`);
                if (!data || !data.public_key) return null;
                const jwk = JSON.parse(data.public_key);
                return window.crypto.subtle.importKey("jwk", jwk, this.keyAlgo, true, ["encrypt"]);
            },

            // Hybrid Encryption
            async encrypt(text, theirPublicKey) {
                const symKey = await window.crypto.subtle.generateKey(this.aesAlgo, true, ["encrypt", "decrypt"]);
                const iv = window.crypto.getRandomValues(new Uint8Array(12));
                
                const encodedText = new TextEncoder().encode(text);
                const encryptedText = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv }, symKey, encodedText);
                
                const exportedSymKey = await window.crypto.subtle.exportKey("raw", symKey);
                const encryptedSymKey = await window.crypto.subtle.encrypt(this.keyAlgo, theirPublicKey, exportedSymKey);

                // Helper to convert ArrayBuffer to Base64
                const bufferToBase64 = buffer => btoa(String.fromCharCode(...new Uint8Array(buffer)));

                return {
                    key: bufferToBase64(encryptedSymKey),
                    iv: bufferToBase64(iv),
                    data: bufferToBase64(encryptedText)
                };
            },

            // Hybrid Decryption
            async decrypt(payload, myPrivateKey) {
                if (!myPrivateKey) throw new Error("Private key not available.");
                
                const { key, iv, data } = JSON.parse(payload);

                // Helper to convert Base64 to ArrayBuffer
                const base64ToBuffer = base64 => Uint8Array.from(atob(base64), c => c.charCodeAt(0)).buffer;

                const encryptedSymKey = base64ToBuffer(key);
                const ivBuffer = base64ToBuffer(iv);
                const encryptedText = base64ToBuffer(data);

                const decryptedSymKeyData = await window.crypto.subtle.decrypt(this.keyAlgo, myPrivateKey, encryptedSymKey);
                const symKey = await window.crypto.subtle.importKey("raw", decryptedSymKeyData, this.aesAlgo, true, ["encrypt", "decrypt"]);

                const decryptedText = await window.crypto.subtle.decrypt({ name: "AES-GCM", iv: ivBuffer }, symKey, encryptedText);

                return new TextDecoder().decode(decryptedText);
            },

            async editMessage(messageId, newContent) {
                // This is a simplified version. A real implementation would need to consider
                // which user's public key to use if the original was E2EE.
                // For now, we assume we are editing our own message and re-encrypting for the same recipient.
                const originalMessage = this.app.chatMessages[this.app.activeChat.id].find(m => m.id === messageId);
                if (!originalMessage) return;

                let contentToSend = newContent;
                let mediaType = 'text';

                // If original was E2EE, re-encrypt
                if (originalMessage.type === 'e2ee' || originalMessage.media_type === 'e2ee') {
                    const theirPublicKey = await this.fetchPublicKey(this.app.activeChat.id);
                    if (theirPublicKey) {
                        const encryptedPayload = await this.encrypt(newContent, theirPublicKey);
                        contentToSend = JSON.stringify(encryptedPayload);
                        mediaType = 'e2ee';
                    } 
                }

                // The API needs to be updated to handle `media_type` on edit
                await this.app.apiFetch('/api/edit_message', {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': CSRF_TOKEN
                    },
                    body: JSON.stringify({ message_id: messageId, content: contentToSend, media_type: mediaType })
                });
            }
        }
    }));
};

// Handle registration for both immediate load and deferred Alpine load
document.addEventListener('alpine:init', initMaiga);
if (window.Alpine) initMaiga();
