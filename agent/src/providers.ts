import { config } from "./config.js";
import { db } from "./memory/db.js";
import { logger } from "./logger.js";
import { emitEvent } from "./events.js";
import { decryptSecret, encryptSecret, vaultEnabled } from "./vault.js";

/**
 * Fournisseurs de modèles, pilotés depuis le panneau.
 *
 * Avant : les clés vivaient dans le .env, et changer un fournisseur voulait
 * dire ssh + éditer un fichier + reconstruire. En pratique, personne ne le
 * fait — donc personne ne met un fournisseur en pause quand il coûte trop,
 * ni n'en essaie un nouveau. Un réglage qu'on ne peut pas changer facilement
 * est un réglage qu'on ne change jamais.
 *
 * Ici : une table, une page, effet immédiat. La clé est chiffrée avec la clé
 * maîtresse du coffre — jamais en clair en base, jamais réaffichée, même à
 * son propriétaire.
 *
 * Le .env reste la valeur de repli. Un serveur dont la base est vide démarre
 * donc comme avant, et rien ne casse le jour où on ajoute ce panneau à une
 * installation existante.
 */

export const CATEGORIES = ["modele", "dev", "recherche", "autre"] as const;
export type Category = (typeof CATEGORIES)[number];

export type ProviderRow = {
  id: string;
  category: Category;
  label: string;
  kind: "anthropic" | "openai_compat";
  base_url: string;
  model: string;
  api_key: string | null;
  enabled: boolean;
  priority: number;
  roles: string;
  daily_cap_usd: number;
  note: string;
  created_at: string;
  updated_at: string;
};

/** Ce qu'on affiche : jamais la clé, seulement le fait qu'elle existe. */
export type PublicProvider = Omit<ProviderRow, "api_key"> & { has_key: boolean; spend24h: number; spend30d: number; over_cap: boolean };

export const ROLES = ["chat", "worker", "planner", "critical"] as const;
export type Role = (typeof ROLES)[number];

const ID_RE = /^[a-z][a-z0-9_-]{1,31}$/;

/** Identifiants dont la catégorie ne se choisit pas : c'est leur nom qui la dit. */
const SERVICES_RESERVES: Record<string, Category> = {
  github: "dev", vercel: "dev", tavily: "recherche", serpapi: "recherche", voix: "autre", image: "autre",
};

function norm(r: ProviderRow): ProviderRow {
  return { ...r, priority: Number(r.priority), daily_cap_usd: Number(r.daily_cap_usd), enabled: Boolean(r.enabled) };
}

/* --- Lecture ------------------------------------------------------------- */

export async function listProviders(): Promise<PublicProvider[]> {
  const r = await db().query<ProviderRow & { s24: string; s30: string }>(
    `SELECT p.*,
            coalesce((SELECT sum(usd) FROM usage_log u WHERE u.provider = p.id AND u.ts > now() - interval '24 hours'), 0) AS s24,
            coalesce((SELECT sum(usd) FROM usage_log u WHERE u.provider = p.id AND u.ts > now() - interval '30 days'), 0) AS s30
     FROM providers p ORDER BY p.priority, p.id`,
  );
  return r.rows.map((row) => {
    const p = norm(row);
    const spend24h = Number(row.s24);
    return {
      ...p,
      api_key: undefined as never,
      has_key: Boolean(row.api_key),
      spend24h,
      spend30d: Number(row.s30),
      over_cap: p.daily_cap_usd > 0 && spend24h >= p.daily_cap_usd,
    } as PublicProvider;
  });
}

export async function getProvider(id: string): Promise<ProviderRow | undefined> {
  const r = await db().query<ProviderRow>(`SELECT * FROM providers WHERE id=$1`, [id]);
  return r.rows[0] ? norm(r.rows[0]) : undefined;
}

/* --- Écriture ------------------------------------------------------------ */

export type NewProvider = {
  id: string;
  category?: Category;
  label?: string;
  kind?: ProviderRow["kind"];
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  enabled?: boolean;
  priority?: number;
  roles?: string[];
  dailyCapUsd?: number;
  note?: string;
};

