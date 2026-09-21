import { logger } from "./logger.js";
import { migrate } from "./memory/migrate.js";
import { closeDb } from "./memory/db.js";
import { connectMcpServers, disconnectMcpServers } from "./mcp/registry.js";
import { MISSIONS, resolveMission } from "./missions/index.js";
import { buildAndDeliverReport } from "./missions/report.js";
import { launch } from "./scheduler.js";
import { runSwarm } from "./swarm/coordinator.js";

/**
 * Lancement manuel :
 *   npm run mission -- seo_daily
 *   npm run mission -- report
 *   npm run mission -- swarm "Relever les tarifs de 10 fournisseurs et mettre à jour le comparateur"
 * Indispensable pour tester sans attendre 6h30 du matin.
 */
const [name, ...rest] = process.argv.slice(2);
if (!name) {
  console.log("usage: mission <nom> | report | swarm \"<objectif>\"");
  console.log("missions:", MISSIONS.map((m) => `${m.name} (${m.cron})`).join(", "));
  process.exit(1);
}

(async () => {
  await migrate();
  await connectMcpServers();
  try {
    if (name === "report") {
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
    await disconnectMcpServers();
    await closeDb();
  }
})().catch((err) => {
  logger.fatal({ err: String(err) }, "échec");
  process.exit(1);
});
