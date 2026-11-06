// MusicFlow - fournisseurs de streaming. Un fournisseur = un objet avec les mêmes méthodes.
// Format de piste commun : { id, source, title, artist, artistId, album, albumId, cover, url, duration }
// Champs optionnels : live (flux continu), videoId (YouTube : lecture HORS moteur audio), pageUrl, official.
(function () {
    const MF = (globalThis.MF = globalThis.MF || {});
    const API = 'https://api.jamendo.com/v3.0';
    const cfg = () => MF.config || {};
    // Erreur à code stable : message = code (compatible avec les tests « e.message === 'NO_CLIENT_ID' » existants)
    const fail = (code, detail) => Object.assign(new Error(code), { code, detail });

    // Clé = celle de l'extension (mf-config.js). Un éventuel réglage « mf_settings.jamendoClientId » ne sert qu'au développeur.
    async function clientId() {
        let id = '';
        try { id = ((await chrome.storage.local.get('mf_settings')).mf_settings || {}).jamendoClientId || ''; } catch (_) {}
        id = id || (MF.config && MF.config.jamendoClientId) || '';
        if (!id || /^VOTRE_/.test(id)) throw new Error('NO_CLIENT_ID');
        return id;
    }
    // Même principe pour les clés Audius / YouTube (le réglage mf_settings ne sert qu'au développeur).
    async function secret(setting, name, code) {
        let v = '';
        try { v = ((await chrome.storage.local.get('mf_settings')).mf_settings || {})[setting] || ''; } catch (_) {}
        v = v || cfg()[name] || '';
        if (!v || /^VOTRE_/.test(v)) throw fail(code);
        return String(v);
    }

    // Cache dans chrome.storage.session : économise les quotas partagés, et n'est PAS synchronisé avec Drive.
    const TTL = 30 * 60 * 1000;
    async function cacheGet(k, ttl) {
        try { const r = (await chrome.storage.session.get(k))[k]; return r && Date.now() - r.t < (ttl || TTL) ? r.v : null; } catch (_) { return null; }
    }
    function cacheSet(k, v) { try { chrome.storage.session.set({ [k]: { t: Date.now(), v } }); } catch (_) {} }

    // fetch + JSON avec délai maximal. Lève NETWORK / TIMEOUT ; renvoie { res, body } (body = null si non-JSON).
    async function getJson(url, timeout) {
        const ctl = new AbortController();
        const to = setTimeout(() => ctl.abort(), timeout || 10000);
        let res;
        try { res = await fetch(url, { signal: ctl.signal }); }
        catch (e) { throw fail(e && e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK'); }
        finally { clearTimeout(to); }
        let body = null;
        try { body = await res.json(); } catch (_) {}
        return { res, body };
    }

    async function call(path, params) {
        const u = new URL(API + path);
        Object.entries(params || {}).forEach(([k, v]) => u.searchParams.set(k, v));
        u.searchParams.set('format', 'json');
        const ck = 'mfc:' + u.search;
        const hit = await cacheGet(ck);
        if (hit) return hit;
        u.searchParams.set('client_id', await clientId());
        let res;
        try { res = await fetch(u); } catch (_) { throw fail('NETWORK'); } // hors connexion : message clair plutôt que « Failed to fetch »
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const j = await res.json();
        if (j.headers && j.headers.status === 'failed') throw new Error(j.headers.error_message || 'Erreur API');
        const out = j.results || [];
        cacheSet(ck, out);
        return out;
    }

    const toTrack = (t) => ({
        id: 'jamendo:' + t.id, source: 'jamendo', title: t.name, artist: t.artist_name,
        artistId: t.artist_id, album: t.album_name || '', albumId: t.album_id || '',
        cover: t.album_image || t.image || '', url: t.audio, duration: Number(t.duration) || 0,
        // Téléchargement (bibliothèque) : uniquement si l'artiste l'autorise (audiodownload_allowed)
        download: t.audiodownload || '', downloadAllowed: t.audiodownload_allowed === true && !!t.audiodownload,
        license: t.license_ccurl || '',
    });
    const tracksOnly = (rows) => rows.map(toTrack).filter((t) => t.url);

    const jamendo = {
        id: 'jamendo', label: 'Jamendo', available: true,
        tagTracks: (tag) => call('/tracks/', { tags: tag, order: 'popularity_week', limit: 40, imagesize: 200 }).then(tracksOnly),
        // Agrégat « Malagasy » : plusieurs requêtes fusionnées, dédoublonnées. Une requête en échec n'empêche pas les autres.
        async malagasy() {
            const c = cfg().malagasy || {};
            const jobs = [];
            if (c.lang) jobs.push(call('/tracks/', { lang: c.lang, order: 'popularity_total', limit: 50, imagesize: 200 }));
            (c.tags || []).forEach((t) => jobs.push(call('/tracks/', { fuzzytags: t, order: 'popularity_total', limit: 30, imagesize: 200 })));
            (c.searches || []).forEach((q) => jobs.push(call('/tracks/', { search: q, limit: 30, imagesize: 200 })));
            const res = await Promise.allSettled(jobs);
            const ok = res.filter((r) => r.status === 'fulfilled');
            if (!ok.length && res.length) throw res[0].reason; // tout a échoué (clé absente, réseau…) : on remonte l'erreur
            const seen = new Set(), out = [];
            for (const r of ok) for (const t of tracksOnly(r.value)) { if (!seen.has(t.id)) { seen.add(t.id); out.push(t); } }
            return out.slice(0, 100);
        },
        popular: () => call('/tracks/', { order: 'popularity_week', limit: 24, imagesize: 300 }).then(tracksOnly),
        searchTracks: (q) => call('/tracks/', { search: q, limit: 30, imagesize: 300 }).then(tracksOnly),
        searchArtists: (q) => call('/artists/', { namesearch: q, limit: 18, imagesize: 300 })
            .then((r) => r.map((a) => ({ id: a.id, name: a.name, image: a.image || '' }))),
        searchAlbums: (q) => call('/albums/', { namesearch: q, limit: 18, imagesize: 300 })
            .then((r) => r.map((a) => ({ id: a.id, name: a.name, artist: a.artist_name, image: a.image || '' }))),
        artistTracks: (id) => call('/tracks/', { artist_id: id, limit: 50, order: 'popularity_total', imagesize: 300 }).then(tracksOnly),
        albumTracks: (id) => call('/tracks/', { album_id: id, limit: 60, imagesize: 300 }).then(tracksOnly),
    };

    // ------------------------------------------------------------------------------------------------
    // Radio Browser (https://api.radio-browser.info) : annuaire de radios web, sans clé. Flux continus lus par mf-engine.js.
    // ------------------------------------------------------------------------------------------------
    const RADIO_SERVERS = ['de1.api.radio-browser.info', 'de2.api.radio-browser.info', 'fr1.api.radio-browser.info', 'nl1.api.radio-browser.info', 'at1.api.radio-browser.info'];
    const httpUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u.trim()) ? u.trim() : '');

    function radioTracks(rows) {
        const seen = new Set(), out = [];
        for (const s of Array.isArray(rows) ? rows : []) {
            const url = httpUrl(s && (s.url_resolved || s.url));
            if (!url || s.hls === 1 || seen.has(url)) continue; // HLS (.m3u8) : non lisible par un <audio> Chrome
            seen.add(url);
            out.push({
                id: 'radio:' + s.stationuuid, source: 'radio', live: true,
                title: String(s.name || '').trim() || 'Radio sans nom',
                artist: 'Radio · ' + (s.country || s.countrycode || 'en direct'),
                artistId: '', album: '', albumId: '', cover: httpUrl(s.favicon), url, duration: 0,
            });
        }
        // HTTPS d'abord (les flux http:// peuvent être bloqués selon le contexte), puis l'ordre de popularité de l'annuaire
        return out.map((t, i) => ({ t, i })).sort((a, b) => (/^https:/i.test(b.t.url) - /^https:/i.test(a.t.url)) || a.i - b.i).map((x) => x.t);
    }

    // Pays proposés dans le panneau « Radios » (surchargeable via MF.config.radio.countries). cc = code ISO ; '' = monde entier.
    const RADIO_COUNTRIES = [
        { cc: 'MG', label: 'Madagascar' }, { cc: 'FR', label: 'France' }, { cc: 'GB', label: 'Royaume-Uni' },
        { cc: 'US', label: 'États-Unis' }, { cc: '', label: 'Monde' },
    ];
    const radio = {
        id: 'radio', label: 'Radios', available: true,
        countries: () => ((cfg().radio || {}).countries || RADIO_COUNTRIES),
        // Stations du pays configuré (Madagascar), non cassées, triées par popularité. name = filtre texte optionnel.
        async stations(name, country) {
            const c = cfg().radio || {};
            const cc = country === undefined ? (c.countrycode || 'MG') : country; // '' = toutes les stations du monde
            const params = { hidebroken: 'true', order: 'clickcount', reverse: 'true', limit: c.limit || 100 };
            if (cc) params.countrycode = cc;
            if (name) params.name = name;
            const q = new URLSearchParams(params).toString();
            const ck = 'mfc:radio?' + q;
            const hit = await cacheGet(ck);
            if (hit) return radioTracks(hit);
            const servers = c.servers && c.servers.length ? c.servers : RADIO_SERVERS;
            let netError = null;
            for (const s of servers) {
                try {
                    const { res, body } = await getJson('https://' + s + '/json/stations/search?' + q, 8000);
                    if (!res.ok || !Array.isArray(body)) continue;
                    cacheSet(ck, body);
                    return radioTracks(body);
                } catch (e) { netError = e; }
            }
            throw fail(netError && netError.code === 'NETWORK' ? 'NETWORK' : 'RADIO_DIRECTORY');
        },
    };

    // ------------------------------------------------------------------------------------------------
    // Audius (https://api.audius.co/v1) : recherche + lecture via l'endpoint de streaming. Clé développeur dans mf-config.js.
    // ------------------------------------------------------------------------------------------------
    const AUDIUS = 'https://api.audius.co/v1';
    const audiusPlayable = (t) => t && t.id && t.is_streamable !== false && t.is_stream_gated !== true && !(t.access && t.access.stream === false);

    async function audiusTracks(path, params) {
        const key = await secret('audiusApiKey', 'audiusApiKey', 'NO_AUDIUS_KEY');
        const app = cfg().audiusAppName || 'BOYWO';
        const u = new URL(AUDIUS + path);
        Object.entries(params || {}).forEach(([k, v]) => u.searchParams.set(k, v));
        u.searchParams.set('app_name', app);
        const ck = 'mfc:audius:' + u.search; // la clé n'est jamais dans la clé de cache
        let rows = await cacheGet(ck);
        if (!rows) {
            u.searchParams.set('api_key', key);
            const { res, body } = await getJson(u, 10000);
            if (res.status === 429) throw fail('RATE_LIMIT');
            if (res.status === 401 || res.status === 403) throw fail('AUDIUS_KEY');
            if (!res.ok) throw fail('HTTP', res.status);
            if (!body || !Array.isArray(body.data)) throw fail('BAD_RESPONSE');
            rows = body.data;
            cacheSet(ck, rows);
        }
        return rows.filter(audiusPlayable).map((t) => {
            const art = t.artwork || {}, user = t.user || {};
            return {
                id: 'audius:' + t.id, source: 'audius', title: String(t.title || 'Sans titre'),
                artist: user.name || user.handle || 'Artiste Audius', artistId: user.id || '', album: '', albumId: '',
                cover: httpUrl(art['480x480'] || art['150x150'] || ''), duration: Number(t.duration) || 0,
                url: AUDIUS + '/tracks/' + encodeURIComponent(t.id) + '/stream?app_name=' + encodeURIComponent(app) + '&api_key=' + encodeURIComponent(key),
                pageUrl: t.permalink ? 'https://audius.co' + t.permalink : '',
            };
        });
    }

    const audius = {
        id: 'audius', label: 'Audius', available: true,
        ensureReady: () => secret('audiusApiKey', 'audiusApiKey', 'NO_AUDIUS_KEY'),
        trending: () => audiusTracks('/tracks/trending', { time: 'week', limit: 30 }),
        searchTracks: (q) => audiusTracks('/tracks/search', { query: q, limit: 30 }),
    };

    // ------------------------------------------------------------------------------------------------
    // YouTube Data API v3 : RECHERCHE uniquement. Aucune URL audio n'est produite : la lecture se fait dans le lecteur
    // officiel visible (iframe de la page outils/musicflow-youtube.html). Pas d'extraction audio, pas de lecture en arrière-plan.
    // ------------------------------------------------------------------------------------------------
    const YT = 'https://www.googleapis.com/youtube/v3';
    const VIDEO_ID = /^[\w-]{11}$/;
    const QUOTA_BLOCK = 60 * 60 * 1000; // après un « quota dépassé », on ne réessaie pas pendant 1 h

    function decodeEntities(s) {
        s = String(s == null ? '' : s);
        if (typeof DOMParser !== 'undefined') { try { return new DOMParser().parseFromString(s, 'text/html').documentElement.textContent || s; } catch (_) {} }
        return s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    }
    // L'API n'expose AUCUN indicateur « officiel » : simple heuristique sur le titre et le nom de la chaîne.
    const isOfficial = (title, channel) => /official|officiel|vevo/i.test(title + ' ' + channel) || /\s-\s*topic$/i.test(channel);

    function ytError(res, body) {
        const e = (body && body.error) || {};
        const reason = (e.errors && e.errors[0] && e.errors[0].reason) || '';
        const txt = reason + ' ' + String(e.message || '') + ' ' + String(e.status || '');
        if (/quotaExceeded|dailyLimitExceeded/i.test(txt)) return fail('YT_QUOTA');
        if (/rateLimitExceeded/i.test(txt)) return fail('RATE_LIMIT');
        if (/keyInvalid|API_KEY_INVALID|API key not valid/i.test(txt)) return fail('YT_KEY');
        if (/accessNotConfigured|ipRefererBlocked|SERVICE_DISABLED|forbidden|blocked|PERMISSION_DENIED/i.test(txt)) return fail('YT_FORBIDDEN');
        return fail('HTTP', res.status);
    }

    const youtube = {
        id: 'youtube', label: 'YouTube', available: true, external: true, // external : lecture hors moteur audio
        ensureReady: () => secret('youtubeApiKey', 'youtubeApiKey', 'NO_YT_KEY'),
        isVideoId: (id) => typeof id === 'string' && VIDEO_ID.test(id),
        embedUrl: (id) => 'https://www.youtube.com/embed/' + encodeURIComponent(id) + '?rel=0&playsinline=1',
        watchUrl: (id) => 'https://www.youtube.com/watch?v=' + encodeURIComponent(id),
        thumbUrl: (id, q) => 'https://i.ytimg.com/vi/' + encodeURIComponent(id) + '/' + (q || 'mqdefault') + '.jpg', // miniature de repli (l'API n'en renvoie pas toujours)
        async search(query) {
            const key = await secret('youtubeApiKey', 'youtubeApiKey', 'NO_YT_KEY');
            const q = String(query || '').trim().replace(/\s+/g, ' ');
            if (!q) return [];
            const boost = cfg().youtubeOfficialBoost !== false && !/official|officiel/i.test(q);
            const u = new URL(YT + '/search');
            Object.entries({ part: 'snippet', type: 'video', videoCategoryId: '10', videoEmbeddable: 'true', videoSyndicated: 'true',
                safeSearch: 'moderate', maxResults: 15, q: boost ? q + ' official' : q }).forEach(([k, v]) => u.searchParams.set(k, v));
            const ck = 'mfc:yt:' + u.search;
            let rows = await cacheGet(ck, (cfg().youtubeCacheHours || 6) * 3600 * 1000); // un résultat en cache ne coûte AUCUN quota
            if (!rows) {
                if (await cacheGet('mfq:yt', QUOTA_BLOCK)) throw fail('YT_QUOTA');
                u.searchParams.set('key', key);
                const { res, body } = await getJson(u, 10000);
                if (!res.ok) { const err = ytError(res, body); if (err.code === 'YT_QUOTA') cacheSet('mfq:yt', true); throw err; }
                if (!body || !Array.isArray(body.items)) throw fail('BAD_RESPONSE');
                rows = body.items;
                cacheSet(ck, rows);
            }
            const out = [];
            rows.forEach((it, i) => {
                const vid = it && it.id && it.id.videoId, sn = (it && it.snippet) || {};
                if (!VIDEO_ID.test(vid || '')) return;
                const title = decodeEntities(sn.title), artist = decodeEntities(sn.channelTitle);
                const th = sn.thumbnails || {};
                out.push({ i, t: {
                    id: 'youtube:' + vid, source: 'youtube', videoId: vid, title, artist, artistId: sn.channelId || '',
                    album: '', albumId: '', cover: httpUrl((th.medium || th.default || {}).url || '') || ('https://i.ytimg.com/vi/' + vid + '/mqdefault.jpg'), url: '', duration: 0,
                    official: isOfficial(title, artist),
                } });
            });
            return out.sort((a, b) => (b.t.official - a.t.official) || a.i - b.i).map((x) => x.t);
        },
    };

    // Messages d'erreur en français, communs au panneau « En ligne » et à la page YouTube.
    const MESSAGES = {
        NO_CLIENT_ID: 'Catalogue en ligne bientôt disponible.',
        NO_AUDIUS_KEY: 'Audius n’est pas encore configuré (clé API absente dans mf-config.js).',
        NO_YT_KEY: 'YouTube n’est pas encore configuré (clé API absente dans mf-config.js).',
        AUDIUS_KEY: 'Audius a refusé la clé API de l’application : vérifiez-la dans mf-config.js.',
        YT_KEY: 'YouTube a refusé la clé API (clé invalide) : vérifiez-la dans mf-config.js.',
        YT_FORBIDDEN: 'YouTube a refusé la requête : « YouTube Data API v3 » n’est pas activée pour cette clé, ou la clé est trop restreinte.',
        YT_QUOTA: 'Le quota quotidien de recherche YouTube est épuisé. Réessayez demain (les recherches déjà faites restent disponibles).',
        RATE_LIMIT: 'Trop de requêtes en peu de temps : patientez un instant puis réessayez.',
        RADIO_DIRECTORY: 'L’annuaire des radios ne répond pas. Réessayez dans quelques minutes.',
        NOT_ALLOWED: 'L’artiste n’autorise pas le téléchargement de ce titre : écoute en ligne uniquement.',
        DOWNLOAD_HTTP: 'Téléchargement impossible : le serveur a refusé la demande.',
        DOWNLOAD_FAILED: 'Téléchargement impossible. Réessayez dans un instant.',
        TOO_BIG: 'Fichier trop volumineux pour la bibliothèque (80 Mo maximum).',
        BAD_FILE: 'Le fichier téléchargé n’est pas un audio valide.',
        NO_DB: 'La bibliothèque locale est indisponible : rouvrez BOYWO puis réessayez.',
        NETWORK: 'Connexion impossible : vérifiez votre accès à Internet.',
        TIMEOUT: 'Le service met trop de temps à répondre. Réessayez.',
        BAD_RESPONSE: 'Réponse inattendue du service. Réessayez plus tard.',
    };
    MF.errorMessage = (e) => {
        const code = (e && (e.code || e.message)) || '';
        if (code === 'HTTP') return 'Service injoignable (erreur HTTP ' + ((e && e.detail) || '?') + ').';
        return MESSAGES[code] || 'Service injoignable (' + (code || 'erreur') + ').';
    };

    // Recherche commune : interroge les sources en parallèle (liste = MF.config.unifiedSources). Une source en échec n'empêche pas
    // les autres ; une source non configurée (clé absente) est ignorée en silence. Si TOUT échoue, l'erreur est remontée.
    const LABELS = { jamendo: 'Jamendo', audius: 'Audius', youtube: 'YouTube', radio: 'Radios' };
    MF.searchAll = async (query, sources) => {
        const q = String(query || '').trim();
        const list = (sources || cfg().unifiedSources || ['jamendo', 'audius', 'youtube']).filter((s) => LABELS[s]);
        const per = cfg().unifiedPerSource || 10;
        const jobs = { jamendo: () => jamendo.searchTracks(q), audius: () => audius.searchTracks(q), youtube: () => youtube.search(q), radio: () => radio.stations(q) };
        const res = await Promise.allSettled(list.map((s) => jobs[s]()));
        const all = list.map((s, i) => ({ src: s, label: LABELS[s], tracks: res[i].status === 'fulfilled' ? res[i].value.slice(0, per) : [], error: res[i].status === 'rejected' ? res[i].reason : null }));
        const unconfigured = (e) => e && /^NO_/.test(e.code || e.message || '');
        const shown = all.filter((x) => !unconfigured(x.error));
        if (!shown.length || shown.every((x) => x.error)) throw (all.find((x) => x.error) || { error: new Error('NETWORK') }).error;
        return shown;
    };

    // Recherche UNIFIÉE (chip « Tout »). Règle : le lecteur audio BOYWO (Jamendo, Audius) passe en premier ; YouTube complète pour les
    // artistes connus. YouTube n'est interrogé (100 unités de quota) que si les sources audio donnent peu de résultats
    // (MF.config.youtubeFallbackBelow, 5 par défaut) ou si l'utilisateur le demande (opts.forceYoutube). Les vidéos qui doublonnent un
    // titre déjà trouvé en audio sont retirées : on ne propose que la version jouable par le lecteur BOYWO.
    const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[([][^)\]]*[)\]]/g, ' ').replace(/\b(official|officiel|video|clip|audio|lyrics|hd|hq|music)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
    const sameSong = (yt, a) => {
        const yt1 = norm(yt.title + ' ' + yt.artist), t = norm(a.title), ar = norm(a.artist);
        return t.length >= 3 && yt1.includes(t) && (!ar || yt1.includes(ar));
    };
    MF.searchUnified = async (query, opts) => {
        opts = opts || {};
        const q = String(query || '').trim();
        const list = (cfg().unifiedSources || ['jamendo', 'audius', 'youtube']).filter((s) => LABELS[s]);
        const audioList = list.filter((s) => s !== 'youtube'), wantYt = list.includes('youtube');
        let audio = [], audioErr = null;
        if (audioList.length) { try { audio = await MF.searchAll(q, audioList); } catch (e) { audioErr = e; } }
        const audioTracks = audio.flatMap((s) => s.tracks);
        const min = cfg().youtubeFallbackBelow == null ? 5 : cfg().youtubeFallbackBelow;
        const queryYt = wantYt && (opts.forceYoutube || audioTracks.length < min);
        let yt = null;
        if (queryYt) {
            try { yt = (await MF.searchAll(q, ['youtube']))[0]; }
            catch (e) { yt = /^NO_/.test(e.code || e.message || '') ? null : { src: 'youtube', label: 'YouTube', tracks: [], error: e }; }
        }
        if (yt && yt.tracks.length) yt.tracks = yt.tracks.filter((v) => !audioTracks.some((a) => sameSong(v, a)));
        const sections = audio.slice();
        if (yt) { yt.label = 'YouTube · artistes connus (vidéo)'; sections.push(yt); }
        if (!sections.length || sections.every((x) => x.error)) throw (sections.find((x) => x.error) || { error: audioErr || new Error('NETWORK') }).error;
        return { sections, audioCount: audioTracks.length, youtubeQueried: !!yt, canAddYoutube: wantYt && !yt };
    };

    // Spotify : volontairement NON branché (voir INTEGRATION.md).
    MF.providers = {
        jamendo, radio, audius, youtube,
        spotify: { id: 'spotify', label: 'Spotify', available: false, reason: 'Lecture complète = SDK distant (interdit par la CSP Manifest V3) + compte Premium.' },
    };
})();