export async function putProvider(p: NewProvider): Promise<PublicProvider> {
  const id = p.id.trim().toLowerCase();
  if (!ID_RE.test(id)) throw new Error(`identifiant invalide : « ${p.id} » (minuscules, chiffres, - et _, 2 à 32 caractères)`);
  // Certains identifiants désignent un service précis. Enregistrés par
  // mégarde en « modèle » (la catégorie par défaut du formulaire), ils
  // entreraient dans le routage du chat : la clé de synthèse vocale se ferait
  // interroger comme un cerveau. On les range d'office.
  const reserve = SERVICES_RESERVES[id];
  const category: Category = reserve ?? p.category ?? "modele";
  if (!CATEGORIES.includes(category)) throw new Error(`catégorie inconnue : ${category} (${CATEGORIES.join(", ")})`);
  const kind = p.kind ?? "openai_compat";
  if (category === "modele" && kind === "openai_compat" && p.apiKey && !p.baseUrl) {
    throw new Error("une adresse d'API est requise pour un fournisseur de modèle compatible OpenAI");
  }
  // Les rôles ne concernent que les modèles : GitHub n'a pas de « rôle de
  // routage », et lui en imposer un rendrait le formulaire absurde.
  const roles = category === "modele"
    ? (p.roles?.length ? p.roles : ["chat", "worker"]).filter((r) => (ROLES as readonly string[]).includes(r))
    : [];
  if (category === "modele" && !roles.length) throw new Error(`rôles inconnus (attendu : ${ROLES.join(", ")})`);
  if (p.apiKey && !vaultEnabled()) throw new Error("VAULT_KEY absente : impossible de chiffrer une clé d'API");

  // Une clé vide veut dire « ne touche pas à celle qui est là » : le
  // formulaire ne réaffiche jamais la clé, donc l'enregistrer vide
  // l'effacerait à chaque modification de libellé.
  const sealed = p.apiKey ? encryptSecret(p.apiKey) : null;
  // Même raisonnement pour le plafond, mais l'enjeu n'est pas le même : un
  // champ oublié qui remet le plafond à 0 ne perd pas une donnée, il lève une
  // limite de dépense. On ne l'efface que si on le demande explicitement (0),
  // jamais par omission. Le coût est un SELECT par enregistrement.
  const cap = p.dailyCapUsd ?? (await getProvider(id))?.daily_cap_usd ?? 0;
  const r = await db().query<ProviderRow>(
    `INSERT INTO providers(id, label, kind, base_url, model, api_key, enabled, priority, roles, daily_cap_usd, note, category)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (id) DO UPDATE SET
       label=EXCLUDED.label, kind=EXCLUDED.kind, base_url=EXCLUDED.base_url, category=EXCLUDED.category,
       model=EXCLUDED.model, api_key=COALESCE(EXCLUDED.api_key, providers.api_key),
       enabled=EXCLUDED.enabled, priority=EXCLUDED.priority, roles=EXCLUDED.roles,
       daily_cap_usd=EXCLUDED.daily_cap_usd, note=EXCLUDED.note, updated_at=now()
     RETURNING *`,
    [id, p.label ?? id, kind, p.baseUrl?.trim() ?? "", p.model?.trim() ?? "", sealed,
     p.enabled ?? true, p.priority ?? 50, roles.join(","), cap, p.note?.trim() ?? "", category],
  );
  invalidate();
  emitEvent({ kind: "provider.changed", message: `fournisseur « ${id} » enregistré`, data: { id, enabled: p.enabled ?? true, roles } });
  const [pub] = await listProviders().then((l) => l.filter((x) => x.id === id));
  return pub ?? ({ ...norm(r.rows[0]!), has_key: Boolean(sealed), spend24h: 0, spend30d: 0, over_cap: false } as unknown as PublicProvider);
}

