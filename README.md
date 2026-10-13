# Montage Audio

Un logiciel de montage audio **multipiste**, en français, pensé pour les débutants. Il fonctionne
dans le navigateur, **sans rien installer**, et vos sons restent sur votre ordinateur. Il a été
testé sous Chrome ; il est conçu pour fonctionner aussi avec Edge, Firefox et Safari récents.

Il comble ce que ocenaudio ne fait pas : poser plusieurs sons sur des **pistes** jouées en même
temps, et régler le **volume de chaque piste** séparément. Il reste plus simple qu'Audacity.

## Ouvrir l'application

- **Le plus simple** : téléchargez le fichier [`dist/montage-audio.html`](dist/montage-audio.html)
  puis double-cliquez dessus. Tout est dans ce seul fichier.
- **Depuis le dépôt complet** : téléchargez le dépôt (bouton vert « Code » puis « Download ZIP »),
  décompressez-le, puis double-cliquez sur `index.html`.

Au premier lancement, un **projet d'exemple** s'ouvre (musique fabriquée sur place) pour
découvrir l'outil. Le bouton « Commencer mon montage » repart d'un projet vide.

## Les bases en 5 étapes

1. **Importez vos sons** : bouton « Importer des sons », ou glissez vos fichiers dans la fenêtre.
   Formats : MP3, WAV, M4A/AAC, OGG, FLAC, et le son des vidéos MP4. Chaque fichier arrive sur sa
   propre piste. Déposé sur une piste existante, il se place à l'endroit où vous le lâchez.
2. **Placez-les dans le temps** : attrapez un morceau et faites-le glisser à gauche ou à droite, ou
   sur une autre piste. Tirez son bord gauche ou droit pour le raccourcir. L'**aimant** colle les
   morceaux les uns aux autres (maintenez Alt pour le désactiver).
3. **Réglez les niveaux** : chaque piste a un curseur **Volume** (en dB) et une **Balance**
   gauche/droite. « Muet » coupe une piste ; « Solo » n'écoute qu'elle. Le témoin
   **Saturation** s'allume si le son devient trop fort.
4. **Adoucissez les transitions** :
   - **Fondus** : tirez le petit rond en haut à gauche (entrée) ou à droite (sortie) d'un morceau.
   - **Courbe de volume** : sélectionnez un morceau, cliquez sur sa ligne de volume pour ajouter
     un point, puis faites-le glisser vers le bas pour baisser le son à cet endroit. Double-clic
     sur un point pour le retirer.
   - **S'effacer quand une autre piste joue** (menu ⋯ d'une piste) : la musique baisse toute seule
     quand la voix parle.
5. **Exportez** : le bouton « Exporter » crée un fichier **MP3** (léger, pour partager) ou **WAV**
   (qualité maximale) avec toutes les pistes mélangées. L'option « Ajuster le volume final » règle
   le niveau au plus fort sans saturer.

## Autres fonctions

- **Couper** un morceau en deux à la tête de lecture (touche `S`), **dupliquer**, **copier/coller**,
  **supprimer et rapprocher la suite** (clic droit sur un morceau).
- **Ajuster le volume automatiquement** d'un morceau, ou **harmoniser** le volume de plusieurs
  morceaux entre eux (par exemple des voix enregistrées à des niveaux différents).
- **Enregistrer au micro** (bouton rond rouge, touche `R`) sur une nouvelle piste, pendant que les
  autres pistes jouent. Utilisez un casque pour que la musique ne soit pas captée.
- **Annuler / rétablir** jusqu'à 300 étapes (`Ctrl+Z`, `Ctrl+Maj+Z`).
- **Sélection multiple** : Maj + clic, ou tracez un cadre autour des morceaux.
- **Zoom** : boutons loupe, touches `+` / `−`, ou `Ctrl` + molette à l'endroit de la souris.

## Raccourcis clavier

| Touche | Action |
| --- | --- |
| `Espace` | Lecture / pause |
| `Début` | Revenir au début |
| `←` `→` | Reculer / avancer d'une seconde (`Maj` : 5 s) |
| `S` | Couper à la tête de lecture |
| `Suppr` | Supprimer la sélection |
| `Ctrl+Z` / `Ctrl+Maj+Z` | Annuler / rétablir |
| `Ctrl+C` / `Ctrl+V` | Copier / coller à la tête de lecture |
| `Ctrl+D` | Dupliquer |
| `Ctrl+A` | Tout sélectionner |
| `R` | Enregistrer au micro |
| `Ctrl+S` | Enregistrer le projet |

Sur Mac, remplacez `Ctrl` par `⌘`.

## Où est enregistré mon travail ?

- Le montage est **gardé automatiquement** dans le navigateur, sur cet ordinateur : vous le
  retrouvez en rouvrant l'application (avec le même navigateur).
- Pour le garder ailleurs ou le transmettre, utilisez **Enregistrer** : vous obtenez un fichier
  `.montage` qui contient le projet **et** ses sons. Rouvrez-le avec **Ouvrir**, ou glissez-le
  dans la fenêtre.
- Rien n'est envoyé sur Internet : les sons sont lus et mélangés par votre navigateur.

## Limites connues

- Les sons sont décodés en mémoire : comptez environ 25 Mo de mémoire par minute de son stéréo.
  Quelques dizaines de minutes de sons passent sans souci ; au-delà d'une heure de sons cumulés,
  le navigateur peut ralentir.
- L'export MP3 d'un long montage prend un peu de temps (une barre de progression s'affiche).
- La version publiée en ligne sur claude.ai ne permet pas d'enregistrer au micro, et vous remet
  les fichiers exportés dans une archive `.zip`.

## Pour les développeurs

Aucune dépendance ni étape de compilation : HTML, CSS et JavaScript simples.

```
index.html          page principale
css/style.css       apparence (thème clair et sombre)
js/util.js          conversions dB, format du temps, outils DOM
js/store.js         état du projet, calculs de volume des morceaux, annuler/rétablir
js/audio.js         moteur audio (Web Audio) : écoute et rendu final
js/peaks.js         formes d'onde et mesures de niveau
js/formats.js       WAV, MP3, ZIP
js/persist.js       sauvegarde automatique (IndexedDB), fichiers projet, téléchargements
js/timeline.js      ligne de temps et manipulations à la souris
js/ui.js            menus, boîtes de dialogue, panneau du morceau
js/recorder.js      enregistrement au micro
js/demo.js          projet d'exemple synthétisé
js/main.js          démarrage, actions, clavier, import/export
vendor/lame.min.js  encodeur MP3 lamejs 1.2.1 (LGPL-3.0)
tools/build.mjs     assemble dist/montage-audio.html
```

- `npm test` : tests de la logique (Node 18 ou plus).
- `npm run test:browser` : tests dans Chromium (nécessite Playwright) ; ils vérifient notamment
  au millième près les niveaux du mixage final (volumes, fondus, courbes, effacement).
- `npm run build` : régénère `dist/montage-audio.html` après une modification.
