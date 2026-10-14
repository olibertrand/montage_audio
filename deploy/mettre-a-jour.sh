#!/usr/bin/env bash
# Met à jour Montage Audio sur le serveur : récupère la dernière version du dépôt et la met en ligne.
#
# Utilisation, depuis n'importe où sur le serveur :
#   sudo bash /opt/montage-audio/deploy/mettre-a-jour.sh
set -euo pipefail

DOSSIER_SITE=/var/www/montage-audio
DEPOT="$(cd "$(dirname "$0")/.." && pwd)"

[ "$(id -u)" -eq 0 ] || { echo "Erreur : lancez ce script en administrateur (sudo)." >&2; exit 1; }
[ -d "$DOSSIER_SITE" ] || { echo "Erreur : l'application n'est pas installée. Lancez d'abord deploy/installer.sh." >&2; exit 1; }

git -C "$DEPOT" pull --ff-only
install -m 644 "$DEPOT/dist/montage-audio.html" "$DOSSIER_SITE/index.html"
echo "Mise à jour terminée ($(git -C "$DEPOT" log -1 --format='%h, %cd' --date=short))."
echo "Les utilisateurs auront la nouvelle version en rechargeant la page."
