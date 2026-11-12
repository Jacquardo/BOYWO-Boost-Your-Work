/*
 * BOYWO (site web) - Synchronisation FACULTATIVE avec l'extension, via Google Drive.
 * Module chargé par outils/index.html (le hub). Les outils restent utilisables sans connexion.
 *
 * Ce qui est synchronisé (phase 1) : l'historique de Smart Copy Tracker (clé « sct_clips »), dans le MÊME fichier Drive que
 * l'extension (BOYWO-data.json), avec la même fusion à 3 voies (sync-merge.js). Rien d'autre n'est lu ni modifié : toutes les autres
 * données du fichier (notes, tâches, réglages, index audio…) sont réécrites telles quelles. « sct_enabled » n'est pas synchronisé
 * (sur le site, l'interrupteur ne capte que les copies de la page).
 *
 * Garde-fous : aucune écriture si le fichier est illisible ou d'une version plus récente ; copie de sauvegarde unique avant la
 * première écriture (BOYWO-data.avant-site.json) ; si le fichier a changé pendant la synchro, le cycle est recommencé.
 * Connexion : Google Identity Services (jeton d'accès ~1 h, sans serveur). La bibliothèque Google n'est chargée qu'à la connexion.
 */
import { mergeStates, deepEqual } from './sync-merge.js';

const CFG = globalThis.BOYWO_WEB_SYNC || {};
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const DATA_FILE = 'BOYWO-data.json';
const BACKUP_FILE = 'BOYWO-data.avant-site.json';
const SCHEMA = 2;
const KEY = 'sct_clips', MAX_CLIPS = 500;
const ACCOUNT_KEY = 'boywo_web_account', BASE_KEY = 'boywo_web_sync_base', META_KEY = 'boywo_web_sync_meta', CHANGED_KEY = 'boywo_web_changed_at', DEVICE_KEY = 'boywo_web_device_id';
const store = chrome.storage.local;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => document.getElementById(id);

let tokenClient = null, pending = null, token = null, tokenExp = 0, timer = null, state = 'signed-out', account = null;

// ---------- Interface ----------
const ui = { bar: $('hub-sync'), text: $('sync-status'), connect: $('sync-connect'), now: $('sync-now'), create: $('sync-create'), off: $('sync-disconnect') };
function render(kind, message) {
    state = kind;
    if (!ui.bar) return;
    ui.text.textContent = message;
    ui.bar.dataset.state = kind;
    const signedIn = ['idle', 'syncing', 'no-remote', 'error'].includes(kind);
    ui.connect.hidden = signedIn || kind === 'connecting';
    ui.connect.textContent = kind === 'auth-expired' ? 'Se reconnecter' : 'Se connecter avec Google';
    ui.now.hidden = !(kind === 'idle' || kind === 'error');
    ui.create.hidden = kind !== 'no-remote';
    ui.off.hidden = !signedIn && kind !== 'auth-expired';
    ui.now.disabled = kind === 'syncing';
}
const when = (t) => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

// ---------- Connexion Google (Google Identity Services) ----------
function loadGis() {
    if (globalThis.google && google.accounts && google.accounts.oauth2) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
        s.onload = () => resolve(); s.onerror = () => reject(new Error('Impossible de charger la connexion Google (réseau ou filtre).'));
        document.head.appendChild(s);
    });
}
async function ensureClient() {
    await loadGis();
    if (tokenClient) return;
    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CFG.clientId, scope: (CFG.scopes || []).join(' '),
        callback: (r) => pending && pending.ok(r),
        error_callback: (e) => pending && pending.fail(e),
    });
}
// prompt : '' (fenêtre Google si nécessaire) ou 'none' (silencieux : échoue si une action de l'utilisateur est requise)
async function requestToken(prompt) {
    await ensureClient();
    return new Promise((resolve, reject) => {
        pending = {
            ok: (r) => {
                if (r.error) return reject(new Error(r.error_description || r.error));
                token = r.access_token; tokenExp = Date.now() + (Number(r.expires_in) || 3600) * 1000 - 60000; resolve(token);
            },
            fail: (e) => reject(new Error((e && (e.type || e.message)) || 'Connexion annulée')),
        };
        tokenClient.requestAccessToken({ prompt });
    });
}
const tokenValid = () => !!token && Date.now() < tokenExp;