export async function setProviderEnabled(id: string, enabled: boolean): Promise<boolean> {
  const r = await db().query(`UPDATE providers SET enabled=$2, updated_at=now() WHERE id=$1`, [id, enabled]);
  invalidate();
  if (r.rowCount) emitEvent({ kind: "provider.changed", message: `${id} ${enabled ? "réactivé" : "mis en pause"}`, data: { id, enabled } });
  return Boolean(r.rowCount);
}

export async function bumpProviderPriority(id: string, delta: number): Promise<void> {
  await db().query(`UPDATE providers SET priority = GREATEST(1, LEAST(99, priority + $2)), updated_at=now() WHERE id=$1`, [id, delta]);
  invalidate();
}

export async function deleteProvider(id: string): Promise<boolean> {
  const r = await db().query(`DELETE FROM providers WHERE id=$1`, [id]);
  invalidate();
  if (r.rowCount) emitEvent({ kind: "provider.changed", message: `fournisseur ${id} supprimé`, data: { id } });
  return Boolean(r.rowCount);
}

/* --- Résolution pour le routeur ------------------------------------------ */

export type ResolvedProvider = { id: string; kind: ProviderRow["kind"]; model: string; baseUrl?: string; apiKey?: string; priority: number; roles: Role[] };

let cache: { at: number; rows: ResolvedProvider[] } | undefined;
/** 15 s : assez court pour qu'une pause depuis le panneau se voie tout de suite, assez long pour ne pas interroger la base à chaque appel. */
const TTL_MS = 15_000;

export function invalidate(): void {
  cache = undefined;
  secrets = undefined;
  reglages = undefined;
}

/**
 * Les fournisseurs utilisables MAINTENANT, triés par priorité.
 *
 * Trois filtres, et chacun a coûté quelque chose à quelqu'un :
 *   - désactivé : mis en pause depuis le panneau ;
 *   - sans clé : présent pour mémoire, inutilisable ;
 *   - plafond de 24 h atteint : c'est tout l'intérêt de suivre la dépense par
 *     fournisseur. Un plafond global coupe tout ; un plafond par fournisseur
 *     bascule sur le suivant.
 */
export async function activeProviders(role?: Role): Promise<ResolvedProvider[]> {
  if (!cache || Date.now() - cache.at > TTL_MS) {
    let rows: ResolvedProvider[] = [];
    try {
      const r = await db().query<ProviderRow & { s24: string }>(
        `SELECT p.*, coalesce((SELECT sum(usd) FROM usage_log u WHERE u.provider = p.id AND u.ts > now() - interval '24 hours'), 0) AS s24
         FROM providers p WHERE p.enabled = true AND p.api_key IS NOT NULL AND p.category = 'modele' ORDER BY p.priority, p.id`,
      );
      const mapped: Array<ResolvedProvider | undefined> = r.rows
        .filter((x) => Number(x.daily_cap_usd) <= 0 || Number(x.s24) < Number(x.daily_cap_usd))
        .map((x): ResolvedProvider | undefined => {
          try {
            return {
              id: x.id,
              kind: x.kind,
              model: x.model,
              baseUrl: x.base_url || undefined,
              apiKey: x.api_key ? decryptSecret(x.api_key) : undefined,
              priority: Number(x.priority),
              roles: x.roles.split(",").map((s) => s.trim()).filter((s) => (ROLES as readonly string[]).includes(s)) as Role[],
            };
          } catch (e) {
            // Une clé illisible (VAULT_KEY changée) ne doit pas faire tomber
            // le routage entier : on écarte cette ligne et on le dit.
            logger.error({ provider: x.id, err: String(e) }, "clé de fournisseur illisible — fournisseur ignoré");
            return undefined;
          }
        });
      rows = mapped.filter((x): x is ResolvedProvider => x !== undefined);
    } catch (e) {
      // La base peut être indisponible au tout premier démarrage. Le routeur
      // retombera sur le .env : mieux vaut un service dégradé qu'un refus.
      logger.warn({ err: String(e) }, "fournisseurs illisibles — repli sur le .env");
    }
    cache = { at: Date.now(), rows };
  }
  return role ? cache.rows.filter((p) => p.roles.includes(role)) : cache.rows;
}

