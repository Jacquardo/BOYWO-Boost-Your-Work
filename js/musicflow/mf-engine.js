// MusicFlow - MOTEUR AUDIO (chargé dans offscreen.html, APRÈS audio-db.js et offscreen.js).
// Pourquoi ici : Chrome n'autorise qu'UN seul document offscreen par extension, et le popup BOYWO se ferme
// dès qu'il perd le focus. Le moteur doit donc vivre dans l'offscreen existant pour que la musique continue.
// Cohabitation : cet élément <audio> est distinct de #bg-audio-element (lecteur BOYWO) ; un seul des deux joue à la fois.
// Messages écoutés : { target: 'musicflow', action: ... } -> aucun conflit avec { target: 'offscreen' }.
(function () {
    if (globalThis.__mfEngine) return;
    globalThis.__mfEngine = true;

    const bg = document.getElementById('bg-audio-element'); // lecteur BOYWO (lecture seule ici : pause/événements)
    const a = new Audio();
    a.preload = 'auto'; // pas de crossOrigin : un flux sans en-têtes CORS doit pouvoir jouer (pas d'égaliseur sur ce lecteur)

    let queue = [], index = -1, shuffle = false, repeat = 0, blobUrl = null, error = null; // repeat : 0 off, 1 tout, 2 piste
    // NB : un document offscreen n'a accès qu'à chrome.runtime (pas chrome.storage). Volume partagé avec le lecteur BOYWO (bg) ;
    // l'état « en cours » est relayé par background.js (message mfNowPlaying), qui l'écrit dans chrome.storage pour le mini-lecteur.
    const cur = () => queue[index] || null;
    // Flux continu (radio) : pas de position, pas de « fin » normale ; messages d'erreur dédiés
    const failMsg = (t) => (t && t.live ? 'Cette radio est hors ligne ou son flux est indisponible.' : 'Lecture impossible pour cette piste');

    // Instantané relayé à background.js (qui l'écrit dans chrome.storage.local : clé mf_now, exclue de la synchro Drive)
    function publish() {
        const t = cur();
        const now = { track: t ? { title: t.title, artist: t.artist, cover: t.cover || '' } : null, isPlaying: !a.paused && !!a.src, ts: Date.now() };
        try { chrome.runtime.sendMessage({ action: 'mfNowPlaying', now }, () => void chrome.runtime.lastError); } catch (_) {}
    }

    async function resolveSrc(t) {
        if (t.source !== 'local') return t.url;
        if (typeof AudioDB === 'undefined') throw new Error('Bibliothèque locale indisponible');
        const rec = (await AudioDB.getAllTracks()).find((x) => x.id === t.localId);
        if (!rec) throw new Error('Fichier introuvable');
        let f = rec.file;
        if (!(f instanceof Blob)) f = new Blob([f.buffer || f.data], { type: f.type || 'audio/mpeg' });
        if (blobUrl) URL.revokeObjectURL(blobUrl);
        blobUrl = URL.createObjectURL(f);
        return blobUrl;
    }

    const ms = () => ('mediaSession' in navigator ? navigator.mediaSession : null);
    function takeMediaSession(t) {
        const m = ms(); if (!m) return;
        m.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: t.album || 'MusicFlow', artwork: t.cover ? [{ src: t.cover }] : [] });
        m.setActionHandler('play', () => a.play());
        m.setActionHandler('pause', () => a.pause());
        m.setActionHandler('stop', () => { a.pause(); a.currentTime = 0; });
        m.setActionHandler('previoustrack', prev);
        m.setActionHandler('nexttrack', () => next(false));
    }

    async function playAt(i) {
        if (i < 0 || i >= queue.length) return;
        index = i; error = null;
        const t = queue[i];
        try {
            const src = await resolveSrc(t);
            if (bg && !bg.paused) bg.pause(); // une seule source audible à la fois
            if (bg) a.volume = bg.volume; // volume partagé avec le lecteur BOYWO
            a.src = src;
            await a.play();
            takeMediaSession(t);
        } catch (e) {
            if (!e || e.name !== 'AbortError') error = e && e.name === 'NotSupportedError' ? failMsg(t) : String((e && e.message) || e);
        }
        publish();
    }

    function next(auto) {
        if (!queue.length) return;
        if (auto && repeat === 2) { a.currentTime = 0; a.play(); return; }
        let n;
        if (shuffle && queue.length > 1) { do { n = Math.floor(Math.random() * queue.length); } while (n === index); }
        else {
            n = index + 1;
            if (n >= queue.length) { if (repeat === 1 || !auto) n = 0; else { a.pause(); publish(); return; } }
        }
        playAt(n);
    }
    function prev() {
        if (!queue.length) return;
        if (a.currentTime > 3 && !(cur() && cur().live)) { a.currentTime = 0; return; }
        playAt(index - 1 < 0 ? queue.length - 1 : index - 1);
    }

    // Bibliothèque : télécharge un titre Jamendo AUTORISÉ au téléchargement et l'enregistre dans BoywoAudio (« Mes fichiers »),
    // dossier « Jamendo ». Exécuté ici (offscreen) pour que le téléchargement continue même si le popup se ferme.
    const LIB_MAX = 80 * 1024 * 1024;
    const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
    const reloadLocal = () => (typeof globalThis.loadPlaylistFromDB === 'function' ? globalThis.loadPlaylistFromDB() : Promise.resolve());
    async function saveToLibrary(t) {
        let u = null;
        try { u = new URL(t && t.download); } catch (_) {}
        if (!t || t.source !== 'jamendo' || t.downloadAllowed !== true || !u || u.protocol !== 'https:' || !/(^|\.)jamendo\.com$/.test(u.hostname)) return { ok: false, code: 'NOT_ALLOWED' };
        if (typeof AudioDB === 'undefined') return { ok: false, code: 'NO_DB' };
        const id = 'jamendo-' + String(t.id).replace(/^jamendo:/, ''); // id sans caractère spécial (Drive, sélecteurs CSS)
        try {
            const old = (await AudioDB.getAllTracks()).find((x) => x.id === id);
            if (old) { if (old.status === 'deleted') { await AudioDB.updateTrackStatus(id, 'active'); await reloadLocal(); } return { ok: true, already: true }; }
            let res;
            try { res = await fetch(u.href); } catch (_) { return { ok: false, code: 'NETWORK' }; }
            if (!res.ok) return { ok: false, code: 'DOWNLOAD_HTTP', detail: res.status };
            const blob = await res.blob();
            if (blob.size > LIB_MAX) return { ok: false, code: 'TOO_BIG' };
            if (blob.size < 20 * 1024 || (blob.type && !/^audio\/|octet-stream/i.test(blob.type))) return { ok: false, code: 'BAD_FILE' };
            const ext = /ogg/i.test(blob.type) ? 'ogg' : /flac/i.test(blob.type) ? 'flac' : 'mp3';
            const title = safeName((t.artist || 'Artiste') + ' - ' + (t.title || 'Titre')) || 'Jamendo';
            const name = title; // nom affiché : sans extension, comme les fichiers importés par le lecteur
            const file = new File([blob], title + '.' + ext, { type: blob.type && /^audio\//i.test(blob.type) ? blob.type : 'audio/mpeg' });
            await AudioDB.saveTracks([{ id, name, file, status: 'active', folder: 'Jamendo' }]);
            await reloadLocal(); // la playlist « Mes fichiers » du lecteur BOYWO voit le nouveau titre
            return { ok: true, name };
        } catch (_) { return { ok: false, code: 'DOWNLOAD_FAILED' }; }
    }

    a.addEventListener('ended', () => {
        const t = cur();
        if (t && t.live) { error = 'Le flux de cette radio s’est interrompu.'; publish(); return; } // une radio ne « finit » pas : coupure
        next(true);
    });
    a.addEventListener('play', publish);
    a.addEventListener('pause', publish);
    a.addEventListener('error', () => { error = failMsg(cur()); publish(); });

    // Quand le lecteur BOYWO démarre : MusicFlow se met en pause et rend les touches média à BOYWO
    // (playNext/playPrev sont des fonctions globales de offscreen.js).
    if (bg) bg.addEventListener('play', () => {
        if (!a.paused) a.pause();
        const m = ms();
        if (m) {
            m.setActionHandler('play', () => bg.play());
            m.setActionHandler('pause', () => bg.pause());
            m.setActionHandler('stop', () => { bg.pause(); bg.currentTime = 0; });
            m.setActionHandler('previoustrack', () => globalThis.playPrev && globalThis.playPrev());
            m.setActionHandler('nexttrack', () => globalThis.playNext && globalThis.playNext());
        }
        publish();
    });

    const state = () => ({
        track: cur(), index, queueLength: queue.length, isPlaying: !a.paused && !!a.src,
        currentTime: a.currentTime || 0, duration: isFinite(a.duration) ? a.duration : (cur() ? cur().duration : 0),
        volume: Math.round((bg ? bg.volume : a.volume) * 100), shuffle, repeat, error,
    });

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        // Déconnexion manuelle ou expiration de session (background.js) : on coupe aussi MusicFlow, sans reprise automatique.
        if (msg && msg.target === 'offscreen' && msg.action === 'pauseForLogout') { a.pause(); return; }
        if (!msg || msg.target !== 'musicflow') return;
        switch (msg.action) {
            case 'setQueue':
                queue = Array.isArray(msg.tracks) ? msg.tracks : [];
                playAt(Number(msg.index) || 0).then(() => sendResponse(state()));
                return true;
            case 'enqueue':
                if (msg.track) queue.push(msg.track);
                sendResponse(state()); return;
            case 'playPause':
                if (a.src) { a.paused ? a.play().catch(() => {}) : a.pause(); }
                else if (queue.length) playAt(Math.max(index, 0));
                sendResponse(state()); return;
            case 'next': next(false); sendResponse(state()); return;
            case 'prev': prev(); sendResponse(state()); return;
            case 'seek': if (!isNaN(msg.time)) a.currentTime = msg.time; sendResponse(state()); return;
            case 'setVolume': a.volume = Math.min(1, Math.max(0, msg.volume / 100)); if (bg) bg.volume = a.volume; sendResponse(state()); return;
            case 'setMode': shuffle = !!msg.shuffle; repeat = msg.repeat || 0; sendResponse(state()); return;
            case 'saveToLibrary': saveToLibrary(msg.track).then(sendResponse); return true;
            case 'getState': sendResponse(state()); return;
        }
    });
})();
