/*
 * BOYWO (site web) - Configuration de la connexion Google FACULTATIVE (synchronisation avec l'extension).
 *
 * clientId : identifiant OAuth de type « Application Web » (à NE PAS confondre avec celui de l'extension).
 *   1) Google Cloud Console > APIs et services > Identifiants > Créer des identifiants > ID client OAuth > Application Web.
 *   2) Utiliser le MÊME projet Google Cloud que l'extension (l'accès « drive.file » est lié à l'application : les fichiers
 *      créés par l'extension ne sont visibles que par une application du même projet).
 *   3) Origines JavaScript autorisées : https://jacquardo.github.io
 *   4) Coller l'identifiant ci-dessous. Tant qu'il est vide, la barre de synchronisation reste masquée.
 * Cet identifiant est public par nature (il apparaît dans la page de connexion Google).
 */
globalThis.BOYWO_WEB_SYNC = {
    clientId: '',
    scopes: [
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/userinfo.profile',
        'https://www.googleapis.com/auth/userinfo.email'
    ]
};