/* --- Réglages modifiables ------------------------------------------------- */

let reglages: { at: number; map: Map<string, string> } | undefined;

export async function setting(cle: string): Promise<string | undefined> {
  if (!reglages || Date.now() - reglages.at > TTL_MS) {
    const map = new Map<string, string>();
    try {
      const r = await db().query<{ cle: string; valeur: string }>(`SELECT cle, valeur FROM settings`);
      for (const row of r.rows) map.set(row.cle, row.valeur);
    } catch (e) {
      logger.warn({ err: String(e) }, "réglages illisibles — repli sur le .env");
    }
    reglages = { at: Date.now(), map };
  }
  return reglages.map.get(cle);
}

export async function setSetting(cle: string, valeur: string): Promise<void> {
  await db().query(
    `INSERT INTO settings(cle, valeur) VALUES ($1,$2) ON CONFLICT (cle) DO UPDATE SET valeur=EXCLUDED.valeur, updated_at=now()`,
    [cle, valeur],
  );
  reglages = undefined;
}

/**
 * Le plafond journalier en vigueur.
 *
 * Changé depuis le panneau, il s'applique en quinze secondes. Laissé tel
 * quel, c'est celui du .env. Un plafond qu'on ne peut relever qu'en se
 * connectant au serveur est un plafond qu'on relève trop tard — au milieu
 * d'une tâche qui vient de s'arrêter.
 */
export async function dailyBudget(): Promise<number> {
  const v = Number(await setting("DAILY_BUDGET_USD"));
  return Number.isFinite(v) && v > 0 ? v : config().DAILY_BUDGET_USD;
}

/**
 * Le projet Vercel à suivre après un push.
 *
 * Dans le .env, il fallait un accès SSH pour le changer — or c'est
 * exactement le genre de valeur qu'on ne connaît qu'APRÈS avoir branché le
 * jeton et vu la liste des projets. Le panneau la propose donc juste à côté.
 */
export async function vercelProject(): Promise<string | undefined> {
  return (await setting("VERCEL_PROJECT"))?.trim() || config().VERCEL_PROJECT;
}

/* --- Clés des services (GitHub, Vercel, recherche…) ----------------------- */

let secrets: { at: number; map: Map<string, string> } | undefined;

/**
 * La clé d'un service, prise dans le panneau si elle y est, sinon dans le .env.
 *
 * Cet ordre est celui qui rend le panneau utile : coller une nouvelle clé
 * GitHub sur la page la met en service en quinze secondes, sans ssh et sans
 * redémarrage. Le .env reste le filet — une base vide ou injoignable ne doit
 * pas priver l'agent de ses outils.
 */
export async function secretFor(id: string, fallback?: string): Promise<string | undefined> {
  if (!secrets || Date.now() - secrets.at > TTL_MS) {
    const map = new Map<string, string>();
    try {
      const r = await db().query<{ id: string; api_key: string }>(
        `SELECT id, api_key FROM providers WHERE enabled = true AND api_key IS NOT NULL AND category <> 'modele'`,
      );
      for (const row of r.rows) {
        try {
          map.set(row.id, decryptSecret(row.api_key));
        } catch (e) {
          logger.error({ service: row.id, err: String(e) }, "clé de service illisible — on garde celle du .env");
        }
      }
    } catch (e) {
      logger.warn({ err: String(e) }, "clés de services illisibles — repli sur le .env");
    }
    secrets = { at: Date.now(), map };
  }
  return secrets.map.get(id) ?? fallback;
}

/* --- Test d'une clé -------------------------------------------------------- */

/**
 * Appelle vraiment le service et dit si la clé marche.
 *
 * Sans ça, le panneau ne prouve rien : on colle un jeton, la page affiche
 * « actif », et on découvre trois jours plus tard, au milieu d'une mission,
 * qu'il était expiré ou sans le bon droit. « Manzi n'a pas accès à GitHub »
 * est un diagnostic qui doit tenir en un clic, pas en une session SSH.
 *
 * Ne lève jamais et ne renvoie jamais la clé — seulement ce que le service a
 * répondu, tronqué.
 */
