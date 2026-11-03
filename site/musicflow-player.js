// BOYWO - page « lecteur » HÉBERGÉE (GitHub Pages, HTTPS). Elle est intégrée dans une iframe par l'extension BOYWO.
// Pourquoi hors de l'extension : l'API officielle YouTube IFrame Player exige de charger https://www.youtube.com/iframe_api (script distant,
// interdit dans une page d'extension Manifest V3) et YouTube refuse les intégrations dont l'origine est chrome-extension://.
// Ici : page HTTPS normale + API officielle, pilotée par postMessage. Aucune extraction audio, le lecteur YouTube reste visible et complet.
(function () {
    'use strict';
    const ALLOWED = ['chrome-extension://joajfaoljmchpllcniehecddanhkolnf']; // ID de l'extension BOYWO (ajouter l'ID de développement si différent)
    const VIDEO_ID = /^[\w-]{11}$/;
    const anc = (location.ancestorOrigins && location.ancestorOrigins[0]) || '';
    const msgEl = document.getElementById('msg');
    if (anc && !ALLOWED.includes(anc)) { msgEl.style.display = 'flex'; msgEl.textContent = 'Lecteur réservé à l’extension BOYWO.'; return; }

    let player = null, ready = false, pending = null, target = anc || ALLOWED[0], timer = null, last = '';
    const post = (evt, data) => { try { window.parent.postMessage(Object.assign({ mf: 'yt', evt }, data), target); } catch (_) {} };
    const STATES = { '-1': 'unstarted', 0: 'ended', 1: 'playing', 2: 'paused', 3: 'buffering', 5: 'cued' };
    const REASONS = { 2: 'invalid', 5: 'html5', 100: 'not_found', 101: 'not_embeddable', 150: 'not_embeddable', 153: 'referrer' };

    function tick() {
        if (!ready || !player || !player.getCurrentTime) return;
        post('time', { t: player.getCurrentTime() || 0, d: player.getDuration() || 0, v: player.getVolume ? player.getVolume() : 100, m: player.isMuted ? !!player.isMuted() : false });
    }
    function meta() {
        try { const d = player.getVideoData ? player.getVideoData() : {}; post('meta', { title: d.title || '', author: d.author || '', d: player.getDuration() || 0 }); } catch (_) {}
    }
    function load(id) {
        if (!VIDEO_ID.test(id || '')) return post('error', { code: 2, reason: 'invalid' });
        if (!ready) { pending = id; return; }
        player.loadVideoById(id);
    }
    function onCommand(m) {
        switch (m.cmd) {
            case 'load': return load(m.videoId);
            case 'play': return ready && player.playVideo();
            case 'pause': return ready && player.pauseVideo();
            case 'seek': return ready && isFinite(m.time) && player.seekTo(Math.max(0, +m.time), true);
            case 'volume': if (ready && isFinite(m.value)) { player.setVolume(Math.min(100, Math.max(0, +m.value))); tick(); } return;
            case 'mute': if (ready) { m.muted ? player.mute() : player.unMute(); tick(); } return;
        }
    }
    window.addEventListener('message', (e) => {
        if (e.source !== window.parent || !ALLOWED.includes(e.origin) || !e.data || e.data.mf !== 'yt') return;
        target = e.origin; onCommand(e.data);
    });

    window.onYouTubeIframeAPIReady = function () {
        player = new YT.Player('p', {
            width: '100%', height: '100%',
            playerVars: { playsinline: 1, rel: 0, controls: 1, fs: 1, enablejsapi: 1, origin: location.origin },
            events: {
                onReady: () => {
                    ready = true; post('ready', {});
                    timer = setInterval(tick, 500);
                    if (pending) { const id = pending; pending = null; load(id); }
                },
                onStateChange: (ev) => {
                    const s = STATES[ev.data] || 'unknown';
                    post('state', { state: s });
                    if (s === 'playing' || s === 'cued') meta();
                    tick();
                },
                onError: (ev) => post('error', { code: ev.data, reason: REASONS[ev.data] || 'unknown' }),
            },
        });
    };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => post('error', { code: 0, reason: 'api_unreachable' }); // youtube.com injoignable (réseau, filtre)
    document.head.appendChild(s);
})();
