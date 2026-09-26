/**
 * Graines de mémoire opérateur (playbooks).
 * Chemins = ceux déjà utilisés par runMission / reflect :
 *   /memories/playbooks/<mission>.md , /memories/playbooks/_global.md
 * Upsert : le contenu opérateur IPTV est autoritatif (écrase à chaque boot
 * uniquement les chemins listés ici — pas les playbooks appris par reflect).
 */
import { db } from "./db.js";

export const OPERATOR_SEED_FILES: Record<string, string> = {
  "/memories/playbooks/iptv_fleet.md": `# Flotte IPTV Lionel — playbook opérateur / Operator memory

## FR — Règles non négociables
- Soft-sell white-hat uniquement. Pas de pub agressive, pas de leads froids.
- WhatsApp défaut : +44 7307 410512 (https://wa.me/447307410512).
- Exception Toronto : site iptv-toronto.ca UNIQUEMENT → +1 807 788 8909.
- 0 AggregateRating / 0 fausses étoiles / 0 avis inventés.
- Aucun M3U public. Jamais de lien playlist en clair.
- Preuves curl (HTTP 200, contenu attendu) avant de déclarer « en ligne ».
- Chef de cabinet : POST https://manzi.7themotion.com/chat avec Bearer ORCHESTRATOR_TOKEN (token dans VPS ~/.env, jamais dans le dépôt).

## EN — Non-negotiables
- Soft-sell white-hat only. No hard ads, no cold leads.
- Default WA: +44 7307 410512 (https://wa.me/447307410512).
- Toronto exception: iptv-toronto.ca ONLY → +1 807 788 8909.
- Zero AggregateRating / fake stars / invented reviews.
- No public M3U. Never expose playlist links.
- curl proofs before claiming live.
- Chef de cabinet may POST /chat with Bearer ORCHESTRATOR_TOKEN (VPS .env only).

## Sites clés / Key sites
- worldiptv1.com
- iptv-toronto.ca (+1 807 788 8909 only)
- iptvnyc.us
- iptvforfirestickusa.com
- usatvs / usastream
- iptv-premium-deutschland.de
- testiptv24h.com
- premiumlatinoiptv.us

## Rôles flotte / Fleet roles
forum_builder · landing_crafter · scrape_factory · automation_smith · fleet_builder · grok_bot_mirror
`,

  "/memories/iptv/operator.md": `# IPTV — mémoire opérateur courte / short operator memory

FR: Soft-sell. WA +44 7307 410512 (wa.me/447307410512). Toronto iptv-toronto.ca → +1 807 788 8909 seulement. 0 AggregateRating. 0 M3U public. Sites: worldiptv1.com, iptv-toronto.ca, iptvnyc.us, iptvforfirestickusa.com, usatvs/usastream, iptv-premium-deutschland.de, testiptv24h.com, premiumlatinoiptv.us. Chef: Bearer ORCHESTRATOR_TOKEN sur POST /chat.

EN: Soft-sell. Default WA +44 7307 410512. Toronto site only +1 807 788 8909. No fake stars, no public M3U. Same key sites. Cabinet chef: Bearer ORCHESTRATOR_TOKEN on POST /chat.
`,

  "/memories/playbooks/_global.md": `# Playbooks globaux / Global playbooks

## IPTV flotte (prioritaire)
- Soft-sell only · WA +44 7307 410512 · Toronto (iptv-toronto.ca) only +1 807 788 8909
- 0 AggregateRating / fake stars · 0 public M3U · preuves curl
- Chef de cabinet: POST /chat + Bearer ORCHESTRATOR_TOKEN

## Transverse
- Une mission = un contrat. Pas de données inventées. Documenter les blocages.
`,
};

/** Soft paths: insert only if absent (préserve reflect). Hard paths: upsert opérateur. */
const SOFT_SEED = new Set(["/memories/playbooks/_global.md"]);

/** Insère/met à jour les graines opérateur. N'efface aucun autre fichier mémoire. */
export async function seedOperatorMemory(): Promise<number> {
  let n = 0;
  for (const [path, content] of Object.entries(OPERATOR_SEED_FILES)) {
    const body = content.trim() + "\n";
    if (SOFT_SEED.has(path)) {
      const r = await db().query(
        `INSERT INTO memory_files(path, content) VALUES ($1,$2)
         ON CONFLICT (path) DO NOTHING`,
        [path, body],
      );
      n += r.rowCount ?? 0;
    } else {
      await db().query(
        `INSERT INTO memory_files(path, content) VALUES ($1,$2)
         ON CONFLICT (path) DO UPDATE SET content=EXCLUDED.content, updated_at=now()`,
        [path, body],
      );
      n += 1;
    }
  }
  return n;
}
