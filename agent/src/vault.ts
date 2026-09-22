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
