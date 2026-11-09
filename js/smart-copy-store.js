/*
 * BOYWO - Smart Copy Tracker : stockage partagé (une seule source de vérité)
 *
 * Chargé par :
 *  - [site web] ce fichier tourne dans la page : chrome.storage est fourni par js/chrome-shim.js (IndexedDB) ;
 *    l'option « force » de addClip permet l'ajout manuel même quand l'enregistrement automatique est coupé.
 *  - js/background.js (service worker, via import) : enregistre les textes reçus du content script ;
 *  - index.html (carte « Smart Copy Tracker » de la page Outils) ;
 *  - outils/smart_copy_tracker.html (gestionnaire complet).
 *
 * Tout est stocké dans chrome.storage.local (persistant, partagé entre les pages, conservé au
 * redémarrage de Chrome, synchronisé par sync-engine.js comme les autres clés) :
 *   sct_enabled : boolean            -> enregistrement automatique actif ?
 *   sct_clips   : Array<{ id, text, cat, ts, host, editedAt? }>
 *                 cat = 'upper' (aucune minuscule) | 'mixed' (au moins une minuscule)
 *
 * Les écritures passent par un verrou (Web Locks) partagé entre le service worker et les pages,
 * pour éviter qu'une copie et une modification simultanées s'écrasent.
 */
