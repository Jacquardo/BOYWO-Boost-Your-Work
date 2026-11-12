// ==========================================
// BOYWO - Moteur de fusion (pur, sans dépendance Chrome)
// Fusion à 3 voies : LOCAL / DISTANT / BASE (dernier état synchronisé).
// Permet de propager ajouts, modifications ET suppressions sans jamais
// écraser aveuglément les données d'un autre appareil.
// ==========================================

export const BLOB_MIN_LENGTH = 20000; // les data: URL plus longues (images, fonds…) sont stockées à part

export function stable(v) {
    if (v === undefined) return 'u';
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort()
        .map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}
export const deepEqual = (a, b) => stable(a) === stable(b);

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const isPrim = v => v === null || typeof v !== 'object';
const isIdArray = a => Array.isArray(a) && a.every(x => isObj(x) && x.id !== undefined && x.id !== null);

function mergeSets(l, r, b) {
    const inL = new Set(l), inR = new Set(r), inB = new Set(b);
    const out = [];
    [...l, ...r].forEach(x => {
        if (out.includes(x)) return;
        const keep = (inL.has(x) && inR.has(x)) || (inL.has(x) && !inB.has(x)) || (inR.has(x) && !inB.has(x));
        if (keep) out.push(x);
    });
    return out;
}

function mergeIdArrays(l, r, b, pref, depth) {
    const map = arr => new Map(arr.map(x => [String(x.id), x]));
    const lm = map(l), rm = map(r), bm = map(b);
    const ids = [...lm.keys(), ...[...rm.keys()].filter(id => !lm.has(id))];
    const out = [];
    ids.forEach(id => {
        const v = mergeValues(lm.get(id), rm.get(id), bm.get(id), pref, depth + 1);
        if (v !== undefined) out.push(v);
    });
    return out;
}

// Retourne undefined si la valeur doit être supprimée.
export function mergeValues(l, r, b, pref = 'remote', depth = 0) {
    if (deepEqual(l, r)) return l;
    if (deepEqual(l, b)) return r;   // seul le distant a changé (ou supprimé)
    if (deepEqual(r, b)) return l;   // seul le local a changé (ou supprimé)

    if (Array.isArray(l) && Array.isArray(r) && (b === undefined || Array.isArray(b))) {
        const bb = b || [];
        if (isIdArray(l) && isIdArray(r) && isIdArray(bb)) return mergeIdArrays(l, r, bb, pref, depth);
        if (l.every(isPrim) && r.every(isPrim) && bb.every(isPrim)) return mergeSets(l, r, bb);
    }
    if (isObj(l) && isObj(r) && (b === undefined || isObj(b)) && depth < 8) {
        const bb = b || {};
        const out = {};
        [...new Set([...Object.keys(l), ...Object.keys(r)])].forEach(k => {
            const v = mergeValues(l[k], r[k], bb[k], pref, depth + 1);
            if (v !== undefined) out[k] = v;
        });
        return out;
    }
    // Vrai conflit sur une valeur simple : le côté préféré gagne.
    return pref === 'local' ? l : r;
}

export function mergeStates(local, remote, base, pref) {
    const out = {};
    new Set([...Object.keys(local), ...Object.keys(remote)]).forEach(k => {
        const v = mergeValues(local[k], remote[k], (base || {})[k], pref, 0);
        if (v !== undefined) out[k] = v;
    });
    return out;
}

// ---------- Médias volumineux (images, fonds, photo de profil…) ----------
// Toute chaîne "data:" volumineuse est remplacée par une référence {$blob: sha256}.
// Le contenu est stocké une seule fois (adressage par contenu) dans Drive.

async function sha256Hex(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function encodeValue(v, blobs) {
    if (typeof v === 'string') {
        if (v.length >= BLOB_MIN_LENGTH && v.startsWith('data:')) {
            const sha = await sha256Hex(v);
            blobs.set(sha, v);
            return { $blob: sha };
        }
        return v;
    }
    if (Array.isArray(v)) {
        const out = [];
        for (const x of v) out.push(await encodeValue(x, blobs));
        return out;
    }
    if (isObj(v)) {
        const out = {};
        for (const k of Object.keys(v)) out[k] = await encodeValue(v[k], blobs);
        return out;
    }
    return v;
}

const isBlobRef = v => isObj(v) && typeof v.$blob === 'string' && Object.keys(v).length === 1;

export function collectRefs(v, set) {
    if (isBlobRef(v)) { set.add(v.$blob); return set; }
    if (Array.isArray(v)) v.forEach(x => collectRefs(x, set));
    else if (isObj(v)) Object.values(v).forEach(x => collectRefs(x, set));
    return set;
}

export async function decodeValue(v, resolve) {
    if (isBlobRef(v)) return resolve(v.$blob);
    if (Array.isArray(v)) {
        const out = [];
        for (const x of v) out.push(await decodeValue(x, resolve));
        return out;
    }
    if (isObj(v)) {
        const out = {};
        for (const k of Object.keys(v)) out[k] = await decodeValue(v[k], resolve);
        return out;
    }
    return v;
}
