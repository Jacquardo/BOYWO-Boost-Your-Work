// BOYWO (site web) - hub « Outils en ligne » : un onglet par outil, chaque outil dans sa propre iframe.
// Les iframes déjà ouvertes restent chargées (masquées) quand on change d'onglet : une musique (Jamendo, Audius, radio) continue
// pendant qu'on utilise un autre outil. Une vidéo YouTube, qui doit rester visible pour jouer, est mise en pause à ce moment-là.
(function () {
    'use strict';
    const TOOLS = ['smart-copy', 'image-editor', 'musicflow'];
    const body = document.getElementById('hub-body');
    const home = document.getElementById('hub-home');
    const panels = document.getElementById('hub-panels');
    const footer = document.getElementById('hub-footer');
    const tabs = Array.from(document.querySelectorAll('.hub-tab'));
    let current = null;

    function frameOf(name) { const p = document.getElementById('panel-' + name); return p ? p.querySelector('iframe') : null; }

    function show(name) {
        name = TOOLS.indexOf(name) >= 0 ? name : '';
        if (name === current) return;
        if (current) { // l'outil quitté : on le prévient (MusicFlow met une éventuelle vidéo en pause)
            const f = frameOf(current);
            try { if (f && f.contentWindow) f.contentWindow.postMessage({ boywo: 'tab-hidden' }, location.origin); } catch (_) {}
        }
        current = name;
        home.hidden = !!name;
        panels.hidden = !name;
        footer.hidden = !!name;
        body.classList.toggle('is-tool', !!name);
        TOOLS.forEach((t) => {
            const panel = document.getElementById('panel-' + t);
            panel.hidden = t !== name;
            if (t === name) { const f = panel.querySelector('iframe'); if (!f.getAttribute('src')) f.setAttribute('src', f.dataset.src); }
        });
        tabs.forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tool === name)));
        document.title = (name ? tabs.find((b) => b.dataset.tool === name).textContent + ' – ' : '') + 'Outils en ligne – BOYWO';
    }

    const fromHash = () => show(location.hash.replace(/^#/, ''));
    tabs.forEach((b) => b.addEventListener('click', () => {
        const t = b.dataset.tool;
        history.pushState(null, '', t ? '#' + t : location.pathname + location.search);
        show(t);
    }));
    document.querySelectorAll('.hub-card').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); history.pushState(null, '', '#' + a.dataset.tool); show(a.dataset.tool); }));
    window.addEventListener('hashchange', fromHash);
    window.addEventListener('popstate', fromHash);
    panels.hidden = true;
    fromHash();
})();
