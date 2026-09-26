#!/usr/bin/env bash
# Voix gratuite : Manzi Junior répond en notes vocales, sans clé ni coût par message.
#
#   ssh manzi@50.21.190.19 'cd manzi-junior && git pull -q && bash deploy/voix-gratuite.sh'
#
# Ce que fait ce script, dans l'ordre :
#   1. vérifie qu'il reste assez de mémoire (la voix prend ~400 Mo) ;
#   2. construit et démarre le conteneur « voix » (Kokoro ONNX, 5 à 10 min la
#      première fois : il télécharge le modèle, 120 Mo) ;
#   3. l'enregistre au panneau comme service « voix », en remplaçant une
#      éventuelle voix payante (OpenAI) — l'ancienne carte est désactivée,
#      pas supprimée ;
#   4. règle le bot : il répond en vocal quand Lionel lui parle en vocal ;
#   5. vérifie de bout en bout qu'une note vocale sort.
#
# Pour revenir à une voix payante : panneau → Voix, ou `bash deploy/voix-gratuite.sh --retirer`.
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE=(docker compose -f docker-compose.yml)
[ -f docker-compose.eco.yml ] && COMPOSE+=(-f docker-compose.eco.yml)
say() { printf '\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mERREUR: %s\033[0m\n' "$*" >&2; exit 1; }

orch_node() {
  "${COMPOSE[@]}" exec -T orchestrator node --input-type=module -e "$1"
}

if [ "${1:-}" = "--retirer" ]; then
  say "arrêt de la voix gratuite"
  "${COMPOSE[@]}" --profile voix stop voix >/dev/null 2>&1 || true
  orch_node 'const p = await import("/app/dist/providers.js"); await p.setProviderEnabled("voix", false); console.log("  service voix désactivé au panneau (réactive-le ou mets une autre voix dans la section Voix)"); process.exit(0);'
  exit 0
fi

# 1. Mémoire. « available » compte ce que le système peut rendre tout de
#    suite (cache compris) : c'est la bonne mesure, « free » sous-estime.
DISPO=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
say "mémoire disponible : ${DISPO} Mo"
if [ "${DISPO}" -lt 500 ] && [ "${FORCER:-}" != "1" ]; then
  die "moins de 500 Mo libres : la voix risquerait de faire manquer de mémoire le navigateur ou la base. Libère de la place, ou relance avec FORCER=1 devant la commande si tu sais ce que tu fais."
fi

# 2. Conteneur.
say "construction de la voix (la première fois : 5 à 10 minutes)"
"${COMPOSE[@]}" --profile voix up -d --build voix 2>&1 | tail -3
say "attente du démarrage"
for i in $(seq 1 60); do
  if "${COMPOSE[@]}" exec -T orchestrator curl -fsS --max-time 3 http://voix:8880/health >/dev/null 2>&1; then break; fi
  sleep 2
  [ "$i" = 60 ] && die "la voix ne répond pas. Journal : ${COMPOSE[*]} --profile voix logs --tail 30 voix"
done

# 3 et 4. Panneau et réglages, par le code de l'orchestrateur lui-même.
say "branchement au panneau"
orch_node '
const p = await import("/app/dist/providers.js");
const { decryptSecret } = await import("/app/dist/vault.js");
const ancien = await p.getProvider("voix");
if (ancien && !/voix:8880/.test(ancien.base_url || "")) {
  // Une voix payante existait : on garde sa carte sous un autre nom, désactivée.
  await p.putProvider({ id: "voix-payante", category: "autre", label: (ancien.label || "Voix") + " (ancienne)", kind: ancien.kind, baseUrl: ancien.base_url, model: ancien.model, apiKey: ancien.api_key ? decryptSecret(ancien.api_key) : undefined, enabled: false, priority: ancien.priority, roles: [], note: "remplacée par la voix gratuite le " + new Date().toLocaleDateString("fr-FR") + " — sa clé est gardée sur cette carte" });
  console.log("  ancienne voix mise de côté (carte « voix-payante », désactivée)");
}
await p.putProvider({ id: "voix", category: "autre", label: "Voix gratuite (Kokoro, sur le serveur)", kind: "openai_compat", baseUrl: "http://voix:8880/v1", model: "kokoro", apiKey: "local", enabled: true, priority: 10, roles: [], note: "gratuit · voix française ff_siwis · rien ne sort du serveur" });
await p.setSetting("VOIX_NOM", "ff_siwis");
const mode = await p.setting("VOIX_MODE");
if (!mode || mode === "off") await p.setSetting("VOIX_MODE", "si_vocal");
const t = await p.testProvider("voix");
console.log("  test du service : " + (t.ok ? "OK" : "ÉCHEC") + " — " + t.message);
const v = await import("/app/dist/voice.js");
const debut = Date.now();
const son = await v.synthese("Salut Lionel, c’est ta nouvelle voix, gratuite, qui tourne sur ton serveur.");
console.log("  note vocale de test : " + son.length + " octets en " + ((Date.now() - debut) / 1000).toFixed(1) + " s, format " + (son.subarray(0, 4).toString() === "OggS" ? "OGG/Opus (WhatsApp) ✓" : "INATTENDU"));
process.exit(0);
'

MEM=$(docker stats --no-stream --format '{{.MemUsage}}' manzi-voix 2>/dev/null || echo "?")
cat <<EOF

────────────────────────────────────────────────────────────────
VOIX GRATUITE EN PLACE   (mémoire utilisée : ${MEM})

Envoie-lui un vocal sur WhatsApp : il répond en vocal.
Pour qu'il parle à chaque fois : écris-lui « réponds toujours en vocal ».
Pour arrêter : « arrête les vocaux ».
Panneau → Voix → « Envoyer une note de test » pour l'écouter.
────────────────────────────────────────────────────────────────
EOF
