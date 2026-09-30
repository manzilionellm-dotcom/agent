/**
 * Contrat de la mémoire de mission.
 *
 * Deux groupes :
 *   - toujours : ce qui ne demande aucune base (les chemins).
 *   - TEST_DATABASE_URL : le comportement réel contre un vrai Postgres.
 *
 * Sans TEST_DATABASE_URL, le second groupe est SAUTÉ, pas silencieusement
 * réussi — `node:test` affiche « skipped », on voit donc qu'il n'a pas tourné.
 *
 *   TEST_DATABASE_URL=postgres://manzi:motdepasse@localhost:5432/manzi_test npm test
 *
 * Les migrations sont jouées par la suite elle-même : une base vide suffit.
 * Chaque exécution utilise un préfixe de mission unique et nettoie derrière
 * elle, donc la suite est rejouable et ne pollue pas une base de travail.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

const TEST_DB = process.env.TEST_DATABASE_URL;

/*
 * Posé AVANT le premier config() — qui met son résultat en cache au premier
 * appel. config() valide TOUTE la configuration d'un coup (fail-fast voulu),
 * donc une suite qui ne touche que la mémoire doit quand même satisfaire les
 * trois champs obligatoires du schéma, plus la clé exigée par le fournisseur
 * anthropic. Aucune n'est utilisée ici : rien n'appelle le réseau.
 */
process.env.DATABASE_URL = TEST_DB ?? "postgres://unused:unused@127.0.0.1:1/unused";
process.env.GITHUB_TOKEN ??= "test-token-non-utilise";
process.env.GITHUB_REPO ??= "test/non-utilise";
process.env.ANTHROPIC_API_KEY ??= "test-key-non-utilisee";

const { missionRunPath, readMissionMemory, writeMissionMemory, memoryDigest } = await import("./store.js");

/* --------------------------------------------------------------- sans base */

describe("chemins", () => {
  it("range les passages hors de /memories, pour qu'ils échappent au digest", () => {
    const p = missionRunPath("veille");
    assert.equal(p, "/runs/veille/last_run.md");
    assert.ok(!p.startsWith("/memories"), "un passage sous /memories entrerait dans memoryDigest");
  });

  it("garde le « : » des clés d'essaim et neutralise le reste", () => {
    assert.equal(missionRunPath("swarm:coder"), "/runs/swarm:coder/last_run.md");
    // Une barre oblique dans un nom de mission créerait un faux sous-dossier.
    assert.equal(missionRunPath("a/b ../c"), "/runs/a_b_.._c/last_run.md");
  });
});

/* ------------------------------------------------------- avec TEST_DATABASE_URL */

describe("mémoire de mission (Postgres)", { skip: TEST_DB ? false : "TEST_DATABASE_URL non défini" }, () => {
  const mission = `test:mem:${process.pid}:${Date.now()}`;
  let db: typeof import("./db.js");

  before(async () => {
    db = await import("./db.js");
    const { migrate } = await import("./migrate.js");
    await migrate();
  });

  after(async () => {
    await db.db().query(`DELETE FROM memory_files WHERE path LIKE '/runs/test:%'`);
    await db.db().query(`DELETE FROM episodes WHERE mission LIKE 'test:%'`);
    await db.closeDb();
  });

  it("relit ce qui vient d'être écrit", async () => {
    await writeMissionMemory(mission, { status: "ok", summary: "article publié, URL vérifiée 200", usd: 1.23 });
    const out = await readMissionMemory(mission);
    assert.match(out, /^<passage_precedent>/);
    assert.match(out, /article publié, URL vérifiée 200/);
    assert.match(out, /statut: ok/);
    assert.match(out, /1\.23 USD/);
  });

  it("remplace le passage précédent au lieu d'en empiler un second", async () => {
    await writeMissionMemory(mission, { status: "ok", summary: "PREMIER", usd: 1 });
    await writeMissionMemory(mission, { status: "ok", summary: "SECOND", usd: 2 });
    const rows = await db.db().query<{ content: string }>(`SELECT content FROM memory_files WHERE path = $1`, [
      missionRunPath(mission),
    ]);
    assert.equal(rows.rowCount, 1, "un chemin doit rester une seule ligne");
    assert.match(rows.rows[0]!.content, /SECOND/);
    assert.doesNotMatch(rows.rows[0]!.content, /PREMIER/);
  });

  it("mémorise un échec avec sa cause", async () => {
    await writeMissionMemory(mission, { status: "failed", summary: "", usd: 0, error: "ECONNREFUSED chez le fournisseur" });
    const out = await readMissionMemory(mission);
    assert.match(out, /statut: failed/);
    assert.match(out, /ECONNREFUSED chez le fournisseur/);
  });

  it("relit les 3 derniers épisodes terminés, pas le quatrième", async () => {
    for (const n of [1, 2, 3, 4]) {
      await db.db().query(
        `INSERT INTO episodes(mission, status, summary, usd, finished_at)
         VALUES ($1, 'ok', $2, 0.1, now() - ($3 || ' minutes')::interval)`,
        [mission, `episode-${n}`, String(10 - n)], // n=4 le plus récent
      );
    }
    const out = await readMissionMemory(mission);
    for (const n of [4, 3, 2]) assert.match(out, new RegExp(`episode-${n}`), `episode-${n} attendu`);
    assert.doesNotMatch(out, /episode-1/, "le 4e plus récent ne doit pas remonter");
  });

  it("ignore un épisode encore en cours", async () => {
    await db.db().query(`INSERT INTO episodes(mission, status, summary) VALUES ($1, 'running', 'episode-en-cours')`, [mission]);
    const out = await readMissionMemory(mission);
    assert.doesNotMatch(out, /episode-en-cours/, "un épisode non terminé n'a rien à raconter");
  });

  it("ne fuit pas dans memoryDigest", async () => {
    await writeMissionMemory(mission, { status: "ok", summary: "SECRET-DE-PASSAGE", usd: 0 });
    const digest = await memoryDigest();
    assert.doesNotMatch(digest, /SECRET-DE-PASSAGE/, "le passage n'appartient pas au digest /memories");
    assert.doesNotMatch(digest, /\/runs\//, "aucun chemin /runs ne doit apparaître dans le digest");
  });

  it("rend une chaîne vide pour une mission jamais exécutée", async () => {
    const out = await readMissionMemory(`test:mem:jamais:${Date.now()}`);
    assert.equal(out, "", "pas de balise orpheline dans le prompt quand il n'y a rien à dire");
  });

  /**
   * Base en panne : testé dans un PROCESSUS SÉPARÉ, parce que `config()` met sa
   * valeur en cache au premier appel — on ne peut pas faire tomber l'URL en
   * cours de route sans fausser les autres tests. Le fils pointe sur un port
   * mort et doit malgré tout rendre "" et ne rien lever.
   */
  it("ne lève jamais quand la base est injoignable", () => {
    const storeUrl = new URL("./store.js", import.meta.url).href;
    const script = `
      const { readMissionMemory, writeMissionMemory } = await import(${JSON.stringify(storeUrl)});
      await writeMissionMemory("test:mem:panne", { status: "ok", summary: "x", usd: 0 });
      const out = await readMissionMemory("test:mem:panne");
      if (out !== "") { console.error("attendu vide, reçu:", out); process.exit(2); }
      process.exit(0);
    `;
    const res = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: {
        ...process.env,
        DATABASE_URL: "postgres://nobody:nobody@127.0.0.1:1/nothing",
        LOG_LEVEL: "error",
      },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(res.status, 0, `le fils a échoué (${res.status}):\n${res.stderr}`);
  });
});
