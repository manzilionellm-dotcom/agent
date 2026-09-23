import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { Cron } from "croner";
import { z } from "zod";
import { config } from "./config.js";
import { db } from "./memory/db.js";
import { logger } from "./logger.js";

/**
 * Rappels et tâches planifiées — l'équivalent de Grok Tasks.
 *
 * Grok permet de « planifier n'importe quelle demande » : une fois, ou tous
 * les jours, toutes les semaines, avec un rythme de type cron. Ici le bot ne
 * savait planifier que des MISSIONS, c'est-à-dire des travaux qu'on avait
 * d'abord dû créer. « Rappelle-moi demain à 9 h de payer IONOS » ou « chaque
 * matin, dis-moi le prix du Titan Gel sur DHgate » n'avaient pas de place.
 *
 * Deux sortes :
 *   rappel — le texte est envoyé tel quel à l'heure dite. Aucun modèle,
 *            aucun coût : c'est une alarme.
 *   tache  — le texte est une DEMANDE, exécutée par le bot à l'heure dite
 *            avec tous ses outils, et le résultat arrive sur WhatsApp.
 *
 * Les heures sont celles de Lionel (fuseau TZ), changements d'heure compris :
 * c'est croner qui interprète « 2026-12-24T09:00 » dans ce fuseau, vérifié
 * hiver (UTC+1) comme été (UTC+2).
 */

export type Rappel = {
  id: number;
  peer: string;
  type: "rappel" | "tache";
  quoi: string;
  cron: string | null;
  prochain: string | null;
  actif: boolean;
  executions: number;
  derniere: string | null;
  dernier_resultat: string | null;
  created_at: string;
};

const QUOI_MAX = 1_000;

/** Prochaine échéance, ou une erreur qui dit précisément ce qui cloche dans la saisie. */
export function prochaineEcheance(opts: { quand?: string; cron?: string }, apres = new Date()): Date {
  const tz = config().TZ;
  if (Boolean(opts.quand) === Boolean(opts.cron)) throw new Error("donne SOIT une date (quand), SOIT un rythme (cron) — pas les deux, pas aucun");
  const motif = opts.quand?.trim() ?? opts.cron!.trim();
  // Une date doit être locale et sans fuseau : « 2026-09-24T09:00 ». Un « Z »
  // ou un décalage ferait lire l'heure en UTC et le rappel sonnerait une ou
  // deux heures à côté — l'erreur la plus facile à commettre en recopiant.
  if (opts.quand && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(motif)) {
    throw new Error(`date attendue au format local AAAA-MM-JJTHH:MM (heure de ${tz}), reçu « ${motif} »`);
  }
  let c: Cron;
  try {
    c = new Cron(opts.quand ? (motif.length === 16 ? `${motif}:00` : motif) : motif, { timezone: tz, paused: true });
  } catch (e) {
    throw new Error(`rythme illisible « ${motif} » : ${String((e as Error).message).slice(0, 120)}`);
  }
  const n = c.nextRun(apres);
  c.stop();
  if (!n) throw new Error(opts.quand ? `« ${motif} » est déjà passé (heure de ${tz})` : `le rythme « ${motif} » ne revient jamais`);
  return n;
}

