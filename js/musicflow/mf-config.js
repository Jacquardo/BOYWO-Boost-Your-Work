// MusicFlow - configuration PROPRE à l'extension (aucun identifiant n'est demandé à l'utilisateur).
// 1) Créez un compte développeur sur Jamendo, créez une application, puis collez son client_id ci-dessous.
// 2) Ce client_id est public par nature (il apparaît dans les URL d'API) ; il identifie BOYWO auprès de Jamendo.
globalThis.MF = globalThis.MF || {};
MF.config = {
    jamendoClientId: '6f066ad4',
    // Playlists « éditoriales » : un tag Jamendo par playlist (valeurs simples = comportement le plus sûr).
    playlists: [
        { id: 'salegy', name: 'Salegy', tag: 'salegy' },
        { id: 'tsapiky', name: 'Tsapiky', tag: 'tsapiky' },
        { id: 'chill', name: 'Chill', tag: 'chillout' },
        { id: 'focus', name: 'Focus', tag: 'ambient' },
        { id: 'lounge', name: 'Lounge', tag: 'lounge' },
        { id: 'acoustic', name: 'Acoustique', tag: 'acoustic' },
        { id: 'jazz', name: 'Jazz', tag: 'jazz' },
        { id: 'classical', name: 'Classique', tag: 'classical' },
        { id: 'electro', name: 'Électro', tag: 'electronic' },
        { id: 'rock', name: 'Rock', tag: 'rock' },
        { id: 'pop', name: 'Pop', tag: 'pop' },
        { id: 'hiphop', name: 'Hip-hop', tag: 'hiphop' }
    ],
    // Catalogue « Malagasy » (Jamendo uniquement : musiques sous licence libre). Plusieurs requêtes sont fusionnées et dédoublonnées :
    //  - lang : langue des paroles (code à 2 lettres, « mg » = malagasy)
    //  - tags : étiquettes de genre/thème (fuzzytags)    - searches : recherche texte libre
    // Si une requête ne renvoie rien, elle est simplement ignorée. Ajustez ces listes après avoir regardé les résultats.
    malagasy: {
        lang: 'mg',
        tags: ['malagasy', 'salegy', 'tsapiky'],
        searches: ['malagasy', 'madagascar', 'hira gasy']
    },
    // Optionnel : liste de playlists modifiable SANS republier l'extension (JSON sur votre dépôt, déjà autorisé dans host_permissions).
    // Format : [{ "id": "etude", "name": "Étude", "tag": "ambient" }, ...]. Si le fichier est absent, la liste ci-dessus est utilisée.
    // ---------- Sources supplémentaires (clés du DÉVELOPPEUR : jamais demandées à l'utilisateur) ----------
    // Radio Browser : annuaire communautaire gratuit, SANS clé. Les serveurs sont essayés dans l'ordre (repli automatique).
    radio: {
        countrycode: 'MG',   // Madagascar
        limit: 100,
        servers: ['de1.api.radio-browser.info', 'de2.api.radio-browser.info', 'fr1.api.radio-browser.info', 'nl1.api.radio-browser.info', 'at1.api.radio-browser.info']
    },
    // Audius : créez une application sur https://audius.co/settings (Développeur) et collez la clé API ici.
    audiusApiKey: '0x2027d39c1cc5ef5ee05076d8fad083e41eb04246',
    audiusAppName: 'BOYWO',
    // YouTube Data API v3 : clé Google Cloud (activez « YouTube Data API v3 » et restreignez la clé à cette seule API).
    // Quota par défaut = 10 000 unités/jour ; une recherche coûte 100 unités (≈ 100 recherches/jour pour TOUS les utilisateurs).
    youtubeApiKey: 'AIzaSyC0YuysHmo1LqsahF1QAIh7FZiPD8raZWc',
    youtubeCacheHours: 6,        // durée de mise en cache d'une recherche (storage.session, non synchronisé Drive)
    youtubeOfficialBoost: true,  // ajoute « official » à la requête et classe en premier les chaînes/titres « official », VEVO, « - Topic »
    // Recherche commune (chip « Tout » et champ de recherche). ATTENTION : chaque recherche inclut YouTube = 100 unités de quota.
    // Retirez 'youtube' de la liste pour ménager le quota ; 'radio' est aussi possible (filtre par nom, gratuit).
    unifiedSources: ['jamendo', 'audius', 'youtube'],
    unifiedPerSource: 10,
    remotePlaylistsUrl: 'https://raw.githubusercontent.com/Jacquardo/BOYWO/main/data/musicflow-playlists.json'
};
