import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { db } from "./memory/db.js";
import { logger } from "./logger.js";
import { setting } from "./providers.js";

/**
 * Ce que le bot sait de Lionel — visible, et effaçable.
 *
 * Grok a rendu sa mémoire consultable et oubliable (Réglages → Mémoire, et
 * « Oublier » à côté de chaque souvenir). Ici le bot retenait déjà : des
 * faits (`facts`) et un profil (`/memories/profil`) injecté dans chaque
 * conversation. Mais rien ne permettait de les VOIR, ni d'en retirer un.
 * Une mémoire qu'on ne peut ni lire ni corriger finit par contenir une
 * erreur qu'il répète pour toujours.
 *
 * Deux portes, comme chez Grok : le panneau (liste, un bouton par souvenir)
 * et la conversation (« oublie que… »). Plus un interrupteur : mémoire
 * coupée, il ne retient plus rien et ne s'appuie plus sur son profil.
 */

const PROFIL = "/memories/profil";

export type Fait = { id: number; topic: string; fact: string; created_at: string; source_url: string | null };
export type FichierProfil = { path: string; content: string; updated_at: string };

export async function memoireActive(): Promise<boolean> {
  return (await setting("MEMOIRE").catch(() => undefined)) !== "off";
}

export async function listerFaits(limite = 200): Promise<Fait[]> {
  const r = await db().query<Fait>(
    `SELECT id, topic, fact, created_at, source_url FROM facts
      WHERE expires_at IS NULL OR expires_at > now()
      ORDER BY created_at DESC LIMIT $1`,
    [limite],
  );
  return r.rows.map((f) => ({ ...f, id: Number(f.id) }));
}

export async function listerProfil(): Promise<FichierProfil[]> {
  const r = await db().query<FichierProfil>(
    `SELECT path, content, updated_at FROM memory_files WHERE path = $1 OR path LIKE $1 || '/%' ORDER BY path`,
    [PROFIL],
  );
  return r.rows;
}

export async function oublierFait(id: number): Promise<boolean> {
  const r = await db().query(`DELETE FROM facts WHERE id=$1`, [id]);
  return Boolean(r.rowCount);
}

/** Uniquement sous /memories/profil : le panneau n'efface pas les notes de travail des missions. */
export async function oublierFichierProfil(path: string): Promise<boolean> {
  if (path !== PROFIL && !path.startsWith(`${PROFIL}/`)) return false;
  const r = await db().query(`DELETE FROM memory_files WHERE path=$1`, [path]);
  return Boolean(r.rowCount);
}

export async function oublierTout(): Promise<{ faits: number; profil: number }> {
  const f = await db().query(`DELETE FROM facts`);
  const p = await db().query(`DELETE FROM memory_files WHERE path = $1 OR path LIKE $1 || '/%'`, [PROFIL]);
  logger.warn({ faits: f.rowCount, profil: p.rowCount }, "mémoire effacée entièrement sur ordre");
  return { faits: f.rowCount ?? 0, profil: p.rowCount ?? 0 };
}

/**
 * « Oublie que j'habite à Uppsala » : on retire les faits qui correspondent,
 * et les LIGNES du profil qui les contiennent — pas le fichier entier, qui
 * porte d'autres choses justes.
 *
 * La recherche est la même que celle de recall_facts (plein texte) : ce que
 * le bot sait retrouver, il sait l'oublier. On rend ce qui a été effacé, mot
 * pour mot, pour que Lionel voie qu'on n'a pas tapé à côté.
 */
export async function oublierCeQuiParleDe(quoi: string): Promise<string[]> {
  const q = quoi.trim();
  if (q.length < 3) throw new Error("précise ce qu'il faut oublier (au moins 3 caractères)");
  const effaces: string[] = [];
  const f = await db().query<{ fact: string }>(
    `DELETE FROM facts WHERE tsv @@ websearch_to_tsquery('simple', $1) OR fact ILIKE '%' || $1 || '%' RETURNING fact`,
    [q],
  );
  effaces.push(...f.rows.map((x) => x.fact));

  const mots = q.toLowerCase().split(/\s+/).filter((m) => m.length >= 3);
  for (const fichier of await listerProfil()) {
    const lignes = fichier.content.split("\n");
    const gardees = lignes.filter((l) => {
      const bas = l.toLowerCase();
      const touche = bas.includes(q.toLowerCase()) || (mots.length > 0 && mots.every((m) => bas.includes(m)));
      if (touche && l.trim()) effaces.push(l.trim());
      return !touche;
    });
    if (gardees.length !== lignes.length) {
      await db().query(`UPDATE memory_files SET content=$2, updated_at=now() WHERE path=$1`, [fichier.path, gardees.join("\n")]);
    }
  }
  logger.info({ quoi: q, n: effaces.length }, "souvenirs oubliés sur ordre");
  return effaces;
}

export const oublierTool = betaZodTool({
  name: "oublier",
  description:
    "Efface de ta mémoire ce qui parle d'un sujet (faits retenus ET lignes du profil). Quand Lionel dit « oublie que… », « efface ce que tu sais sur… », « ce n'est plus vrai que… ». Tu confirmes en citant ce qui a été effacé.",
  inputSchema: z.object({ quoi: z.string().min(3).describe("Le sujet ou la phrase à oublier, ex : « Uppsala », « mon numéro de téléphone »") }),
  run: async (i) => {
    const e = await oublierCeQuiParleDe(i.quoi);
    return e.length ? `oublié (${e.length}) :\n${e.slice(0, 15).map((x) => `- ${x}`).join("\n")}` : `rien en mémoire ne parle de « ${i.quoi} ».`;
  },
});
