import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { db } from "./memory/db.js";
import { logger } from "./logger.js";

/**
 * Compétences — l'équivalent des Skills de Grok.
 *
 * Grok : « apprends-le une fois, il s'en souvient dans chaque conversation ».
 * Une compétence se crée en la décrivant dans la conversation, s'applique
 * d'elle-même quand la situation se présente, et une version personnelle
 * remplace toujours celle d'origine.
 *
 * Différence avec la mémoire : un FAIT dit ce qui est vrai (« Lionel vit à
 * Uppsala ») ; une COMPÉTENCE dit comment faire (« quand je demande un prix
 * sur 1688, convertis toujours en couronnes et ajoute les frais de port »).
 * Les mélanger, c'était ranger une recette dans un carnet d'adresses.
 *
 * Toutes les compétences actives sont lues à chaque message, bornées en
 * taille : au-delà, elles mangeraient le contexte du modèle à chaque tour.
 */

export type Competence = { nom: string; quand: string; instructions: string; actif: boolean; source: string; updated_at: string };

const NOM_RE = /^[\p{L}\p{N}][\p{L}\p{N} _'’-]{1,59}$/u;
export const INSTRUCTIONS_MAX = 3_000;
/** Plafond de ce qu'on injecte à chaque message, toutes compétences confondues. */
const INJECTION_MAX = 8_000;

function nomPropre(nom: string): string {
  const n = nom.trim().replace(/\s+/g, " ");
  if (!NOM_RE.test(n)) throw new Error(`nom de compétence invalide : « ${nom} » (2 à 60 caractères, lettres, chiffres, espaces, - et ')`);
  return n.toLowerCase();
}

export async function apprendre(a: { nom: string; quand: string; instructions: string; source?: string }): Promise<{ competence: Competence; remplacee: boolean }> {
  const nom = nomPropre(a.nom);
  const quand = a.quand.trim();
  const instructions = a.instructions.trim();
  if (quand.length < 3) throw new Error("dis QUAND l'appliquer (ex. « quand je demande un prix sur 1688 »)");
  if (instructions.length < 3) throw new Error("dis COMMENT faire");
  if (instructions.length > INSTRUCTIONS_MAX) throw new Error(`instructions trop longues (${instructions.length} caractères, ${INSTRUCTIONS_MAX} au plus)`);
  const r = await db().query<Competence & { cree: boolean }>(
    `INSERT INTO competences(nom, quand, instructions, source) VALUES ($1,$2,$3,$4)
     ON CONFLICT (nom) DO UPDATE SET quand=EXCLUDED.quand, instructions=EXCLUDED.instructions,
       source=EXCLUDED.source, actif=true, updated_at=now()
     RETURNING *, (xmax = 0) AS cree`,
    [nom, quand.slice(0, 300), instructions, a.source ?? "chat"],
  );
  const row = r.rows[0]!;
  logger.info({ nom, remplacee: !row.cree }, "compétence apprise");
  return { competence: row, remplacee: !row.cree };
}

export async function listerCompetences(): Promise<Competence[]> {
  return (await db().query<Competence>(`SELECT * FROM competences ORDER BY actif DESC, nom`)).rows;
}

export async function oublierCompetence(nom: string): Promise<boolean> {
  const r = await db().query(`DELETE FROM competences WHERE nom=$1`, [nom.trim().toLowerCase()]);
  return Boolean(r.rowCount);
}

export async function basculerCompetence(nom: string, actif: boolean): Promise<boolean> {
  const r = await db().query(`UPDATE competences SET actif=$2, updated_at=now() WHERE nom=$1`, [nom.trim().toLowerCase(), actif]);
  return Boolean(r.rowCount);
}

/**
 * Le bloc ajouté au prompt. Chaque compétence dit QUAND elle s'applique :
 * c'est au modèle de reconnaître la situation, exactement comme Grok les
 * applique « automatiquement ». Ce qui dépasse le plafond est annoncé, pas
 * coupé en silence — une compétence tronquée au milieu donnerait une
 * consigne fausse.
 */
export async function blocCompetences(): Promise<string> {
  const actives = (await listerCompetences().catch(() => [])).filter((c) => c.actif);
  if (!actives.length) return "";
  const lignes: string[] = [];
  let taille = 0;
  let omises = 0;
  for (const c of actives) {
    const l = `· « ${c.nom} » — quand : ${c.quand}\n  comment : ${c.instructions}`;
    if (taille + l.length > INJECTION_MAX) {
      omises++;
      continue;
    }
    lignes.push(l);
    taille += l.length;
  }
  return [
    "COMPÉTENCES — ce que Lionel t'a appris. Quand la situation correspond, applique la compétence sans qu'on te le redise. Elles priment sur tes habitudes.",
    ...lignes,
    omises ? `(${omises} compétence(s) de plus non chargée(s) faute de place : réduis-en sur le panneau.)` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export const outilsCompetences = [
  betaZodTool({
    name: "apprendre_competence",
    description:
      "Enregistre une façon de faire que Lionel veut que tu appliques désormais toute seule — « à partir de maintenant, quand… fais… », « retiens cette méthode », « sauvegarde ça comme compétence ». Donne-lui un nom court, dis QUAND elle s'applique et COMMENT. Même nom = la nouvelle version remplace l'ancienne. Pour un simple fait (« j'habite à Uppsala »), utilise plutôt remember_fact.",
    inputSchema: z.object({
      nom: z.string().min(2).max(60),
      quand: z.string().min(3).max(300).describe("La situation qui déclenche la compétence"),
      instructions: z.string().min(3).max(INSTRUCTIONS_MAX).describe("Ce qu'il faut faire, précisément"),
    }),
    run: async (i) => {
      const { competence, remplacee } = await apprendre({ ...i, source: "chat" });
      return `${remplacee ? "compétence remplacée" : "compétence apprise"} : « ${competence.nom} ». Elle s'applique dès le prochain message.`;
    },
  }),
  betaZodTool({
    name: "oublier_competence",
    description: "Supprime une compétence par son nom (« oublie la méthode pour… »).",
    inputSchema: z.object({ nom: z.string().min(2).max(60) }),
    run: async (i) => ((await oublierCompetence(i.nom)) ? `compétence « ${i.nom} » oubliée.` : `aucune compétence nommée « ${i.nom} ».`),
  }),
  betaZodTool({
    name: "lister_competences",
    description: "Liste les compétences que Lionel t'a apprises.",
    inputSchema: z.object({}),
    run: async () => {
      const l = await listerCompetences();
      return l.length ? l.map((c) => `« ${c.nom} »${c.actif ? "" : " (en pause)"} — quand : ${c.quand}`).join("\n") : "aucune compétence apprise pour l'instant";
    },
  }),
];
