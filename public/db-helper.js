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

async function openMaigaDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(MAIGA_DB_CONFIG.name, MAIGA_DB_CONFIG.version);
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            MAIGA_DB_CONFIG.stores.forEach(store => {
                if (!db.objectStoreNames.contains(store.name)) {
                    db.createObjectStore(store.name, store.options);
                }
            });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}