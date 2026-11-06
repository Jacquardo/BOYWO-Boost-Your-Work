/*
 * BOYWO - Page complète outils/smart_copy_tracker.html
 * Consulte et gère l'historique des textes copiés. Données et état d'enregistrement : js/smart-copy-store.js
 * (chrome.storage.local, partagé avec la carte de la page Outils : tout se met à jour en temps réel).
 * Export : js/smart-copy-export.js.
 */
(() => {
    'use strict';

    const Store = window.BOYWOSmartCopy;
    const Exporter = window.BOYWOSmartCopyExport;
    if (!Store) return;

    const $ = id => document.getElementById(id);
    const els = {
        toggle: $('sctp-toggle'), recLabel: $('sctp-rec-label'), clearBtn: $('sctp-clear-btn'),
        total: $('sctp-count-total'), upper: $('sctp-count-upper'), mixed: $('sctp-count-mixed'),
        dup: $('sctp-count-dup'), dupHint: $('sctp-count-dup-hint'),
        search: $('sctp-search'),
        viewAll: $('sctp-view-all'), viewDup: $('sctp-view-dup'), viewDupCount: $('sctp-view-dup-count'),
        dedupeBtn: $('sctp-dedupe-btn'),
        listUpper: $('sctp-list-upper'), listMixed: $('sctp-list-mixed'),
        countUpper: $('sctp-section-count-upper'), countMixed: $('sctp-section-count-mixed'),
        dialog: $('sctp-clear-dialog'), dialogText: $('sctp-clear-text'),
        dialogCancel: $('sctp-clear-cancel'), dialogConfirm: $('sctp-clear-confirm'),
        dedupeDialog: $('sctp-dedupe-dialog'), dedupeText: $('sctp-dedupe-text'),
        dedupeCancel: $('sctp-dedupe-cancel'), dedupeConfirm: $('sctp-dedupe-confirm'),
        toast: $('sctp-toast')
    };

    const dateFmt = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'medium' });
    const fmt = n => Number(n || 0).toLocaleString('fr-FR');
    const plural = (n, one, many) => `${fmt(n)} ${n > 1 ? many : one}`;
    const CLAMP_CHARS = 280;

    let state = { enabled: false, clips: [], stats: { total: 0, upper: 0, mixed: 0, duplicates: 0, extra: 0 } };
    let dup = Store.analyzeDuplicates([]);
    let view = 'all';              // 'all' (tout l'historique) | 'dups' (doublons uniquement)
    let query = '';
    let editing = null;            // { id, draft } : modification en cours (conservée si la liste se rafraîchit)
    const expanded = new Set();    // textes dépliés ("Voir tout")
    const openGroups = new Set();  // groupes de doublons dont les occurrences sont affichées

    const normalize = s => String(s).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

    // ---------- Petits utilitaires d'interface ----------
    function icon(name) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'sctp-ico');
        svg.setAttribute('aria-hidden', 'true');
        const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        use.setAttribute('href', '#s-' + name);
        svg.appendChild(use);
        return svg;
    }

    function button(label, iconName, cls, onClick) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'sctp-btn ' + cls;
        if (iconName) b.appendChild(icon(iconName));
        b.appendChild(document.createTextNode(label));
        b.addEventListener('click', onClick);
        return b;
    }

    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }

    let toastTimer = null;
    function toast(message) {
        els.toast.textContent = message;
        els.toast.classList.add('sctp-toast-show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => els.toast.classList.remove('sctp-toast-show'), 2200);
    }

    async function copyToClipboard(text) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (_) {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;opacity:0;';
            document.body.appendChild(ta);
            ta.select();
            let ok = false;
            try { ok = document.execCommand('copy'); } catch (__) { /* ignoré */ }
            ta.remove();
            return ok;
        }
    }

    // Bouton « Recopier » commun aux cartes et aux groupes de doublons.
    function copyButton(text) {
        return button('Recopier', 'copy', 'sctp-btn-primary', async (e) => {
            const btn = e.currentTarget; // à lire avant tout await (null ensuite)
            const ok = await copyToClipboard(text);
            toast(ok ? 'Texte copié dans le presse-papiers' : 'Copie impossible');
            if (ok) {
                btn.lastChild.textContent = 'Copié !';
                setTimeout(() => { if (btn.isConnected) btn.lastChild.textContent = 'Recopier'; }, 1500);
            }
        });
    }

    // Texte (avec « Voir tout » si long)
    function appendText(card, text, expandKey) {
        const p = el('p', 'sctp-clip-text', text);
        card.appendChild(p);
        if (text.length > CLAMP_CHARS || text.split('\n').length > 6) {
            const open = expanded.has(expandKey);
            p.classList.toggle('sctp-clamped', !open);
            const more = el('button', 'sctp-more', open ? 'Réduire' : 'Voir tout');
            more.type = 'button';
            more.addEventListener('click', () => {
                if (expanded.has(expandKey)) expanded.delete(expandKey); else expanded.add(expandKey);
                render();
            });
            card.appendChild(more);
        }
    }

    // ---------- Cartes de l'historique ----------
    function buildViewCard(clip, card) {
        const info = dup.info.get(clip.id) || { count: 1, rank: 1 };
        if (info.count > 1) {
            card.classList.add('sctp-is-dup');
            const badge = el('span', 'sctp-badge', `Doublon ×${info.count}`);
            badge.title = `Ce texte a été copié ${info.count} fois (cette entrée est la copie n°${info.rank}).`;
            card.appendChild(badge);
        }

        appendText(card, clip.text, clip.id);

        const meta = el('div', 'sctp-clip-meta');
        const time = document.createElement('time');
        time.dateTime = new Date(clip.ts).toISOString();
        time.textContent = 'Copié le ' + dateFmt.format(new Date(clip.ts));
        meta.appendChild(time);
        if (info.count > 1) meta.appendChild(el('span', null, `copie ${info.rank}/${info.count}`));
        if (clip.host) meta.appendChild(el('span', null, 'depuis ' + clip.host));
        if (clip.editedAt) meta.appendChild(el('span', null, 'modifié le ' + dateFmt.format(new Date(clip.editedAt))));
        card.appendChild(meta);

        const actions = el('div', 'sctp-clip-actions');
        actions.appendChild(copyButton(clip.text));
        actions.appendChild(button('Modifier', 'edit', 'sctp-btn-soft', () => {
            editing = { id: clip.id, draft: clip.text };
            render();
            const ta = document.querySelector('.sctp-edit');
            if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
        }));
        actions.appendChild(button('Supprimer', 'trash', 'sctp-btn-danger', async () => {
            expanded.delete(clip.id);
            if (editing && editing.id === clip.id) editing = null;
            await Store.removeClip(clip.id);
            toast('Entrée supprimée');
        }));
        card.appendChild(actions);
    }

    function buildEditCard(clip, card) {
        const ta = el('textarea', 'sctp-edit');
        ta.value = editing.draft;
        ta.setAttribute('aria-label', 'Modifier le texte');
        ta.maxLength = Store.MAX_TEXT;
        ta.addEventListener('input', () => { editing.draft = ta.value; });
        ta.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { editing = null; render(); }
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
        });
        card.appendChild(ta);

        async function save() {
            if (!editing.draft.trim()) { toast('Le texte ne peut pas être vide'); return; }
            const id = editing.id, value = editing.draft;
            editing = null;
            const res = await Store.updateClip(id, value);
            toast(res.updated ? 'Texte modifié' : 'Entrée introuvable');
            if (!res.updated) render();
        }

        const actions = el('div', 'sctp-edit-actions');
        actions.appendChild(button('Enregistrer', 'check', 'sctp-btn-primary', save));
        actions.appendChild(button('Annuler', null, 'sctp-btn-soft', () => { editing = null; render(); }));
        card.appendChild(actions);
    }

    function buildCard(clip) {
        const card = el('article', 'sctp-clip');
        card.dataset.id = clip.id;
        if (editing && editing.id === clip.id) buildEditCard(clip, card); else buildViewCard(clip, card);
        return card;
    }

    // ---------- Cartes de groupes de doublons ----------
    function buildGroupCard(group) {
        const card = el('article', 'sctp-clip sctp-is-dup sctp-dup-group');
        card.dataset.key = group.key;
        const first = group.clips[0], last = group.clips[group.count - 1];

        const badge = el('span', 'sctp-badge', `×${group.count} · copié ${group.count} fois`);
        card.appendChild(badge);
        appendText(card, first.text, 'g:' + group.key);

        const meta = el('div', 'sctp-clip-meta');
        meta.appendChild(el('span', null, 'Première copie : ' + dateFmt.format(new Date(first.ts))));
        meta.appendChild(el('span', null, 'Dernière copie : ' + dateFmt.format(new Date(last.ts))));
        card.appendChild(meta);

        const isOpen = openGroups.has(group.key);
        const actions = el('div', 'sctp-clip-actions');
        actions.appendChild(copyButton(first.text));
        const toggle = button(isOpen ? 'Masquer les occurrences' : `Voir les ${group.count} occurrences`, null, 'sctp-btn-soft', () => {
            if (openGroups.has(group.key)) openGroups.delete(group.key); else openGroups.add(group.key);
            render();
        });
        toggle.setAttribute('aria-expanded', String(isOpen));
        actions.appendChild(toggle);
        card.appendChild(actions);

        if (isOpen) {
            const list = el('ol', 'sctp-occ');
            group.clips.forEach((c, i) => {
                const li = document.createElement('li');
                const infoBox = el('div', 'sctp-occ-info');
                const time = document.createElement('time');
                time.dateTime = new Date(c.ts).toISOString();
                time.textContent = `${i + 1}. ${dateFmt.format(new Date(c.ts))}`;
                infoBox.appendChild(time);
                if (c.host) infoBox.appendChild(el('small', null, 'depuis ' + c.host));
                if (i === 0) infoBox.appendChild(el('span', 'sctp-occ-first', '1re copie (conservée par « Supprimer les doublons »)'));
                li.appendChild(infoBox);
                const del = button('Supprimer', 'trash', 'sctp-btn-danger', async () => {
                    await Store.removeClip(c.id);
                    toast('Occurrence supprimée');
                });
                del.setAttribute('aria-label', `Supprimer l'occurrence du ${dateFmt.format(new Date(c.ts))}`);
                li.appendChild(del);
                list.appendChild(li);
            });
            card.appendChild(list);
        }
        return card;
    }

    function fillList(container, items, build, emptyMessage) {
        container.textContent = '';
        if (!items.length) {
            container.appendChild(el('p', 'sctp-empty', emptyMessage));
            return;
        }
        const frag = document.createDocumentFragment();
        items.forEach(i => frag.appendChild(build(i)));
        container.appendChild(frag);
    }

    // ---------- Rendu global ----------
    function render() {
        const { enabled, clips, stats } = state;
        dup = Store.analyzeDuplicates(clips);

        els.toggle.checked = enabled;
        els.recLabel.textContent = enabled ? 'Enregistrement actif' : 'Enregistrement désactivé';
        els.clearBtn.disabled = stats.total === 0;
        els.total.textContent = fmt(stats.total);
        els.upper.textContent = fmt(stats.upper);
        els.mixed.textContent = fmt(stats.mixed);
        els.dup.textContent = fmt(stats.duplicates);
        els.dupHint.textContent = stats.extra ? plural(stats.extra, 'copie en trop', 'copies en trop') : 'Aucun doublon';
        els.viewDupCount.textContent = fmt(stats.duplicates);
        els.viewAll.setAttribute('aria-pressed', String(view === 'all'));
        els.viewDup.setAttribute('aria-pressed', String(view === 'dups'));
        els.dedupeBtn.disabled = stats.extra === 0;
        document.querySelectorAll('[data-export]').forEach(b => { b.disabled = stats.total === 0; });

        const q = normalize(query.trim());
        const noResult = `Aucun résultat pour « ${query.trim()} ».`;

        // Une actualisation (copie dans un autre onglet, synchro…) ne doit pas faire perdre le curseur
        // à l'utilisateur qui est en train de modifier un texte.
        const active = document.activeElement;
        const editFocus = active && active.classList && active.classList.contains('sctp-edit')
            ? { start: active.selectionStart, end: active.selectionEnd } : null;

        if (view === 'dups') {
            const groups = q ? dup.groups.filter(g => normalize(g.key).includes(q)) : dup.groups;
            const upper = groups.filter(g => g.cat === 'upper');
            const mixed = groups.filter(g => g.cat !== 'upper');
            const total = (cat) => dup.groups.filter(g => (cat === 'upper') === (g.cat === 'upper')).length;
            els.countUpper.textContent = (q ? `${fmt(upper.length)} / ${fmt(total('upper'))}` : fmt(upper.length)) + ' en double';
            els.countMixed.textContent = (q ? `${fmt(mixed.length)} / ${fmt(total('mixed'))}` : fmt(mixed.length)) + ' en double';
            const empty = n => (q && n > 0 ? noResult : 'Aucun doublon dans cette section.');
            fillList(els.listUpper, upper, buildGroupCard, empty(total('upper')));
            fillList(els.listMixed, mixed, buildGroupCard, empty(total('mixed')));
        } else {
            // Une entrée en cours de modification reste affichée même si elle ne correspond plus à la recherche.
            const visible = q ? clips.filter(c => normalize(c.text).includes(q) || (editing && editing.id === c.id)) : clips;
            const upper = visible.filter(c => c.cat === 'upper');
            const mixed = visible.filter(c => c.cat !== 'upper');
            els.countUpper.textContent = q ? `${fmt(upper.length)} / ${fmt(stats.upper)}` : fmt(stats.upper);
            els.countMixed.textContent = q ? `${fmt(mixed.length)} / ${fmt(stats.mixed)}` : fmt(stats.mixed);
            const empty = n => (q && n > 0 ? noResult
                : (enabled ? 'Rien ici pour l\'instant : copiez un texte sur une page web.'
                           : 'Rien ici pour l\'instant. Activez l\'enregistrement pour capturer vos copies.'));
            fillList(els.listUpper, upper, buildCard, empty(stats.upper));
            fillList(els.listMixed, mixed, buildCard, empty(stats.mixed));
        }

        if (editFocus) {
            const ta = document.querySelector('.sctp-edit');
            if (ta) { ta.focus(); ta.setSelectionRange(editFocus.start, editFocus.end); }
        }
    }

    function onState(next) {
        state = next;
        // Nettoyage si une entrée en cours de modification a disparu (supprimée depuis un autre appareil, historique vidé…).
        if (editing && !state.clips.some(c => c.id === editing.id)) editing = null;
        render();
    }

    // ---------- Événements ----------
    els.toggle.addEventListener('change', () => {
        Store.setEnabled(els.toggle.checked).catch(() => { els.toggle.checked = !els.toggle.checked; });
    });

    els.search.addEventListener('input', () => { query = els.search.value; render(); });
    els.viewAll.addEventListener('click', () => { view = 'all'; render(); });
    els.viewDup.addEventListener('click', () => { view = 'dups'; render(); });

    // Export (le fichier est généré à partir de TOUT l'historique, quels que soient la recherche ou l'affichage)
    document.querySelectorAll('[data-export]').forEach(btn => {
        btn.addEventListener('click', () => {
            if (!Exporter || !state.clips.length) return;
            try {
                const name = Exporter.exportAs(btn.dataset.export, state.clips, Store.analyzeDuplicates(state.clips));
                toast('Export prêt : ' + name);
            } catch (e) {
                console.error('[BOYWO] Export Smart Copy Tracker :', e);
                toast('Export impossible');
            }
        });
    });

    // Suppression des doublons (confirmation obligatoire ; la 1re copie de chaque texte est conservée)
    els.dedupeBtn.addEventListener('click', () => {
        const d = Store.analyzeDuplicates(state.clips);
        if (!d.extra) return;
        els.dedupeText.textContent =
            `${plural(d.extra, 'copie en double sera supprimée', 'copies en double seront supprimées')}. ` +
            `La première copie (la plus ancienne) de chacun des ${plural(d.groupCount, 'texte concerné', 'textes concernés')} sera conservée. ` +
            'Cette action est irréversible : pensez à exporter l\'historique avant si besoin.';
        els.dedupeDialog.showModal();
    });
    els.dedupeCancel.addEventListener('click', () => els.dedupeDialog.close());
    els.dedupeConfirm.addEventListener('click', async () => {
        els.dedupeDialog.close();
        const res = await Store.removeDuplicates();
        openGroups.clear();
        toast(res.removed ? `${plural(res.removed, 'doublon supprimé', 'doublons supprimés')}` : 'Aucun doublon à supprimer');
    });

    // Vider l'historique (confirmation)
    els.clearBtn.addEventListener('click', () => {
        const n = state.stats.total;
        els.dialogText.textContent = `Les ${fmt(n)} texte${n > 1 ? 's' : ''} enregistré${n > 1 ? 's' : ''} seront supprimés définitivement. Cette action est irréversible.`;
        els.dialog.showModal();
    });
    els.dialogCancel.addEventListener('click', () => els.dialog.close());
    els.dialogConfirm.addEventListener('click', async () => {
        els.dialog.close();
        editing = null;
        expanded.clear();
        openGroups.clear();
        await Store.clearClips();
        toast('Historique vidé');
    });

    // Couleurs du thème BOYWO choisi dans l'application (même clés que le reste de l'extension).
    function applyTheme(c1, c2) {
        if (c1) document.body.style.setProperty('--sctp-c1', c1);
        if (c2) document.body.style.setProperty('--sctp-c2', c2);
    }
    chrome.storage.local.get(['app_theme_color1', 'app_theme_color2'], res => applyTheme(res.app_theme_color1, res.app_theme_color2));
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !(changes.app_theme_color1 || changes.app_theme_color2)) return;
        chrome.storage.local.get(['app_theme_color1', 'app_theme_color2'], res => applyTheme(res.app_theme_color1, res.app_theme_color2));
    });

    Store.subscribe(onState);
})();