export async function planifier(a: { peer: string; type: "rappel" | "tache"; quoi: string; quand?: string; cron?: string }): Promise<Rappel> {
  const quoi = a.quoi.trim();
  if (!quoi) throw new Error("rien à rappeler");
  if (quoi.length > QUOI_MAX) throw new Error(`texte trop long (${quoi.length} caractères, ${QUOI_MAX} au plus)`);
  const n = prochaineEcheance({ quand: a.quand, cron: a.cron });
  const r = await db().query<Rappel>(
    `INSERT INTO rappels(peer, type, quoi, cron, prochain) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [a.peer, a.type, quoi, a.cron?.trim() || null, n],
  );
  return norm(r.rows[0]!);
}

function norm(r: Rappel): Rappel {
  return { ...r, id: Number(r.id), executions: Number(r.executions) };
}

export async function listerRappels(opts: { peer?: string; tous?: boolean } = {}): Promise<Rappel[]> {
  const r = await db().query<Rappel>(
    `SELECT * FROM rappels WHERE ($1::text IS NULL OR peer=$1) AND ($2 OR actif) ORDER BY actif DESC, prochain NULLS LAST, id DESC LIMIT 200`,
    [opts.peer ?? null, Boolean(opts.tous)],
  );
  return r.rows.map(norm);
}

export async function annulerRappel(id: number, peer?: string): Promise<boolean> {
  const r = await db().query(`UPDATE rappels SET actif=false, prochain=NULL WHERE id=$1 AND ($2::text IS NULL OR peer=$2) AND actif`, [id, peer ?? null]);
  return Boolean(r.rowCount);
}

export async function supprimerRappel(id: number): Promise<boolean> {
  const r = await db().query(`DELETE FROM rappels WHERE id=$1`, [id]);
  return Boolean(r.rowCount);
}

/** Heure lisible pour Lionel, dans son fuseau. */
export function heureLocale(d: string | Date | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("fr-FR", { timeZone: config().TZ, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/* --- Exécution ------------------------------------------------------------ */

export type Executeur = (r: Rappel) => Promise<string>;

/**
 * Prend les échéances dues et les exécute. Appelé toutes les 30 s.
 *
 * La prise est atomique (UPDATE … WHERE id IN (… FOR UPDATE SKIP LOCKED)) :
 * deux passages qui se chevauchent — une tâche longue, un second processus —
 * ne peuvent pas exécuter le même rappel deux fois. Un rappel envoyé deux
 * fois agace ; une tâche exécutée deux fois se paie deux fois.
 */
export async function passer(executer: Executeur): Promise<number> {
  const pris = await db().query<Rappel>(
    `UPDATE rappels SET en_cours=true
      WHERE id IN (SELECT id FROM rappels WHERE actif AND NOT en_cours AND prochain <= now()
                   ORDER BY prochain LIMIT 5 FOR UPDATE SKIP LOCKED)
      RETURNING *`,
  );
  for (const brut of pris.rows) {
    const r = norm(brut);
    let resultat = "";
    try {
      resultat = await executer(r);
    } catch (e) {
      resultat = `échec : ${String(e).slice(0, 300)}`;
      logger.error({ rappel: r.id, err: String(e) }, "rappel en échec");
    }
    // Récurrent : on recalcule depuis MAINTENANT, pas depuis l'échéance
    // manquée. Après une panne de six heures, une tâche horaire repart une
    // fois, au lieu de rattraper six exécutions d'un coup.
    let prochain: Date | null = null;
    if (r.cron) {
      try {
        prochain = prochaineEcheance({ cron: r.cron });
      } catch {
        prochain = null;
      }
    }
    await db().query(
      `UPDATE rappels SET en_cours=false, executions=executions+1, derniere=now(), dernier_resultat=$2,
              prochain=$3, actif=$4
        WHERE id=$1`,
      [r.id, resultat.slice(0, 2_000), prochain, Boolean(prochain)],
    );
  }
  return pris.rowCount ?? 0;
}

let minuterie: NodeJS.Timeout | undefined;

export async function demarrerRappels(executer: Executeur): Promise<void> {
  // Un processus tué en pleine exécution laisse `en_cours` levé : sans ce
  // nettoyage au démarrage, ce rappel ne sonnerait plus jamais.
  await db().query(`UPDATE rappels SET en_cours=false WHERE en_cours`).catch(() => undefined);
  const tour = () => void passer(executer).catch((e) => logger.error({ err: String(e) }, "boucle des rappels"));
  tour();
  minuterie = setInterval(tour, 30_000);
  minuterie.unref();
}

export function arreterRappels(): void {
  if (minuterie) clearInterval(minuterie);
  minuterie = undefined;
}

/* --- Outils de conversation ------------------------------------------------ */

export function outilsRappels(peer: string) {
  const creer = betaZodTool({
    name: "planifier",
    description: `Planifie un rappel ou une tâche, une fois ou sur un rythme — « rappelle-moi demain à 9 h de… », « chaque matin à 8 h, donne-moi… », « tous les lundis, vérifie… ».
type « rappel » : le texte est envoyé tel quel à l'heure dite (gratuit).
type « tache » : le texte est une DEMANDE que tu exécuteras à l'heure dite avec tous tes outils ; le résultat part sur WhatsApp. Rédige-la comme une consigne complète, compréhensible sans la conversation d'aujourd'hui.
Une fois : quand = date LOCALE de Lionel au format AAAA-MM-JJTHH:MM, sans fuseau (calcule-la depuis l'heure locale donnée en tête du message).
Récurrent : cron = 5 champs en heure locale (« 0 8 * * * » chaque jour 8 h, « 30 7 * * 1-5 » 7 h 30 en semaine, « 0 9 * * 1 » le lundi 9 h).`,
    inputSchema: z.object({
      type: z.enum(["rappel", "tache"]),
      quoi: z.string().min(1).max(QUOI_MAX),
      quand: z.string().optional(),
      cron: z.string().optional(),
    }),
    run: async (i) => {
      const r = await planifier({ peer, ...i });
      return `planifié n°${r.id} (${r.type}) — ${r.cron ? `rythme ${r.cron}, prochaine fois` : "le"} ${heureLocale(r.prochain)}.`;
    },
  });

  const lister = betaZodTool({
    name: "lister_planifications",
    description: "Liste les rappels et tâches planifiés en cours, avec leur numéro et leur prochaine échéance.",
    inputSchema: z.object({}),
    run: async () => {
      const l = await listerRappels({ peer });
      if (!l.length) return "aucun rappel ni tâche planifiée";
      return l.map((r) => `n°${r.id} ${r.type} — ${heureLocale(r.prochain)}${r.cron ? ` (rythme ${r.cron})` : ""} : ${r.quoi.slice(0, 120)}`).join("\n");
    },
  });

  const annuler = betaZodTool({
    name: "annuler_planification",
    description: "Annule un rappel ou une tâche planifiée par son numéro (donné par lister_planifications).",
    inputSchema: z.object({ id: z.number().int().positive() }),
    run: async (i) => ((await annulerRappel(i.id, peer)) ? `n°${i.id} annulé.` : `n°${i.id} introuvable ou déjà terminé.`),
  });

  return [creer, lister, annuler];
}
