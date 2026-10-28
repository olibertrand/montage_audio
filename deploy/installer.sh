#!/usr/bin/env bash
# Installe Montage Audio sur un serveur Debian ou Ubuntu, servi en HTTPS par Caddy.
#
# Utilisation, depuis le dossier du dépôt cloné sur le serveur :
#   sudo bash deploy/installer.sh montage.mon-domaine.fr
#
# Le domaine doit déjà pointer vers l'adresse IP du serveur (enregistrement DNS de type A).
# Pour les mises à jour suivantes, utilisez deploy/mettre-a-jour.sh.
set -euo pipefail

DOMAINE="${1:-}"
DOSSIER_SITE=/var/www/montage-audio
DEPOT="$(cd "$(dirname "$0")/.." && pwd)"
CONF=/etc/caddy/Caddyfile

erreur() {
  echo "Erreur : $*" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || erreur "lancez ce script en administrateur : sudo bash deploy/installer.sh $DOMAINE"
[ -n "$DOMAINE" ] || erreur "indiquez votre nom de domaine, par exemple : sudo bash deploy/installer.sh montage.mon-domaine.fr"
[[ "$DOMAINE" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ && "$DOMAINE" == *.* ]] || erreur "« $DOMAINE » n'est pas un nom de domaine valide."
[ -f "$DEPOT/dist/montage-audio.html" ] || erreur "fichier dist/montage-audio.html introuvable dans $DEPOT."
command -v apt-get >/dev/null || erreur "ce script est prévu pour Debian ou Ubuntu."

echo "== 1/4 Installation de Caddy"
if command -v caddy >/dev/null; then
  echo "Caddy est déjà installé ($(caddy version | cut -d' ' -f1))."
else
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  # Dépôt officiel de Caddy (versions à jour)
  if curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg \
    && curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' -o /etc/apt/sources.list.d/caddy-stable.list; then
    chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
    apt-get update
  else
    rm -f /etc/apt/sources.list.d/caddy-stable.list
    echo "Dépôt officiel injoignable : installation de la version fournie par le système."
  fi
  apt-get install -y caddy
fi

echo "== 2/4 Copie de l'application"
install -d -m 755 "$DOSSIER_SITE"
install -m 644 "$DEPOT/dist/montage-audio.html" "$DOSSIER_SITE/index.html"
install -d -o caddy -g caddy -m 755 /var/log/caddy

echo "== 3/4 Configuration de Caddy pour $DOMAINE"
NOUVELLE="$(mktemp)"
sed -e "s/montage\.example\.fr/$DOMAINE/" -e "s#/var/www/montage-audio#$DOSSIER_SITE#" "$DEPOT/deploy/Caddyfile" > "$NOUVELLE"
caddy validate --adapter caddyfile --config "$NOUVELLE" >/dev/null || erreur "la configuration générée est invalide ($NOUVELLE)."
# Toute configuration différente (par exemple avec d'autres sites ajoutés à la main) est sauvegardée.
if [ -f "$CONF" ] && ! cmp -s "$NOUVELLE" "$CONF"; then
  SAUVEGARDE="$CONF.sauvegarde.$(date +%Y%m%d-%H%M%S)"
  cp "$CONF" "$SAUVEGARDE"
  echo "L'ancienne configuration est sauvegardée dans $SAUVEGARDE"
  echo "(si vous y aviez ajouté d'autres sites, recopiez-les dans $CONF)"
fi
install -m 644 "$NOUVELLE" "$CONF"
rm -f "$NOUVELLE"
# La vérification ci-dessus, lancée en root, peut créer le fichier journal : on le rend à Caddy.
chown -R caddy:caddy /var/log/caddy
systemctl enable caddy >/dev/null 2>&1 || true
if systemctl is-active --quiet caddy; then ACTION=reload; else ACTION=start; fi
if ! systemctl "$ACTION" caddy; then
  journalctl -u caddy --no-pager -n 15 || true
  erreur "Caddy n'a pas pu appliquer la configuration (voir les messages ci-dessus)."
fi

echo "== 4/4 Pare-feu"
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  echo "Ports 80 et 443 ouverts dans ufw."
else
  echo "Pas de pare-feu ufw actif sur le serveur."
fi

echo
echo "C'est prêt : https://$DOMAINE"
echo "Le premier chargement peut prendre une minute, le temps que Caddy obtienne le certificat HTTPS."
echo "En cas de souci : journalctl -u caddy --no-pager -n 50"
