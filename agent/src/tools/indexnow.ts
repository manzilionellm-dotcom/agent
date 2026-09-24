import { randomBytes } from "node:crypto";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { setting, setSetting } from "../providers.js";
import { logger } from "../logger.js";

/**
 * IndexNow — l'indexation rapide, telle que documentée sur indexnow.org
 * (lu le 24/09/2026) : un POST sur api.indexnow.org avec le domaine, une clé
 * de 8 à 128 caractères [a-zA-Z0-9-] et la liste des URL (jusqu'à 10 000),
 * la clé étant prouvée par un fichier `/<clé>.txt` à la racine du site.
 * Bing, Yandex, Seznam, Naver partagent la soumission entre eux. Google
 * n'est pas dans IndexNow : pour lui, un sitemap propre déclaré dans
 * robots.txt, et la Search Console.
 *
 * Codes de réponse, d'après la même page : 200 reçu, 202 reçu (clé en cours
 * de validation), 400 requête mal formée, 403 clé invalide, 422 URL hors du
 * domaine ou clé mal placée, 429 trop de requêtes.
 */

const API = "https://api.indexnow.org/indexnow";
const MAX_URLS = 10_000;

/** La clé du site : créée une fois, gardée dans les réglages, jamais dans le code du site autrement que par son fichier. */
export async function cleIndexNow(): Promise<string> {
  const existante = await setting("INDEXNOW_KEY");
  if (existante && /^[a-zA-Z0-9-]{8,128}$/.test(existante)) return existante;
  const cle = randomBytes(16).toString("hex");
  await setSetting("INDEXNOW_KEY", cle);
  return cle;
}

export type BilanIndexNow = { ok: boolean; statut: number; host: string; urls: number; message: string; fichier_cle: string; fichier_present: boolean };

export async function soumettreIndexNow(urls: string[], opts: { fetch?: typeof fetch; verifierFichier?: boolean } = {}): Promise<BilanIndexNow> {
  const f = opts.fetch ?? fetch;
  const propres = [...new Set(urls.map((u) => u.trim()).filter((u) => /^https?:\/\//i.test(u)))].slice(0, MAX_URLS);
  if (!propres.length) throw new Error("aucune URL valide (http(s)://…)");
  const hosts = new Set(propres.map((u) => new URL(u).host));
  if (hosts.size > 1) throw new Error(`toutes les URL doivent être sur le même domaine (reçu : ${[...hosts].join(", ")})`);
  const host = [...hosts][0]!;
  const cle = await cleIndexNow();
  const fichier = `https://${host}/${cle}.txt`;
  let present = false;
  if (opts.verifierFichier !== false) {
    try {
      const r = await f(fichier, { signal: AbortSignal.timeout(10_000) });
      present = r.ok && (await r.text()).trim() === cle;
    } catch {
      present = false;
    }
  }
  const res = await f(API, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ host, key: cle, keyLocation: fichier, urlList: propres }),
    signal: AbortSignal.timeout(20_000),
  });
  const messages: Record<number, string> = {
    200: "reçu",
    202: "reçu, clé en cours de validation",
    400: "requête mal formée",
    403: "clé refusée : le fichier de clé est absent ou ne contient pas la bonne clé",
    422: "URL hors du domaine, ou fichier de clé mal placé",
    429: "trop de soumissions, réessaie plus tard",
  };
  const bilan: BilanIndexNow = {
    ok: res.status === 200 || res.status === 202,
    statut: res.status,
    host,
    urls: propres.length,
    message: messages[res.status] ?? `réponse HTTP ${res.status}`,
    fichier_cle: fichier,
    fichier_present: present,
  };
  logger.info({ host, urls: propres.length, statut: res.status, fichier_present: present }, "IndexNow");
  return bilan;
}

export const indexNowTool = betaZodTool({
  name: "indexnow_submit",
  description:
    "Soumet des URL fraîchement publiées ou modifiées à IndexNow (Bing, Yandex, Seznam, Naver : indexation en heures au lieu de semaines). Toutes sur le même domaine, jusqu'à 10 000. Prérequis : le fichier de clé /<clé>.txt à la racine du site — l'outil rend la clé et dit si le fichier est en place ; s'il manque, fais-le ajouter par le codeur (fichier public/<clé>.txt contenant la clé) et déployer, puis resoumets. Google n'écoute pas IndexNow : sitemap.xml déclaré dans robots.txt.",
  inputSchema: z.object({ urls: z.array(z.string().url()).min(1).max(10_000) }),
  run: async (i) => {
    try {
      const b = await soumettreIndexNow(i.urls);
      return [
        `${b.ok ? "OK" : "REFUS"} (HTTP ${b.statut}) : ${b.message}. ${b.urls} URL sur ${b.host}.`,
        `Fichier de clé : ${b.fichier_cle} — ${b.fichier_present ? "en place" : "ABSENT ou incorrect : crée-le avec pour seul contenu la clé, puis déploie et resoumets"}.`,
        `Clé IndexNow du site : ${b.fichier_cle.split("/").pop()!.replace(/\.txt$/, "")}`,
      ].join("\n");
    } catch (e) {
      return `Error: ${String(e).slice(0, 300)}`;
    }
  },
});