// ---------- Drive ----------
class AuthError extends Error {}
async function driveFetch(url, init = {}, attempt = 0) {
    if (!tokenValid()) throw new AuthError('Session Google expirée : reconnectez-vous.');
    const headers = new Headers(init.headers || {});
    headers.set('Authorization', `Bearer ${token}`);
    let res;
    try { res = await fetch(url, { ...init, headers }); }
    catch (e) { if (attempt < 3) { await sleep(1000 * 2 ** attempt); return driveFetch(url, init, attempt + 1); } throw e; }
    if (res.status === 401) { token = null; throw new AuthError('Session Google expirée : reconnectez-vous.'); }
    if ((res.status === 429 || res.status >= 500) && attempt < 3) { await sleep(1000 * 2 ** attempt); return driveFetch(url, init, attempt + 1); }
    if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`Google Drive (${res.status})${t ? ` : ${t.slice(0, 200)}` : ''}`); }
    return res;
}
const q = encodeURIComponent;
async function findDataFile() {
    const query = q(`name = '${DATA_FILE}' and trashed = false and mimeType != 'application/vnd.google-apps.folder'`);
    const j = await (await driveFetch(`${DRIVE}/files?q=${query}&orderBy=createdTime&pageSize=1&fields=files(id,modifiedTime,version)`)).json();
    return j.files && j.files[0] ? j.files[0] : null;
}
async function writeDataFile(fileId, payload) {
    const boundary = `boywo_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const metadata = fileId ? {} : { name: DATA_FILE, mimeType: 'application/json' };
    const body = [`--${boundary}`, 'Content-Type: application/json; charset=UTF-8', '', JSON.stringify(metadata),
        `--${boundary}`, 'Content-Type: application/json; charset=UTF-8', '', JSON.stringify(payload), `--${boundary}--`, ''].join('\r\n');
    const url = `${UPLOAD}${fileId ? '/' + encodeURIComponent(fileId) : ''}?uploadType=multipart&fields=id,version,modifiedTime`;
    return (await driveFetch(url, { method: fileId ? 'PATCH' : 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body })).json();
}
async function getDeviceId() {
    const r = await store.get(DEVICE_KEY);
    if (r[DEVICE_KEY]) return r[DEVICE_KEY];
    const id = 'web-' + crypto.randomUUID(); await store.set({ [DEVICE_KEY]: id }); return id;
}

// ---------- Cycle de synchronisation ----------
const normalize = (clips) => (Array.isArray(clips) ? clips : []).filter((c) => c && c.id && typeof c.text === 'string')
    .sort((a, b) => ((b.ts || 0) - (a.ts || 0)) || (a.id < b.id ? -1 : 1)).slice(0, MAX_CLIPS);

async function syncCycle(create, attempt = 0) {
    const file = await findDataFile();
    if (!file && !create) return { noRemote: true };
    const saved = await store.get([KEY, BASE_KEY, CHANGED_KEY, META_KEY]);
    const base = saved[BASE_KEY] || null, meta = saved[META_KEY] || {};
    const localClips = Array.isArray(saved[KEY]) ? saved[KEY] : [];

    let remote = null, remoteClips = [];
    if (file) {
        remote = await (await driveFetch(`${DRIVE}/files/${encodeURIComponent(file.id)}?alt=media`)).json();
        if (!remote || typeof remote !== 'object' || !remote.data || typeof remote.data !== 'object') throw new Error('Le fichier de synchronisation Drive est illisible : aucune donnée n’a été modifiée.');
        if ((remote.schemaVersion || 1) > SCHEMA) throw new Error('Une version plus récente de BOYWO est requise pour synchroniser.');
        remoteClips = Array.isArray(remote.data[KEY]) ? remote.data[KEY] : [];
    }
    // 3 voies : local / distant / dernier état synchronisé. Sans base : union (le distant prime en cas de conflit sur un même texte).
    const pref = file && base && Number(saved[CHANGED_KEY] || 0) > Number(remote.updatedAt || 0) ? 'local' : (file ? 'remote' : 'local');
    const merged = normalize(mergeStates({ [KEY]: localClips }, { [KEY]: remoteClips }, file && base ? base : {}, pref)[KEY]);

    let written = null, didBackup = false;
    if (!file || !deepEqual(merged, normalize(remoteClips)) || (remote.schemaVersion || 1) !== SCHEMA) {
        if (file) {
            // sauvegarde unique de sécurité avant la première écriture du site
            if (!meta.backupDone) {
                await driveFetch(`${DRIVE}/files/${encodeURIComponent(file.id)}/copy?fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: BACKUP_FILE }) });
                didBackup = true;
            }
            // le fichier a-t-il changé pendant ce cycle (l'extension a pu synchroniser) ? alors on recommence
            const again = await findDataFile();
            if (!again || again.version !== file.version) { if (attempt < 2) return syncCycle(create, attempt + 1); throw new Error('Le fichier Drive change sans cesse : réessayez dans un instant.'); }
        }
        const payload = file
            ? { ...remote, schemaVersion: remote.schemaVersion || SCHEMA, updatedAt: Date.now(), deviceId: await getDeviceId(), data: { ...remote.data, [KEY]: merged } }
            : { schemaVersion: SCHEMA, updatedAt: Date.now(), deviceId: await getDeviceId(), data: { [KEY]: merged } };
        written = await writeDataFile(file ? file.id : null, payload);
    }
    let changedLocal = false;
    if (!deepEqual(merged, localClips)) {
        await store.set({ [KEY]: merged });
        changedLocal = true;
    }
    await store.set({
        [BASE_KEY]: { [KEY]: merged },
        [META_KEY]: { fileId: (written && written.id) || (file && file.id) || null, remoteVersion: (written && written.version) || (file && file.version) || null,
            backupDone: !!meta.backupDone || didBackup, updatedAt: Date.now() },
    });
    return { pushed: !!written, changedLocal, count: merged.length };
}

