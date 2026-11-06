/*
 * BOYWO (site web) - Module de compatibilité « chrome.* »
 * Les outils de l'extension (Smart Copy Tracker, éditeur d'images, MusicFlow) sont écrits pour les API d'extension Chrome.
 * Ce fichier fournit sur le site, SANS toucher à leur code, l'équivalent dont ils ont besoin :
 *   - chrome.storage.local / .session : stockage clé-valeur (IndexedDB « boywo-site » ; session = mémoire de l'onglet),
 *     avec chrome.storage.onChanged, y compris entre onglets et entre les pages du site (BroadcastChannel).
 *   - chrome.runtime : petit bus de messages interne à la page (sendMessage / onMessage), qui permet au moteur audio MusicFlow
 *     de tourner dans la page au lieu du document « offscreen » de l'extension.
 * Si le code tourne DANS l'extension (chrome.storage déjà défini), ce fichier ne fait rien.
 * À charger AVANT tout autre script de l'outil.
 */
(function () {
    'use strict';
    if (window.chrome && chrome.storage && chrome.storage.local) return; // vraie extension : rien à faire
    const chromeObj = (window.chrome = window.chrome || {});

    // ---------- chrome.storage ----------
    const DB_NAME = 'boywo-site', STORE = 'kv';
    let dbp = null;
    function db() {
        if (dbp) return dbp;
        dbp = new Promise((resolve, reject) => {
            const r = indexedDB.open(DB_NAME, 1);
            r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE); };
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => reject(r.error);
        });
        return dbp;
    }
    const clone = (v) => (v === undefined ? undefined : (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v))));

    const listeners = new Set();
    const channel = 'BroadcastChannel' in window ? new BroadcastChannel('boywo-site-storage') : null;
    const emit = (changes, area) => listeners.forEach((fn) => { try { fn(changes, area); } catch (_) {} });
    if (channel) channel.onmessage = (e) => { if (e.data && e.data.changes) emit(e.data.changes, e.data.area); };

    function makeArea(name, backend) {
        const broadcast = (changes) => { if (channel && name === 'local') { try { channel.postMessage({ area: name, changes }); } catch (_) {} } };
        return {
            get(keys, cb) {
                const p = (async () => {
                    let list;
                    if (keys == null) list = null;
                    else if (typeof keys === 'string') list = [keys];
                    else if (Array.isArray(keys)) list = keys;
                    else list = Object.keys(keys);
                    const all = await backend.getMany(list);
                    if (keys && typeof keys === 'object' && !Array.isArray(keys)) {
                        Object.keys(keys).forEach((k) => { if (!(k in all)) all[k] = keys[k]; });
                    }
                    return all;
                })();
                if (typeof cb === 'function') { p.then(cb, () => cb({})); return undefined; }
                return p;
            },
            set(items, cb) {
                const p = (async () => {
                    const changes = {}, stored = {};
                    const old = await backend.getMany(Object.keys(items));
                    Object.keys(items).forEach((k) => {
                        stored[k] = clone(items[k]);
                        changes[k] = { oldValue: old[k], newValue: clone(items[k]) };
                    });
                    await backend.setMany(stored);
                    emit(changes, name);
                    broadcast(changes);
                })();
                if (typeof cb === 'function') { p.then(() => cb(), () => cb()); return undefined; }
                return p;
            },
            remove(keys, cb) {
                const list = Array.isArray(keys) ? keys : [keys];
                const p = (async () => {
                    const old = await backend.getMany(list);
                    await backend.removeMany(list);
                    const changes = {};
                    list.forEach((k) => { if (k in old) changes[k] = { oldValue: old[k] }; });
                    if (Object.keys(changes).length) { emit(changes, name); broadcast(changes); }
                })();
                if (typeof cb === 'function') { p.then(() => cb(), () => cb()); return undefined; }
                return p;
            },
        };
    }

    const idbBackend = {
        async getMany(list) {
            const d = await db();
            return new Promise((resolve, reject) => {
                const tx = d.transaction(STORE, 'readonly'), s = tx.objectStore(STORE), out = {};
                if (list === null) {
                    const c = s.openCursor();
                    c.onsuccess = () => { const cur = c.result; if (cur) { out[cur.key] = cur.value; cur.continue(); } };
                } else list.forEach((k) => { const r = s.get(k); r.onsuccess = () => { if (r.result !== undefined) out[k] = r.result; }; });
                tx.oncomplete = () => resolve(out);
                tx.onerror = () => reject(tx.error);
            });
        },
        async setMany(obj) {
            const d = await db();
            return new Promise((resolve, reject) => {
                const tx = d.transaction(STORE, 'readwrite'), s = tx.objectStore(STORE);
                Object.keys(obj).forEach((k) => s.put(obj[k], k));
                tx.oncomplete = () => resolve();
                tx.onerror = tx.onabort = () => reject(tx.error);
            });
        },
        async removeMany(list) {
            const d = await db();
            return new Promise((resolve, reject) => {
                const tx = d.transaction(STORE, 'readwrite'), s = tx.objectStore(STORE);
                list.forEach((k) => s.delete(k));
                tx.oncomplete = () => resolve();
                tx.onerror = tx.onabort = () => reject(tx.error);
            });
        },
    };
    // « session » : mémoire de la page (vidée à la fermeture de l'onglet), comme storage.session de l'extension
    const mem = new Map();
    const memBackend = {
        async getMany(list) { const out = {}; (list === null ? [...mem.keys()] : list).forEach((k) => { if (mem.has(k)) out[k] = clone(mem.get(k)); }); return out; },
        async setMany(obj) { Object.keys(obj).forEach((k) => mem.set(k, obj[k])); },
        async removeMany(list) { list.forEach((k) => mem.delete(k)); },
    };

    chromeObj.storage = {
        local: makeArea('local', idbBackend),
        session: makeArea('session', memBackend),
        onChanged: {
            addListener(fn) { listeners.add(fn); },
            removeListener(fn) { listeners.delete(fn); },
            hasListener(fn) { return listeners.has(fn); },
        },
    };

    // ---------- chrome.runtime : bus de messages dans la page ----------
    const msgListeners = new Set();
    chromeObj.runtime = chromeObj.runtime || {};
    Object.assign(chromeObj.runtime, {
        // pas d'« id » : le code de l'extension qui teste chrome.runtime.id sait ainsi qu'il n'y a pas de service worker
        onMessage: {
            addListener(fn) { msgListeners.add(fn); },
            removeListener(fn) { msgListeners.delete(fn); },
            hasListener(fn) { return msgListeners.has(fn); },
        },
        sendMessage(message, cb) {
            let done = false, resolveP;
            const p = new Promise((r) => { resolveP = r; });
            const respond = (res) => {
                if (done) return; done = true;
                setTimeout(() => { if (typeof cb === 'function') { try { cb(res); } catch (_) {} } resolveP(res); }, 0);
            };
            let asyncResponse = false;
            msgListeners.forEach((fn) => {
                try { if (fn(message, {}, respond) === true) asyncResponse = true; } catch (_) {}
            });
            if (!asyncResponse) respond(undefined);
            return typeof cb === 'function' ? undefined : p;
        },
        getURL(path) { return new URL(String(path).replace(/^\//, ''), document.baseURI).href; },
    });
})();
