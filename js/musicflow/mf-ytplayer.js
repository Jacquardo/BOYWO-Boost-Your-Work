// MusicFlow - lecteur YouTube intégré (API officielle YouTube IFrame Player, via une page HTTPS hébergée sur GitHub Pages).
// Deux usages :
//  1) MF.yt.attach(iframe, opts) : contrôleur générique (poignée de main + commandes postMessage + détection des problèmes).
//     Utilisé par le mini-lecteur du popup ET par la page outils/musicflow-youtube.html (onglet / fenêtre détachée).
//  2) MF.yt.dock : mini-lecteur du popup (#mfyt-dock dans index.html), au niveau du <body> : il reste en place quand on
//     change de rubrique. Le popup d'une extension se ferme dès qu'il perd le focus : la lecture s'arrête alors
//     (bouton « Détacher » = fenêtre séparée qui continue). Le lecteur reste TOUJOURS visible (règle YouTube : 200 x 200 px minimum).
(function () {
    const MF = (globalThis.MF = globalThis.MF || {});
    const DEFAULT_URL = 'https://jacquardo.github.io/BOYWO-Boost-Your-Work/player/player.html';
    const VID = /^[\w-]{11}$/;
    const HELLO_MS = 12000, READY_MS = 15000, PROBE_MS = 6000;
    const $ = (id) => document.getElementById(id);

    const cfgUrl = () => { const u = MF.config && MF.config.youtubePlayerUrl; return typeof u === 'string' && /^https:\/\//.test(u) ? u : DEFAULT_URL; };
    const origin = () => new URL(cfgUrl()).origin;
    function playerUrl(o) { const u = new URL(cfgUrl()); if (o && o.controls) u.searchParams.set('controls', '1'); return u.href; }
    const thumbUrl = (id, q) => 'https://i.ytimg.com/vi/' + encodeURIComponent(id) + '/' + (q || 'mqdefault') + '.jpg';
    const watchUrl = (id) => 'https://www.youtube.com/watch?v=' + encodeURIComponent(id);

    // ---------- Messages d'erreur (français) : un code = une cause ----------
    const PROBLEMS = {
        NETWORK: ['Erreur de connexion', 'Impossible de contacter les serveurs YouTube. Vérifiez votre connexion Internet, un pare-feu, un filtre réseau (DNS, fournisseur d’accès) ou un bloqueur de contenu.'],
        PLAYER_PAGE: ['Page du lecteur injoignable', 'La page du lecteur hébergée sur GitHub Pages ne répond pas : connexion coupée, page non publiée, ou accès à github.io bloqué.'],
        PLAYER_TIMEOUT: ['Le lecteur ne démarre pas', 'La page du lecteur s’est chargée mais YouTube n’a pas répondu à temps.'],
        API: ['API indisponible', 'Impossible de charger le lecteur YouTube (script « iframe_api » de youtube.com). Souvent un blocage réseau ou un bloqueur de contenu.'],
        CONFIG: ['Erreur de configuration', 'Le lecteur est joignable mais ne démarre pas : vérifiez que la page est bien publiée en HTTPS, l’origine autorisée dans player.html (ID de l’extension), les permissions du manifest et la politique de sécurité (CSP) de l’extension.'],
        YT_2: ['Identifiant de vidéo invalide', 'YouTube ne reconnaît pas cet identifiant de vidéo.'],
        YT_5: ['Erreur du lecteur HTML5', 'Le lecteur YouTube a rencontré une erreur de lecture. Réessayez dans un instant.'],
        YT_100: ['Vidéo introuvable', 'Cette vidéo a été supprimée ou est privée.'],
        YT_101: ['Vidéo non intégrable', 'Le propriétaire de la vidéo n’autorise pas sa lecture dans un lecteur externe. Utilisez « Ouvrir sur YouTube ».'],
        YT_150: ['Vidéo non intégrable', 'Le propriétaire de la vidéo n’autorise pas sa lecture dans un lecteur externe. Utilisez « Ouvrir sur YouTube ».'],
        YT_153: ['Erreur de configuration', 'YouTube refuse l’intégration car l’origine de la page est absente ou non reconnue (erreur 153). Vérifiez que le lecteur est bien servi en HTTPS depuis GitHub Pages et que le referrer n’est pas supprimé.'],
        THUMB: ['Miniature indisponible', 'Impossible de charger l’image de prévisualisation (i.ytimg.com). Cela n’empêche pas forcément la lecture.'],
    };
    const describe = (code) => PROBLEMS[code] || (/^YT_/.test(code) ? ['Erreur YouTube (' + code.slice(3) + ')', 'YouTube a signalé une erreur pour cette vidéo.'] : PROBLEMS.CONFIG);
    // Causes liées à l'infrastructure (réseau, page, API) : on lance alors le diagnostic détaillé.
    const INFRA = new Set(['PLAYER_PAGE', 'PLAYER_TIMEOUT', 'API', 'YT_153']);

    // ---------- Diagnostic : on teste SÉPARÉMENT connexion, YouTube, miniatures et page du lecteur ----------
    function probeFetch(url) {
        return new Promise((resolve) => {
            let done = false; const fin = (v) => { if (!done) { done = true; resolve(v); } };
            const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
            setTimeout(() => { if (ctl) ctl.abort(); fin(false); }, PROBE_MS);
            // no-cors : réponse opaque, mais la requête aboutit seulement si le serveur est joignable (DNS + TLS + réponse).
            fetch(url, { mode: 'no-cors', cache: 'no-store', signal: ctl ? ctl.signal : undefined }).then(() => fin(true), () => fin(false));
        });
    }
    function probeImage(url) {
        return new Promise((resolve) => {
            const img = new Image(); let done = false; const fin = (v) => { if (!done) { done = true; resolve(v); } };
            setTimeout(() => fin(false), PROBE_MS);
            img.onload = () => fin(true); img.onerror = () => fin(false);
            img.referrerPolicy = 'no-referrer'; img.src = url + (url.includes('?') ? '&' : '?') + '_=' + Date.now();
        });
    }
    async function diagnose(videoId) {
        const id = VID.test(videoId || '') ? videoId : 'dQw4w9WgXcQ';
        const online = navigator.onLine !== false;
        const [youtube, thumb, page] = await Promise.all([
            probeFetch('https://www.youtube.com/generate_204'),
            probeImage(thumbUrl(id, 'default')),
            probeFetch(playerUrl()),
        ]);
        const rows = [
            { label: 'Connexion Internet', ok: online },
            { label: 'Serveurs YouTube (youtube.com)', ok: youtube },
            { label: 'Miniatures (i.ytimg.com)', ok: thumb },
            { label: 'Page du lecteur BOYWO (github.io)', ok: page },
        ];
        let code;
        if (!online || (!youtube && !page)) code = 'NETWORK';
        else if (!youtube) code = 'NETWORK';
        else if (!page) code = 'PLAYER_PAGE';
        else code = null; // tout est joignable : la cause est ailleurs (configuration, vidéo…)
        return { rows, code, thumbOk: thumb, online, youtube, page };
    }

    // ---------- Contrôleur d'iframe ----------
    function attach(iframe, opts) {
        opts = opts || {};
        const org = origin();
        let helloOk = false, loadSent = false, ready = false, pending = null, helloTimer = 0, readyTimer = 0, dead = false;
        const emit = (e) => { try { if (opts.onEvent) opts.onEvent(e); } catch (_) {} };
        const post = (m) => { try { iframe.contentWindow.postMessage(Object.assign({ mfyt: 1 }, m), org); } catch (_) {} };
        const problem = (code, extra) => { clearTimeout(helloTimer); clearTimeout(readyTimer); emit({ evt: 'problem', code, extra, videoId: pending && pending.videoId }); };

        function mount() {
            helloOk = false; loadSent = false; ready = false;
            clearTimeout(helloTimer); clearTimeout(readyTimer);
            iframe.src = playerUrl({ controls: opts.controls });
            helloTimer = setTimeout(() => { if (!helloOk) problem('PLAYER_PAGE'); }, HELLO_MS);
        }
        function sendLoad() {
            if (!pending || dead) return;
            loadSent = true; ready = false;
            post({ cmd: 'load', videoId: pending.videoId, start: pending.start || 0, autoplay: pending.autoplay !== false });
            clearTimeout(readyTimer);
            readyTimer = setTimeout(() => { if (!ready) problem('PLAYER_TIMEOUT'); }, READY_MS);
        }
        function onMsg(e) {
            if (dead || e.source !== iframe.contentWindow || e.origin !== org) return;
            const d = e.data; if (!d || d.mfyt !== 1) return;
            switch (d.evt) {
                case 'hello': helloOk = true; clearTimeout(helloTimer); if (pending && !loadSent) sendLoad(); break;
                case 'apierror': problem('API'); break;
                case 'error': problem('YT_' + d.code, d.code); break;
                case 'ready': case 'state': case 'meta': ready = true; clearTimeout(readyTimer); emit(d); break;
                default: emit(d);
            }
        }
        window.addEventListener('message', onMsg);

        const ctrl = {
            load(videoId, o) {
                if (!VID.test(videoId || '')) { problem('YT_2'); return; }
                o = o || {}; pending = { videoId, start: o.start || 0, autoplay: o.autoplay !== false };
                dead = false;
                if (!iframe.getAttribute('src')) mount();
                else if (helloOk) sendLoad();      // lecteur déjà prêt : on change simplement de vidéo (pas de rechargement)
                // sinon : la poignée de main en cours enverra la vidéo
            },
            send(m) { if (helloOk) post(m); },
            retry() { dead = false; mount(); },     // recharge la page du lecteur puis renvoie la vidéo en attente
            get videoId() { return pending ? pending.videoId : ''; },
            destroy() { dead = true; clearTimeout(helloTimer); clearTimeout(readyTimer); window.removeEventListener('message', onMsg); try { iframe.removeAttribute('src'); } catch (_) {} pending = null; },
        };
        return ctrl;
    }

    // ---------- Mini-lecteur du popup ----------
    const fmt = (s) => { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
    const dock = (function () {
        let el = null, ctrl = null, cur = null, list = [], st = -1, seeking = false, lastT = 0, lastD = 0, lastV = 100, thumbBad = false, diagRun = 0, audioWatch = 0;
        const q = (id) => $(id);

        function place() {
            const nav = document.querySelector('.bottom-nav');
            el.style.setProperty('--mfyt-bottom', ((nav ? nav.offsetHeight : 60) + 8) + 'px');
        }
        function setMode(m) {
            el.dataset.mode = m;
            const b = q('mfyt-min'); b.textContent = m === 'compact' ? '⤢' : '▁'; b.title = m === 'compact' ? 'Agrandir' : 'Réduire'; b.setAttribute('aria-label', b.title);
        }
        function setPlaying(on) { q('mfyt-play').textContent = on ? '⏸' : '▶'; q('mfyt-play').title = on ? 'Pause' : 'Lecture'; q('mfyt-poster').classList.toggle('mfyt-hide', st === 1 || st === 2 || st === 3); }
        function hideDiag() { q('mfyt-diag').hidden = true; }
        function note(text) { const n = q('mfyt-note'); n.textContent = text || ''; n.hidden = !text; }

        function fill(t) {
            q('mfyt-title').textContent = t.title || 'Vidéo YouTube';
            q('mfyt-channel').textContent = t.artist || '';
            q('mfyt-open').href = watchUrl(t.videoId);
            thumbBad = false; note('');
            const poster = q('mfyt-poster-img'), mini = q('mfyt-thumb');
            [poster, mini].forEach((img) => {
                img.onerror = () => { img.hidden = true; if (!thumbBad) { thumbBad = true; note(PROBLEMS.THUMB[0] + ' : ' + PROBLEMS.THUMB[1]); } };
                img.onload = () => { img.hidden = false; };
                img.hidden = false; img.src = t.cover || thumbUrl(t.videoId);
            });
            const multi = list.length > 1; q('mfyt-prev').disabled = q('mfyt-next').disabled = !multi;
        }

        async function showProblem(code, videoId) {
            const [title, text] = describe(code);
            q('mfyt-diag-title').textContent = title; q('mfyt-diag-text').textContent = text;
            const ul = q('mfyt-diag-list'); ul.replaceChildren(); ul.hidden = true;
            q('mfyt-diag').hidden = false; setPlaying(false);
            if (!INFRA.has(code)) return;
            // Diagnostic détaillé : quelles étapes fonctionnent, lesquelles échouent
            const run = ++diagRun; ul.hidden = false;
            const wait = document.createElement('li'); wait.textContent = 'Diagnostic en cours…'; ul.append(wait);
            const r = await diagnose(videoId || (cur && cur.videoId));
            if (run !== diagRun) return;
            ul.replaceChildren(...r.rows.map((x) => { const li = document.createElement('li'); li.textContent = (x.ok ? '✓ ' : '✗ ') + x.label; li.className = x.ok ? 'ok' : 'ko'; return li; }));
            const final = r.code || (code === 'YT_153' ? 'YT_153' : 'CONFIG'); // tout est joignable : la cause est la configuration
            const [t2, x2] = describe(final);
            q('mfyt-diag-title').textContent = t2; q('mfyt-diag-text').textContent = x2;
            if (!r.thumbOk && r.youtube) note(PROBLEMS.THUMB[0] + ' : ' + PROBLEMS.THUMB[1]);
        }

        function onEvent(e) {
            switch (e.evt) {
                case 'ready': case 'state':
                    if (typeof e.s === 'number') st = e.s;
                    hideDiag(); setPlaying(st === 1); break;
                case 'autoplayblocked': st = -1; setPlaying(false); break;
                case 'meta':
                    if (e.title && cur && (!cur.title || cur.title !== e.title)) { cur.title = e.title; q('mfyt-title').textContent = e.title; }
                    if (e.author && cur && !cur.artist) { cur.artist = e.author; q('mfyt-channel').textContent = e.author; }
                    break;
                case 'time': {
                    st = e.s; lastT = e.t; lastD = e.d || 0; setPlaying(st === 1);
                    const bar = q('mfyt-seek');
                    if (!seeking && e.d > 0) { bar.value = String(Math.round((e.t / e.d) * 1000)); q('mfyt-cur').textContent = fmt(e.t); q('mfyt-dur').textContent = fmt(e.d); }
                    if (typeof e.v === 'number') lastV = e.m ? 0 : e.v;
                    const vol = q('mfyt-vol'); if (document.activeElement !== vol && typeof e.v === 'number') vol.value = String(e.m ? 0 : e.v);
                    break;
                }
                case 'problem': showProblem(e.code, e.videoId); break;
            }
        }

        // Une seule source sonore à la fois : si l'audio BOYWO / MusicFlow démarre pendant la vidéo, la vidéo se met en pause.
        function watchAudio() {
            clearInterval(audioWatch);
            audioWatch = setInterval(() => {
                if (el.hidden || st !== 1) return;
                if (globalThis.MFBridge && MFBridge.last && MFBridge.last.isPlaying) { ctrl && ctrl.send({ cmd: 'pause' }); return; }
                try { chrome.runtime.sendMessage({ target: 'offscreen', action: 'getState' }, (s) => { void chrome.runtime.lastError; if (s && s.isPlaying && st === 1) ctrl && ctrl.send({ cmd: 'pause' }); }); } catch (_) {}
            }, 1500);
        }

        function step(d) {
            if (list.length < 2 || !cur) return;
            const i = list.findIndex((x) => x.videoId === cur.videoId);
            play(list[(i + d + list.length) % list.length]);
        }

        function detach() {
            if (!cur) return;
            const url = chrome.runtime.getURL('outils/musicflow-youtube.html') + '?v=' + encodeURIComponent(cur.videoId) + '&t=' + Math.floor(lastT || 0);
            const done = () => close();
            if (chrome.windows && chrome.windows.create) chrome.windows.create({ url, type: 'popup', width: 520, height: 600 }, done);
            else if (chrome.tabs && chrome.tabs.create) { chrome.tabs.create({ url }); done(); }
            else window.open(url, '_blank');
        }
        async function fullscreen() {
            // Dans la fenêtre du popup Chrome, le plein écran est le plus souvent refusé : on bascule alors sur une fenêtre détachée.
            try { if (document.fullscreenEnabled) { await q('mfyt-stage').requestFullscreen(); return; } } catch (_) {}
            detach();
        }
        function close() {
            diagRun++; clearInterval(audioWatch);
            if (ctrl) { ctrl.send({ cmd: 'stop' }); ctrl.destroy(); ctrl = null; }
            q('mfyt-diag').hidden = true; el.hidden = true; cur = null; st = -1; lastT = 0;
            q('mfyt-seek').value = '0'; q('mfyt-cur').textContent = '0:00'; q('mfyt-dur').textContent = '0:00';
            document.dispatchEvent(new CustomEvent('mfyt:closed'));
        }

        function play(t, opts) {
            if (!el || !t || !VID.test(t.videoId || '')) return false;
            opts = opts || {};
            if (Array.isArray(opts.list)) list = opts.list.filter((x) => x && VID.test(x.videoId || ''));
            cur = { videoId: t.videoId, title: t.title || '', artist: t.artist || '', cover: t.cover || '' };
            el.hidden = false; place();
            if (!el.dataset.mode) setMode('expanded');
            st = -1; lastT = 0; lastD = 0; fill(cur); hideDiag(); setPlaying(false);
            q('mfyt-seek').value = '0'; q('mfyt-cur').textContent = '0:00'; q('mfyt-dur').textContent = '0:00';
            if (!ctrl) ctrl = attach(q('mfyt-frame'), { onEvent });
            ctrl.load(t.videoId, { autoplay: true });
            watchAudio();
            return true;
        }

        // État au format du moteur MusicFlow : permet au lecteur Médias (MFBridge) d'afficher et piloter la vidéo comme une piste.
        function state() {
            const i = cur ? list.findIndex((x) => x.videoId === cur.videoId) : -1;
            return {
                track: cur ? { id: 'youtube:' + cur.videoId, source: 'youtube', videoId: cur.videoId, title: cur.title, artist: cur.artist, cover: cur.cover } : null,
                index: Math.max(0, i), queueLength: list.length, isPlaying: st === 1,
                currentTime: lastT || 0, duration: lastD || 0, volume: Math.round(lastV), shuffle: false, repeat: 0, error: null,
            };
        }
        function command(action, v) {
            if (!ctrl || !cur) return false;
            switch (action) {
                case 'playPause': ctrl.send({ cmd: st === 1 ? 'pause' : 'play' }); break;
                case 'pause': ctrl.send({ cmd: 'pause' }); break;
                case 'next': step(1); break;
                case 'prev': step(-1); break;
                case 'seek': if (isFinite(v) && lastD > 0) { ctrl.send({ cmd: 'seek', time: Number(v) }); lastT = Number(v); } break;
                case 'volume': ctrl.send({ cmd: 'unmute' }); ctrl.send({ cmd: 'volume', value: Number(v) }); lastV = Number(v); break;
                default: return false;
            }
            return true;
        }

        function init() {
            el = q('mfyt-dock'); if (!el) return;
            setMode('expanded');
            q('mfyt-play').addEventListener('click', () => { if (ctrl) ctrl.send({ cmd: st === 1 ? 'pause' : 'play' }); });
            q('mfyt-poster-play').addEventListener('click', () => { if (ctrl) ctrl.send({ cmd: 'play' }); });
            q('mfyt-min').addEventListener('click', () => setMode(el.dataset.mode === 'compact' ? 'expanded' : 'compact'));
            q('mfyt-close').addEventListener('click', close);
            q('mfyt-detach').addEventListener('click', detach);
            q('mfyt-full').addEventListener('click', fullscreen);
            q('mfyt-prev').addEventListener('click', () => step(-1));
            q('mfyt-next').addEventListener('click', () => step(1));
            const bar = q('mfyt-seek');
            bar.addEventListener('input', () => { seeking = true; });
            bar.addEventListener('change', () => {
                seeking = false;
                if (lastD > 0 && ctrl) ctrl.send({ cmd: 'seek', time: (Number(bar.value) / 1000) * lastD });
            });
            q('mfyt-vol').addEventListener('input', (e) => { if (ctrl) { ctrl.send({ cmd: 'unmute' }); ctrl.send({ cmd: 'volume', value: Number(e.target.value) }); } });
            q('mfyt-retry').addEventListener('click', () => { hideDiag(); note(''); if (ctrl && cur) { ctrl.retry(); } else if (cur) play(cur); });
            window.addEventListener('resize', place);
        }
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

        return { play, close, state, command, currentId: () => (cur && !el.hidden ? cur.videoId : ''), isOpen: () => !!el && !el.hidden };
    })();

    MF.yt = { attach, dock, diagnose, describe, playerUrl, thumbUrl, watchUrl, isVideoId: (id) => typeof id === 'string' && VID.test(id) };
})();
