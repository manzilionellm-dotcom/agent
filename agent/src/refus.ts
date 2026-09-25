import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { db } from "./memory/db.js";
import { caviarder, enregistrer, traceCourante } from "./boite-noire.js";

/**
 * Le journal des refus.
 *
 * Règle : chaque chose que le bot n'a pas faite laisse une ligne, avec la
 * PREUVE — le message d'erreur exact, ce que la page affichait, le code HTTP.
 * Sans entrée, une tâche non faite n'est pas un refus, c'est un échec du
 * bot ; et une entrée sans preuve est un échec aussi. La conversation dit
 * « je n'ai pas pu », le journal dit pourquoi, et le panneau montre les deux.
 *
 * Deux sources :
 *   bot  — le modèle a appelé signaler_refus lui-même (le cas voulu) ;
 *   auto — sa réponse ressemble à un refus (« je ne peux pas », « je n'ai
 *          pas accès ») sans qu'il ait rien signalé : la ligne est posée
 *          d'office, marquée sans preuve, pour que ça se voie.
 */

export type Refus = {
  id: number;
  ts: string;
  trace_id: string | null;
  peer: string;
  quoi: string;
  raison: string;
  preuve: string;
  source: "bot" | "auto";
};

/** Ce qui, dans une réponse, ressemble à un refus ou à un abandon. */
export const MOTIF_REFUS = /\b(je ne peux pas|je ne peux plus|je n'ai pas (?:pu|réussi|accès|trouvé)|impossible de|je ne suis pas en mesure|je n'arrive pas|je ne parviens pas|je n'ai pas le droit|ça ne marche pas|je ne pourrai pas|je préfère ne pas)\b/i;

export function ressembleAUnRefus(texte: string): boolean {
  return MOTIF_REFUS.test(texte);
}

export async function signalerRefus(a: { quoi: string; raison?: string; preuve?: string; peer?: string; source?: "bot" | "auto"; traceId?: string }): Promise<Refus> {
  const r = await db().query<Refus>(
    `INSERT INTO refus(trace_id, peer, quoi, raison, preuve, source) VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id, ts::text, trace_id, peer, quoi, raison, preuve, source`,
    [a.traceId ?? traceCourante() ?? null, a.peer ?? "", caviarder(a.quoi.trim().slice(0, 300)), caviarder((a.raison ?? "").trim().slice(0, 600)), caviarder((a.preuve ?? "").trim().slice(0, 2000)), a.source ?? "bot"],
  );
  const refus = { ...r.rows[0]!, id: Number(r.rows[0]!.id) };
  enregistrer({ type: "erreur", niveau: "warn", titre: `Refus : ${refus.quoi}`, detail: `${refus.raison}\n\nPreuve : ${refus.preuve || "(aucune)"}`, ok: false });
  return refus;
}

export async function listerRefus(limite = 50): Promise<Refus[]> {
  const r = await db().query<Refus>(`SELECT id, ts::text, trace_id, peer, quoi, raison, preuve, source FROM refus ORDER BY ts DESC LIMIT $1`, [limite]);
  return r.rows.map((x) => ({ ...x, id: Number(x.id) }));
}

export async function refusDansTrace(traceId: string): Promise<number> {
  const r = await db().query<{ n: string }>(`SELECT count(*) AS n FROM refus WHERE trace_id=$1`, [traceId]);
  return Number(r.rows[0]?.n ?? 0);
}

export async function supprimerRefus(id: number): Promise<boolean> {
  return Boolean((await db().query(`DELETE FROM refus WHERE id=$1`, [id])).rowCount);
}

export async function purgerRefus(jours = 90): Promise<number> {
  const r = await db().query(`DELETE FROM refus WHERE ts < now() - ($1 || ' days')::interval`, [String(jours)]);
  return r.rowCount ?? 0;
}

/**
 * Après une réponse : si elle ressemble à un refus et que rien n'a été
 * signalé dans cette trace, on pose la ligne d'office, sans preuve. Le
 * panneau la montre en rouge : c'est le bot qui a lâché, pas un obstacle.
 */
export async function verifierReponse(reponse: string, peer: string, demande: string): Promise<Refus | undefined> {
  if (!ressembleAUnRefus(reponse)) return undefined;
  const trace = traceCourante();
  if (trace && (await refusDansTrace(trace)) > 0) return undefined;
  return signalerRefus({ quoi: demande.slice(0, 200), raison: reponse.slice(0, 600), preuve: "", peer, source: "auto", traceId: trace });
}

export function outilRefus(peer: string) {
  return betaZodTool({
    name: "signaler_refus",
    description:
      "OBLIGATOIRE avant de dire à Lionel que quelque chose n'a pas pu être fait, en tout ou partie : enregistre ce qui bloque avec la PREUVE (le message d'erreur exact rendu par l'outil, le code HTTP, ce que la page affichait, la ligne du captcha). Sans cet appel, un « je n'ai pas pu » compte comme un échec de ta part et s'affiche en rouge au panneau. Une preuve vide n'est pas une preuve.",
    inputSchema: z.object({
      quoi: z.string().min(3).max(300).describe("ce qui n'a pas été fait, ex. « publier l'annonce sur Blocket »"),
      raison: z.string().min(3).max(600).describe("pourquoi, en une phrase"),
      preuve: z.string().min(3).max(2000).describe("la preuve brute : texte d'erreur, code HTTP, extrait de page, nom de l'outil qui a rendu Error"),
    }),
    run: async (i) => {
      const r = await signalerRefus({ quoi: i.quoi, raison: i.raison, preuve: i.preuve, peer, source: "bot" });
      return `refus n°${r.id} enregistré avec preuve. Dis maintenant à Lionel en UNE ligne ce qui bloque et ce que tu tentes à la place.`;
    },
  });
}