(function () {
    'use strict';

    const root = globalThis;
    if (root.BOYWOSmartCopy) return;

    const KEY_ENABLED = 'sct_enabled';
    const KEY_CLIPS = 'sct_clips';
    const MAX_CLIPS = 500;      // au-delà, les plus anciens sont retirés
    const MAX_TEXT = 20000;     // longueur maximale d'un texte enregistré
    const LOCK_NAME = 'boywo-smart-copy';

    const store = chrome.storage.local;

    function withLock(fn) {
        const locks = root.navigator && root.navigator.locks;
        return locks ? locks.request(LOCK_NAME, fn) : fn();
    }

    // 'mixed' dès qu'une minuscule est présente ; sinon 'upper'
    // (textes tout en majuscules, mais aussi chiffres ou symboles seuls : aucune minuscule).
    function classify(text) {
        return /\p{Ll}/u.test(String(text)) ? 'mixed' : 'upper';
    }

    // Doublon = texte identique (espaces de début/fin ignorés). Chaque entrée garde sa propre date.
    const duplicateKey = text => String(text).trim();

    // Regroupe les entrées identiques. "Première occurrence" = la plus ancienne.
    // Retourne { groups: [{ key, count, cat, clips (du plus ancien au plus récent) }],
    //            info: Map(id -> { count, rank, key }), groupCount, extra }
    // extra = nombre d'entrées supprimables (toutes sauf la première de chaque groupe).
    function analyzeDuplicates(clips) {
        const byKey = new Map();
        for (const c of clips) {
            const k = duplicateKey(c.text);
            if (!byKey.has(k)) byKey.set(k, []);
            byKey.get(k).push(c);
        }
        const groups = [];
        const info = new Map();
        byKey.forEach((arr, key) => {
            arr.sort((a, b) => ((a.ts || 0) - (b.ts || 0)) || (a.id < b.id ? -1 : 1));
            arr.forEach((c, i) => info.set(c.id, { count: arr.length, rank: i + 1, key }));
            if (arr.length > 1) groups.push({ key, count: arr.length, cat: arr[0].cat, clips: arr });
        });
        groups.sort((a, b) => (b.clips[b.count - 1].ts || 0) - (a.clips[a.count - 1].ts || 0));
        const extra = groups.reduce((n, g) => n + g.count - 1, 0);
        return { groups, info, groupCount: groups.length, extra };
    }

    function stats(clips) {
        let upper = 0, mixed = 0;
        for (const c of clips) { if (c.cat === 'upper') upper++; else mixed++; }
        const d = analyzeDuplicates(clips);
        return { total: clips.length, upper, mixed, duplicates: d.groupCount, extra: d.extra };
    }

    function sortClips(clips) {
        return clips.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
    }

    async function readAll() {
        const res = await store.get([KEY_ENABLED, KEY_CLIPS]);
        const clips = Array.isArray(res[KEY_CLIPS]) ? res[KEY_CLIPS].filter(c => c && c.id && typeof c.text === 'string') : [];
        return { enabled: res[KEY_ENABLED] === true, clips };
    }

    async function getState() {
        const { enabled, clips } = await readAll();
        const sorted = sortClips(clips);
        return { enabled, clips: sorted, stats: stats(sorted) };
    }

    const getEnabled = async () => (await readAll()).enabled;
    const setEnabled = value => store.set({ [KEY_ENABLED]: !!value });

    function newId() {
        return 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    }

    // Appelé par le service worker pour chaque copie détectée par le content script.
    function addClip({ text, host, force }) {
        return withLock(async () => {
            const { enabled, clips } = await readAll();
            if (!enabled && !force) return { added: false, reason: 'disabled' };

            let value = String(text == null ? '' : text);
            if (!value.trim()) return { added: false, reason: 'empty' };
            if (value.length > MAX_TEXT) value = value.slice(0, MAX_TEXT);

            const newest = clips.reduce((a, c) => (!a || (c.ts || 0) > (a.ts || 0) ? c : a), null);
            if (newest && newest.text === value) return { added: false, reason: 'duplicate' };

            const entry = { id: newId(), text: value, cat: classify(value), ts: Date.now(), host: String(host || '') };
            const next = sortClips([entry, ...clips]).slice(0, MAX_CLIPS);
            await store.set({ [KEY_CLIPS]: next });
            return { added: true, id: entry.id };
        });
    }

    function updateClip(id, text) {
        return withLock(async () => {
            const value = String(text == null ? '' : text).slice(0, MAX_TEXT);
            if (!value.trim()) return { updated: false, reason: 'empty' };
            const { clips } = await readAll();
            let found = false;
            const next = clips.map(c => {
                if (c.id !== id) return c;
                found = true;
                return { ...c, text: value, cat: classify(value), editedAt: Date.now() };
            });
            if (!found) return { updated: false, reason: 'missing' };
            await store.set({ [KEY_CLIPS]: next });
            return { updated: true };
        });
    }

    function removeClip(id) {
        return withLock(async () => {
            const { clips } = await readAll();
            const next = clips.filter(c => c.id !== id);
            if (next.length !== clips.length) await store.set({ [KEY_CLIPS]: next });
            return { removed: next.length !== clips.length };
        });
    }

    // Supprime tous les doublons en conservant la première occurrence (la plus ancienne) de chaque texte.
    // Le calcul est refait sous verrou, sur les données les plus récentes.
    function removeDuplicates() {
        return withLock(async () => {
            const { clips } = await readAll();
            const d = analyzeDuplicates(clips);
            const drop = new Set();
            d.groups.forEach(g => g.clips.slice(1).forEach(c => drop.add(c.id)));
            if (!drop.size) return { removed: 0, groups: 0 };
            await store.set({ [KEY_CLIPS]: clips.filter(c => !drop.has(c.id)) });
            return { removed: drop.size, groups: d.groupCount };
        });
    }

    function clearClips() {
        return withLock(async () => {
            await store.set({ [KEY_CLIPS]: [] });
            return { cleared: true };
        });
    }

    // Notifie à chaque changement (autre page, service worker, synchro Drive…).
    function subscribe(callback, { immediate = true } = {}) {
        const refresh = () => getState().then(callback).catch(() => {});
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area === 'local' && (changes[KEY_ENABLED] || changes[KEY_CLIPS])) refresh();
        });
        if (immediate) refresh();
    }

    root.BOYWOSmartCopy = {
        KEY_ENABLED, KEY_CLIPS, MAX_CLIPS, MAX_TEXT,
        classify, stats, analyzeDuplicates, getState, getEnabled, setEnabled,
        addClip, updateClip, removeClip, removeDuplicates, clearClips, subscribe
    };
})();