export type TestResult = { ok: boolean; message: string };

const TEST_TIMEOUT_MS = 8_000;

async function probe(url: string, headers: Record<string, string>): Promise<{ status: number; body: unknown; texte: string }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TEST_TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers, signal: ctl.signal });
    const texte = (await r.text()).slice(0, 600);
    let body: unknown;
    try { body = JSON.parse(texte); } catch { body = undefined; }
    return { status: r.status, body, texte };
  } finally {
    clearTimeout(t);
  }
}

/** Le message d'erreur du service, sans le reste du corps de réponse. */
function raison(p: { status: number; body: unknown; texte: string }): string {
  const b = p.body as Record<string, unknown> | undefined;
  const m = b && (b.message ?? (b.error as Record<string, unknown> | undefined)?.message ?? b.error);
  return `HTTP ${p.status}${m ? ` — ${String(m).slice(0, 200)}` : ""}`;
}

export async function testProvider(id: string): Promise<TestResult> {
  const row = await getProvider(id);
  if (!row) return { ok: false, message: `${id} introuvable.` };
  if (!row.api_key) return { ok: false, message: `${id} n'a pas de clé : rien à tester.` };
  let key: string;
  try {
    key = decryptSecret(row.api_key);
  } catch {
    return { ok: false, message: `Clé illisible : elle a été chiffrée avec une autre VAULT_KEY. Recolle-la.` };
  }
  const c = config();

  try {
    if (id === "github") {
      const moi = await probe("https://api.github.com/user", { authorization: `Bearer ${key}`, accept: "application/vnd.github+json", "user-agent": "manzi-junior" });
      if (moi.status !== 200) return { ok: false, message: `GitHub refuse la clé : ${raison(moi)}` };
      const login = (moi.body as { login?: string })?.login ?? "?";
      // Un jeton valide qui ne voit pas LE dépôt est un jeton inutile ici :
      // c'est la panne que « accès refusé » ne dit pas.
      const dep = await probe(`https://api.github.com/repos/${c.GITHUB_REPO}`, { authorization: `Bearer ${key}`, accept: "application/vnd.github+json", "user-agent": "manzi-junior" });
      if (dep.status !== 200) return { ok: false, message: `Connecté en tant que ${login}, mais le dépôt ${c.GITHUB_REPO} est inaccessible : ${raison(dep)}. Il manque la portée « repo » (ou l'accès au dépôt) sur ce jeton.` };
      const push = Boolean((dep.body as { permissions?: { push?: boolean } })?.permissions?.push);
      return push
        ? { ok: true, message: `GitHub OK — connecté en tant que ${login}, écriture autorisée sur ${c.GITHUB_REPO}.` }
        : { ok: false, message: `Connecté en tant que ${login}, mais en lecture seule sur ${c.GITHUB_REPO} : l'agent ne pourra pas pousser.` };
    }

    if (id === "vercel") {
      const moi = await probe("https://api.vercel.com/v2/user", { authorization: `Bearer ${key}` });
      if (moi.status !== 200) return { ok: false, message: `Vercel refuse la clé : ${raison(moi)}` };
      const u = (moi.body as { user?: { username?: string; email?: string } })?.user;
      const qui = u?.username ?? u?.email ?? "?";
      // On ÉNUMÈRE les projets au lieu de demander leur nom.
      //
      // Le nom du projet ne se connaît qu'une fois le jeton branché — le
      // réclamer avant, c'est envoyer quelqu'un fouiller une interface qu'il
      // n'a peut-être pas sous la main. Le jeton, lui, sait déjà.
      const liste = await probe("https://api.vercel.com/v9/projects?limit=20", { authorization: `Bearer ${key}` });
      const noms = ((liste.body as { projects?: Array<{ name?: string }> })?.projects ?? []).map((p) => p.name).filter(Boolean) as string[];
      const projet = await vercelProject();

      if (!projet) {
        return noms.length
          ? { ok: true, message: `Vercel OK — ${qui}. Projets visibles : ${noms.join(", ")}. Choisis-en un dans « Projet Vercel à suivre », en bas de page, sinon les déploiements ne seront pas suivis.` }
          : { ok: true, message: `Vercel OK — ${qui}, mais ce jeton ne voit AUCUN projet. Si tes projets appartiennent à une équipe, refais le jeton en choisissant cette équipe dans « Scope ».` };
      }
      const pr = await probe(`https://api.vercel.com/v9/projects/${encodeURIComponent(projet)}`, { authorization: `Bearer ${key}` });
      if (pr.status === 200) return { ok: true, message: `Vercel OK — ${qui}, projet ${projet} visible, déploiements suivis.` };
      return {
        ok: false,
        message: `Connecté en tant que ${qui}, mais « ${projet} » est introuvable.${noms.length ? ` Ce jeton voit : ${noms.join(", ")}. Corrige le nom en bas de page.` : " Ce jeton ne voit aucun projet : s'ils appartiennent à une équipe, refais-le en choisissant cette équipe dans « Scope »."}`,
      };
    }

    if (id === "tavily") {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), TEST_TIMEOUT_MS);
      try {
        const r = await fetch("https://api.tavily.com/search", {
          method: "POST", signal: ctl.signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ api_key: key, query: "test", max_results: 1 }),
        });
        return r.ok ? { ok: true, message: "Tavily OK — la recherche répond." } : { ok: false, message: `Tavily refuse la clé : HTTP ${r.status}` };
      } finally { clearTimeout(t); }
    }

    if (id === "serpapi") {
      const p = await probe(`https://serpapi.com/account?api_key=${encodeURIComponent(key)}`, {});
      const reste = (p.body as { total_searches_left?: number })?.total_searches_left;
      return p.status === 200
        ? { ok: true, message: `SerpAPI OK${reste === undefined ? "" : ` — ${reste} recherche(s) restante(s)`}.` }
        : { ok: false, message: `SerpAPI refuse la clé : ${raison(p)}` };
    }

    if (row.kind === "anthropic") {
      const p = await probe("https://api.anthropic.com/v1/models?limit=1", { "x-api-key": key, "anthropic-version": "2023-06-01" });
      return p.status === 200
        ? { ok: true, message: `${row.label || id} OK — la clé Anthropic est valide.` }
        : { ok: false, message: `Anthropic refuse la clé : ${raison(p)}` };
    }

    if (row.base_url) {
      // `/models` est le seul point d'entrée que tous les endpoints compatibles
      // OpenAI exposent, et il ne consomme pas de jetons.
      const p = await probe(`${row.base_url.replace(/\/+$/, "")}/models`, { authorization: `Bearer ${key}` });
      if (p.status === 200) {
        const liste = (p.body as { data?: Array<{ id?: string }> })?.data ?? [];
        const connu = !row.model || liste.some((m) => m.id === row.model);
        return liste.length && !connu
          ? { ok: false, message: `Clé valide (${liste.length} modèles), mais « ${row.model} » n'est pas dans la liste. Corrige le nom du modèle.` }
          : { ok: true, message: `${row.label || id} OK — clé valide${liste.length ? `, ${liste.length} modèle(s) disponibles` : ""}.` };
      }
      return { ok: false, message: `${row.label || id} refuse la clé : ${raison(p)}` };
    }

    return { ok: false, message: `Pas de test automatique pour « ${id} » : renseigne une adresse d'API pour en avoir un.` };
  } catch (e) {
    const msg = String(e);
    if (/abort/i.test(msg)) return { ok: false, message: `Aucune réponse en ${TEST_TIMEOUT_MS / 1000} s — service injoignable depuis le serveur.` };
    // `fetch failed` tout seul ne dit rien. La vraie panne (DNS, refus de
    // connexion, certificat) est dans `cause` — et c'est elle qu'il faut lire
    // pour savoir si c'est la clé ou le réseau du serveur.
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    const detail = cause?.code ?? cause?.message;
    return { ok: false, message: `Test impossible : ${detail ? `${detail} — le serveur n'a pas pu joindre le service (réseau, DNS ou pare-feu), ce n'est pas la clé.` : msg.slice(0, 200)}` };
  }
}