let running = null;
function syncNow(create = false) {
    if (running) return running;
    running = (async () => {
        const run = () => syncCycle(create);
        try {
            render('syncing', 'Synchronisation en cours…');
            const r = await (navigator.locks ? navigator.locks.request('boywo-web-sync', run) : run());
            if (r.noRemote) { render('no-remote', 'Aucune sauvegarde BOYWO trouvée sur ce compte Google. Si vous utilisez l’extension, connectez-vous d’abord depuis l’extension ; sinon, créez une sauvegarde depuis le site.'); return r; }
            render('idle', `Synchronisé avec Google Drive à ${when(Date.now())}${r.changedLocal ? ' (données reçues)' : ''}`);
            return r;
        } catch (e) {
            if (e instanceof AuthError) render('auth-expired', 'Session Google expirée : reconnectez-vous pour continuer à synchroniser.');
            else render('error', (e && e.message) || 'Synchronisation impossible.');
            return { error: e };
        } finally { running = null; }
    })();
    return running;
}
const schedule = (delay) => { clearTimeout(timer); timer = setTimeout(() => { if (tokenValid()) syncNow(); }, delay); };

// ---------- Actions de l'utilisateur ----------
async function connect() {
    render('connecting', 'Connexion à Google…');
    try {
        await requestToken('');
        try {
            const info = await (await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${token}` } })).json();
            account = { email: info.email || '' };
        } catch (_) { account = { email: '' }; }
        await store.set({ [ACCOUNT_KEY]: { connected: true, email: account.email } });
        await syncNow();
    } catch (e) { render('signed-out', (e && e.message) ? `Connexion impossible : ${e.message}` : 'Connexion impossible.'); }
}
async function disconnect() {
    try { if (token && globalThis.google) google.accounts.oauth2.revoke(token, () => {}); } catch (_) {}
    token = null; tokenExp = 0; account = null;
    await store.remove([ACCOUNT_KEY, BASE_KEY, META_KEY]);
    render('signed-out', 'Non connecté. Vos données restent sur cet appareil.');
}

async function init() {
    if (!ui.bar || !CFG.clientId) return; // non configuré : la barre reste masquée
    ui.bar.hidden = false;
    ui.connect.addEventListener('click', connect);
    ui.now.addEventListener('click', () => syncNow());
    ui.create.addEventListener('click', () => syncNow(true));
    ui.off.addEventListener('click', disconnect);
    // Une modification locale de l'historique déclenche une synchro après 5 s. Nos propres écritures (état fusionné = base) sont ignorées.
    chrome.storage.onChanged.addListener(async (changes, area) => {
        if (area !== 'local' || !changes[KEY] || !(state === 'idle' || state === 'error')) return;
        const b = (await store.get(BASE_KEY))[BASE_KEY];
        if (b && deepEqual(b[KEY], changes[KEY].newValue)) return;
        await store.set({ [CHANGED_KEY]: Date.now() });
        schedule(5000);
    });
    setInterval(() => { if (!document.hidden && tokenValid() && state === 'idle') syncNow(); }, 5 * 60 * 1000);
    render('signed-out', 'Facultatif : connectez-vous avec Google pour synchroniser l’historique Smart Copy Tracker avec l’extension.');
    const saved = (await store.get(ACCOUNT_KEY))[ACCOUNT_KEY];
    if (saved && saved.connected) { // déjà connecté auparavant : reconnexion silencieuse si Google le permet
        account = { email: saved.email || '' };
        render('connecting', 'Reconnexion à Google…');
        try { await requestToken('none'); await syncNow(); }
        catch (_) { render('auth-expired', `Reconnectez-vous${saved.email ? ' (' + saved.email + ')' : ''} pour reprendre la synchronisation.`); }
    }
}
init();
