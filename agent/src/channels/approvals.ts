import { randomBytes } from "node:crypto";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { db } from "../memory/db.js";
import { setting } from "../providers.js";
import { primaryNumber, sendWhatsApp, whatsappEnabled } from "./whatsapp.js";

/**
 * Approbation humaine par WhatsApp pour les outils irréversibles (envoi d'e-mail,
 * création d'issue, suppression d'événement…) : le bot envoie « … réponds OUI-K7Q2 ou NON-K7Q2 »,
 * attend jusqu'à APPROVAL_TIMEOUT_MIN, puis exécute, refuse, ou passe en dry-run.
 * Sans WhatsApp configuré → dry-run (comportement d'origine).
 */

export type Decision = "approved" | "denied" | "timeout";

/**
 * L'interrupteur des approbations.
 *
 * Lionel : « je suis le seul maître, supprime les garde-fous. » C'est son
 * bot, son serveur, son argent — la demande est légitime et elle est ici.
 *
 * Un réglage plutôt qu'une suppression de code : le jour où il confie un
 * numéro à quelqu'un d'autre, ou tente une mission qu'il ne veut pas voir
 * partir toute seule, il rallume d'un clic. Supprimer le code aurait rendu
 * ce retour impossible sans me rappeler.
 *
 * Par défaut les approbations restent actives : une installation neuve ne
 * doit pas hériter d'un choix qui n'a pas été fait.
 */
export async function approbationsActives(): Promise<boolean> {
  return (await setting("APPROBATIONS").catch(() => undefined)) !== "off";
}

export async function requestApproval(tool: string, args: Record<string, unknown>): Promise<Decision> {
  const cfg = config();
  if (!(await approbationsActives())) {
    // Journalisé, pas silencieux : l'action reste retrouvable dans le journal
    // même quand personne ne l'a validée.
    logger.info({ tool }, "approbations désactivées — exécution directe");
    return "approved";
  }
  const to = primaryNumber();
  if (!whatsappEnabled() || !to) return "timeout";
  const code = randomBytes(3).toString("hex").toUpperCase().slice(0, 4);
  await db().query(`INSERT INTO approvals(code, tool, args) VALUES ($1,$2,$3)`, [code, tool, JSON.stringify(args).slice(0, 4000)]);
  const preview = JSON.stringify(args, null, 1).slice(0, 900);
  await sendWhatsApp(to, `🔐 Approbation requise\nOutil : ${tool.replace("__", " › ")}\n${preview}\n\nRéponds OUI-${code} pour exécuter, NON-${code} pour refuser. Expire dans ${cfg.APPROVAL_TIMEOUT_MIN} min.`);
  const deadline = Date.now() + cfg.APPROVAL_TIMEOUT_MIN * 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5_000));
    const r = await db().query<{ decision: string | null }>(`SELECT decision FROM approvals WHERE code=$1`, [code]);
    const d = r.rows[0]?.decision;
    if (d === "approved" || d === "denied") return d;
  }
  await db().query(`UPDATE approvals SET decision='timeout' WHERE code=$1 AND decision IS NULL`, [code]);
  logger.info({ tool, code }, "approbation expirée");
  return "timeout";
}

/** Appelé par le chat : « OUI-K7Q2 » / « NON-K7Q2 ». Retourne un message si le texte était une décision. */
export async function handleApprovalReply(text: string): Promise<string | undefined> {
  const m = text.trim().match(/^(oui|ok|go|yes|non|no|stop)[\s-]*([A-Z0-9]{4})$/i);
  if (!m) return undefined;
  const decision = /^(oui|ok|go|yes)$/i.test(m[1]!) ? "approved" : "denied";
  const r = await db().query(`UPDATE approvals SET decision=$2, decided_at=now() WHERE code=$1 AND decision IS NULL RETURNING tool`, [m[2]!.toUpperCase(), decision]);
  if (!r.rowCount) return "Code inconnu ou déjà traité.";
  return decision === "approved" ? `✅ Approuvé, j'exécute ${String(r.rows[0]!.tool).replace("__", " › ")}.` : "❌ Refusé, je n'exécute pas.";
}
