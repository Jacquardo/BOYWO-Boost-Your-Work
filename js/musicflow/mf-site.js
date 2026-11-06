// MusicFlow - logique de la page du SITE (outils/musicflow.html), dérivée de js/musicflow/mf-page.js de l'extension.
// Différences avec l'extension : le moteur audio (mf-engine.js) tourne dans la page (bus de messages de chrome-shim.js) au lieu du
// document offscreen ; la recherche réunit Jamendo, Audius et YouTube (MF.searchUnified) ; onglet Radios par pays ; les vidéos YouTube
// sont lues dans le lecteur officiel affiché dans la page ; le mini-lecteur flottant (réservé à l'extension) est retiré des réglages.
(function () {
    'use strict';
    const MF = globalThis.MF;
    const $ = (id) => document.getElementById(id);
    const S = { tab: 'discover', type: 'tracks', stack: [], favs: new Map(), playlists: [], seeking: false, dlgTrack: null };
    const AUDIO_RE = /\.(mp3|ogg|wav|m4a|aac|flac|opus)$/i;

    // ---------- utilitaires ----------
    function h(tag, attrs, ...kids) {
        const e = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs || {})) {
            if (k === 'class') e.className = v;
            else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
            else if (v !== false && v != null) e.setAttribute(k, v);
        }
        kids.flat().forEach((c) => { if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(c)); });
        return e;
    }
    function ico(id) {
        const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        s.setAttribute('class', 'mf-ico'); s.setAttribute('aria-hidden', 'true');
        const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        u.setAttribute('href', '#' + id); s.append(u); return s;
    }
    const fmt = (s) => { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
    function toast(msg) { const t = $('mf-toast'); t.textContent = msg; t.classList.add('mf-toast-show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('mf-toast-show'), 2600); }
    const cover = (src, cls) => (src ? h('img', { class: cls, src, alt: '', loading: 'lazy' }) : h('div', { class: cls + ' mf-nocover' }, ico('m-music')));

    // ---------- dialogue avec le moteur ----------
    function send(action, extra) {
        return new Promise((resolve) => {
            try { chrome.runtime.sendMessage(Object.assign({ target: 'musicflow', action }, extra), (r) => { resolve(chrome.runtime.lastError ? null : (r || null)); }); }
            catch (_) { resolve(null); }
        });
    }
    async function ensureEngine() {
        if (await send('getState')) return true;
        // Le document offscreen peut être fermé (Chrome le ferme après ~30 s sans son) : background.js le recrée (message existant).
        await new Promise((r) => { try { chrome.runtime.sendMessage({ action: 'initOffscreen' }, () => { void chrome.runtime.lastError; r(); }); } catch (_) { r(); } });
        for (let i = 0; i < 6; i++) { await new Promise((r) => setTimeout(r, 250)); if (await send('getState')) return true; }
        return false;
    }
    // ---------- vidéo YouTube : lecteur officiel (API IFrame via player/player.html), visible dans la page ----------
    const Y = { ctrl: null, track: null, list: [], i: -1, playing: false, t: 0, d: 0, v: 100, active: false };
    function ytEvent(e) {
        if (e.evt === 'problem') { const d = MF.yt.describe(e.code); toast(d[0] + ' : ' + d[1]); }
        else if (e.evt === 'time') { Y.t = e.t || 0; Y.d = e.d || 0; Y.v = e.m ? 0 : (e.v == null ? 100 : e.v); Y.playing = e.s === 1; }
        else if (e.evt === 'state') { Y.playing = e.s === 1; if (e.s === 0 && Y.i < Y.list.length - 1) ytStep(1); }
        else if (e.evt === 'meta' && e.title && Y.track) { $('mf-video-title').textContent = e.title; }
    }
    function ytLoad() {
        const t = Y.track; if (!t) return;
        $('mf-video').hidden = false;
        $('mf-video-title').textContent = t.title;
        $('mf-video-channel').textContent = t.artist || '';
        $('mfy-open').href = MF.providers.youtube.watchUrl(t.videoId);
        if (!Y.ctrl) Y.ctrl = MF.yt.attach($('mfy-frame'), { controls: true, onEvent: ytEvent });
        Y.ctrl.load(t.videoId, { autoplay: true });
    }
    function ytStep(d) {
        if (!Y.list.length) return;
        Y.i = (Y.i + d + Y.list.length) % Y.list.length; Y.track = Y.list[Y.i]; Y.t = 0; Y.d = 0; ytLoad();
    }
    async function playVideo(list, i) {
        const t = list[i];
        Y.list = list.filter((x) => x.source === 'youtube' && x.videoId); Y.i = Y.list.findIndex((x) => x.id === t.id);
        if (Y.i < 0) return;
        const st = await send('getState'); if (st && st.isPlaying) await send('playPause'); // une seule source sonore à la fois
        Y.track = Y.list[Y.i]; Y.active = true; ytLoad();
    }
    function stopVideo() {
        if (Y.ctrl) Y.ctrl.send({ cmd: 'pause' });
        Y.active = false; Y.playing = false; $('mf-video').hidden = true;
    }
    // Commandes de la barre du lecteur : la vidéo si elle est active, sinon le moteur audio
    function ctl(action, extra) {
        if (!Y.active) return send(action, extra);
        switch (action) {
            case 'playPause': if (Y.ctrl) Y.ctrl.send({ cmd: Y.playing ? 'pause' : 'play' }); break;
            case 'next': ytStep(1); break;
            case 'prev': ytStep(-1); break;
            case 'seek': if (Y.ctrl) Y.ctrl.send({ cmd: 'seek', time: extra.time }); break;
            case 'setVolume': if (Y.ctrl) { Y.ctrl.send({ cmd: 'unmute' }); Y.ctrl.send({ cmd: 'volume', value: extra.volume }); } Y.v = extra.volume; send(action, extra); break;
            default: send(action, extra);
        }
        return Promise.resolve(null);
    }
    // Le hub « Outils » prévient quand l'onglet MusicFlow est masqué : la vidéo doit rester visible pour jouer (règle YouTube), on la met en pause.
    window.addEventListener('message', (e) => {
        if (e.origin !== location.origin || e.source !== window.parent || !e.data || e.data.boywo !== 'tab-hidden') return;
        if (Y.active && Y.playing && Y.ctrl) Y.ctrl.send({ cmd: 'pause' });
    });

    async function playList(tracks, i) {
        const t = tracks[i];
        if (t && t.source === 'youtube') return playVideo(tracks, i);
        if (Y.active) stopVideo();
        if (!(await ensureEngine())) return toast('Moteur audio indisponible : rechargez la page puis réessayez.');
        const st = await send('setQueue', { tracks, index: i });
        if (st && st.error) toast(st.error);
    }

    // ---------- lignes de pistes ----------
    function trackRow(t, list, i, opts) {
        opts = opts || {};
        const fav = h('button', { class: 'mf-icobtn mf-fav', type: 'button', title: 'Favori', 'aria-pressed': String(S.favs.has(t.id)) }, ico('m-heart'));
        fav.addEventListener('click', async () => {
            if (S.favs.has(t.id)) { S.favs.delete(t.id); await MF.store.removeFavorite(t.id); } else { S.favs.set(t.id, t); await MF.store.addFavorite(t); }
            fav.setAttribute('aria-pressed', String(S.favs.has(t.id)));
            if (S.tab === 'favorites') render();
        });
        const add = h('button', { class: 'mf-icobtn', type: 'button', title: 'Ajouter à une playlist', onclick: () => openPlaylistDialog(t) }, ico('m-plus'));
        const extra = opts.onRemove ? h('button', { class: 'mf-icobtn', type: 'button', title: 'Retirer', onclick: () => opts.onRemove(t) }, ico('m-trash')) : null;
        return h('li', { class: 'mf-row' },
            h('button', { class: 'mf-play-cell', type: 'button', title: 'Lire', onclick: () => playList(list, i) }, cover(t.cover, 'mf-thumb'), h('span', { class: 'mf-playmark' }, ico('m-play'))),
            h('div', { class: 'mf-row-text' }, h('strong', {}, t.title), h('span', {}, t.source === 'youtube' ? [h('span', { class: 'mf-badge-yt', title: 'Vidéo : lecture dans le lecteur officiel YouTube, affiché dans la page' }, '▶ Vidéo'), t.artist] : [t.artist, t.album].filter(Boolean).join(' · '))),
            h('span', { class: 'mf-dur' }, t.duration ? fmt(t.duration) : ''), fav, add, extra);
    }
    const trackList = (tracks, opts) => tracks.length
        ? h('ul', { class: 'mf-list' }, tracks.map((t, i) => trackRow(t, tracks, i, opts)))
        : h('p', { class: 'mf-empty' }, 'Rien à afficher pour le moment.');

    // ---------- vues ----------
    const main = () => $('mf-main');
    const setView = (...nodes) => { main().replaceChildren(...nodes); };
    function errorBox(e) {
        if (e && e.message === 'NO_CLIENT_ID') {
            return h('div', { class: 'mf-card' }, h('h2', {}, 'Catalogue en ligne indisponible'),
                h('p', {}, 'La clé de l’application n’est pas encore configurée (assets/js/musicflow/mf-config.js). Vos fichiers locaux restent utilisables.'));
        }
        return h('div', { class: 'mf-card' }, h('h2', {}, 'Oups'), h('p', {}, 'Le service de streaming ne répond pas (' + ((e && e.message) || 'erreur') + ').'));
    }
    const backBtn = () => h('button', { class: 'mf-btn', type: 'button', onclick: () => { S.stack.pop(); const v = S.stack.pop(); if (v) v(); else render(); } }, ico('m-back'), 'Retour');

    // Recherche « Tout » : lecteur audio du site d'abord (Jamendo, Audius), YouTube en complément pour les artistes connus (MF.searchUnified).
    async function viewDiscover(query, forceYoutube) {
        const P = MF.providers.jamendo;
        setView(h('p', { class: 'mf-empty' }, 'Chargement…'));
        try {
            if (!query) {
                const tracks = await P.popular();
                return setView(h('h2', { class: 'mf-h' }, 'Populaires cette semaine'), trackList(tracks));
            }
            const [uni, artists, albums] = await Promise.all([
                MF.searchUnified(query, { forceYoutube: !!forceYoutube }), P.searchArtists(query).catch(() => []), P.searchAlbums(query).catch(() => [])]);
            const nodes = [];
            if (uni.youtubeQueried && !uni.audioCount) nodes.push(h('p', { class: 'mf-note' }, 'Pas de titre libre pour cette recherche : voici les vidéos YouTube, lues dans le lecteur officiel.'));
            uni.sections.forEach((sec) => { if (!sec.error && sec.tracks.length) nodes.push(h('h2', { class: 'mf-h' }, sec.label), trackList(sec.tracks)); });
            if (!nodes.length) nodes.push(h('p', { class: 'mf-empty' }, 'Aucun résultat.'));
            if (uni.canAddYoutube) nodes.push(h('button', { class: 'mf-btn mf-more', type: 'button', onclick: () => viewDiscover(query, true) }, 'Voir aussi sur YouTube (artistes connus)'));
            if (artists.length) nodes.push(h('h2', { class: 'mf-h' }, 'Artistes'), grid(artists.map((a) => ({ title: a.name, sub: 'Artiste', img: a.image, open: () => openCollection(a.name, () => P.artistTracks(a.id)) }))));
            if (albums.length) nodes.push(h('h2', { class: 'mf-h' }, 'Albums'), grid(albums.map((a) => ({ title: a.name, sub: a.artist, img: a.image, open: () => openCollection(a.name, () => P.albumTracks(a.id)) }))));
            setView(...nodes);
        } catch (e) { setView(errorBox(e)); }
    }

    // Radios en direct, par pays (annuaire Radio Browser). Seuls les flux https:// sont proposés sur le site.
    let radioCc = ((MF.providers.radio.countries() || [])[0] || { cc: 'MG' }).cc;
    async function viewRadio(query) {
        const R = MF.providers.radio;
        const chips = h('div', { class: 'mf-chips' }, R.countries().map((c) => h('button', { class: 'mf-chip', type: 'button', 'aria-pressed': String(c.cc === radioCc),
            onclick: () => { radioCc = c.cc; viewRadio(query); } }, c.label)));
        setView(chips, h('p', { class: 'mf-empty' }, 'Chargement…'));
        try {
            const tracks = await R.stations(query, radioCc);
            setView(chips, h('h2', { class: 'mf-h' }, query ? 'Stations trouvées' : 'Stations populaires'), trackList(tracks),
                h('p', { class: 'mf-note' }, 'Stations : annuaire Radio Browser (radio-browser.info). Les flux appartiennent à leurs diffuseurs.'));
        } catch (e) { setView(chips, errorBox(e)); }
    }
    const grid = (items) => items.length
        ? h('div', { class: 'mf-grid' }, items.map((it) => h('button', { class: 'mf-tile', type: 'button', onclick: it.open }, cover(it.img, 'mf-tile-img'), h('strong', {}, it.title), h('span', {}, it.sub))))
        : h('p', { class: 'mf-empty' }, 'Aucun résultat.');
    async function openCollection(title, loader) {
        S.stack.push(() => openCollection(title, loader));
        setView(h('p', { class: 'mf-empty' }, 'Chargement…'));
        try { const tracks = await loader(); setView(backBtn(), h('h2', { class: 'mf-h' }, title), trackList(tracks)); } catch (e) { setView(errorBox(e)); }
    }

    function localToTrack(r) { return { id: 'local:' + r.id, source: 'local', localId: r.id, title: r.name, artist: 'Fichier local', album: '', cover: '', url: '', duration: 0 }; }
    async function importFiles(fileList) {
        const files = Array.from(fileList).filter((f) => (f.type || '').startsWith('audio/') || AUDIO_RE.test(f.name));
        if (!files.length) return toast('Aucun fichier audio détecté.');
        // Même format que le lecteur BOYWO (audio-db.js) : les pistes importées sont aussi visibles dans Médias.
        await AudioDB.saveTracks(files.map((f) => ({ id: Date.now().toString() + Math.random(), name: f.name.replace(/\.[^.]+$/, ''), file: f, status: 'active' })));
        // Message BOYWO existant : rafraîchit la playlist du lecteur Médias
        try { chrome.runtime.sendMessage({ target: 'offscreen', action: 'reloadPlaylist' }, () => void chrome.runtime.lastError); } catch (_) {}
        toast(files.length + ' fichier(s) importé(s)');
        render();
    }
    async function viewLocal() {
        const rows = (await AudioDB.getAllTracks()).filter((r) => (r.status || 'active') === 'active').map(localToTrack);
        setView(
            h('div', { class: 'mf-actions' },
                h('button', { class: 'mf-btn mf-btn-solid', type: 'button', onclick: () => $('mf-file-input').click() }, 'Ajouter des fichiers'),
                h('button', { class: 'mf-btn', type: 'button', onclick: () => $('mf-folder-input').click() }, 'Ajouter un dossier')),
            h('h2', { class: 'mf-h' }, 'Mes fichiers (' + rows.length + ')'), trackList(rows));
    }
    const viewFavorites = () => setView(h('h2', { class: 'mf-h' }, 'Favoris'), trackList(Array.from(S.favs.values())));

    function viewPlaylists() {
        const make = h('form', { class: 'mf-pl-new', onsubmit: async (e) => {
            e.preventDefault(); const name = $('mf-pl-create').value.trim(); if (!name) return;
            await MF.store.savePlaylist({ id: crypto.randomUUID(), name, tracks: [] }); S.playlists = await MF.store.getPlaylists(); render();
        } }, h('input', { id: 'mf-pl-create', type: 'text', placeholder: 'Nouvelle playlist…', maxlength: '60', 'aria-label': 'Nom de la playlist' }), h('button', { class: 'mf-btn mf-btn-solid', type: 'submit' }, 'Créer'));
        setView(make, h('h2', { class: 'mf-h' }, 'Mes playlists'), S.playlists.length
            ? grid(S.playlists.map((p) => ({ title: p.name, sub: p.tracks.length + ' titre(s)', img: (p.tracks[0] || {}).cover, open: () => openPlaylist(p.id) })))
            : h('p', { class: 'mf-empty' }, 'Aucune playlist.'));
    }
    function openPlaylist(id) {
        S.stack.push(() => openPlaylist(id));
        const p = S.playlists.find((x) => x.id === id); if (!p) return viewPlaylists();
        setView(backBtn(), h('div', { class: 'mf-actions' }, h('h2', { class: 'mf-h' }, p.name),
            h('button', { class: 'mf-btn', type: 'button', onclick: async () => { await MF.store.deletePlaylist(id); S.playlists = await MF.store.getPlaylists(); S.stack = []; render(); } }, ico('m-trash'), 'Supprimer')),
            trackList(p.tracks, { onRemove: async (t) => { p.tracks = p.tracks.filter((x) => x.id !== t.id); await MF.store.savePlaylist(p); openPlaylist(id); S.stack.pop(); } }));
    }

    function viewSettings() {
        setView(
            h('div', { class: 'mf-card' }, h('h2', {}, 'Sources musicales'),
                h('p', {}, 'Jamendo et Audius (musique libre, lue par le lecteur du site), radios en direct (Radio Browser) et vidéos YouTube (lecteur officiel) pour les artistes connus.')),
            h('div', { class: 'mf-card' }, h('h2', {}, 'Données sur cet appareil'),
                h('p', {}, 'Favoris, playlists et fichiers importés restent dans votre navigateur, pour ce site uniquement. Ils ne sont pas partagés avec l’extension BOYWO.')),
            h('div', { class: 'mf-card' }, h('h2', {}, 'Autres fournisseurs'),
                Object.values(MF.providers).filter((p) => !p.available).map((p) => h('p', {}, h('strong', {}, p.label + ' : '), 'bientôt. ' + p.reason))),
            h('div', { class: 'mf-card' }, h('h2', {}, 'Extension BOYWO'),
                h('p', {}, 'La lecture en arrière-plan avec mini-lecteur flottant sur toutes vos pages est réservée à l’extension Chrome.'),
                h('a', { class: 'mf-btn mf-btn-solid', href: 'https://chromewebstore.google.com/detail/boywo-boost-your-work/joajfaoljmchpllcniehecddanhkolnf', target: '_blank', rel: 'noopener' }, 'Voir sur le Chrome Web Store')));
    }

    // ---------- dialogue playlist ----------
    function openPlaylistDialog(track) {
        S.dlgTrack = track;
        const box = $('mf-pl-list');
        box.replaceChildren(...(S.playlists.length ? S.playlists.map((p) => h('button', { class: 'mf-btn', type: 'button', onclick: async () => {
            if (!p.tracks.some((x) => x.id === track.id)) { p.tracks.push(track); await MF.store.savePlaylist(p); }
            toast('Ajouté à « ' + p.name + ' »'); $('mf-pl-dialog').close();
        } }, p.name + ' (' + p.tracks.length + ')')) : [h('p', { class: 'mf-empty' }, 'Aucune playlist : créez-en une ci-dessous.')]));
        $('mf-pl-dialog').showModal();
    }

    // ---------- navigation ----------
    function render() {
        S.stack = [];
        ({ discover: () => viewDiscover($('mf-search-input').value.trim()), radio: () => viewRadio($('mf-search-input').value.trim()), local: viewLocal, favorites: viewFavorites, playlists: viewPlaylists, settings: viewSettings }[S.tab])();
    }
    function showTab(tab) {
        S.tab = tab;
        document.querySelectorAll('.mf-nav-btn').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tab === tab)));
        render();
    }

    // ---------- barre du lecteur ----------
    let lastMode = {};
    async function tick() {
        if (document.hidden) return;
        const s = Y.active
            ? { track: Y.track, isPlaying: Y.playing, currentTime: Y.t, duration: Y.d, volume: Y.v, shuffle: false, repeat: 0 }
            : await send('getState');
        if (!s) return;
        const t = s.track;
        $('mf-np-title').textContent = t ? t.title : 'Aucune lecture';
        $('mf-np-artist').textContent = t ? t.artist : '—';
        const c = $('mf-np-cover'); if (t && t.cover) { c.src = t.cover; c.style.visibility = ''; } else c.style.visibility = 'hidden';
        $('mf-play-use').setAttribute('href', s.isPlaying ? '#m-pause' : '#m-play');
        if (!S.seeking) { $('mf-seek').max = s.duration || 100; $('mf-seek').value = s.currentTime; }
        $('mf-time-cur').textContent = fmt(s.currentTime); $('mf-time-dur').textContent = fmt(s.duration);
        $('mf-shuffle').setAttribute('aria-pressed', String(s.shuffle));
        $('mf-repeat').setAttribute('aria-pressed', String(s.repeat > 0)); $('mf-repeat-one').hidden = s.repeat !== 2;
        if (document.activeElement !== $('mf-volume')) $('mf-volume').value = s.volume;
        lastMode = { shuffle: s.shuffle, repeat: s.repeat };
        if (s.error) toast(s.error);
    }

    // ---------- initialisation ----------
    async function init() {
        document.querySelectorAll('.mf-nav-btn').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
        $('mf-search-form').addEventListener('submit', (e) => { e.preventDefault(); showTab(S.tab === 'radio' ? 'radio' : 'discover'); });
        $('mf-play').addEventListener('click', async () => { if (!Y.active) await ensureEngine(); ctl('playPause'); });
        $('mf-prev').addEventListener('click', () => ctl('prev'));
        $('mf-next').addEventListener('click', () => ctl('next'));
        $('mf-shuffle').addEventListener('click', () => ctl('setMode', { shuffle: !lastMode.shuffle, repeat: lastMode.repeat || 0 }));
        $('mf-repeat').addEventListener('click', () => ctl('setMode', { shuffle: !!lastMode.shuffle, repeat: ((lastMode.repeat || 0) + 1) % 3 }));
        const seek = $('mf-seek');
        seek.addEventListener('input', () => { S.seeking = true; $('mf-time-cur').textContent = fmt(seek.value); });
        seek.addEventListener('change', () => { ctl('seek', { time: Number(seek.value) }); S.seeking = false; });
        $('mf-volume').addEventListener('input', (e) => ctl('setVolume', { volume: Number(e.target.value) }));
        $('mf-video-close').addEventListener('click', stopVideo);
        $('mf-file-input').addEventListener('change', (e) => { importFiles(e.target.files); e.target.value = ''; });
        $('mf-folder-input').addEventListener('change', (e) => { importFiles(e.target.files); e.target.value = ''; });
        $('mf-pl-close').addEventListener('click', () => $('mf-pl-dialog').close());
        $('mf-pl-new').addEventListener('submit', async (e) => {
            e.preventDefault(); const name = $('mf-pl-name').value.trim(); if (!name || !S.dlgTrack) return;
            await MF.store.savePlaylist({ id: crypto.randomUUID(), name, tracks: [S.dlgTrack] });
            S.playlists = await MF.store.getPlaylists(); $('mf-pl-name').value = ''; toast('Playlist créée'); $('mf-pl-dialog').close();
        });
        (await MF.store.getFavorites()).forEach((t) => S.favs.set(t.id, t));
        S.playlists = await MF.store.getPlaylists();
        showTab('discover');
        tick(); setInterval(tick, 500);
    }
    init();
})();
