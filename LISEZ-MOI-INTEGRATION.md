# Intégration des outils dans le site BOYWO (dépôt du site uniquement)

Copiez le contenu de ce dossier à la racine du dépôt du SITE (BOYWO-Boost-Your-Work), en respectant les sous-dossiers.
Aucun fichier du dépôt de l'extension n'est modifié.

## À remplacer
- index.html, privacy-policy.html
- player/player.html (une seule ligne : le site est ajouté aux origines autorisées ; l'adresse ne change pas)

## À ajouter
- outils/ : index.html (hub à onglets), smart-copy.html, image-editor.html, musicflow.html
- css/ : site.css, tools.css, smart-copy.css, image-editor.css, musicflow.css
- js/ : chrome-shim.js, embed.js, hub.js, audio-db.js, smart-copy-*.js, musicflow/*.js

## js/image-editor.js
Copie à l'identique du fichier de l'extension (il n'utilise que le navigateur : IndexedDB et localStorage, aucune API Chrome).

## À supprimer (devenus inutiles)
- css/style.txt, css/vitrine.css et vitrine.css (à la racine) : remplacés par css/site.css
- site/gnrnog.txt (fichier sans contenu utile)
- site/musicflow-player.html et .js : à supprimer seulement après avoir vérifié qu'aucune version publiée de l'extension ne les utilise

## À faire dans Google Cloud
Clé YouTube Data API : ajouter l'origine https://jacquardo.github.io aux restrictions d'application (sites web).
Le quota (10 000 unités/jour) est partagé avec l'extension.

## Synchronisation facultative avec l'extension (connexion Google sur le site)
Fichiers : js/sync-web.js, js/sync-web-config.js, js/sync-merge.js (copie de l'extension, inchangée). Tant que `clientId` est vide dans
js/sync-web-config.js, la barre de synchronisation reste masquée et le site fonctionne comme avant.

Pour l'activer :
1. Google Cloud Console, MÊME projet que l'extension > APIs et services > Identifiants > Créer des identifiants > ID client OAuth > « Application Web ».
2. Origines JavaScript autorisées : https://jacquardo.github.io (pas d'URI de redirection nécessaire).
3. Coller l'identifiant dans js/sync-web-config.js (clientId).
4. Si l'écran de consentement est en mode « Test », ajouter votre compte aux utilisateurs de test ; sinon, passer en production.
5. Premier essai : se connecter avec le MÊME compte Google que l'extension. Si le site affiche « Aucune sauvegarde BOYWO trouvée », les
   fichiers de l'extension ne sont pas visibles pour l'application web (l'accès « drive.file » est lié à l'application) : ne rien créer
   et me le signaler.
Phase 1 : seul l'historique Smart Copy Tracker (clé sct_clips) est synchronisé. Favoris/playlists MusicFlow et projets de l'éditeur
d'images ne le sont pas, même dans l'extension.
