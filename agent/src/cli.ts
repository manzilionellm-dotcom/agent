import { logger } from "./logger.js";
import { migrate } from "./memory/migrate.js";
import { closeDb } from "./memory/db.js";
import { connectMcpServers, disconnectMcpServers } from "./mcp/registry.js";
import { MISSIONS, resolveMission } from "./missions/index.js";
import { buildAndDeliverReport } from "./missions/report.js";
import { launch } from "./scheduler.js";
import { runSwarm } from "./swarm/coordinator.js";
import { config } from "./config.js";
import { createVaultTicket } from "./vault.js";
import { runBctl } from "./tools/browser.js";
import { sendWhatsAppImage } from "./channels/whatsapp.js";

/**
 * Lancement manuel :
 *   npm run mission -- seo_daily
 *   npm run mission -- report
 *   npm run mission -- swarm "Relever les tarifs de 10 fournisseurs et mettre à jour le comparateur"
 * Indispensable pour tester sans attendre 6h30 du matin.
 */
const [name, ...rest] = process.argv.slice(2);
if (!name) {
  console.log("usage: mission <nom> | report | swarm \"<objectif>\" | vault-link [page] | test-capture [numéro]");
  console.log("missions:", MISSIONS.map((m) => `${m.name} (${m.cron})`).join(", "));
  process.exit(1);
}

(async () => {
  await migrate();
  // Fabriquer un lien n'a besoin ni des serveurs MCP ni de leurs journaux.
  // Les connecter coûtait trois secondes et noyait l'unique ligne utile —
  // l'adresse — sous des pages de JSON, au point qu'on la recopiait de
  // travers. Une commande dont la sortie est illisible est une commande
  // qu'on utilise mal.
  const leger = name === "vault-link" || name === "test-capture";
  if (!leger) await connectMcpServers();
  try {
    if (name === "vault-link") {
      // Lien à usage unique vers la page du coffre. Le jeton de l'API ne
      // circule plus dans une URL : celui-ci meurt à la première ouverture,
      // donc le recopier quelque part ne coûte rien.
      // `vault-link [page]` : coffre par défaut, mais la même porte sert
      // l'écran du navigateur et le tableau de bord. Un billet par page,
      // puisqu'un billet meurt à l'ouverture.
      const page = (rest[0] ?? "vault").replace(/^\//, "");
      if (!["vault", "screen", "board", "panel"].includes(page)) throw new Error(`page inconnue : ${page} (vault | screen | board | panel)`);
      const t = await createVaultTicket(10);
      const base = config().PUBLIC_URL ?? "http://127.0.0.1:8787";
      console.log(`\n  ${base}/${page}?t=${t.id}\n`);
      console.log(`  Valable jusqu'à ${t.expiresAt.toLocaleTimeString("fr-FR")}, une seule ouverture.`);
      if (!config().PUBLIC_URL) console.log(`  (PUBLIC_URL absente : passe par « ssh -L 8787:127.0.0.1:8787 manzi@… »)`);
    } else if (name === "test-capture") {
      // « Le screenshot ne marche pas » est un symptôme, pas un diagnostic :
      // la chaîne a quatre maillons (navigateur → fichier → téléversement →
      // envoi) et chacun casse pour une raison différente. Cette commande les
      // parcourt dans l'ordre et s'arrête au premier qui lâche, en le NOMMANT.
      const cfg = config();
      const to = rest[0] ?? cfg.WHATSAPP_ALLOWED_NUMBERS.split(",")[0]?.trim();
      if (!to) throw new Error("aucun numéro : passe-le en argument, ou renseigne WHATSAPP_ALLOWED_NUMBERS");
      if (cfg.WHATSAPP_PROVIDER !== "meta") throw new Error(`l'envoi d'image demande WHATSAPP_PROVIDER=meta (actuellement : ${cfg.WHATSAPP_PROVIDER})`);

      console.log("\n1/4  navigateur : ouverture de example.com");
      const nav = await runBctl("goto", JSON.stringify({ url: "https://example.com" }), undefined, cfg.BROWSER_CDP_URL);
      if (typeof nav === "string" || !nav.ok) throw new Error(`le navigateur ne répond pas : ${typeof nav === "string" ? nav : nav.error}`);
      console.log("     ok");

      console.log("2/4  capture");
      const shot = await runBctl("screenshot", JSON.stringify({}), undefined, cfg.BROWSER_CDP_URL);
      if (typeof shot === "string" || !shot.file) throw new Error(`capture impossible : ${typeof shot === "string" ? shot : shot.error}`);
      console.log(`     ok — ${shot.file}`);

      console.log(`3/4  téléversement chez Meta puis envoi à ${to}`);
      const env = await sendWhatsAppImage(to, String(shot.file), "Test d'envoi de capture — si tu vois cette image, la chaîne complète fonctionne.");
      if (!env.ok) throw new Error(env.error ?? "envoi refusé");
      console.log("     ok");

      console.log("4/4  regarde ton WhatsApp : l'image doit y être.\n");
    } else if (name === "report") {
      console.log(await buildAndDeliverReport());
    } else if (name === "swarm") {
      const objective = rest.join(" ").trim();
      if (objective.length < 10) throw new Error("objectif requis");
      const r = await runSwarm(objective);
      console.log(`\n=== PLAN ===\n${r.plan.subtasks.map((s) => `${s.id} [${s.role}] ${s.title}${s.depends_on.length ? ` ← ${s.depends_on.join(",")}` : ""}`).join("\n")}`);
      console.log(`\n=== SOUS-TÂCHES ===\n${r.results.map((x) => `${x.id} ${x.status} ${Math.round(x.seconds)}s ${x.usage.usd.toFixed(2)}$`).join("\n")}`);
      console.log(`\n=== LIVRABLE ===\n${r.merged}`);
      console.log(`\nTotal: ${r.totalUsd.toFixed(2)} USD, mur ${Math.round(r.wallSeconds)}s, séquentiel estimé ${Math.round(r.results.reduce((a, x) => a + x.seconds, 0))}s`);
    } else {
      const m = await resolveMission(name);
      if (!m) throw new Error(`mission inconnue: ${name}`);
      await launch(m);
    }
  } finally {
    if (!leger) await disconnectMcpServers();
    await closeDb();
  }
})().catch((err) => {
  logger.fatal({ err: String(err) }, "échec");
  process.exit(1);
});