/* --- Consommation --------------------------------------------------------- */

/**
 * Enregistre un appel. Appelé après chaque réponse de modèle.
 *
 * N'échoue jamais : une écriture de statistique qui ferait tomber une mission
 * serait un comble. La perte d'une ligne coûte une imprécision d'affichage.
 */
export function recordUsage(u: { provider: string; model: string; kind?: string; inputTokens?: number; outputTokens?: number; usd: number; ok?: boolean }): void {
  void db()
    .query(
      `INSERT INTO usage_log(provider, model, kind, input_tokens, output_tokens, usd, ok) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [u.provider, u.model.slice(0, 120), u.kind ?? "", u.inputTokens ?? 0, u.outputTokens ?? 0, u.usd, u.ok ?? true],
    )
    .catch((e) => logger.warn({ err: String(e) }, "consommation non enregistrée"));
}

export type UsageRow = { provider: string; model: string; appels: number; usd: number; tokens: number };

export async function usageByProvider(hours = 24): Promise<UsageRow[]> {
  const r = await db().query<{ provider: string; model: string; appels: string; usd: string; tokens: string }>(
    `SELECT provider, model, count(*) AS appels, coalesce(sum(usd),0) AS usd,
            coalesce(sum(input_tokens + output_tokens),0) AS tokens
     FROM usage_log WHERE ts > now() - ($1 || ' hours')::interval
     GROUP BY provider, model ORDER BY sum(usd) DESC`,
    [String(hours)],
  );
  return r.rows.map((x) => ({ provider: x.provider, model: x.model, appels: Number(x.appels), usd: Number(x.usd), tokens: Number(x.tokens) }));
}

export type MissionCost = { mission: string; modele: string; lancements: number; usd: number; dernier: string };

/**
 * Dépense par MISSION, lue dans `episodes`.
 *
 * `usage_log` dit quel MODÈLE a coûté ; celle-ci dit quel TRAVAIL a coûté, et
 * c'est la question qu'on se pose vraiment devant une facture : « qu'est-ce
 * qui a mangé l'argent cette nuit ? ». Les deux vues sont nécessaires —
 * changer de modèle ne sert à rien si c'est une mission qui boucle.
 *
 * Elle a un autre mérite : `episodes` existait AVANT le panneau. C'est donc
 * la seule vue qui sait répondre pour les journées d'avant son installation.
 */
export async function spendByMission(hours = 24): Promise<MissionCost[]> {
  // `meta` porte le modèle visé depuis toujours : c'est la seule trace qui
  // sache dire QUI a facturé pour les journées d'avant `usage_log`. Elle dit
  // la cible, pas le repli — si la cascade est montée d'un cran, la facture
  // vient du suivant. C'est une piste, pas une preuve, et la colonne par
  // modèle en dessous tranche à partir d'aujourd'hui.
  const r = await db().query<{ mission: string; modele: string | null; lancements: string; usd: string; dernier: string }>(
    `SELECT mission, meta->>'model' AS modele, count(*) AS lancements, coalesce(sum(usd),0) AS usd, max(started_at) AS dernier
     FROM episodes WHERE started_at > now() - ($1 || ' hours')::interval
     GROUP BY mission, meta->>'model' HAVING sum(usd) > 0 ORDER BY sum(usd) DESC LIMIT 30`,
    [String(hours)],
  );
  return r.rows.map((x) => ({ mission: x.mission, modele: x.modele ?? "inconnu", lancements: Number(x.lancements), usd: Number(x.usd), dernier: x.dernier }));
}

/** Dépense par jour sur N jours, pour la courbe du panneau. */
export async function spendByDay(days = 14): Promise<Array<{ jour: string; usd: number }>> {
  const r = await db().query<{ jour: string; usd: string }>(
    `SELECT to_char(ts::date, 'YYYY-MM-DD') AS jour, coalesce(sum(usd),0) AS usd
     FROM usage_log WHERE ts > now() - ($1 || ' days')::interval
     GROUP BY 1 ORDER BY 1`,
    [String(days)],
  );
  return r.rows.map((x) => ({ jour: x.jour, usd: Number(x.usd) }));
}

/**
 * Reprend les fournisseurs du .env au premier démarrage, pour que le panneau
 * ne s'ouvre pas vide sur une installation qui marche déjà. Les clés sont
 * recopiées chiffrées ; le .env reste en place et continue de servir de repli.
 */
export async function seedFromEnv(): Promise<number> {
  if (!vaultEnabled()) return 0;
  const c = config();
  const n = await db().query<{ n: string }>(`SELECT count(*) AS n FROM providers`);
  if (Number(n.rows[0]?.n ?? 0) > 0) return 0;

  const seeds: NewProvider[] = [];
  if (c.MISTRAL_API_KEY) {
    seeds.push({ id: "mistral", label: "Mistral", kind: "openai_compat", baseUrl: c.MISTRAL_BASE_URL, model: c.MODEL_MISTRAL,
                 apiKey: c.MISTRAL_API_KEY, priority: 10, roles: ["chat", "worker"], note: "français et tâches courantes" });
  }
  if (c.OPENAI_COMPAT_API_KEY && c.OPENAI_COMPAT_BASE_URL) {
    seeds.push({ id: "deepseek", label: "DeepSeek", kind: "openai_compat", baseUrl: c.OPENAI_COMPAT_BASE_URL, model: c.MODEL_WORKER,
                 apiKey: c.OPENAI_COMPAT_API_KEY, priority: 20, roles: ["chat", "worker", "planner"], note: "code et maths, bon marché" });
  }
  if (c.ANTHROPIC_API_KEY) {
    seeds.push({ id: "claude", label: "Claude", kind: "anthropic", model: c.MODEL_CRITICAL ?? "claude-sonnet-5",
                 apiKey: c.ANTHROPIC_API_KEY, priority: 30, roles: ["planner", "critical", "chat"], note: "raisonnement lourd et production" });
  }
  // Les services à clé, pour que le panneau serve à quelque chose dès la
  // première ouverture : GitHub et Vercel sont ce que l'agent utilise le plus
  // après les modèles.
  if (c.GITHUB_TOKEN) {
    seeds.push({ id: "github", category: "dev", label: "GitHub", kind: "openai_compat", baseUrl: "https://api.github.com",
                 apiKey: c.GITHUB_TOKEN, priority: 10, note: `dépôt ${c.GITHUB_REPO}` });
  }
  if (c.VERCEL_TOKEN) {
    seeds.push({ id: "vercel", category: "dev", label: "Vercel", kind: "openai_compat", baseUrl: "https://api.vercel.com",
                 apiKey: c.VERCEL_TOKEN, priority: 20, note: c.VERCEL_PROJECT ? `projet ${c.VERCEL_PROJECT}` : "déploiement" });
  }
  if (c.TAVILY_API_KEY) {
    seeds.push({ id: "tavily", category: "recherche", label: "Tavily", kind: "openai_compat", baseUrl: "https://api.tavily.com",
                 apiKey: c.TAVILY_API_KEY, priority: 10, note: "recherche web" });
  }
  if (c.SERPAPI_API_KEY) {
    seeds.push({ id: "serpapi", category: "recherche", label: "SerpAPI", kind: "openai_compat", baseUrl: "https://serpapi.com",
                 apiKey: c.SERPAPI_API_KEY, priority: 20, note: "résultats Google" });
  }

  for (const s of seeds) await putProvider(s).catch((e) => logger.warn({ id: s.id, err: String(e) }, "fournisseur non repris du .env"));
  if (seeds.length) logger.info({ n: seeds.length }, "fournisseurs repris du .env");
  return seeds.length;
}
