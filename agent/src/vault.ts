import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync } from "node:crypto";
import { config } from "./config.js";
import { db } from "./memory/db.js";
import { emitEvent } from "./events.js";

/**
 * Coffre d'identifiants.
 *
 * Objectif : que l'agent puisse se connecter tout seul à un site, sur le
 * serveur, PC éteint — sans qu'un mot de passe traverse jamais une
 * conversation ni le contexte d'un modèle.
 *
 * Trois règles de conception, dans l'ordre d'importance :
 *
 *  1. Le mot de passe n'est JAMAIS rendu au modèle. `getCredential` est
 *     réservé au code de l'orchestrateur, qui l'injecte dans le navigateur
 *     par l'entrée standard. Les outils exposés au modèle ne listent que des
 *     noms de sites et des identifiants de connexion.
 *  2. Le mot de passe n'est JAMAIS saisi dans une conversation. Il s'écrit
 *     dans un champ de formulaire (page /vault), c'est-à-dire là où un
 *     gestionnaire de mots de passe le met déjà.
 *  3. Chiffré au repos avec une clé qui n'est pas dans la base. Une
 *     sauvegarde Postgres qui fuite ne livre donc aucun mot de passe — il
 *     faudrait aussi le .env, qui n'est pas sauvegardé au même endroit.
 *
 * AES-256-GCM : le chiffrement seul empêche de lire, pas de modifier. GCM
 * authentifie, donc une ligne altérée en base est rejetée au lieu de
 * produire un mot de passe faux qu'on irait présenter trois fois à un site
 * jusqu'au blocage du compte.
 */

const ALGO = "aes-256-gcm";
/** Sel fixe : la clé maîtresse est déjà longue et aléatoire, et un sel par ligne empêcherait de la changer sans tout relire. */
const SALT = "manzi-vault-v1";

let cachedKey: Buffer | undefined;

export function vaultEnabled(): boolean {
  return Boolean(config().VAULT_KEY);
}

function key(): Buffer {
  if (cachedKey) return cachedKey;
  const k = config().VAULT_KEY;
  if (!k) throw new Error("coffre désactivé : définis VAULT_KEY dans .env (32 caractères aléatoires minimum)");
  // scrypt plutôt que la chaîne brute : même si VAULT_KEY est une phrase
  // courte, la dérivation coûte assez cher pour rendre une attaque par
  // dictionnaire hors de propos.
  cachedKey = scryptSync(k, SALT, 32);
  return cachedKey;
}

/**
 * Chiffre une valeur avec la clé maîtresse du coffre. Exporté parce que les
 * clés d'API des fournisseurs méritent exactement la même protection que les
 * mots de passe : une seule mécanique, un seul endroit à auditer.
 */
export function encryptSecret(plain: string): string {
  return seal(plain);
}

export function decryptSecret(sealed: string): string {
  return open(sealed);
}

