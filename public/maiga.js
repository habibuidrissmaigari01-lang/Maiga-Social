// Define CSRF_TOKEN globally to prevent ReferenceErrors
const CSRF_TOKEN = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '';

// Automatically switch between local and production backend
const API_BASE_URL = (function() {
    const host = window.location.hostname;
    return (host === 'localhost' || host === '127.0.0.1') ? 'http://localhost:3000' : '';
})();

let isMaigaInitialized = false;
const initMaiga = () => {
    if (isMaigaInitialized) return;

    // Helper function for formatting post content (hashtags, mentions)
    window.formatContent = (content) => {
        if (!content) return '';
        content = content.replace(/</g, "&lt;").replace(/>/g, "&gt;"); // Basic sanitize
        content = content.replace(/#(\w+)/g, '<a href="#" class="text-blue-500 hover:underline" onclick="openHashtag(\'$1\'); return false;">#$1</a>');
        content = content.replace(/@(\w+)/g, '<a href="#" class="text-blue-500 hover:underline" onclick="openUserProfileByName(\'$1\'); return false;">@$1</a>');
        return content;
    };

    isMaigaInitialized = true;
    Alpine.data('appData', () => ({
        init() {
            this.mainInit();
            this.arAssets.hat.src = 'https://img.icons8.com/color/96/party-hat.png'; // Reliable online URL
            this.arAssets.background.src = 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?q=80&w=1080&auto=format&fit=crop';
            // Load recently used stickers from local storage
            const savedRecents = localStorage.getItem('recent_stickers');
            if (savedRecents) {
                this.recentlyUsedStickers = JSON.parse(savedRecents);
            }
            this.initVisibilityListener();
            
            window.addEventListener('beforeinstallprompt', (e) => {
                e.preventDefault();
                this.installPrompt = e;
            });
        },
        installPrompt: null,
        // Initialize State Variables
        darkMode: localStorage.getItem('darkMode') === 'true',
        isFullScreen: localStorage.getItem('maiga_fullscreen') === 'true',      
        // Helper to prevent apiFetch crash if missing
        getMockData(url) {
            // Mocks removed to force backend connection for implemented features.
            // Only keep user mock if absolutely necessary, but implementing all means removing safety nets.
            return null;
        },

        async apiFetch(url, options = {}) {
            // Ensure CSRF token is included for non-GET requests
            if (options.method && options.method !== 'GET') {
                options.headers = {
                    ...options.headers,
                    'X-CSRF-Token': CSRF_TOKEN
                };
            }

            // Prepend Server URL if the url is relative (starts with /)
            const fullUrl = url.startsWith('/') ? `${API_BASE_URL}${url}` : url;

            try {
                const response = await fetch(fullUrl, options);
                
                if (response.status === 401) {
                    window.location.href = '/';
                    return null;
                }

                const contentType = response.headers.get('content-type');

                if (contentType && contentType.includes('application/json')) {
                    return await response.json();
                } else if (!response.ok) {
                    // Handle 502, 404, or 500 HTML error pages
                    const msg = `Server Error: ${response.status}. Please check backend logs.`;
                    this.showToast('Server Error', msg, 'error');
                    return null;
                } else {
                    // If server returns 404 (e.g. endpoint not found), try mock data
                    const mock = this.getMockData(url);
                    if (mock) return mock;
                    return null; 
                }
            } catch (error) {
                // Fallback to mock data if connection fails (server down)
                const mock = this.getMockData(url);
                if (mock) return mock;
                
                this.showToast('Network Error', 'Could not connect to the server.', 'error');
                return null;
            }
        },
        activeTab: localStorage.getItem('maiga_active_tab') || 'home',
        
        // --- CHAT & CALL STATE (Consolidated) ---
        activeMessageTab: 'all',
        chatStarFilter: false,
        callHistory: [],
        starredMessages: [],
        get missedCallsCount() {
            if (!this.callHistory || !this.user?.id) return 0;
            // Safe check for receiver existence using optional chaining
            return (this.callHistory || []).filter(c => c?.receiver?._id == this.user.id && c.is_missed).length;
        },
        get starredMessagesInActiveChat() {
            if (!this.activeChat?.id || !this.chatMessages?.[this.activeChat.id]) return [];
            return this.chatMessages[this.activeChat.id].filter(m => m.starred);
        },
        get activeChatPinnedMsg() {
            if (!this.activeChat?.id || !this.chatMessages?.[this.activeChat.id]) return null;
            return this.chatMessages[this.activeChat.id].find(m => m.pinned);
        },
        async fetchCallHistory() {
            const data = await this.apiFetch('/api/get_call_history');
            if (data) this.callHistory = data;
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
        editorTextFont: 'sans-serif',
        editorFonts: ['sans-serif', 'serif', 'monospace', 'cursive', 'fantasy', 'Arial', 'Verdana', 'Times New Roman'],
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

        isLeftSidebarCollapsed: false,
        socket: null,
        followLoading: [],
        connectionList: [],
        connectionSearchQuery: '',
        isCreatingPost: false,
        isCreatingStory: false,
        postFile: null, // Store raw file for posts
        storyFile: null,
        storyMediaPreview: null,
        textStoryStyleIndex: 0,
        musicPickerSource: 'editor', // 'editor' or 'camera'
        showMusicPicker: false,
        musicTracks: [], // Will fetch from backend
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
            { background: '#18181b', color: '#ffffff' },
            { background: '#ffffff', color: '#18181b' },
        ],
        showStoryStickerPicker: false,
        groupSearchQuery: '',
        friendsSearchQuery: '',
        friendsTab: 'suggestions',
        get unreadBadgeDisplay() {
           const count = this.totalUnreadChats || 0;
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
            if (!this.friendsSearchQuery?.trim()) return this.followingList || [];
            const q = this.friendsSearchQuery.toLowerCase();
            return (this.followingList || []).filter(f =>
                (f.name && f.name.toLowerCase().includes(q)) ||
                (f.username && f.username.toLowerCase().includes(q)) ||
                (f.dept && f.dept.toLowerCase().includes(q))
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
            return potential.filter(f => (f.name && f.name.toLowerCase().includes(q)) || (f.username && f.username.toLowerCase().includes(q)));
        },
        get filteredFriendsList() {
            if (!this.friendsSearchQuery?.trim()) return this.friends || [];
            const q = this.friendsSearchQuery.toLowerCase();
            return (this.friends || []).filter(f =>
                (f.name && f.name.toLowerCase().includes(q)) ||
                (f.username && f.username.toLowerCase().includes(q)) ||
                (f.dept && f.dept.toLowerCase().includes(q))
            );
        },
        get filteredFollowingForGroup() {
            if (!this.groupSearchQuery?.trim()) return this.followingList || [];
            const q = this.groupSearchQuery.toLowerCase();
            return (this.followingList || []).filter(f =>
                (f.name && f.name.toLowerCase().includes(q)) ||
                (f.username && f.username.toLowerCase().includes(q)) ||
                (f.dept && f.dept.toLowerCase().includes(q))
            );
        },
        isMessaging: false,
        isEditingProfile: false,
        isSideMenuOpen: false,
        isCreatingGroup: false,
        activeChat: null,
        typingUsers: [],
        showMemberOptionsFor: null,
        isAddingGroupMembers: false,
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
        isCameraRecording: false,
        recordingProgress: 0,
        cameraRecorder: null,
        cameraChunks: [],
        beautyFilter: 'none',
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
                    this.startCanvasLoop();
                };
            } catch (err) {
                this.showToast('Camera Error', 'Could not access camera. Please check permissions.', 'error');
                this.isCameraOpen = false;
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
                if (this.isDoubleExposureActive && this.$refs.secondaryVideo) {
                    ctx.globalCompositeOperation = 'screen';
                    ctx.globalAlpha = 0.5;
                    ctx.drawImage(this.$refs.secondaryVideo, 0, 0, canvas.width, canvas.height);
                    ctx.globalCompositeOperation = 'source-over';
                    ctx.globalAlpha = 1.0;
                }

                // 0. Optimized Glitch logic
                if (this.isGlitchActive && Math.random() > 0.85) {
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
                if (this.isBackgroundRemovalActive && this.segmentationMask) {
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
                    // ... existing chroma key logic
                }

                // 1. Ghost Frame Overlay (Bottom Layer)
                if (this.isGhostModeActive && this.ghostFrame) {
                    ctx.globalAlpha = 0.4;
                    ctx.drawImage(this.ghostFrame, 0, 0, canvas.width, canvas.height);
                    ctx.globalAlpha = 1.0;
                }

                // 2. Live Camera Feed
                if (this.isGreenScreenActive) {
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
                    ctx.save();
                    // Mirror the selfie camera for a professional feel
                    if (this.facingMode === 'user') {
                        ctx.translate(canvas.width, 0);
                        ctx.scale(-1, 1);
                    }
                    ctx.filter = activeFilter;
                    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                    ctx.restore();
                }
                ctx.filter = 'none';

                // 3. Draw AR Filter Elements
                if (this.isFaceMeshActive && this.faceLandmarks) {
                    this.drawARFilter(ctx);
                }

                // 3. QR Code Detection (Throttled to 1 second)
                if (this.qrDetector && !this.isCameraRecording && Date.now() - lastQrScan > 1000) {
                    lastQrScan = Date.now();
                    const codes = await this.qrDetector.detect(canvas);
                    if (codes.length > 0) {
                        const raw = codes[0].rawValue;
                        if (confirm(`QR Detected: ${raw}\n\nOpen link?`)) window.open(raw, '_blank');
                    }
                }

                // 4. Auto-Capture Face/Smile Detection (Throttled)
                if (this.faceDetector && this.isAutoCaptureActive && !this.isCameraRecording && Date.now() - lastFaceDetect > 500) {
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

                requestAnimationFrame(render);
            };
            requestAnimationFrame(render);
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
            this.isCameraRecording = false;
            if (this.cameraSource === 'post') this.isCreatingPost = true;
            if (this.cameraSource === 'story') this.isCreatingStory = true;
        },

        async triggerShutter() {
            if (this.cameraMode === 'photo') return this.takeCameraPhoto();
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
            });
        },

        startCameraRecording() {
            this.isCameraRecording = true;
            this.recordingProgress = 0;
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
                this.musicSourceNode.connect(this.audioMixer.destination); // Play locally so user can hear it
                this.$refs.cameraMusicPlayer.currentTime = 0;
                this.$refs.cameraMusicPlayer.play();
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

        typingIndicatorTimeout: null,
        isRecording: false,
        mediaRecorder: null,
        audioChunks: [],
        recordingTimer: null,
        recordingDuration: 0,
        isRecordingComment: false,
        commentRecordingDuration: 0,
        commentMediaRecorder: null,
        commentAudioChunks: [],
        commentRecordingTimer: null,
        showMessageOptions: false,
        selectedMessageForOptions: null,
        showForwardModal: false,
        messageToForward: null,
        replyingTo: null,
        isCreatingPoll: false,
        newPoll: { question: '', options: ['', ''] },
        isSchedulingMessage: false,
        scheduledTime: '',
        scheduledMessages: [],
        isReelsMuted: false,
        reelClickTimer: null,
        selectedMedia: null,
        mediaType: null,
        newPostContent: '',
        homeSearchQuery: '',
        isSearchFocused: false,
        recentSearches: ['Exam Timetable', 'Library', 'Sports'],
        isCallChatOpen: false,
        isCallMinimized: false,
        isCalling: false,
        async logout() {
            await this.apiFetch('/api/logout');
            // Redirect to YSU login if account_type is 'ysu', otherwise to default Maiga login
            window.location.href = this.user.account_type === 'ysu' ? 'ysu.html' : 'index.html';
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
        facingMode: 'user',
        isScreenSharing: false,
        localStream: null,
        callStatus: '',
        isMicMuted: false,
        isCameraOff: false,
        isSpeakerOn: false,
        callDuration: 0,
        callTimer: null,
        isDragging: false,
        dragInfo: { startX: 0, startY: 0, initialX: 0, initialY: 0 },
        minimizedCallTransform: { x: 0, y: 0 },
        swipeStart: { x: 0, y: 0 },
        swipingMsgId: null,
        swipeOffset: 0,
        touchTimer: null,
        editingMessageId: null,
        isSearchingChat: false,
        isSendingMessage: false,
        showCommentStickers: false,
        // brightnessIntensity and contrastIntensity already defined above
        chatSearchQuery: '',
        clearChatSearch() {
            this.chatSearchQuery = '';
            this.isSearchingChat = false;
            // Watcher will automatically trigger fetchMessages
        },
        createPostOffset: { x: 0, y: 0 },
        createPostStart: { x: 0, y: 0 },
        isCreatePostDragging: false,
        mutedChats: [],
        mediaPreviewUrl: null,
        mediaPreviewFile: null,
        mediaPreviewType: null,
        incomingCall: null,
        peerConnection: null,
        currentCallId: null,
        pinnedChats: [],
        archivedChats: [],
        activeHashtag: null,
        page: 1,
        isLoadingMore: false,
        searchResults: [],
        toasts: [],
        isReporting: false,
        reportForm: { title: '', description: '', screenshot: null, preview: null, targetType: '', targetId: null, targetUserId: null },
        // Pull to Refresh
        pullStartY: 0,
        pullDistance: 0,
        isOffline: !navigator.onLine,
        isRefreshing: false,
        handlePullStart(e) {
            if (this.$refs.mainContent && this.$refs.mainContent.scrollTop === 0 && window.scrollY === 0) {
                this.pullStartY = e.touches[0].clientY;
            }
        },
        handlePullMove(e) {
            if (this.pullStartY > 0 && this.$refs.mainContent && this.$refs.mainContent.scrollTop === 0 && window.scrollY === 0) {
                const touchY = e.touches[0].clientY;
                const dist = touchY - this.pullStartY;
                if (dist > 0) {
                    e.preventDefault(); // Prevent browser's default pull-to-refresh
                    this.pullDistance = Math.min(dist * 0.4, 150);
                } else {
                    this.pullDistance = 0;
                }
            }
        },
        handlePullEnd() {
            if (this.pullDistance > 80) { // Increased threshold for better UX
                this.refreshAllData();
            } else {
                this.pullDistance = 0;
                this.pullStartY = 0;
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

            const promises = [
                this.apiFetch('/api/get_posts?page=1').then(data => { if (Array.isArray(data)) { this.posts = data; this.page = 1; } }), // Fixed: this.homePosts to this.posts
                this.apiFetch('/api/get_chats').then(data => { if (Array.isArray(data)) this.chats = data; }),
                this.apiFetch('/api/get_groups').then(data => { if (Array.isArray(data)) this.groups = data; }),
                this.apiFetch('/api/get_stories').then(data => this.processStories(Array.isArray(data) ? data : [])),
                this.apiFetch('/api/friends/suggestions').then(data => { if (Array.isArray(data)) this.friends = data; }),
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
        showSkeletons: true,
        user: {
            id: 0,
            name: '',
            username: '',
            nickname: '',
            avatar: '',
            account_type: 'maiga',
            followerIds: [],
            followingIds: []
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
        isUploadingStory: false,
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
        posts: [],
        friends: [], // Will be populated from API
        groups: [],
        trendingTopics: [],
        savedPostList: [], // Store saved posts here
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

        async mainInit() {
            // Prevent back button to login page
            history.pushState(null, null, location.href);
            window.onpopstate = function () {
                history.go(1);
            };

            // --- SOCKET.IO IMPLEMENTATION ---
            this.socket = io(API_BASE_URL);

            // 2. Join a room based on the user's ID once connected and user is loaded
            this.socket.on('connect', () => {
                if (this.user && this.user.id) {
                    this.socket.emit('join_room', this.user.id); // This should be the user's actual ID from the backend
                    // Join group rooms for real-time updates
                    this.groups.forEach(g => {
                        this.socket.emit('join_group', g.id);
                    });
                }
            });

            // 3. Listen for incoming messages
            this.socket.on('receive_message', async (data) => {
                document.getElementById('receive-sound').play().catch(()=>{}); // Play notification sound

                // Make sure it's not our own message coming back
                if (data.sender_id == this.user.id) return;

                // Acknowledge delivery to the server
                this.socket.emit('message_received', { message_id: data.id });

                // If we are currently looking at this chat, mark incoming message as read
                if (this.activeChat && this.activeChat.id == data.sender_id) {
                    this.markAsRead(this.activeChat);
                }

                // Decrypt E2EE messages
                if (data.media_type === 'e2ee') {
                    try {
                        const privKey = await this.crypto.getPrivateKey();
                        data.content = await this.crypto.decrypt(data.content, privKey);
                        data.media_type = 'text'; 
                    } catch (e) {
                        data.content = '🔒 Encrypted Message';
                        data.media_type = 'text';
                    }
                }

                // Normalize message for Alpine templates (match fetchMessages format)
                const formattedMsg = {
                    ...data,
                    sender: 'them',
                    type: data.media_type || 'text',
                    time: new Date(data.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                };

                const chatId = data.sender_id;
                if (!this.chatMessages[chatId]) {
                    this.chatMessages[chatId] = [];
                }
                this.chatMessages[chatId].push(formattedMsg);

                const chatInList = this.chats.find(c => c.id == chatId);
                if (chatInList) {
                    chatInList.lastMsg = data.content;
                    chatInList.time = 'Just now';
                    if (this.activeChat?.id != chatId) chatInList.unread = true;
                }
            });

             // --- Socket Call Listeners ---
            this.socket.on('incoming_call', (data) => {
                if (this.isCalling || this.incomingCall) return; // Busy
                this.incomingCall = {
                    id: data.callId,
                    caller_id: data.from,
                    name: data.name,
                    avatar: data.avatar,
                    type: data.type,
                    sdp: data.signal // Keep original object
                };
                document.getElementById('ringing-sound').play().catch(()=>{});
            });

            this.socket.on('call_accepted', (signal) => {
                this.callStatus = 'Connecting...';
                document.getElementById('ringing-sound').pause();
                this.peerConnection.setRemoteDescription(new RTCSessionDescription(signal));
                clearInterval(this.connectionInterval); // Stop any fallback polling
            });

            this.socket.on('ice_candidate', (candidate) => {
                if (this.peerConnection) {
                    this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch(e=>{});
                }
            });

            this.socket.on('call_ended', () => {
                this.endCall();
                this.showToast('Info', 'Call ended.');
            });

            // Listen for typing events
            this.socket.on('display_typing', (data) => {
                const chat = this.chats.find(c => c.id == data.chat_id);
                if (chat) {
                    chat.isTyping = true;
                    clearTimeout(chat.typingTimeout);
                    chat.typingTimeout = setTimeout(() => chat.isTyping = false, 3000);
                }
                
                if (this.activeChat && this.activeChat.id == data.chat_id && data.sender_id != this.user.id) {
                    if (!this.typingUsers.includes(data.sender_id)) this.typingUsers.push(data.sender_id);
                }
            });

            this.socket.on('message_deleted', (data) => {
                // Look through all chat buckets to find and remove the deleted message
                for (let chatId in this.chatMessages) {
                    this.chatMessages[chatId] = this.chatMessages[chatId].filter(m => m.id != data.message_id);
                }
            });

            // Listen for delivery receipts
            this.socket.on('message_delivered', (data) => {
                for (let chatId in this.chatMessages) {
                    const msg = this.chatMessages[chatId].find(m => m.id == data.message_id);
                    if (msg) {
                        msg.delivered = true;
                        break;
                    }
                }
            });

            this.socket.on('hide_typing', (data) => {
                const chat = this.chats.find(c => c.id == data.chat_id);
                if (chat) chat.isTyping = false;
                if (this.activeChat && this.activeChat.id == data.chat_id) {
                    this.typingUsers = this.typingUsers.filter(id => id != data.sender_id);
                }
            });

            this.socket.on('disappearing_mode_changed', (data) => {
                if (this.activeChat && this.activeChat.id == data.chat_id) {
                    this.showToast('Chat Update', `Disappearing messages ${data.active ? 'enabled' : 'disabled'} by ${data.user_name}`, 'info');
                }
            });

            // --- Notification Listener ---
            this.socket.on('new_notification', (data) => {
                this.notifications.unshift(data);
                
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
                const chat = this.chats.find(c => c.id == data.userId);
                if (chat && chat.type !== 'group') { // Only update for direct chats
                    chat.status = data.status;
                }

                // Update Friends/Suggestions List
                const friend = this.friends.find(f => f.id == data.userId);
                if (friend) {
                    friend.online = data.status === 'online';
                }

                // Update Following List
                const following = this.followingList.find(f => f.id == data.userId);
                if (following) {
                    following.online = data.status === 'online';
                }
            });

            // --- Message Edited Listener ---
            this.socket.on('message_edited', async (data) => {
                const chatId = data.group_id || (data.sender_id == this.user.id ? data.receiver_id : data.sender_id);
                const messages = this.chatMessages[chatId];
                if (!messages) return;

                const msg = messages.find(m => m.id == data.id);
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
                const chatId = data.viewer_id;
                if (this.chatMessages[chatId]) {
                    this.chatMessages[chatId].forEach(m => {
                        if (m.sender === 'me') m.read = true;
                    });
                }
            });

    // --- Read Receipt Listener ---
    // Updates UI checkmarks and "Seen by" lists real-time
    this.socket.on('read_receipt', (data) => {
        for (let chatId in this.chatMessages) {
            const msg = this.chatMessages[chatId].find(m => m.id == data.message_id);
            if (msg) {
                msg.read = data.is_read;
                msg.read_by = data.read_by;
                break; 
            }
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
            // Setup cryptography - Fix for phone/non-secure context
            if (window.isSecureContext && window.crypto && window.crypto.subtle) {
                try {
                    await this.crypto.init(this);
                    const hasKeys = await this.crypto.hasKeys();
                    if (!hasKeys) {
                        await this.crypto.generateAndStoreKeys();
                        this.showToast('Security', 'Encryption keys generated and stored securely.', 'success');
                    }
                } catch (e) { }            }
            this.$watch('user.account_type', val => document.title = val === 'ysu' ? 'Ysu Social' : 'Maiga Social');
            
            // Watch for changes to isFullScreen and save to localStorage
            this.$watch('isFullScreen', (value) => {
                localStorage.setItem('maiga_fullscreen', value);
            });
            
            // Watch for dark mode changes
            this.$watch('darkMode', (value) => {
                localStorage.setItem('darkMode', value);
                if (value) {
                    document.documentElement.classList.add('dark');
                } else {
                    document.documentElement.classList.remove('dark');
                }
            });

            // Watch for chat search queries to filter messages
            this.$watch('chatSearchQuery', (val) => {
                if (this.activeChat) this.fetchMessages(this.activeChat, false);
            });
             
            this.$watch('chatStarFilter', (val) => {
                if (this.activeChat) this.fetchMessages(this.activeChat, false);
            });
            
            // Automatically mark as read when switching chats
            this.$watch('activeChat', (newChat) => {
                if (newChat) this.markAsRead(newChat);
            });

            // Re-join room if user data loads after socket connects
            this.$watch('user.id', (newId) => {
                if (newId && this.socket && this.socket.connected) this.socket.emit('join_room', newId);
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
            
            // Consolidate initial data fetching
            const initialDataPromises = [
                // 1. Get User Data
                this.apiFetch('/api/get_user').then(data => {
                    if(data) {
                        this.user = { ...this.user, ...data };
                        this.editUser = { ...this.user };
                    }
                }),
                // 2. Get Posts
                this.apiFetch('/api/get_posts?page=1').then(data => {
                    this.posts = Array.isArray(data) ? data : [];
                }),
                // 3. Get Chats
                this.apiFetch('/api/get_chats').then(data => {
                    this.chats = Array.isArray(data) ? data : [];
                }),
                // 4. Get Connections (for group creation etc)
                this.apiFetch('/api/get_connections?type=following').then(data => {
                    this.followingList = Array.isArray(data) ? data : [];
                })
            ];

            // Fetch newly implemented features
            this.apiFetch('/api/get_forum_topics').then(data => { if(Array.isArray(data)) this.forumTopics = data; });
            this.apiFetch('/api/get_music_tracks').then(data => { if(Array.isArray(data)) this.musicTracks = data; });
            this.apiFetch('/api/get_stickers').then(data => { 
                if(data) { this.editorStickers = data.editor || []; this.storyStickers = data.story || []; }
            });

            // Non-blocking fetches (can load after UI is ready)
            this.apiFetch('/api/get_trending').then(data => {
                this.trendingTopics = Array.isArray(data) ? data : [];
            });

            // Fetch Groups
            this.apiFetch('/api/get_groups').then(data => {
                    this.groups = Array.isArray(data) ? data : [];
                    if(this.socket && this.socket.connected) {
                        this.groups.forEach(g => this.socket.emit('join_group', g.id));
                    }
            });

            // Fetch Reports (for in-app admin view)
            if (this.user.is_admin) { // Only fetch if user is admin
                this.apiFetch('/api/admin/get_reports').then(data => {
                    if (Array.isArray(data)) this.reports = data;
                });
            }

            // Fetch Blocked Users
            this.apiFetch('/api/get_blocked_users')
                .then(data => {
            
                    this.blockedUsers = Array.isArray(data) ? data : [];
                }).catch(() => { this.blockedUsers = []; });

            // Fetch Notifications
            this.apiFetch('/api/get_notifications')
                .then(data => {
                    this.notifications = Array.isArray(data) ? data : [];
                }).catch(() => { this.notifications = []; });

            // Fetch Muted Chats
            this.apiFetch('/api/get_muted_chats')
                    .then(data => {
                    this.mutedChats = Array.isArray(data) ? data : [];
                }).catch(() => { this.mutedChats = []; });

            // Fetch Pinned Chats
            this.apiFetch('/api/get_pinned_chats')
                .then(data => {
                    this.pinnedChats = data;
                    this.pinnedChats = Array.isArray(data) ? data : [];
                })
                .catch(err => { });

            // Fetch Reels
            this.apiFetch('/api/get_reels?page=1&limit=5')
                .then(data => {
                    this.reels = Array.isArray(data) ? data : [];
                }).catch(() => { this.reels = []; });

            // Fetch Starred Messages
            this.apiFetch('/api/get_starred_messages').then(data => { if (Array.isArray(data)) this.starredMessages = data; });

            this.$watch('isPaused', val => {
                const video = document.querySelector('.story-video');
                if (video) val ? video.pause() : video.play();
            });

            // Setup cryptography - Fix for phone/non-secure context
            if (window.isSecureContext && window.crypto && window.crypto.subtle) {
                try {
                    await this.crypto.init(this);
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
            

            if (!userId || userId == this.user.id) {
                this.activeTab = 'profile';
                return;
            }
            
            // Close other modals to prevent overlapping/z-index issues
            this.showFollowerList = null;
            this.viewingComments = null;
            this.showGroupInfo = false;

            this.viewingUser = null; // Show loading state
            this.showUserProfile = true;

            // Fetch full user profile from API
            this.apiFetch(`/api/get_profile?user_id=${userId}`)
                .then(data => {
                    if (data && !data.error && data.id) {
                        this.viewingUser = { ...data,
                            profilePostsPage: 1,
                            profilePostsLimit: 10,
                            isLoadingMoreProfilePosts: false }; // Initialize pagination state
                        // Use posts from profile data if provided, else fallback to fetch
                        if (data.posts) {
                            this.viewingUser.posts = data.posts;
                        } else {
                            this.viewingUser.posts = [];
                            this.apiFetch(`/api/get_posts?user_id=${userId}`)
                                .then(postsData => {
                                    if (postsData) this.viewingUser.posts = postsData;
                                }); // This fallback is now less critical as get_profile returns posts
                        }
                        // Fetch their reels
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
        async loadMoreProfilePosts() {
            if (!this.viewingUser || this.viewingUser.isLoadingMoreProfilePosts || !this.viewingUser.hasMorePosts) {
                return;
            }

            this.viewingUser.isLoadingMoreProfilePosts = true;
            this.viewingUser.profilePostsPage++;

            const data = await this.apiFetch(`/api/get_profile?user_id=${this.viewingUser.id}&page=${this.viewingUser.profilePostsPage}&limit=${this.viewingUser.profilePostsLimit}`);
            
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
        updateLastSeen() {
            if (this.socket && this.socket.connected) {
                this.socket.emit('update_last_seen');
            }
        },
        sendTypingSignal: Alpine.throttle(function() { 
            if (!this.activeChat) return;
            this.socket.emit('typing', { 
                chat_id: this.activeChat.id, 
                is_group: this.activeChat.type === 'group',
                sender_id: this.user.id
            });
        }, 2000),

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
                    musicTrack: story.music_track
                };

                // Check if story belongs to current user
                // Note: Ensure both IDs are compared as strings or numbers consistentnly
                if (String(story.user_id) === String(this.user.id)) {
                    fetchedMyStories.push(storyObj);
                } else {
                    if (!storiesByUser.has(story.user_id)) {
                        storiesByUser.set(story.user_id, {
                            id: story.user_id,
                            name: (story.first_name || 'User') + ' ' + (story.surname || ''),
                            // Use story.avatar from DB, fallback to dicebear if missing
                            avatar: story.avatar || `https://api.dicebear.com/7.x/avataaars/svg?seed=${story.user_id}`,
                            stories: []
                        });
                    }
                    storiesByUser.get(story.user_id).stories.push(storyObj);
                }
            });

            this.myStories = fetchedMyStories;
            // Convert Map to Array for Alpine x-for
            this.following = Array.from(storiesByUser.values());
        },
        get userMediaPosts() {
            return this.myReels;
        },
        get userLikedPosts() {
           return (this.posts || []).filter(p => p.myReaction !== null);
        },
        get filteredConnectionList() {
            if (!this.connectionSearchQuery.trim()) {
                return this.connectionList;
            }
            const query = this.connectionSearchQuery.toLowerCase();
            return this.connectionList.filter(person =>
                person.name.toLowerCase().includes(query) ||
                (person.username && person.username.toLowerCase().includes(query)) ||
                (person.dept && person.dept.toLowerCase().includes(query))
            );
        },
        isFollowing(friendId) {
            if (!friendId) return false;
            return this.user.followingIds.some(id => id == friendId);
        },
        isChatMuted(chatId, type) {
            return this.mutedChats.some(m => m.chat_id == chatId && m.type == type);
        },
        isPinned(chatId, type) {
            return this.pinnedChats.some(p => p.chat_id == chatId && p.type == type);
        },
        toggleFollow(friendId) {
            if (this.followLoading.includes(friendId)) return;
            
            this.followLoading.push(friendId);
            const isCurrentlyFollowing = this.isFollowing(friendId);

            // --- Optimistic UI Update ---
            if (isCurrentlyFollowing) {
                this.user.followingIds = this.user.followingIds.filter(id => id != friendId);
                if (this.viewingUser && this.viewingUser.id == friendId) {
                    this.viewingUser.followers_count--;
                }
            } else {
                this.user.followingIds.push(friendId);
                if (this.viewingUser && this.viewingUser.id == friendId) {
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
                    if (isCurrentlyFollowing) {
                        this.user.followingIds.push(friendId);
                        if (this.viewingUser && this.viewingUser.id == friendId) this.viewingUser.followers_count++;
                    } else {
                        this.user.followingIds = this.user.followingIds.filter(id => id != friendId);
                        if (this.viewingUser && this.viewingUser.id == friendId) this.viewingUser.followers_count--;
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
                if (isCurrentlyFollowing) {
                    this.user.followingIds.push(friendId);
                    if (this.viewingUser && this.viewingUser.id == friendId) this.viewingUser.followers_count++;
                } else {
                    this.user.followingIds = this.user.followingIds.filter(id => id != friendId);
                    if (this.viewingUser && this.viewingUser.id == friendId) {
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
            this.apiFetch(`/api/get_connections?type=&user_id=${this.user.id}`)
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
                    this.connectionList = this.connectionList.filter(p => p.id !== followerId);
                    this.user.followerIds = this.user.followerIds.filter(id => id !== followerId);
                    this.showToast('Success', 'Follower removed.');
                } else {
                    this.showToast('Error', data.error || 'Failed to remove follower.', 'error');
                }
            });
        },
        handlePostMedia(event) {
                const file = event.target.files[0];
            if (!file) return;
            this.postFile = file;
            this.mediaType = file.type.startsWith('video') ? 'video' : 'image';
            const reader = new FileReader();
            reader.onload = (e) => this.selectedMedia = e.target.result;
            reader.readAsDataURL(file);
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
        createPost() {
            if ((!this.newPostContent && !this.selectedMedia) || this.isUploadingPost || this.isUploadingReel) return;

            const content = this.newPostContent;
            const isVideo = this.mediaType === 'video';
            
            const formData = new FormData();
            formData.append('content', this.newPostContent);
            
            if (isVideo) this.isUploadingReel = true; else this.isUploadingPost = true;

            // Use edited file if available, else original input
            if (this.postFile) {
                formData.append('media', this.postFile);
            }
            if (this.editorMusic && this.editorSource === 'post') formData.append('music_track', this.editorMusic.src);

            this.apiFetch('/api/create_post', {
                    method: 'POST',
                headers: { 'X-CSRF-Token': CSRF_TOKEN },
                body: formData
            })
            .then(data => {
                if (data && data.success) {
                    this.showToast('Success', 'Post created successfully!', 'success');

                    // World Class Optimistic Update: Use the full object returned by backend
                    this.posts.unshift({
                        ...data.post,
                        author: this.user.name, // Local fallback until next refresh
                        avatar: this.user.avatar
                    });
                    
                    this.newPostContent = '';
                    this.selectedMedia = null;
                    this.mediaType = null;

                    if (isVideo) {
                        this.activeTab = 'reels';
                        this.apiFetch('/api/get_reels')
                            .then(data => { if (data) this.reels = data; });
                        this.apiFetch(`/api/get_reels?user_id=${this.user.id}`)
                            .then(data => { if (data) this.myReels = data; });
                        this.isUploadingReel = false;
                    }

                if (!isVideo) this.activeTab = 'home';

                    // Refresh trending topics as new hashtags might have been added
                    this.apiFetch('/api/get_trending')
                        .then(data => {
                            if (data) this.trendingTopics = data;
                        });
                    this.isUploadingPost = false;
                } else {
                    this.showToast('Error', data.error || 'Failed to create post.', 'error');
                    this.isUploadingPost = false;
                    this.isUploadingReel = false;
                }
            });
            this.isCreatingPost = false;
        },
        createGroup() {
            if (!this.newGroup.name.trim()) {
                this.showToast('Error', 'Group name is required.', 'error');
                return;
            }

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
                    this.groups.unshift({ ...data.group, lastMsg: 'Group created', time: 'Now', unread: false, members: this.newGroup.members, role: 'admin' });
                    this.isCreatingGroup = false;
                    this.activeChat = this.groups[0];
                    this.showToast('Success', 'Group created successfully!');
                    // Reset form
                    this.createGroupStep = 1;
                    this.newGroup = { name: '', description: '', members: [], avatarFile: null, avatarPreview: null, permissions: { can_edit_settings: false, can_send_messages: true, can_add_members: false }, approve_members: false };
                } else {
                    this.showToast('Error', data.error || 'Failed to create group.', 'error');
                }
            });
        },
        async sendMessage(mediaData = null, type = 'text', contentOverride = null, fileObject = null) {

            if (this.isBlocked(this.activeChat?.id)) return;
            let content = contentOverride || mediaData || this.newMessage;
            this.isSendingMessage = true;
            
            // Handle Edit
            if (this.editingMessageId) {
                // E2EE edit is complex, for now, we just edit unencrypted messages
                // or re-encrypt, which reveals edit history.
                // Simple implementation:
                await this.crypto.editMessage(this.editingMessageId, content);
                this.fetchMessages(this.activeChat, false);
                this.newMessage = '';
                this.editingMessageId = null;
                this.isSendingMessage = false;

                return;
            }

            if (!content && type === 'text') return;
            
            const formData = new FormData();
            let finalType = type;
            
            // E2EE for 1-on-1 text messages
            if (type === 'text' && this.activeChat.type !== 'group' && this.activeChat.id) {
                try {
                    const theirPublicKey = await this.crypto.fetchPublicKey(this.activeChat.id);
                    if (theirPublicKey) {
                        const encryptedPayload = await this.crypto.encrypt(content, theirPublicKey);
                        formData.append('content', JSON.stringify(encryptedPayload));
                        formData.append('media_type', 'e2ee');
                        finalType = 'e2ee';
                    } else {
    // Fallback to plain text if recipient has no public key
                        formData.append('content', content);
                        formData.append('media_type', type);
                    }
                } catch (e) {
                    this.showToast('Error', 'Could not encrypt message.', 'error');
                    formData.append('content', content);
                    formData.append('media_type', type);
                }
            } else {
                formData.append('content', (type === 'text' || type === 'sticker' || type === 'call_log') ? content : '');
                formData.append('media_type', type);
            }

            if (this.replyingTo) {
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
            // If using the file input refs:
            if (fileObject) {
                formData.append('media', fileObject);
            } else if (type === 'image' && this.$refs.imgInput.files[0]) {
                formData.append('media', this.$refs.imgInput.files[0]);
            } else if (type === 'video' && this.$refs.videoInput.files[0]) {
                formData.append('media', this.$refs.videoInput.files[0]);
            } else if (type === 'file' && this.$refs.fileInput.files[0]) {
                formData.append('media', this.$refs.fileInput.files[0]);
            }
            else if (type === 'audio' && mediaData) {
                formData.append('media', mediaData, 'voice_note.webm');
            }

            // Optimistic UI Update
            const messagePayload = {
                id: Date.now(),
                sender_id: this.user.id,
                receiver_id: this.activeChat.id,
                content: content, // This might be encrypted content or raw, careful with display
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                author: this.user.name,
                avatar: this.user.avatar,
                sender: 'me',
                type: finalType === 'e2ee' ? 'text' : finalType,
                pending: !navigator.onLine
            };
            if (!this.chatMessages[this.activeChat.id]) this.chatMessages[this.activeChat.id] = [];
            this.chatMessages[this.activeChat.id].push(messagePayload);
            this.$nextTick(() => {
                const container = document.getElementById('messageContainer');
                if (container) container.scrollTop = container.scrollHeight;
            });

            // Update chat list preview with pending state
            const chatInList = this.chats.find(c => c.id == this.activeChat.id);
            if (chatInList) {
                chatInList.lastMsg = content;
                chatInList.time = 'Just now';
                chatInList.pending = !navigator.onLine;
            } else if (this.activeChat.type !== 'group') {
                // If it's a new chat not yet in the list, add it
                this.chats.unshift({ ...this.activeChat, lastMsg: content, time: 'Just now' });
            }

            if (navigator.onLine) {
                this.apiFetch('/api/send_message', {
                    method: 'POST',
                    body: formData,
                    headers: { 'X-CSRF-Token': CSRF_TOKEN }
                }).then(data => {
                    if (data && data.success) {
                        document.getElementById('sent-sound').play().catch(()=>{});
                    } else {
                        this.showToast('Error', 'Message failed to send.', 'error');
                    }
                })
                .catch(() => this.showToast('Error', 'Connection lost.', 'error'))
                .finally(() => { this.isSendingMessage = false; });
            } else if ('serviceWorker' in navigator && 'SyncManager' in window) {
                // Background Sync Logic
                const pendingMsg = {
                    chat_id: this.activeChat.id,
                    is_group: this.activeChat.type === 'group',
                    content: content,
                    media_type: finalType,
                    reply_to_id: this.replyingTo?.id || null,
                    timestamp: Date.now()
                };
                
                await this.crypto.savePendingMessage(pendingMsg);
                const reg = await navigator.serviceWorker.ready;
                await reg.sync.register('send-pending-messages');
                this.showToast('Offline', 'Message will be sent automatically when online.', 'info');
                this.isSendingMessage = false;
            }

            this.newMessage = '';
            this.replyingTo = null;
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
            const type = this.activeChat.type === 'group' ? 'group' : 'user';
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
            let url = `/api/get_messages?chat_id=${chat.id}&type=${type}`;
            if (this.chatSearchQuery) {
                url += `&search=${encodeURIComponent(this.chatSearchQuery)}`;
            }
            if (this.chatStarFilter) {
                url += `&starred=true`;
            }

            this.apiFetch(url)
                .then(async data => {
                    const formattedMessages = await Promise.all(data.map(async m => {
                        let content = m.media || m.content;
                        let msgType = m.media_type || 'text';

                        if (msgType === 'e2ee') {
                            try {
                                const privKey = await this.crypto.getPrivateKey();
                                content = await this.crypto.decrypt(content, privKey);
                                msgType = 'text';
                            } catch (e) {
                                content = '🔒 Encrypted Message';
                                msgType = 'text';
                            }
                        }

                        return {
                        id: m.id,
                        sender_id: m.sender_id,
                        sender: m.sender_id == this.user.id ? 'me' : 'them',
                        type: msgType,
                        content: content,
                        created_at: m.created_at,
                        time: new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                        is_edited: !!m.is_edited,
                        pinned: !!m.is_pinned,
                        read: !!m.is_read,
                        read_by: m.read_by || [],
                        author: m.first_name + ' ' + m.surname, // For groups
                        avatar: m.avatar,
                        replyTo: m.replyTo,
                        // Poll specific data
                        question: m.question,
                        options: m.options ? m.options.map(opt => ({
                            id: opt._id || opt.id,
                            text: opt.text,
                            votes: opt.votes || []
                        })) : null,
                        poll_id: m.poll_id
                    }}));
                    this.chatMessages[chat.id] = formattedMessages;
                    
                    if (forceScroll) {
                        this.$nextTick(() => {
                            const container = document.getElementById('messageContainer');
                            if (container) container.scrollTop = container.scrollHeight;
                        });
                    }
                });
        },
        markAsRead(chat) {
            if (!chat) return;
            const type = chat.type === 'group' ? 'group' : 'user';
            
            // Real-time 'seen' status update via socket
            this.socket.emit('mark_seen', { chat_id: chat.id, type: type });

            this.apiFetch('/api/mark_messages_read', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': CSRF_TOKEN
                },
                body: JSON.stringify({ chat_id: chat.id, type: type })
            });
            // Local update handled by polling or optimistic update if needed
            chat.unread = false;
        },
        markAsUnread(chat) {
            if (!chat) return;
            this.showChatOptions = false;
            this.activeChat = null; // Close chat to see the unread status
            this.isMessaging = true; // Go back to list
            
            this.apiFetch('/api/mark_chat_unread', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': CSRF_TOKEN
                },
                body: JSON.stringify({ chat_id: chat.id })
            });
            chat.unread = true; // Optimistic update
        },
        sendSticker(sticker) {
            this.recordStickerUse(sticker);
            this.sendMessage(sticker, 'sticker');
            this.showStickerPicker = false;
        },
        handleSwipeStart(e, msgId) {
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
                const msg = this.chatMessages[this.activeChat.id].find(m => m.id === this.swipingMsgId);
                if (msg) this.replyToMessage(msg);
            }
            this.swipingMsgId = null;
            this.swipeOffset = 0;
            this.touchEnd();
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
        replyToMessage(msg = null) {
            this.replyingTo = msg || this.selectedMessageForOptions;
            this.showMessageOptions = false;
            this.$nextTick(() => document.querySelector('input[x-model="newMessage"]')?.focus());
        },
        togglePinMessage() {
            if (!this.selectedMessageForOptions || !this.activeChat) return;
            const chatId = this.activeChat.id;
            const msg = this.selectedMessageForOptions;
            
            this.apiFetch('/api/toggle_pin_message', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': CSRF_TOKEN
                },
                body: JSON.stringify({ message_id: msg.id })
            }).then(() => {
                msg.pinned = !msg.pinned;
                this.showToast('Success', msg.pinned ? 'Message pinned' : 'Message unpinned');
            });

            this.showMessageOptions = false;
        },
        unpinMessage(msg) {
            if (msg) msg.pinned = false;
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
            if (!this.messageToForward) return;
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
            const chat = this.chats.find(c => c.id === friend.id);
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
                return;
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
            const msg = this.chatMessages[this.activeChat.id].find(m => m.id === msgId);
            if (!msg || !msg.poll_id) return;

            this.apiFetch('/api/vote_poll', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': CSRF_TOKEN
                },
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
            this.scheduledMessages.push({
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
            this.chatMessages[msg.chatId].push({
                id: Date.now(),
                sender: 'me',
                type: msg.type,
                content: msg.content,
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                read: false
            });
            
            // Update last message if this chat is in list
            const chat = this.chats.find(c => c.id === msg.chatId) || this.groups.find(g => g.id === msg.chatId);
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
            if (!msg) return;

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
                    this.showToast('Success', 'User blocked and report resolved.', 'success');
                }
            });
            this.showMessageOptions = false;
        },
        editMessage() {
            const msg = this.selectedMessageForOptions;
            if (!msg || msg.type !== 'text') return;
            
            this.newMessage = msg.content;
            this.editingMessageId = msg.id;
            this.showMessageOptions = false;
            // Focus input
            this.$nextTick(() => document.querySelector('input[x-model="newMessage"]').focus());
        },
        deleteMessage(mode) {
            if (!this.selectedMessageForOptions || !this.activeChat) return;
            if (!confirm(mode === 'everyone' ? 'Delete for everyone?' : 'Delete for me?')) return;

            const chatId = this.activeChat.id;
            const msgId = this.selectedMessageForOptions.id;

            this.apiFetch('/api/delete_message', {
                    method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': CSRF_TOKEN
                },
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
            this.fetchComments(item.id, item.user_id);
            if (this.viewingComments) {
                this.viewingComments.type = type;
            }
        },
        fetchComments(postId, postAuthorId) {
            this.viewingComments = { id: postId, type: 'post', list: [], post_author_id: postAuthorId };
            this.apiFetch(`/api/get_comments?post_id=${postId}`)
                .then(data => {
                    if (this.viewingComments && this.viewingComments.id === postId) {
                        this.viewingComments.list = data || [];
                    }
                });
        },
        addComment(contentOrBlob = null, type = 'text') {
            if ((!this.commentInput.trim() && !contentOrBlob) || !this.viewingComments) return;
            
            const formData = new FormData(); formData.append('post_id', this.viewingComments.id);
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
                        const parent = this.viewingComments.list.find(c => c.id === this.replyingToComment.id);
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
                        ? this.posts.find(p => p.id === this.viewingComments.id)
                        : this.reels.find(r => r.id === this.viewingComments.id);
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
            });
        },
        sendCommentSticker(sticker) {
            this.addComment(sticker, 'sticker');
            this.showCommentStickers = false;
        },
        async startCommentRecording() {
            if (this.isRecordingComment) return;
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                this.commentMediaRecorder = new MediaRecorder(stream);
                this.commentAudioChunks = [];
                this.commentMediaRecorder.addEventListener("dataavailable", event => {
                    this.commentAudioChunks.push(event.data);
                });
                this.commentMediaRecorder.onstop = () => {
                    const audioBlob = new Blob(this.commentAudioChunks, { type: 'audio/webm' });
                    this.addComment(audioBlob); // Pass blob to addComment
                    this.commentAudioChunks = [];
                    stream.getTracks().forEach(track => track.stop());
                };
                this.commentMediaRecorder.start();
                this.isRecordingComment = true;
                this.commentRecordingDuration = 0;
                this.commentRecordingTimer = setInterval(() => { this.commentRecordingDuration++; }, 1000);
            } catch (err) {
                this.showToast('Error', 'Could not access microphone. Check permissions.', 'error');
            }
        },
        stopCommentRecording() {
            if (!this.isRecordingComment || !this.commentMediaRecorder) return;
            this.commentMediaRecorder.stop();
            this.isRecordingComment = false;
            clearInterval(this.commentRecordingTimer);
            
        },
        deleteComment(commentId) {
            if (!confirm('Delete this comment?')) return;
            this.apiFetch('/api/delete_comment', {
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
        sharePost() {
            if (!this.sharingPost) return;
            this.apiFetch('/api/share_post', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': CSRF_TOKEN
                },
                body: JSON.stringify({ post_id: this.sharingPost.id })
            })
            .then(data => {
                if (data && data.success) {
                    this.showToast('Success', 'Post shared to your feed!');
                    this.showShareModal = false;
                    
                    // Update original post/reel share count
                    const post = this.homePosts.find(p => p.id === this.sharingPost.id);
                    if (post) post.shares++;
                    
                    const reel = this.reels.find(r => r.id === this.sharingPost.id);
                    if (reel) reel.shares++;
                }
            });
        },
        sharePostToStory() {
            if (!this.sharingPost) return;
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
        copyPostLink() {
            if (!this.sharingPost) return;
            navigator.clipboard.writeText(`https://maigasocial.com/post/${this.sharingPost.id}`);
            this.showShareModal = false;
            this.sharingPost.shares++;
            this.showToast('Copied', 'Link copied to clipboard!', 'success');
        },
        handleReelClick(reel, event) {
            const now = Date.now();
            if (now - this.lastReelClick < 300) {
                // Double tap detected
                clearTimeout(this.reelClickTimer);
                
                if (!reel.liked) {
                    this.toggleReelLike(reel);
                }
                
                reel.showHeart = true;
                setTimeout(() => reel.showHeart = false, 600);
            } else {
                // Single tap (wait to see if it's double)
                this.reelClickTimer = setTimeout(() => {
                    const video = document.getElementById('reel-video-' + reel.id);
                    if (video) video.paused ? video.play().catch(e => {}) : video.pause();
                }, 300);
            }
            this.lastReelClick = now;
        },
        get homePosts() {
            return this.posts;
        },
        get totalUnreadChats() {
            return (this.chats || []).filter(c => c?.unread).length + (this.groups || []).filter(g => g?.unread).length;
        },
        get sortedChats() {
            const all = [...(this.chats || []), ...(this.groups || [])].filter(Boolean);
            return all.sort((a, b) => {
                const aPinned = this.isPinned(a.id, a.type || 'user');
                const bPinned = this.isPinned(b.id, b.type || 'user');
                if (aPinned && !bPinned) return -1;
                if (!aPinned && bPinned) return 1;
                return 0; // Keep original order (usually time based)
            });
        },
        searchUsers() {
            if (this.homeSearchQuery.length < 2) {
                this.searchResults = [];
                return;
            }
                this.apiFetch(`/api/search_users?q=${encodeURIComponent(this.homeSearchQuery)}`)
                .then(data => {
                    if (data) this.searchResults = data;
                });
        },
        openUserProfileByName(name) {
            // Search by username
            const user = this.friends.find(f => f.username && f.username.toLowerCase() === name.toLowerCase());
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
        formatRecordingTime(seconds) {
            const m = Math.floor(seconds / 60);
            const s = seconds % 60;
            return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
        },
        async startRecording() {
            if (this.isRecording || !this.activeChat || this.isBlocked(this.activeChat.id)) return;
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                this.mediaRecorder = Alpine.raw(new MediaRecorder(stream));
                this.audioChunks = [];
                this.mediaRecorder.addEventListener("dataavailable", event => {
                    this.audioChunks.push(event.data);
                });
                this.mediaRecorder.onstop = () => {
                    const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' });
                    this.sendMessage(audioBlob, 'audio');
                    this.audioChunks = [];
                    stream.getTracks().forEach(track => track.stop());
                };
                this.mediaRecorder.start();
                this.isRecording = true;
                this.recordingDuration = 0;
                this.recordingTimer = setInterval(() => { this.recordingDuration++; }, 1000);
            } catch (err) {
                this.showToast('Error', 'Could not access microphone. Check permissions.', 'error');
            }
        },
        stopRecording() {
            if (!this.isRecording || !this.mediaRecorder) return;
            this.mediaRecorder.stop();
            this.isRecording = false;
            clearInterval(this.recordingTimer);
        },
        saveProfile() {
             const formData = new FormData(); // Fixed: user.nickname to user.name
            formData.append('name', this.editUser.name);
            formData.append('username', this.editUser.username);
            formData.append('bio', this.editUser.bio || '');
            formData.append('dept', this.editUser.dept || '');
            
            if (this.$refs.profileAvatarInput.files.length > 0) {
                formData.append('avatar', this.$refs.profileAvatarInput.files[0]);
            }


            this.apiFetch('/api/update_profile', {
                method: 'POST',
                body: formData,
                headers: {
                    'X-CSRF-Token': CSRF_TOKEN
                }
            })
            .then(data => {
                if (data && data.success) {
                    this.showToast('Success', 'Profile updated successfully.');
                    // Refresh user data to get new avatar URL if changed
                    
                    this.apiFetch('/api/get_user')
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
            })
            .catch(err => {
                this.showToast('Error', 'Network error.', 'error');
            });
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
        downloadReel(reel) {
            const a = document.createElement('a');
            a.href = reel.media;
            a.download = `reel_${reel.id}.mp4`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            this.showReelOptions = false;
            this.showToast('Downloading', 'Download started...', 'success');
        },
        downloadPostMedia(post) {
            if (!post.media) return;
            const a = document.createElement('a');
            a.href = post.media;
            const ext = post.mediaType === 'video' ? 'mp4' : 'jpg';
            a.download = `post_${post.id}.${ext}`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            this.showPostOptions = false;
            this.showToast('Downloading', 'Download started...', 'success');
        },
        markInterested(reel) {
            this.showToast('Feedback', 'Thanks! We will show more like this.', 'success');
            this.showReelOptions = false;
        },
        
        async changePassword() {
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
        get userPosts() {
             return (this.posts || []).filter(p => p.user_id == this.user?.id || p.author === this.user?.name);
        },
        addToRecent(term) {
            if (!term) return;
            this.recentSearches = this.recentSearches.filter(t => t !== term);
            this.recentSearches.unshift(term);
            if (this.recentSearches.length > 5) this.recentSearches.pop();
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
                    this.apiFetch('/api/get_groups').then(d => { if(Array.isArray(d)) this.groups = d; });
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
                        this.apiFetch('/api/get_groups').then(g => { if(g) this.groups = g; });
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
                        this.showToast('Archived', 'Chat moved to archived.');
                        this.activeChat = null;
                        this.showChatOptions = false;
                    } else {
                        this.archivedChats = this.archivedChats.filter(c => c.id !== chat.id);
                        this.showToast('Unarchived', 'Chat moved back to main list.');
                        // Refresh main lists
                        this.apiFetch('/api/get_chats').then(d => { if(d) this.chats = d; });
                        this.apiFetch('/api/get_groups').then(d => { if(d) this.groups = d; });
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

            if (file.type.startsWith('video')) {
                const video = document.createElement('video');
                video.preload = 'metadata';
                video.onloadedmetadata = () => {
                    window.URL.revokeObjectURL(video.src);
                    /* Requirement: Max Duration 30 Seconds */
                    if (video.duration > 30) {
                        alert('Video exceeds 30s limit. Trimming automatically to 30s.');
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
                if (this.storyProgress >= 100) {
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
        sendStoryReply(content) {
            if (!content || !this.viewingStory || !this.viewingStory.user || this.viewingStory.user.id === this.user.id) return;
            const friendId = this.viewingStory.user.id;
            const messageContent = `Replying to story: `;

            if (!this.chatMessages[friendId]) this.chatMessages[friendId] = [];
            this.chatMessages[friendId].push({
                id: Date.now(),
                sender: 'me',
                type: 'text',
                content: messageContent,
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                read: false
            });

            // Update chat list preview
            const chat = this.chats.find(c => c.id === friendId && c.type !== 'group');
            if (chat) {
                chat.lastMsg = messageContent;
                chat.time = 'Now';
            }

            const formData = new FormData();
            formData.append('receiver_id', friendId);
            formData.append('content', messageContent);
            formData.append('media_type', 'text');

            this.apiFetch('/api/send_message', {
                method: 'POST',
                body: formData,
                headers: {
                    'X-CSRF-Token': CSRF_TOKEN
                }
            }).then(data => {
                if(data && data.success) this.showToast('Sent', 'Reply sent');
            });
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
            return 'lg:grid-cols-[auto_1fr_auto]';
        },
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
            const currentIndex = owners.findIndex(o => o.user.name === this.viewingStory.user.name);
            if (currentIndex !== -1 && currentIndex < owners.length - 1) {
                const next = owners[currentIndex + 1];
                this.viewStory(next.stories, next.user);
            } else {
                this.closeStory();
            }
        },
        didILikeThisStory() {
            if (!this.viewingStory || this.viewingStory.user.id === this.user.id) return false;
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
            this.newPostContent = 'Check out this story from @' + this.viewingStory.user.nickname + '!';
            this.selectedMedia = story.media;
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
            const file = source === 'post' ? this.postFile : this.storyFile;
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
                this.cropper = new Cropper(image, { viewMode: 1, dragMode: 'move', autoCropArea: 1, background: false });
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
                this.isPostingStory = false;
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
            };
            xhr.send(formData);
        },
        async generateFinalStoryImage(baseFile, text, overlays, providedCtx = null) {
            return new Promise(resolve => {
                const canvas = document.createElement('canvas');
                 const ctx = providedCtx || canvas.getContext('2d');
                canvas.width = 1080;
                canvas.height = 1920;
                const drawFrame = async () => {
                    // 1. Draw background (either style or image)
                    if (baseFile) {
                        const img = new Image();
                        const imgLoaded = new Promise(res => { img.onload = res; });
                        img.src = URL.createObjectURL(baseFile);
                        await imgLoaded;
                        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                    } else {
                        ctx.fillStyle = this.textStoryStyles[this.textStoryStyleIndex].background;
                        ctx.fillRect(0, 0, canvas.width, canvas.height);
                    }

                    // 2. Draw main text content
                    if (text && text.trim()) {
                        ctx.fillStyle = this.textStoryStyles[this.textStoryStyleIndex].color;
                        ctx.font = 'bold 80px sans-serif';
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
                        if (overlay.type === 'svg') {
                            const size = 300 * (overlay.scale || 1);
                            ctx.drawImage(overlay.img, -size/2, -size/2, size, size);
                        } else {
                            ctx.font = '150px sans-serif';
                            ctx.textAlign = 'center';
                            ctx.textBaseline = 'middle';
                            ctx.fillText(overlay.content, 0, 0);
                        }
                        ctx.restore();
                    }
                };

                drawFrame().then(() => {
                    canvas.toBlob(blob => resolve(new File([blob], "story.jpg", { type: "image/jpeg" })), 'image/jpeg', 0.9);
                });
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
            if (Date.now() - this.pressStartTime > 200) return;
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
            const reader = new FileReader();
            reader.onload = (e) => {
                this.editUser.avatar = e.target.result;
            };
            reader.readAsDataURL(file);
        },
        async setReaction(post, reaction) {
            if (!post) return;
            
            const currentReaction = post.myReaction || null;
            const isUnreacting = currentReaction === reaction;
            const isReactingForTheFirstTime = !currentReaction;

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
                body: JSON.stringify({ post_id: post.id })
            });
        },
        reportStory() {
            if (!this.viewingStory) return;
            const currentStory = this.viewingStory.list[this.viewingStory.index];
            // Ensure user_id is available
            if (!currentStory.user_id && this.viewingStory.user) {
                currentStory.user_id = this.viewingStory.user.id;
            }
            this.openReportModal('story', currentStory);
        },
        reportUser(user) {
            if (!user) return; 
            this.openReportModal('user', user);
        }, 
        reportPost(post) {
            if (!post) return;
            this.openReportModal('post', post);
        },
        startChatWithUser(userToChat) {
            if (!userToChat) return;
            this.showUserProfile = false; // Close profile modal
            
            if (!this.chatMessages[userToChat.id]) {
                this.chatMessages[userToChat.id] = [];
            }

            let chat = this.chats.find(c => c.id == userToChat.id && c.type !== 'group');
            
            if (!chat) {
                chat = {
                    id: userToChat.id,
                    name: userToChat.name,
                    avatar: userToChat.avatar,
                    lastMsg: 'Start a conversation',
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
            this.isCalling = true;
            this.isCallMinimized = false;
            this.isCallChatOpen = false;
            this.callType = type;
            this.callStatus = 'Calling...';
            this.callDuration = 0;
            this.isMicMuted = false;
            this.isCameraOff = false;
            this.facingMode = 'user';
            this.isPoorConnection = false;
            this.isReconnecting = false;
            this.isScreenSharing = false;
            document.getElementById('ringing-sound').play().catch(()=>{});

            navigator.mediaDevices.getUserMedia({
                video: type === 'video' ? { facingMode: this.facingMode } : false,
                audio: true
            }).then(stream => {
                this.localStream = Alpine.raw(stream);
                if (type === 'video') {
                    this.$refs.localVideo.srcObject = stream;
                }
                
                // Update mic/camera state based on initial stream
                this.isMicMuted = !stream.getAudioTracks().some(track => track.enabled);
                this.isCameraOff = type === 'video' ? !stream.getVideoTracks().some(track => track.enabled) : true;

                this.setupPeerConnection();
                this.localStream.getTracks().forEach(track => this.peerConnection.addTrack(track, this.localStream));

                // Create Offer
                this.peerConnection.createOffer().then(offer => {
                    this.peerConnection.setLocalDescription(offer);
                    // Optimize: Send via Socket directly
                    this.socket.emit('call_user', {
                        userToCall: this.activeChat.id,
                        signalData: offer,
                        from: this.user.id,
                        name: this.user.name,
                        avatar: this.user.avatar,
                        type: type
                    });
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
        setupPeerConnection() {
            const servers = { iceServers: [{ urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] }] };
            this.peerConnection = new RTCPeerConnection(servers);

            this.peerConnection.onicecandidate = event => {
                if (event.candidate && this.activeChat) {
                    this.socket.emit('ice_candidate', {
                        to: this.activeChat.id,
                        candidate: event.candidate
                    });
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

            this.peerConnection.onconnectionstatechange = () => {
                switch (this.peerConnection.connectionState) {
                    case 'disconnected':
                    case 'failed':
                        this.isReconnecting = true;
                        this.showToast('Call Status', 'Connection lost. Reconnecting...', 'error');
                        break;
                    case 'connected':
                        this.isReconnecting = false;
                        this.isPoorConnection = false;
                        this.callStatus = 'Connected';
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
        },
        pollCallStatus() {
            // Polling deprecated in favor of Socket events (call_accepted, call_ended)
        },
        acceptCall() {
            const callData = this.incomingCall;
            this.incomingCall = null;
            document.getElementById('ringing-sound').pause();

            // Setup UI
            let caller = this.friends.find(f => f.id == callData.caller_id) || { id: callData.caller_id, name: callData.name, avatar: callData.avatar };
            this.activeChat = caller;
            this.isCalling = true;
            this.callType = callData.type;
            this.currentCallId = callData.id;
            this.callStatus = 'Connecting...';
            this.callDuration = 0;

            navigator.mediaDevices.getUserMedia({
                video: this.callType === 'video',
                audio: true
            }).then(stream => {
                this.localStream = Alpine.raw(stream);
                if (this.callType === 'video') this.$refs.localVideo.srcObject = stream;
                
                this.setupPeerConnection();
                this.localStream.getTracks().forEach(track => this.peerConnection.addTrack(track, this.localStream));

                this.peerConnection.setRemoteDescription(new RTCSessionDescription(JSON.parse(callData.sdp)));
                this.peerConnection.createAnswer().then(answer => {
                    this.peerConnection.setLocalDescription(answer);
                    this.socket.emit('answer_call', {
                        callId: callData.id,
                        to: callData.caller_id,
                        signal: answer
                    });
                });
            });
        },
        rejectCall() {
            if (!this.incomingCall) return;
            this.socket.emit('reject_call', { callId: this.incomingCall.id, to: this.incomingCall.caller_id });
            this.incomingCall = null;
            document.getElementById('ringing-sound').pause();
        },
        endCall() {
            if (this.isCallRecording && this.callRecorder && this.callRecorder.state !== 'inactive') {
                this.callRecorder.stop();
                this.isCallRecording = false;
            }
            
            // Notify via Socket
            const wasActiveChat = this.activeChat;
            if (this.activeChat) {
                this.socket.emit('end_call', { 
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
            document.getElementById('ringing-sound').pause();
            document.getElementById('ringing-sound').currentTime = 0;
            this.localStream?.getTracks().forEach(track => track.stop());
            this.localStream = null;
            if (this.peerConnection) this.peerConnection.close();
            this.peerConnection = null;
            this.currentCallId = null;
            this.$refs.remoteVideo.pause();
            this.$refs.remoteVideo.srcObject = null;

            if (this.activeChat) {
                if (!this.chatMessages[this.activeChat.id]) this.chatMessages[this.activeChat.id] = [];
                
                let messageContent = '';
                if (wasConnected) {
                    messageContent = `${this.callType === 'voice' ? 'Voice' : 'Video'} call ended • ${this.formatRecordingTime(this.callDuration)}`;
                } else {
                    messageContent = `Missed ${this.callType === 'voice' ? 'voice' : 'video'} call`;
                }

                // Send call log to chat
                this.sendMessage(messageContent, 'call_log');
            }
            
            this.callStatus = '';
            this.callDuration = 0;
            this.isCallMinimized = false;
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
        setupReelsObserver() {
            if (this.observer) this.observer.disconnect();
            if (!this.$refs.reelsContainer) return;

            const options = {
                root: this.$refs.reelsContainer,
                threshold: 0.6,
            };

            this.observer = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    const video = entry.target.querySelector('video');
                    if (!video) return;

                    const reelId = entry.target.dataset.reelId;
                    const reel = this.reels.find(r => r.id == reelId);

                    if (entry.isIntersecting) {
                        video.play().catch(e => {});

                        // Increment view count
                        if (reel && !this.viewedReels.has(reel.id)) {
                            this.viewedReels.add(reel.id);
                            reel.views = (reel.views || 0) + 1; // Optimistic update
                                this.apiFetch('/api/increment_reel_view', {
                                method: 'POST',
                                headers: { 
                                    'Content-Type': 'application/json',
                                    'X-CSRF-Token': CSRF_TOKEN
                                },
                                body: JSON.stringify({ post_id: reel.id })
                            });
                        }
                    } else {
                        video.pause();
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
            let url = '/api/get_posts?page=1';
            if (this.activeHashtag) {
                url += `&hashtag=${encodeURIComponent(this.activeHashtag)}`;
            }
            
            this.apiFetch(url)
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
            if (this.isLoadingMore) return;
            this.isLoadingMore = true;
            this.page++;
            let url = `/api/get_posts?page=${this.page}`;
            if (this.activeHashtag) {
                url += `&hashtag=${encodeURIComponent(this.activeHashtag)}`;
            }

            this.apiFetch(url)
                .then(data => {
                    if (data.length > 0) {
                        this.posts = [...this.posts, ...data];
                    }
                    this.isLoadingMore = false;
                });
        },
        loadMoreReels() {
            if (this.isLoadingMoreReels) return;
            this.isLoadingMoreReels = true;
            this.reelPage++;
            this.apiFetch(`/api/get_reels?page=${this.reelPage}&limit=5`)
                .then(data => {
                    if (data && data.length > 0) {
                        this.reels = [...this.reels, ...data];
                    }
                    this.isLoadingMoreReels = false;
                }).catch(() => {
                    this.isLoadingMoreReels = false;
                });
        },
        handleScroll(el) {
            this.showScrollTop = (el.scrollTop > 300);
            if (el.scrollTop + el.clientHeight >= el.scrollHeight - 100) {
                this.loadMorePosts();
            }
        },
        scrollReel(direction) {
            if (this.activeTab !== 'reels') return;
            const container = this.$refs.reelsContainer;
            const reelHeight = container.clientHeight;
            const currentIndex = Math.round(container.scrollTop / reelHeight);
            const nextIndex = Math.max(0, Math.min(this.reels.length - 1, currentIndex + direction));
            container.scrollTo({
                top: reelHeight * nextIndex,
                behavior: 'smooth'
            });
        },
        shareReel(reel) {
            if (navigator.share) {
                navigator.share({
                    title: 'Check out this reel on Maiga Social!',
                    text: reel.caption,
                    url: window.location.href
                }).then(() => {
                    reel.shares++;
                    this.showToast('Shared', 'Reel shared successfully!', 'success');
                }).catch((error) => console.log('Error sharing', error));
            } else {
                this.sharingPost = { ...reel, media_type: 'video' };
                this.showShareModal = true;
            }
        },
        markNotInterested(reel) {
            this.reels = this.reels.filter(r => r.id !== reel.id);
            this.showToast('Feedback', 'We will show less like this.', 'info');
            this.showReelOptions = false;
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
                targetId: target.id,
                targetUserId: type === 'user' ? target.id : (target.user_id || (target.user ? target.user.id : null))
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
            const formData = new FormData();
            formData.append('user_id', this.reportForm.targetUserId);
            formData.append('reason', this.reportForm.title);
            formData.append('details', this.reportForm.description + `\n(Reported ${this.reportForm.targetType} ID: ${this.reportForm.targetId})`);
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

            // Register Service Worker if not already done
            try {
                const appType = this.user.account_type || 'maiga';
                await navigator.serviceWorker.register(`/sw.js?app=${appType}`);
                const registration = await navigator.serviceWorker.ready;
                
                const vapidResp = await fetch(`${API_BASE_URL}/api/vapid_public_key`);
                if (!vapidResp.ok) {
                    console.warn("VAPID key endpoint not found. Push notifications disabled.");
                    return;
                }
                
                const { publicKey } = await vapidResp.json();
                if (!publicKey || publicKey.includes('REPLACE')) return;

                const convertedVapidKey = this.urlBase64ToUint8Array(publicKey);

                // Subscribe
                const subscription = await registration.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: convertedVapidKey
                });

                // Send subscription to backend
                await this.apiFetch('/api/subscribe', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF_TOKEN },
                    body: JSON.stringify(subscription)
                });
            } catch (e) {
                console.warn("Service Worker or Push registration failed:", e);
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
                    const request = indexedDB.open(this.dbName, 2); // Bump version to add store
                    request.onupgradeneeded = e => {
                        this.db = e.target.result;
                        if (!this.db.objectStoreNames.contains(this.storeName)) {
                            this.db.createObjectStore(this.storeName, { keyPath: 'id' });
                        }
                        if (!this.db.objectStoreNames.contains('pending_messages')) {
                            this.db.createObjectStore('pending_messages', { keyPath: 'id', autoIncrement: true });
                        }
                    };
                    request.onsuccess = e => { this.db = e.target.result; resolve(); };
                    request.onerror = e => { reject(e.target.error); };
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
