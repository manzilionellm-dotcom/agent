import { randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { config } from "./config.js";
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
  if (!stocke) return { ok: false, raison: "Aucun mot de passe n'est encore défini. Entre avec un code WhatsApp : bouton « Recevoir un code »." };
  if (!mdp || !verifier(mdp, stocke)) {
    noterEchec(ip);
    return { ok: false, raison: "Mot de passe incorrect." };
  }
  echecsParAdresse.delete(ip);
  return { ok: true };
}

/* --- Code WhatsApp ---------------------------------------------------------
 *
 * Pourquoi un deuxième chemin : la première entrée exigeait un lien du bot,
 * ouvert dans le navigateur interne de WhatsApp. Le cookie restait dans ce
 * navigateur-là, et le signet dans Chrome retombait sur cette page, qui
 * refusait tout tant qu'aucun mot de passe n'était défini. Pour Lionel, ça
 * se résumait à « ça ne s'ouvre pas ».
 *
 * Ici, la page elle-même envoie un code à six chiffres sur le WhatsApp du
 * propriétaire (le premier numéro autorisé). Il le tape, et la session dure
 * trente jours, dans le navigateur où il l'a tapé. Pas de mot de passe à
 * retenir, pas de lien à ouvrir au bon endroit ; le mot de passe reste
 * possible pour qui préfère.
 *
 * Ce qui borne l'abus : un code par minute (quelqu'un qui martèle le bouton
 * ne fait que remplir le WhatsApp de Lionel d'un message par minute, et on
 * le voit) ; cinq essais par code, puis le code meurt ; cinq minutes de vie ;
 * et les compteurs d'échecs par adresse et globaux du mot de passe. Un
 * million de codes possibles, cinq essais, un code par minute : le hasard
 * ne rentre pas.
 */
export const CODE_VALIDE_MS = 5 * 60_000;
export const CODE_INTERVALLE_MS = 60_000;
export const CODE_ESSAIS = 5;

let codeCourant: { code: string; expire: number; essais: number } | undefined;
let dernierEnvoi = 0;

/** Le numéro du propriétaire : le premier de WHATSAPP_ALLOWED_NUMBERS. */
export function numeroProprietaire(): string | undefined {
  return config().WHATSAPP_ALLOWED_NUMBERS.split(",").map((n) => n.replace(/[^\d]/g, "")).find(Boolean);
}

export type Envoi = { ok: true } | { ok: false; raison: string };

/**
 * Fabrique un code et l'envoie. `envoyer` est fourni par l'appelant : ce
 * module ne connaît pas WhatsApp, et les tests passent une fonction qui
 * retient le texte au lieu de l'envoyer.
 */
export async function envoyerCode(ip: string, envoyer: (to: string, texte: string) => Promise<boolean>, maintenant = Date.now()): Promise<Envoi> {
  const minutes = attente(ip);
  if (minutes > 0) return { ok: false, raison: `Trop d'essais. Réessaie dans ${minutes} min.` };
  const to = numeroProprietaire();
  if (!to) return { ok: false, raison: "Aucun numéro WhatsApp autorisé sur le serveur (WHATSAPP_ALLOWED_NUMBERS)." };
  const reste = Math.ceil((dernierEnvoi + CODE_INTERVALLE_MS - maintenant) / 1000);
  if (reste > 0) return { ok: false, raison: `Un code vient de partir. Regarde WhatsApp, ou réessaie dans ${reste} s.` };
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  codeCourant = { code, expire: maintenant + CODE_VALIDE_MS, essais: 0 };
  dernierEnvoi = maintenant;
  const texte = [
    `🔑 Code pour ouvrir ton panneau : ${code.slice(0, 3)} ${code.slice(3)}`,
    "",
    "Valable 5 minutes. Tape-le sur la page de connexion, ne le renvoie pas ici.",
    "Tu n'as rien demandé ? Ignore ce message : sans le code, personne n'entre.",
  ].join("\n");
  if (!(await envoyer(to, texte).catch(() => false))) {
    codeCourant = undefined;
    dernierEnvoi = 0;
    return { ok: false, raison: "Le code n'a pas pu être envoyé sur WhatsApp. Écris d'abord un mot au bot, puis réessaie." };
  }
  return { ok: true };
}

