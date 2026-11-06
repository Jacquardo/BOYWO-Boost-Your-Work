/*
 * BOYWO (site web) - Smart Copy Tracker : ce que le site ajoute à la page de l'extension.
 *  1) Capture des copies faites DANS cette page (l'extension, elle, capte les copies de tous les sites via un content script).
 *  2) Ajout manuel d'un texte, même quand l'enregistrement automatique est coupé.
 * Le stockage, le classement, les doublons et l'export restent ceux de smart-copy-store.js / smart-copy-page.js, inchangés.
 */
(function () {
    'use strict';
    const Store = window.BOYWOSmartCopy;
    if (!Store) return;
    const $ = (id) => document.getElementById(id);

    function toast(msg) {
        const t = $('sctp-toast'); if (!t) return;
        t.textContent = msg; t.classList.add('sctp-toast-show');
        clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('sctp-toast-show'), 2400);
    }

    // Texte copié : champ de saisie (sélection dans un <textarea>) ou sélection de la page. Jamais un champ « mot de passe ».
    document.addEventListener('copy', () => {
        const a = document.activeElement;
        let text = '';
        if (a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && /^(text|search|url|tel|email)$/i.test(a.type)))) {
            try { text = a.value.substring(a.selectionStart, a.selectionEnd); } catch (_) {}
        } else if (a && a.tagName === 'INPUT' && a.type === 'password') return;
        if (!text) {
            const sel = window.getSelection && window.getSelection();
            if (sel && sel.anchorNode && sel.anchorNode.parentElement && sel.anchorNode.parentElement.closest('.sctp-list')) return; // copie depuis l'historique lui-même
            text = sel ? String(sel) : '';
        }
        if (text.trim()) Store.addClip({ text, host: location.hostname || 'site BOYWO' }).catch(() => {});
    });

    const form = $('sctp-add-form');
    if (form) form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const field = $('sctp-add-text');
        const r = await Store.addClip({ text: field.value, host: 'saisie manuelle', force: true });
        if (r.added) { field.value = ''; toast('Texte ajouté à l’historique'); }
        else toast(r.reason === 'duplicate' ? 'Ce texte est déjà le plus récent de l’historique' : 'Rien à ajouter');
    });
})();