function seal(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv(ALGO, key(), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1:${iv.toString("base64")}:${c.getAuthTag().toString("base64")}:${ct.toString("base64")}`;
}

function open(sealed: string): string {
  const [v, iv, tag, ct] = sealed.split(":");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("entrée de coffre illisible");
  const d = createDecipheriv(ALGO, key(), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  try {
    return Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
  } catch {
    // L'échec d'authentification a deux causes, et la seconde est de loin la
    // plus fréquente : VAULT_KEY a changé. Le dire évite de chercher une
    // corruption de base qui n'existe pas.
    throw new Error("déchiffrement impossible : VAULT_KEY a changé, ou la ligne a été altérée. Ressaisis cet identifiant sur /vault.");
  }
}

/** Normalise un site en nom d'hôte comparable : « https://www.LinkedIn.com/feed » → « linkedin.com ». */
export function normalizeSite(input: string): string {
  let s = input.trim().toLowerCase();
  if (!s) throw new Error("site vide");
  if (s.includes("://")) {
    try {
      s = new URL(s).hostname;
    } catch {
      /* laisse tel quel */
    }
  }
  s = s.split("/")[0]!.replace(/^www\./, "").replace(/:\d+$/, "");
  if (!/^[a-z0-9.-]+$/.test(s)) throw new Error(`nom de site invalide : « ${input} »`);
  return s;
}

export type CredentialRow = {
  site: string;
  login: string;
  secret: string;
  totp: string | null;
  url: string;
  note: string;
  uses: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
};

/** Ce que le modèle a le droit de voir : de quoi choisir un site, rien de plus. */
export type PublicCredential = { site: string; login: string; url: string; has_totp: boolean; note: string; uses: number; last_used_at: string | null };

function publicView(r: CredentialRow): PublicCredential {
  return { site: r.site, login: r.login, url: r.url, has_totp: Boolean(r.totp), note: r.note, uses: Number(r.uses), last_used_at: r.last_used_at };
}

export async function putCredential(a: { site: string; login: string; secret: string; totp?: string; url?: string; note?: string }): Promise<PublicCredential> {
  const site = normalizeSite(a.site);
  if (!a.login.trim()) throw new Error("identifiant vide");
  if (!a.secret) throw new Error("mot de passe vide");
  const totp = a.totp?.replace(/\s+/g, "").toUpperCase();
  if (totp && !/^[A-Z2-7]{16,}=*$/.test(totp)) throw new Error("clé TOTP invalide : attendu du base32 (la chaîne derrière « secret= » du QR code)");
  const r = await db().query<CredentialRow>(
    `INSERT INTO credentials(site, login, secret, totp, url, note)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (site) DO UPDATE SET
       login=EXCLUDED.login, secret=EXCLUDED.secret, totp=EXCLUDED.totp,
       url=EXCLUDED.url, note=EXCLUDED.note, updated_at=now()
     RETURNING *`,
    // Si le site a été donné sous forme d'URL complète, c'est elle la page de
    // connexion : la réduire à « https://<hôte>/ » perdrait le chemin
    // (/login, /session/new), que beaucoup de sites n'affichent pas depuis
    // leur accueil.
    [site, a.login.trim(), seal(a.secret), totp ? seal(totp) : null, a.url?.trim() || (a.site.includes("://") ? a.site.trim() : `https://${site}/`), a.note?.trim() ?? ""],
  );
  // L'événement nomme le site, jamais la valeur. Un journal qui contient un
  // mot de passe est un mot de passe public.
  emitEvent({ kind: "vault.stored", message: `identifiant enregistré pour ${site}`, data: { site, login: a.login.trim(), totp: Boolean(totp) } });
  return publicView(r.rows[0]!);
}

/** Réservé au code serveur. N'expose JAMAIS le retour de cette fonction à un modèle. */
export async function getCredential(site: string): Promise<{ site: string; login: string; secret: string; totp?: string; url: string } | undefined> {
  const r = await db().query<CredentialRow>(`SELECT * FROM credentials WHERE site=$1`, [normalizeSite(site)]);
  const row = r.rows[0];
  if (!row) return undefined;
  return { site: row.site, login: row.login, secret: open(row.secret), totp: row.totp ? open(row.totp) : undefined, url: row.url };
}

/**
 * Retrouve l'entrée qui correspond à ce que l'utilisateur a dit.
 *
 * On accepte « linkedin », « linkedin.com », « https://www.linkedin.com/jobs ».
 * Le suffixe compte dans les deux sens : `mail.google.com` doit trouver
 * l'entrée `google.com`, et « blocket » doit trouver `blocket.se`.
 */
export async function findCredentialSite(input: string): Promise<string | undefined> {
  const raw = input.trim().toLowerCase();
  const host = raw.includes("://") || raw.includes(".") ? normalizeSite(raw) : raw.replace(/[^a-z0-9.-]/g, "");
  const r = await db().query<{ site: string }>(`SELECT site FROM credentials`);
  const sites = r.rows.map((x) => x.site);
  const exact = sites.find((s) => s === host);
  if (exact) return exact;
  const parent = sites.find((s) => host.endsWith("." + s));
  if (parent) return parent;
  // Dernier recours, et seulement s'il n'y a pas d'ambiguïté : deux sites qui
  // matchent le même mot, c'est une question à poser, pas un compte à ouvrir.
  const loose = sites.filter((s) => s.split(".")[0] === host || s.startsWith(host + "."));
  return loose.length === 1 ? loose[0] : undefined;
}

export async function listCredentials(): Promise<PublicCredential[]> {
  const r = await db().query<CredentialRow>(`SELECT * FROM credentials ORDER BY site`);
  return r.rows.map(publicView);
}

export async function forgetCredential(site: string): Promise<boolean> {
  const s = normalizeSite(site);
  const r = await db().query(`DELETE FROM credentials WHERE site=$1`, [s]);
  if (r.rowCount) emitEvent({ kind: "vault.forgotten", message: `identifiant supprimé pour ${s}`, data: { site: s } });
  return Boolean(r.rowCount);
}