export function verifierCode(ip: string, saisi: string, maintenant = Date.now()): Tentative {
  const minutes = attente(ip);
  if (minutes > 0) return { ok: false, raison: `Trop d'essais. Réessaie dans ${minutes} min.` };
  const c = codeCourant;
  if (!c || c.expire < maintenant) {
    codeCourant = undefined;
    return { ok: false, raison: "Ce code a expiré. Demande-en un nouveau." };
  }
  const propre = saisi.replace(/\D/g, "");
  const a = Buffer.from(propre);
  const b = Buffer.from(c.code);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    c.essais++;
    noterEchec(ip);
    if (c.essais >= CODE_ESSAIS) {
      codeCourant = undefined;
      return { ok: false, raison: "Trop d'essais sur ce code. Demande-en un nouveau." };
    }
    return { ok: false, raison: `Code incorrect (${CODE_ESSAIS - c.essais} essai${CODE_ESSAIS - c.essais > 1 ? "s" : ""} restants).` };
  }
  codeCourant = undefined;
  echecsParAdresse.delete(ip);
  return { ok: true };
}

/** Pour les tests : repart d'un compteur vide. */
export function oublierEchecs(): void {
  echecsParAdresse.clear();
  echecsGlobaux = [];
  codeCourant = undefined;
  dernierEnvoi = 0;
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export interface EtatConnexion {
  /** Un mot de passe existe : on montre aussi son champ. */
  mdp: boolean;
  /** Un code vient de partir : on montre le champ du code. */
  codeEnvoye?: boolean;
  /** Le message est une bonne nouvelle, pas une erreur. */
  bon?: boolean;
}

export function pageConnexion(message = "", nom = "Manzi Junior", suite = "", etat: EtatConnexion = { mdp: true }): string {
  const cache = `<input type="hidden" name="suite" value="${esc(suite)}">`;
  const code = etat.codeEnvoye
    ? `<form method="post" action="/login" autocomplete="off">${cache}<input type="hidden" name="action" value="code_verifier">
  <label for="c">Code reçu sur WhatsApp</label>
  <input id="c" name="code" inputmode="numeric" pattern="[0-9 ]*" autocomplete="one-time-code" maxlength="7" placeholder="123 456" required autofocus>
  <button>Entrer</button>
  <p class="aide">Rien reçu ? <button type="submit" class="lien" formaction="/login" name="action" value="code_envoyer">Renvoyer un code</button></p>
</form>`
    : `<form method="post" action="/login">${cache}<input type="hidden" name="action" value="code_envoyer">
  <p class="aide">${etat.mdp ? "Sans mot de passe :" : "Pas de mot de passe à retenir :"} un code à 6 chiffres arrive sur ton WhatsApp, tu le tapes ici, et c'est ouvert pour 30 jours.</p>
  <button>Recevoir un code sur WhatsApp</button>
</form>`;
  const mdp = etat.mdp && !etat.codeEnvoye
    ? `<form method="post" action="/login" autocomplete="on">${cache}
  <p class="ou">ou avec ton mot de passe</p>
  <label for="m">Mot de passe</label>
  <input id="m" name="mdp" type="password" autocomplete="current-password" required>
  <button class="second">Entrer</button>
</form>`
    : "";
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(nom)} — connexion</title><meta name="robots" content="noindex">
<style>
:root{color-scheme:light dark;--fg:#141414;--muted:#6b6b6b;--bg:#fafafa;--card:#fff;--line:#e6e6e6;--go:#1d5fd0;--bad:#c0392b;--bon:#1e8449}
@media(prefers-color-scheme:dark){:root{--fg:#e9e9e9;--muted:#9a9a9a;--bg:#121212;--card:#1b1b1b;--line:#2c2c2c;--go:#7aa7ff;--bad:#ff6b5e;--bon:#5fd38a}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);
font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;padding:1rem}
main{width:100%;max-width:22rem;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:1.5rem}
form{margin:0}h1{font-size:1.15rem;margin:0 0 1rem}label{display:block;font-size:.85rem;color:var(--muted);margin-bottom:.35rem}
input{width:100%;padding:.7rem .75rem;font-size:1rem;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)}
#c{font-size:1.5rem;letter-spacing:.2em;text-align:center}
input:focus{outline:2px solid var(--go);outline-offset:1px;border-color:transparent}
button{width:100%;margin-top:1rem;padding:.75rem;font-size:1rem;border:0;border-radius:8px;background:var(--go);color:#fff;cursor:pointer}
button.second{background:transparent;color:var(--go);border:1px solid var(--line)}
button.lien{width:auto;margin:0;padding:0;background:none;color:var(--go);text-decoration:underline;font-size:inherit}
.err{color:var(--bad);font-size:.9rem;margin:0 0 .9rem}.bon{color:var(--bon);font-size:.9rem;margin:0 0 .9rem}
.aide{color:var(--muted);font-size:.9rem;margin:0}.ou{color:var(--muted);font-size:.85rem;text-align:center;margin:1.25rem 0 .75rem}
</style></head><body><main>
  <h1>${esc(nom)}</h1>
  ${message ? `<p class="${etat.bon ? "bon" : "err"}">${esc(message)}</p>` : ""}
  ${code}
  ${mdp}
</main></body></html>`;
}
