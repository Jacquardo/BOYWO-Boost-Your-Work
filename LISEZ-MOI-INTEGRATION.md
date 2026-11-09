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