export async function touchCredential(site: string): Promise<void> {
  await db().query(`UPDATE credentials SET uses=uses+1, last_used_at=now() WHERE site=$1`, [normalizeSite(site)]);
}

/* --- Billets d'accès ------------------------------------------------------ */

/**
 * Un billet à usage unique pour ouvrir la page du coffre.
 *
 * Il remplace le jeton de l'API dans l'URL, et il le remplace pour une
 * raison observée, pas théorique : une adresse qui contient un secret finit
 * recopiée. Dans un historique de navigateur, dans une capture d'écran,
 * dans un message collé à quelqu'un pour montrer que ça marche. Un billet
 * recopié ne vaut rien : il est mort à la première utilisation, et de toute
 * façon dix minutes plus tard.
 */
export async function createVaultTicket(minutes = 10): Promise<{ id: string; expiresAt: Date }> {
  const id = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + minutes * 60_000);
  await db().query(`INSERT INTO vault_tickets(id, expires_at) VALUES ($1,$2)`, [id, expiresAt]);
  // Ménage opportuniste : sans ça la table grossit d'une ligne par ouverture
  // et personne ne la regardera jamais.
  await db().query(`DELETE FROM vault_tickets WHERE expires_at < now() - interval '1 day'`).catch(() => undefined);
  return { id, expiresAt };
}

/**
 * Consomme un billet. L'usage unique se joue dans le `WHERE` : marquer après
 * avoir lu laisserait deux requêtes simultanées passer toutes les deux.
 */
export async function consumeVaultTicket(id: string): Promise<boolean> {
  const r = await db().query(
    `UPDATE vault_tickets SET used_at=now() WHERE id=$1 AND used_at IS NULL AND expires_at > now()`,
    [id],
  );
  return Boolean(r.rowCount);
}

/* --- TOTP (RFC 6238) ------------------------------------------------------ */

/**
 * Sans ça, le coffre s'arrête au premier site qui demande un code à six
 * chiffres — c'est-à-dire à presque tous ceux qui comptent. La clé TOTP est
 * la chaîne base32 affichée sous le QR code au moment où on active la double
 * authentification ; elle vaut un second mot de passe, donc elle est
 * chiffrée comme le premier.
 */
