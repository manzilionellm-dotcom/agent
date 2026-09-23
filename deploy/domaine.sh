#!/usr/bin/env bash
# Donne à Manzi Junior une adresse FIXE, sur ton domaine.
#
#   ssh -t manzi@50.21.190.19 'cd manzi-junior && bash deploy/domaine.sh'
#
# Le `-t` n'est pas décoratif : sans terminal, la saisie masquée ci-dessous
# est impossible et le jeton finirait dans la ligne de commande.
#
# POURQUOI CE SCRIPT EXISTE
#
# Le tunnel « quick » tire un nom d'hôte au hasard à chaque redémarrage
# (« problems-gradually-colon-says.trycloudflare.com », puis un autre). Tout
# ce qui pointe dessus casse : les liens du bot, le webhook, un signet. Un
# tunnel NOMMÉ garde la même adresse pour toujours.
#
# POURQUOI IL DEMANDE LE JETON À L'ÉCRAN, ET PAS EN ARGUMENT
#
# Un argument de commande est lisible dans `ps aux` par tout utilisateur du
# serveur, reste dans /proc/<pid>/cmdline, et — passé par ssh depuis Windows —
# est écrit sur le disque par PSReadLine, en clair, dans l'historique. Ici il
# est lu au clavier, sans écho, et transmis à set-env.sh par l'entrée standard.
# Il ne passe par aucune ligne de commande.
#
# AVANT DE LANCER CE SCRIPT, dans Cloudflare :
#   1. dash.cloudflare.com → ton domaine doit y être (nameservers Cloudflare)
#   2. Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared
#   3. nomme-le « manzi », puis Save
#   4. onglet « Public Hostname » → Add a public hostname :
#        Subdomain : manzi          Domain : ton-domaine.com
#        Type : HTTP                URL : orchestrator:8787
#   5. copie le JETON affiché à l'étape « Install and run a connector »
#      (la longue chaîne après `--token`, pas la commande entière)
set -euo pipefail

DIR="${MANZI_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$DIR"

say() { printf '\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mERREUR: %s\033[0m\n' "$*" >&2; exit 1; }

[ -f .env ] || die "pas de .env dans $DIR"
[ -t 0 ] || die "pas de terminal — relance avec:  ssh -t manzi@50.21.190.19 'cd manzi-junior && bash deploy/domaine.sh'"

cat <<'EOF'

────────────────────────────────────────────────────────────────
ADRESSE FIXE POUR MANZI JUNIOR

Dans Cloudflare, avant de continuer :
  dash.cloudflare.com → Zero Trust → Networks → Tunnels
  → Create a tunnel → Cloudflared → nom « manzi » → Save
  → onglet Public Hostname → Add a public hostname :
       Subdomain : manzi     Domain : ton-domaine.com
       Type : HTTP           URL : orchestrator:8787

Puis copie le JETON (la longue chaîne après --token).
────────────────────────────────────────────────────────────────

EOF

printf 'Colle le jeton du tunnel (rien ne s'"'"'affiche, c'"'"'est normal) : '
IFS= read -rs JETON || true
printf '\n\n'
JETON=${JETON%$'\r'}
JETON=$(printf '%s' "$JETON" | tr -d '[:space:]')

[ -n "$JETON" ] || die "aucun jeton saisi"

# Une erreur de copier-coller fréquente : coller la COMMANDE entière au lieu
# du seul jeton. Le tunnel démarrerait puis s'arrêterait, avec un message que
# personne ne relie au collage.
case "$JETON" in
  *cloudflared*|*--token*|*docker*)
    die "on dirait la commande entière, pas le jeton. Ne garde que la longue chaîne qui suit « --token »." ;;
esac
[ "${#JETON}" -ge 60 ] || die "jeton trop court (${#JETON} caractères) — un jeton de tunnel en fait plusieurs centaines"

printf 'CLOUDFLARE_TUNNEL_TOKEN=%s\n' "$JETON" | bash "$DIR/deploy/set-env.sh" --stdin
unset JETON

# Le tunnel jetable doit disparaître, sinon deux tunnels servent la même
# application et l'adresse qui répond dépend de l'ordre de démarrage.
say "arrêt du tunnel jetable"
docker compose -f docker-compose.yml -f docker-compose.eco.yml --profile tunnel-quick rm -sf tunnel-quick >/dev/null 2>&1 || true

# whatsapp-up.sh bascule seul sur le profil « tunnel » dès que le jeton est
# présent, lit le nom d'hôte que Cloudflare envoie au connecteur, l'écrit dans
# PUBLIC_URL, recrée l'orchestrateur et redéclare le webhook à Meta.
say "démarrage du tunnel nommé et redéclaration du webhook"
bash "$DIR/deploy/whatsapp-up.sh"

PUBLIC=$(grep -E '^PUBLIC_URL=' .env | head -1 | cut -d= -f2- | tr -d '"\r')
cat <<EOF

────────────────────────────────────────────────────────────────
ADRESSE FIXE EN PLACE

  $PUBLIC

Elle ne changera plus, même après un redémarrage. Mets-la en signet.

  $PUBLIC/panel     clés d'API, consommation, plafond
  $PUBLIC/board     tableau de bord
  $PUBLIC/vault     coffre d'identifiants
  $PUBLIC/screen    écran du navigateur du serveur

Pour entrer : $PUBLIC/login et ton mot de passe. Pas encore de mot de
passe ? Entre une première fois avec un lien du bot (« envoie-moi le lien
du panneau »), puis définis-le dans la section « Accès depuis n'importe où ».
────────────────────────────────────────────────────────────────
EOF
