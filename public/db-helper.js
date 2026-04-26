// Shared IndexedDB Configuration
const MAIGA_DB_CONFIG = {
    name: 'maiga_crypto',
    version: 5, // Incrementing to ensure clean state
    stores: [
        { name: 'keys', options: { keyPath: 'id' } },
        { name: 'pending_messages', options: { keyPath: 'id', autoIncrement: true } },
        { name: 'pending_posts', options: { keyPath: 'id', autoIncrement: true } }
    ]
};

async function openMaigaDB(dbName = null) {
    return new Promise((resolve, reject) => {
        const name = dbName || MAIGA_DB_CONFIG.name;
        const request = indexedDB.open(name, MAIGA_DB_CONFIG.version);

        request.onblocked = () => {
            console.warn("Database upgrade blocked by another tab. Please close other instances of this app.");
            // In a PWA, you might trigger a UI notification here
        };

        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            const transaction = e.target.transaction;
            const oldVersion = e.oldVersion;

            // 1. Structural Changes (Creating Stores)
            MAIGA_DB_CONFIG.stores.forEach(store => {
                if (!db.objectStoreNames.contains(store.name)) {
                    db.createObjectStore(store.name, store.options);
                }
            });

            // 2. Data Migrations (Transforming Data)
            if (oldVersion < 5 && oldVersion > 0) {
                // Example: Transform data in 'pending_messages'
                if (db.objectStoreNames.contains('pending_messages')) {
                    const store = transaction.objectStore('pending_messages');
                    store.openCursor().onsuccess = (event) => {
                        const cursor = event.target.result;
                        if (cursor) {
                            const update = cursor.value;
                            // Apply transformation logic
                            // e.g., update.newField = update.oldField || 'default';
                            cursor.update(update);
                            cursor.continue();
                        }
                    };
                }
            }
        };

        request.onsuccess = () => {
            const db = request.result;
            db.onversionchange = () => {
                db.close();
                window.dispatchEvent(new CustomEvent('maiga-db-outdated'));
            };
            resolve(db);
        };
        request.onerror = () => reject(request.error);
    });
}