function base32Decode(s: string): Buffer {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, "").toUpperCase()) {
    const i = A.indexOf(ch);
    if (i < 0) throw new Error("clé TOTP : caractère base32 invalide");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totpCode(secret: string, at: number = Date.now()): string {
  const counter = Math.floor(at / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const mac = createHmac("sha1", base32Decode(secret)).update(buf).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(bin % 1_000_000).padStart(6, "0");
}

/** Secondes restantes avant que le code courant expire — utile pour ne pas en saisir un qui meurt en route. */
export function totpRemaining(at: number = Date.now()): number {
  return 30 - Math.floor(at / 1000) % 30;
}

/* --- Import d'un gestionnaire de mots de passe ------------------------------- */

/**
 * Lit un CSV (RFC 4180) : guillemets, virgules et retours à la ligne dans les
 * champs. Un mot de passe peut contenir tout ça ; un découpage naïf sur les
 * virgules en aurait coupé et mélangé.
 */
export function lireCsv(texte: string): string[][] {
  const lignes: string[][] = [];
  let ligne: string[] = [], champ = "", guillemets = false;
  const t = texte.replace(/^﻿/, "");
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (guillemets) {
      if (c === '"') {
        if (t[i + 1] === '"') { champ += '"'; i++; } else guillemets = false;
      } else champ += c;
    } else if (c === '"') guillemets = true;
    else if (c === ",") { ligne.push(champ); champ = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      ligne.push(champ); champ = "";
      if (ligne.some((x) => x !== "")) lignes.push(ligne);
      ligne = [];
    } else champ += c;
  }
  ligne.push(champ);
  if (ligne.some((x) => x !== "")) lignes.push(ligne);
  return lignes;
}

/** Les noms de colonnes des exports courants : Chrome/Google, Firefox, Bitwarden, iCloud/Safari, 1Password. */
const COLONNES = {
  url: ["url", "login_uri", "website", "web site", "urls"],
  login: ["username", "login_username", "login", "user name", "email"],
  secret: ["password", "login_password"],
  totp: ["login_totp", "otpauth", "totp", "one-time password", "otp"],
  nom: ["name", "title"],
};

function secretTotp(v: string): string | undefined {
  const s = v.trim();
  if (!s) return undefined;
  if (s.startsWith("otpauth://")) {
    try {
      return new URL(s).searchParams.get("secret") ?? undefined;
    } catch {
      return undefined;
    }
  }
  return s;
}

export type BilanImport = { importes: number; remplaces: number; ignores: Array<{ ligne: string; raison: string }> };

/**
 * Importe l'export d'un gestionnaire de mots de passe dans le coffre.
 *
 * Un site = un compte (c'est la clé du coffre) : plusieurs comptes pour un
 * même site, on garde le premier et on le dit. Les entrées d'applications
 * Android (android://…) n'ont pas de page web où se connecter : ignorées.
 * Rien de ce fichier n'est journalisé ni gardé en clair : chaque mot de
 * passe est chiffré ligne par ligne, et le texte du fichier n'est tenu qu'en
 * mémoire le temps de la requête.
 */
export async function importerMotsDePasse(csv: string): Promise<BilanImport> {
  if (!vaultEnabled()) throw new Error("VAULT_KEY absente du .env : impossible de chiffrer, donc d'importer");
  const lignes = lireCsv(csv);
  if (lignes.length < 2) throw new Error("fichier vide ou illisible : attendu l'export CSV de ton gestionnaire de mots de passe");
  const entetes = lignes[0]!.map((h) => h.trim().toLowerCase());
  const col = (noms: string[]): number => entetes.findIndex((h) => noms.includes(h));
  const iUrl = col(COLONNES.url), iLogin = col(COLONNES.login), iSecret = col(COLONNES.secret), iTotp = col(COLONNES.totp), iNom = col(COLONNES.nom);
  if (iUrl < 0 || iSecret < 0) throw new Error(`colonnes introuvables (reçu : ${entetes.slice(0, 8).join(", ")}) — attendu au moins une adresse et un mot de passe`);

  const existants = new Set((await db().query<{ site: string }>(`SELECT site FROM credentials`)).rows.map((r) => r.site));
  const vus = new Set<string>();
  const bilan: BilanImport = { importes: 0, remplaces: 0, ignores: [] };
  for (const l of lignes.slice(1)) {
    const url = (l[iUrl] ?? "").split(/[\s,]+/)[0]!.trim();
    const login = iLogin >= 0 ? (l[iLogin] ?? "").trim() : "";
    const secret = l[iSecret] ?? "";
    const nomLigne = (iNom >= 0 && l[iNom]) || url || "(sans nom)";
    if (!url || /^android:\/\//i.test(url)) { bilan.ignores.push({ ligne: nomLigne, raison: "application mobile, pas de site web" }); continue; }
    if (!secret) { bilan.ignores.push({ ligne: nomLigne, raison: "mot de passe vide" }); continue; }
    if (!login) { bilan.ignores.push({ ligne: nomLigne, raison: "identifiant vide" }); continue; }
    let site: string;
    try {
      site = normalizeSite(url.includes("://") ? url : `https://${url}`);
      if (!site.includes(".")) throw new Error("pas un nom de site");
    } catch {
      bilan.ignores.push({ ligne: nomLigne, raison: "adresse illisible" });
      continue;
    }
    if (vus.has(site)) { bilan.ignores.push({ ligne: `${site} (${login})`, raison: "deuxième compte pour ce site — le coffre en garde un par site" }); continue; }
    vus.add(site);
    const totp = iTotp >= 0 ? secretTotp(l[iTotp] ?? "") : undefined;
    const pageConnexion = /^https?:\/\//i.test(url) ? url : `https://${site}/`;
    try {
      await putCredential({ site, login, secret, totp, url: pageConnexion, note: "importé" });
    } catch {
      // Clé 2FA d'un format inattendu : le compte vaut mieux sans elle que pas du tout.
      try {
        await putCredential({ site, login, secret, url: pageConnexion, note: "importé (sans 2FA : clé illisible)" });
      } catch (e) {
        bilan.ignores.push({ ligne: site, raison: e instanceof Error ? e.message.slice(0, 80) : "refusé" });
        continue;
      }
    }
    if (existants.has(site)) bilan.remplaces++;
    else bilan.importes++;
  }
  return bilan;
}
