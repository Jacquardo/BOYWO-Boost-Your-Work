// BOYWO (site web) - repère les pages affichées dans le hub « Outils » (iframe) pour masquer l'en-tête et le pied de page du site.
(function () { try { if (window.self !== window.top) document.documentElement.classList.add('embedded'); } catch (_) { document.documentElement.classList.add('embedded'); } })();
