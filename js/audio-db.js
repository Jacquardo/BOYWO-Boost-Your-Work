// audio-db.js

// globalThis : fonctionne dans les pages (window), l'offscreen ET le service worker de synchro
globalThis.AudioDB = {
    dbName: "BoywoAudio",
    silent: false, // mis à true par le moteur de synchro pour ses propres écritures

    // Prévient le service worker qu'une piste a été ajoutée/modifiée/supprimée (synchro Drive)
    _notify() {
        if (this.silent) return;
        try {
            if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
                const p = chrome.runtime.sendMessage({ action: 'boywoAudioChanged' });
                if (p && p.catch) p.catch(() => {});
            }
        } catch (_) {}
    },
    init() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(this.dbName, 1);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains("playlist")) {
                    db.createObjectStore("playlist", { keyPath: "id" });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    },
    async saveTracks(tracks) {
        const db = await this.init();
        return new Promise((resolve, reject) => {
            const tx = db.transaction("playlist", "readwrite");
            const store = tx.objectStore("playlist");

            // Stocker chaque piste
            tracks.forEach(track => {
                const rec = {
                    id: track.id,
                    name: track.name,
                    file: track.file,
                    status: track.status || 'active' // 'active' | 'deleted' (Corbeille)
                };
                if (track.folder) rec.folder = track.folder; // dossier d'origine (ex. « Jamendo ») : champ optionnel
                store.put(rec);
            });

            tx.oncomplete = () => { this._notify(); resolve(); };
            tx.onerror = () => reject(tx.error);
        });
    },
    async getAllTracks() {
        const db = await this.init();
        return new Promise((resolve, reject) => {
            const tx = db.transaction("playlist", "readonly");
            const req = tx.objectStore("playlist").getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
    },
    async clearAll() {
        const db = await this.init();
        return new Promise((resolve, reject) => {
            const tx = db.transaction("playlist", "readwrite");
            tx.objectStore("playlist").clear();
            tx.oncomplete = () => { this._notify(); resolve(); };
            tx.onerror = () => reject(tx.error);
        });
    },

    // --- Méthodes ciblées : ne touchent qu'UNE SEULE piste, jamais toute la base ---

    async updateTrackName(id, newName) {
        const db = await this.init();
        return new Promise((resolve, reject) => {
            const tx = db.transaction("playlist", "readwrite");
            const store = tx.objectStore("playlist");
            const getReq = store.get(id);
            getReq.onsuccess = () => {
                const track = getReq.result;
                if (track) { track.name = newName; store.put(track); }
            };
            tx.oncomplete = () => { this._notify(); resolve(); };
            tx.onerror = () => reject(tx.error);
        });
    },

    async updateTrackStatus(id, status) {
        const db = await this.init();
        return new Promise((resolve, reject) => {
            const tx = db.transaction("playlist", "readwrite");
            const store = tx.objectStore("playlist");
            const getReq = store.get(id);
            getReq.onsuccess = () => {
                const track = getReq.result;
                if (track) { track.status = status; store.put(track); }
            };
            tx.oncomplete = () => { this._notify(); resolve(); };
            tx.onerror = () => reject(tx.error);
        });
    },

    async deleteTrack(id) {
        const db = await this.init();
        return new Promise((resolve, reject) => {
            const tx = db.transaction("playlist", "readwrite");
            tx.objectStore("playlist").delete(id);
            tx.oncomplete = () => { this._notify(); resolve(); };
            tx.onerror = () => reject(tx.error);
        });
    }
};
