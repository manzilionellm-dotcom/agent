import { readFile } from "node:fs/promises";
import { z } from "zod";
import { config } from "../config.js";
import { structured, resolveModel } from "../llm.js";
import { logger } from "../logger.js";
import { migrate } from "../memory/migrate.js";
import { closeDb, db } from "../memory/db.js";
import { connectMcpServers, disconnectMcpServers } from "../mcp/registry.js";
import { handleChat } from "../channels/chat.js";
import { resolveMission, runMission } from "../missions/index.js";

/**
 * Mesure : rejoue les cas de evals/cases.json, note chaque sortie contre ses critères
 * (juge structuré, effort bas), imprime un tableau et enregistre le run (eval_runs).
 * C'est la seule façon de savoir si un changement de prompt, de modèle ou de playbook
 * rend le bot meilleur ou pire. À lancer avant/après chaque changement.
 *
 *   npm run eval                 # tous les cas
 *   npm run eval -- chat_        # seulement les cas dont le nom commence par chat_
 */

const Case = z.object({
  name: z.string(),
  kind: z.enum(["chat", "mission"]),
  input: z.string(),
  criteria: z.array(z.string()).min(1),
});
const File = z.object({ cases: z.array(Case) });

type Result = { name: string; kind: string; score: number; pass: boolean; usd: number; seconds: number; issues: string[] };

async function judge(c: z.infer<typeof Case>, output: string): Promise<{ score: number; pass: boolean; issues: string[]; usd: number }> {
  const { value, usd } = await structured<{ score: number; pass: boolean; issues: string[] }>({
    ...resolveModel("worker"),
    effort: "low",
    system:
      "Tu es un évaluateur strict. Note de 0 à 10 dans quelle mesure la SORTIE satisfait CHACUN des critères. Un critère non satisfait coûte au moins 3 points. pass = tous les critères essentiels satisfaits (score ≥ 7). issues = critères non satisfaits, une ligne chacun.",
    schema: {
      type: "json_schema",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["score", "pass", "issues"],
        properties: { score: { type: "integer", minimum: 0, maximum: 10 }, pass: { type: "boolean" }, issues: { type: "array", items: { type: "string" } } },
      },
    },
    prompt: `<entree>\n${c.input}\n</entree>\n<criteres>\n${c.criteria.map((x) => `- ${x}`).join("\n")}\n</criteres>\n<sortie>\n${output.slice(0, 12_000) || "(vide)"}\n</sortie>`,
  });
  return { ...value, usd };
}

async function main(): Promise<void> {
  const filter = process.argv[2] ?? "";
  const file = File.parse(JSON.parse(await readFile(new URL("../../evals/cases.json", import.meta.url), "utf8")));
  const cases = file.cases.filter((c) => c.name.startsWith(filter));
  if (!cases.length) throw new Error("aucun cas");
  await migrate();
  await connectMcpServers();
  const results: Result[] = [];
  try {
    for (const c of cases) {
      const t0 = Date.now();
      let output = "";
      let usd = 0;
      try {
        if (c.kind === "chat") {
          output = await handleChat({ channel: "api", peer: `eval:${c.name}`, text: c.input });
        } else {
          const m = await resolveMission(c.input);
          if (!m) throw new Error(`mission inconnue: ${c.input}`);
          const r = await runMission(m);
          output = r.text;
          usd += r.usage.usd;
        }
      } catch (e) {
        output = `ERREUR: ${String(e)}`;
      }
      const j = await judge(c, output);
      const res: Result = { name: c.name, kind: c.kind, score: j.score, pass: j.pass, usd: usd + j.usd, seconds: (Date.now() - t0) / 1000, issues: j.issues };
      results.push(res);
      console.log(`${res.pass ? "PASS" : "FAIL"} ${res.score}/10  ${res.name}  ${Math.round(res.seconds)}s  ${res.usd.toFixed(3)}$${res.issues.length ? `\n     - ${res.issues.join("\n     - ")}` : ""}`);
    }
    const passed = results.filter((r) => r.pass).length;
    const avg = results.reduce((a, r) => a + r.score, 0) / results.length;
    const usd = results.reduce((a, r) => a + r.usd, 0);
    await db().query(`INSERT INTO eval_runs(cases, passed, avg_score, usd, details) VALUES ($1,$2,$3,$4,$5)`, [results.length, passed, avg.toFixed(2), usd, JSON.stringify(results)]);
    const prev = await db().query<{ passed: number; cases: number; avg_score: string; ran_at: string }>(`SELECT passed, cases, avg_score, ran_at::text FROM eval_runs ORDER BY id DESC OFFSET 1 LIMIT 1`);
    console.log(`\n=== ${passed}/${results.length} PASS · moyenne ${avg.toFixed(1)}/10 · ${usd.toFixed(2)} $ · provider ${config().LLM_PROVIDER}`);
    if (prev.rows[0]) console.log(`    run précédent (${prev.rows[0].ran_at.slice(0, 16)}) : ${prev.rows[0].passed}/${prev.rows[0].cases} PASS · ${Number(prev.rows[0].avg_score).toFixed(1)}/10`);
  } finally {
    await disconnectMcpServers();
    await closeDb();
  }
}

main().catch((e) => {
  logger.fatal({ err: String(e) }, "eval");
  process.exit(1);
});
