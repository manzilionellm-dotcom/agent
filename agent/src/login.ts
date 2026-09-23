import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { setSetting, setting } from "./providers.js";

/**
 * Connexion au panneau par mot de passe.
 *
 * Jusqu'ici, on n'entrait qu'avec un billet à usage unique, fabriqué sur le
 * serveur ou envoyé par le bot. C'est sûr, mais ça veut dire qu'on ne peut
 * pas mettre l'adresse en favori et revenir : il faut d'abord passer par la
 * machine ou par la conversation. Avec une adresse fixe, Lionel veut ouvrir
 * son panneau comme n'importe quel site — adresse, mot de passe, dedans.
 *
 * Le billet reste possible : le mot de passe s'ajoute, il ne remplace rien.
 *
 * Choix qui comptent :
 *   - scrypt, sel aléatoire, comparaison à temps constant. Le hachage vit en
 *     base, jamais le mot de passe.
 *   - Limite d'essais PAR ADRESSE et GLOBALE. La limite par adresse arrête un
 *     curieux ; la globale arrête quelqu'un qui change d'adresse à chaque
 *     essai. Sans elle, dix mille machines font dix mille essais chacune.
 *   - Aucun mot de passe par défaut. Tant qu'il n'est pas défini depuis le
 *     panneau (donc par quelqu'un déjà entré avec un billet), la page de
 *     connexion refuse tout : il n'existe pas de fenêtre où « admin » marche.
 */

const CLE = "PANEL_MDP";
export const MDP_MIN = 10;

const PAR_ADRESSE = { essais: 5, fenetreMs: 15 * 60_000 };
const GLOBAL = { essais: 30, fenetreMs: 60 * 60_000 };

const echecsParAdresse = new Map<string, number[]>();
let echecsGlobaux: number[] = [];

export function hacher(mdp: string): string {
  const sel = randomBytes(16);
  const h = scryptSync(mdp, sel, 64);
  return `scrypt$${sel.toString("hex")}$${h.toString("hex")}`;
}

export function verifier(mdp: string, stocke: string): boolean {
  const [algo, selHex, hHex] = stocke.split("$");
  if (algo !== "scrypt" || !selHex || !hHex) return false;
  const attendu = Buffer.from(hHex, "hex");
  const calcule = scryptSync(mdp, Buffer.from(selHex, "hex"), attendu.length);
  return calcule.length === attendu.length && timingSafeEqual(calcule, attendu);
}

export async function motDePasseDefini(): Promise<boolean> {
  return Boolean(await setting(CLE).catch(() => undefined));
}

export async function definirMotDePasse(mdp: string, confirmation: string): Promise<void> {
  if (mdp !== confirmation) throw new Error("les deux mots de passe ne sont pas identiques");
  if (mdp.length < MDP_MIN) throw new Error(`au moins ${MDP_MIN} caractères`);
  if (/^(.)\1+$/.test(mdp)) throw new Error("un seul caractère répété n'est pas un mot de passe");
  await setSetting(CLE, hacher(mdp));
}

export async function retirerMotDePasse(): Promise<void> {
  await setSetting(CLE, "");
}

/**
 * L'adresse du visiteur. Derrière Cloudflare, la socket voit le conteneur du
 * tunnel — la même adresse pour tout le monde — et la limite par adresse
 * bloquerait tous les visiteurs dès le cinquième échec de n'importe qui.
 * `cf-connecting-ip` porte la vraie. Hors tunnel, on retombe sur la socket.
 */
export function adresse(req: IncomingMessage): string {
  const cf = req.headers["cf-connecting-ip"];
  return (Array.isArray(cf) ? cf[0] : cf) || req.socket.remoteAddress || "?";
}

function recents(liste: number[], fenetre: number): number[] {
  const seuil = Date.now() - fenetre;
  return liste.filter((t) => t > seuil);
}

/** Minutes à attendre avant un nouvel essai, ou 0 si c'est permis. */
export function attente(ip: string): number {
  const mine = recents(echecsParAdresse.get(ip) ?? [], PAR_ADRESSE.fenetreMs);
  echecsGlobaux = recents(echecsGlobaux, GLOBAL.fenetreMs);
  if (mine.length >= PAR_ADRESSE.essais) return Math.ceil((mine[0]! + PAR_ADRESSE.fenetreMs - Date.now()) / 60_000);
  if (echecsGlobaux.length >= GLOBAL.essais) return Math.ceil((echecsGlobaux[0]! + GLOBAL.fenetreMs - Date.now()) / 60_000);
  return 0;
}

function noterEchec(ip: string): void {
  const mine = recents(echecsParAdresse.get(ip) ?? [], PAR_ADRESSE.fenetreMs);
  mine.push(Date.now());
  echecsParAdresse.set(ip, mine);
  echecsGlobaux.push(Date.now());
  // Une carte qui grossit sans fin est une fuite mémoire offerte à qui
  // veut essayer depuis beaucoup d'adresses.
  if (echecsParAdresse.size > 10_000) echecsParAdresse.clear();
}

export type Tentative = { ok: true } | { ok: false; raison: string };

export async function tenter(ip: string, mdp: string): Promise<Tentative> {
  const minutes = attente(ip);
  if (minutes > 0) return { ok: false, raison: `Trop d'essais. Réessaie dans ${minutes} min.` };
  const stocke = await setting(CLE).catch(() => undefined);
  if (!stocke) return { ok: false, raison: "Aucun mot de passe n'est encore défini. Entre une première fois avec un lien du bot, puis définis-le dans le panneau (section Accès)." };
  if (!mdp || !verifier(mdp, stocke)) {
    noterEchec(ip);
    return { ok: false, raison: "Mot de passe incorrect." };
  }
  echecsParAdresse.delete(ip);
  return { ok: true };
}

/** Pour les tests : repart d'un compteur vide. */
export function oublierEchecs(): void {
  echecsParAdresse.clear();
  echecsGlobaux = [];
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function pageConnexion(message = "", nom = "Manzi Junior", suite = ""): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(nom)} — connexion</title><meta name="robots" content="noindex">
<style>
:root{color-scheme:light dark;--fg:#141414;--muted:#6b6b6b;--bg:#fafafa;--card:#fff;--line:#e6e6e6;--go:#1d5fd0;--bad:#c0392b}
@media(prefers-color-scheme:dark){:root{--fg:#e9e9e9;--muted:#9a9a9a;--bg:#121212;--card:#1b1b1b;--line:#2c2c2c;--go:#7aa7ff;--bad:#ff6b5e}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);
font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;padding:1rem}
form{width:100%;max-width:22rem;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:1.5rem}
h1{font-size:1.15rem;margin:0 0 1rem}label{display:block;font-size:.85rem;color:var(--muted);margin-bottom:.35rem}
input{width:100%;padding:.7rem .75rem;font-size:1rem;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)}
input:focus{outline:2px solid var(--go);outline-offset:1px;border-color:transparent}
button{width:100%;margin-top:1rem;padding:.75rem;font-size:1rem;border:0;border-radius:8px;background:var(--go);color:#fff;cursor:pointer}
.err{color:var(--bad);font-size:.9rem;margin:0 0 .9rem}
</style></head><body>
<form method="post" action="/login" autocomplete="on">
  <input type="hidden" name="suite" value="${esc(suite)}">
  <h1>${esc(nom)}</h1>
  ${message ? `<p class="err">${esc(message)}</p>` : ""}
  <label for="m">Mot de passe</label>
  <input id="m" name="mdp" type="password" autocomplete="current-password" required autofocus>
  <button>Entrer</button>
</form></body></html>`;
}
