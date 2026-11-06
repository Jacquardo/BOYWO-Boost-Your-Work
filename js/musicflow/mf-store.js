// MusicFlow - stockage (favoris + playlists). Base IndexedDB PROPRE à MusicFlow : "BoywoMusicFlow".
// On ne touche pas à "BoywoAudio" (utilisée par le lecteur BOYWO et la synchro Drive).
(function () {
    const MF = (globalThis.MF = globalThis.MF || {});
    let dbp = null;

    function open() {
        if (dbp) return dbp;
        dbp = new Promise((resolve, reject) => {
            const r = indexedDB.open('BoywoMusicFlow', 1);
            r.onupgradeneeded = () => {
                const db = r.result;
                if (!db.objectStoreNames.contains('favorites')) db.createObjectStore('favorites', { keyPath: 'id' });
                if (!db.objectStoreNames.contains('playlists')) db.createObjectStore('playlists', { keyPath: 'id' });
            };
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => reject(r.error);
        });
        return dbp;
    }

    async function run(store, mode, fn) {
        const db = await open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(store, mode);
            let out;
            const req = fn(tx.objectStore(store));
            if (req) req.onsuccess = () => { out = req.result; };
            tx.oncomplete = () => resolve(out);
            tx.onerror = tx.onabort = () => reject(tx.error);
        });
    }

    MF.store = {
        getFavorites: () => run('favorites', 'readonly', (s) => s.getAll()).then((r) => r || []),
        addFavorite: (track) => run('favorites', 'readwrite', (s) => s.put(track)),
        removeFavorite: (id) => run('favorites', 'readwrite', (s) => s.delete(id)),
        getPlaylists: () => run('playlists', 'readonly', (s) => s.getAll()).then((r) => r || []),
        savePlaylist: (pl) => run('playlists', 'readwrite', (s) => s.put(pl)),
        deletePlaylist: (id) => run('playlists', 'readwrite', (s) => s.delete(id)),
    };
})();
