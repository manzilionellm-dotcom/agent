import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { db } from "./memory/db.js";
import { surLog } from "./logger.js";
import { redactSecrets } from "./safety.js";

/**
 * La boîte noire : tout ce que fait le bot, enregistré étape par étape.
 *
 * Avant, une panne se reconstituait à partir de trois morceaux qui ne se
 * parlaient pas : la conversation (ce qu'il a dit), `usage_log` (ce qu'il a
 * payé) et les journaux Docker (ce qui a planté) — ces derniers perdus au
 * premier redémarrage, et hors de portée d'un téléphone. On savait QU'il
 * avait raté, jamais OÙ.
 *
 * Ici, chaque travail — une conversation, une mission, un rappel, un e-mail —
 * est une trace, et tout ce qui s'y passe s'y accroche tout seul, même au
 * fond d'un outil appelé par un modèle appelé par une tâche : le contexte
 * suit le fil d'exécution (AsyncLocalStorage), aucun appelant n'a à le
 * transmettre. Ouvrir une trace, c'est relire la minute exacte : message
 * reçu, modèle essayé, outil lancé avec quoi, réponse, erreur, durée, coût.
 *
 * Trois règles :
 * - elle n'arrête jamais ce qu'elle observe : toute écriture est détachée,
 *   toute erreur d'écriture avalée ;
 * - elle ne garde aucun secret : tout passe par `caviarder` avant la base ;
 * - elle ne s'observe pas elle-même : ses pannes vont sur la console, pas au
 *   journal — sinon une base en panne écrirait une erreur qui écrirait une
 *   erreur, sans fin.
 */

export type TypeTrace = "conversation" | "mission" | "tache" | "rappel" | "email" | "inspection";
export type TypeEtape = "entree" | "reponse" | "modele" | "outil" | "livraison" | "log" | "mission" | "erreur" | "systeme";

export const TYPES_TRACE: Record<TypeTrace, string> = {
  conversation: "Conversation",
  mission: "Mission",
  tache: "Tâche d'agent",
  rappel: "Rappel / tâche planifiée",
  email: "E-mail surveillé",
  inspection: "Inspection",
};

type Contexte = { id: string; debut: number; etapes: number; erreurs: number; usd: number };
const fil = new AsyncLocalStorage<Contexte>();

export function traceCourante(): string | undefined {
  return fil.getStore()?.id;
}

/* --- Caviardage -------------------------------------------------------------- */

const MOTIFS: Array<[RegExp, string | ((m: string) => string)]> = [
  // Formats de clés connus : Anthropic, OpenAI, GitHub, xAI, Google, Tavily, Meta.
  [/\b(?:sk-ant-[\w-]{10,}|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xai-[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}|tvly-[A-Za-z0-9_-]{10,}|EAA[A-Za-z0-9]{30,}|ya29\.[\w.-]{20,})/g, "[clé masquée]"],
  [/\bBearer\s+[\w.~+/-]+=*/gi, "Bearer [masqué]"],
  // Un lien de panneau porte un ticket : il ouvre la session à qui le lit.
  [/([?&](?:t|token|key|api_key|apikey|access_token|code|sig|signature)=)[^&\s"'<>]+/gi, "$1[masqué]"],
  [/\b((?:mot de passe|password|passwd|mdp|pwd|passcode)\s*[:=]\s*)\S+/gi, "$1[masqué]"],
  // Tout long jeton mêlant lettres et chiffres : un format de clé qu'on ne
  // connaît pas encore reste un secret.
  [/\b[A-Za-z0-9_-]{40,}\b/g, (m) => (/\d/.test(m) && /[A-Za-z]/.test(m) ? "[jeton masqué]" : m)],
  // Numéros de téléphone : avec + et espaces, ou longue suite de chiffres.
  [/\+\d[\d ]{8,16}\d/g, "[numéro]"],
  [/\b\d{10,15}\b/g, "[numéro]"],
];

export function caviarder(s: string): string {
  // D'abord les secrets EXACTS du serveur (jeton WhatsApp, clé du coffre…) :
  // ceux-là n'ont pas toujours un format reconnaissable.
  let r = s;
  try {
    r = redactSecrets(r);
  } catch {
    /* configuration illisible : les motifs ci-dessous restent */
  }
  for (const [re, par] of MOTIFS) r = r.replace(re, par as never);
  return r;
}

function texte(v: unknown, max: number): string {
  if (v === undefined || v === null) return "";
  let s: string;
  if (typeof v === "string") s = v;
  else {
    try {
      s = JSON.stringify(v, (_k, x) => (typeof x === "string" && x.length > 1500 ? `${x.slice(0, 1500)}…` : x));
    } catch {
      s = String(v);
    }
  }
  s = caviarder(s);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/* --- Écriture ------------------------------------------------------------------ */

let dernierePanne = 0;
function panne(e: unknown): void {
  // Console et non journal : voir l'en-tête. Une fois par minute au plus.
  if (Date.now() - dernierePanne < 60_000) return;
  dernierePanne = Date.now();
  console.error(`[boîte noire] écriture impossible : ${String(e).slice(0, 200)}`);
}

export type Etape = {
  type: TypeEtape;
  titre: string;
  detail?: unknown;
  ok?: boolean;
  niveau?: "info" | "warn" | "error";
  dureeMs?: number;
  usd?: number;
  /** Forcer la trace (fin de trace, après que le contexte est sorti). */
  trace?: string | null;
};

export function enregistrer(e: Etape): void {
  const ctx = fil.getStore();
  const trace = e.trace !== undefined ? e.trace : ctx?.id ?? null;
  const ok = e.ok ?? true;
  const niveau = e.niveau ?? (ok ? "info" : "error");
  if (ctx && trace === ctx.id) {
    ctx.etapes++;
    if (!ok || niveau === "error") ctx.erreurs++;
    ctx.usd += e.usd ?? 0;
  }
  void db()
    .query(
      `INSERT INTO boite_noire(trace_id, type, niveau, titre, detail, ok, duree_ms, usd) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [trace, e.type, niveau, texte(e.titre, 200), texte(e.detail, 4000), ok, e.dureeMs === undefined ? null : Math.round(e.dureeMs), e.usd ?? 0],
    )
    .catch(panne);
}

function nouvelId(): string {
  return `t${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
}

/**
 * Exécute `fn` dans une trace. Déjà dans une trace (un rappel qui passe par
 * la conversation, une tâche qui lance une mission) : on reste dans celle-ci,
 * pour que le travail entier se relise d'un seul tenant.
 */
export async function dansTrace<T>(type: TypeTrace, titre: string, fn: () => Promise<T>): Promise<T> {
  if (fil.getStore()) return fn();
  const ctx: Contexte = { id: nouvelId(), debut: Date.now(), etapes: 0, erreurs: 0, usd: 0 };
  const debut = new Date(ctx.debut);
  // Insertion ET clôture en « upsert » : elles partent sur deux connexions et
  // peuvent arriver dans le désordre ; aucune des deux ne doit se perdre.
  void db()
    .query(`INSERT INTO traces(id, type, titre, debut) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`, [ctx.id, type, texte(titre, 200), debut])
    .catch(panne);
  let ok = true;
  try {
    return await fil.run(ctx, fn);
  } catch (e) {
    ok = false;
    ctx.erreurs++;
    enregistrer({ type: "erreur", titre: "Le travail a planté", detail: String(e instanceof Error ? e.stack ?? e.message : e), ok: false, trace: ctx.id });
    throw e;
  } finally {
    void db()
      .query(
        `INSERT INTO traces(id, type, titre, debut, fin, ok, etapes, erreurs, usd) VALUES ($1,$2,$3,$4,now(),$5,$6,$7,$8)
         ON CONFLICT (id) DO UPDATE SET fin=now(), ok=EXCLUDED.ok, etapes=EXCLUDED.etapes, erreurs=EXCLUDED.erreurs, usd=EXCLUDED.usd`,
        [ctx.id, type, texte(titre, 200), debut, ok, ctx.etapes, ctx.erreurs, ctx.usd],
      )
      .catch(panne);
  }
}

/* --- Outils ---------------------------------------------------------------------- */

const instrumentes = new WeakSet<object>();

/** Heuristique : beaucoup d'outils rendent leur échec en texte au lieu de lever. */
const ECHEC_TEXTE = /^\s*(error|erreur|échec|echec|impossible|refus|introuvable|failed)\b/i;

function apercuSortie(r: unknown): { texte: string; echec: boolean } {
  if (typeof r === "string") return { texte: r.slice(0, 800), echec: ECHEC_TEXTE.test(r) };
  if (Array.isArray(r)) {
    const t = r
      .map((b: { type?: string; text?: string }) => (b?.type === "text" ? b.text ?? "" : b?.type === "image" ? "[image]" : `[${b?.type ?? "?"}]`))
      .join(" ");
    return { texte: t.slice(0, 800), echec: ECHEC_TEXTE.test(t) };
  }
  return { texte: texte(r, 800), echec: false };
}

/**
 * Chaque outil passé à un modèle est enveloppé : on note ce qu'il a reçu, ce
 * qu'il a rendu, en combien de temps, et s'il a échoué. L'objet d'origine
 * n'est pas modifié ; la marque vit dans un WeakSet et non dans une
 * propriété, parce que la définition d'outil part telle quelle à l'API — un
 * champ en trop et c'est l'appel entier qui est refusé.
 */
export function instrumenter<T>(outils: T[]): T[] {
  return outils.map((t) => {
    const o = t as unknown as { name?: string; run?: (...a: unknown[]) => unknown };
    if (!o || typeof o.run !== "function" || instrumentes.has(o)) return t;
    const origine = o.run;
    const nom = o.name ?? "outil";
    const enveloppe = Object.assign(Object.create(Object.getPrototypeOf(o)), o, {
      run: async (...args: unknown[]) => {
        const debut = Date.now();
        try {
          const r = await origine.apply(o, args);
          const s = apercuSortie(r);
          enregistrer({ type: "outil", titre: nom, detail: { entree: args[0], sortie: s.texte }, ok: !s.echec, niveau: s.echec ? "warn" : "info", dureeMs: Date.now() - debut });
          return r;
        } catch (e) {
          enregistrer({ type: "outil", titre: nom, detail: { entree: args[0], erreur: String(e).slice(0, 1500) }, ok: false, dureeMs: Date.now() - debut });
          throw e;
        }
      },
    });
    instrumentes.add(enveloppe);
    return enveloppe as T;
  });
}

/* --- Journal ---------------------------------------------------------------------- */

surLog((niveau, objet, message) => {
  enregistrer({
    type: "log",
    titre: message || "(sans message)",
    detail: objet,
    ok: niveau < 50,
    niveau: niveau >= 50 ? "error" : "warn",
  });
});

/* --- Démarrage ---------------------------------------------------------------------- */

/**
 * Au démarrage : tout travail resté sans fin a été coupé par l'arrêt
 * précédent — crash, redémarrage, mise à jour. C'est la seule trace qu'un
 * crash laisse ; on la rend visible au lieu de la laisser pourrir « en cours ».
 */
export async function ouvrirBoiteNoire(): Promise<number> {
  const r = await db().query(`UPDATE traces SET interrompue=true, ok=false WHERE fin IS NULL AND NOT interrompue`);
  const n = r.rowCount ?? 0;
  enregistrer({ type: "systeme", titre: "Démarrage", detail: n ? `${n} travail(aux) coupé(s) net par l'arrêt précédent` : "arrêt précédent propre", ok: n === 0, niveau: n ? "warn" : "info" });
  return n;
}

export async function purgerBoiteNoire(jours: number): Promise<number> {
  const j = String(Math.max(1, Math.round(jours)));
  const a = await db().query(`DELETE FROM boite_noire WHERE ts < now() - ($1 || ' days')::interval`, [j]);
  await db().query(`DELETE FROM traces WHERE debut < now() - ($1 || ' days')::interval`, [j]);
  return a.rowCount ?? 0;
}

export async function viderBoiteNoire(): Promise<void> {
  await db().query(`DELETE FROM boite_noire`);
  await db().query(`DELETE FROM traces`);
}

/* --- Lecture ------------------------------------------------------------------------ */

export type TraceResume = {
  id: string; type: string; titre: string; debut: string; fin: string | null; ok: boolean | null;
  interrompue: boolean; etapes: number; erreurs: number; usd: number; duree_ms: number;
};

export type EtapeLue = { id: number; ts: string; type: string; niveau: string; titre: string; detail: string; ok: boolean; duree_ms: number | null; usd: number };

export type Filtre = { type?: string; etat?: "tous" | "erreurs" | "interrompus"; q?: string; heures?: number };

export const PERIODES: Record<string, string> = { "1": "1 heure", "24": "24 heures", "168": "7 jours", "720": "30 jours" };

const echapperLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function listerTraces(f: Filtre = {}, limite = 50): Promise<TraceResume[]> {
  const r = await db().query<TraceResume & { usd: string; duree_ms: string }>(
    `SELECT id, type, titre, debut, fin, ok, interrompue, etapes, erreurs, usd,
            round(extract(epoch FROM (coalesce(fin, now()) - debut)) * 1000) AS duree_ms
     FROM traces t
     WHERE debut > now() - ($1 || ' hours')::interval
       AND ($2 = '' OR type = $2)
       AND ($3 = 'tous' OR ($3 = 'erreurs' AND (ok = false OR erreurs > 0)) OR ($3 = 'interrompus' AND interrompue))
       AND ($4 = '' OR titre ILIKE '%' || $4 || '%'
            OR EXISTS (SELECT 1 FROM boite_noire b WHERE b.trace_id = t.id AND (b.titre ILIKE '%' || $4 || '%' OR b.detail ILIKE '%' || $4 || '%')))
     ORDER BY debut DESC LIMIT $5`,
    [String(f.heures ?? 24), f.type ?? "", f.etat ?? "tous", echapperLike((f.q ?? "").trim().slice(0, 100)), Math.min(limite, 200)],
  );
  return r.rows.map((x) => ({ ...x, usd: Number(x.usd), duree_ms: Number(x.duree_ms) }));
}

export async function lireTrace(id: string): Promise<{ trace: TraceResume; etapes: EtapeLue[] } | undefined> {
  if (!/^t[a-z0-9]{6,20}$/.test(id)) return undefined;
  const t = (await listerTracesParId([id]))[0];
  if (!t) return undefined;
  const r = await db().query<EtapeLue & { usd: string }>(
    `SELECT id, ts, type, niveau, titre, detail, ok, duree_ms, usd FROM boite_noire WHERE trace_id=$1 ORDER BY id LIMIT 400`,
    [id],
  );
  return { trace: t, etapes: r.rows.map((x) => ({ ...x, usd: Number(x.usd) })) };
}

async function listerTracesParId(ids: string[]): Promise<TraceResume[]> {
  const r = await db().query<TraceResume & { usd: string; duree_ms: string }>(
    `SELECT id, type, titre, debut, fin, ok, interrompue, etapes, erreurs, usd,
            round(extract(epoch FROM (coalesce(fin, now()) - debut)) * 1000) AS duree_ms
     FROM traces WHERE id = ANY($1)`,
    [ids],
  );
  return r.rows.map((x) => ({ ...x, usd: Number(x.usd), duree_ms: Number(x.duree_ms) }));
}

/** Ce qui s'est mal passé HORS de tout travail : démarrage, boucles de fond. */
export async function incidentsHorsTrace(heures = 24, limite = 30): Promise<EtapeLue[]> {
  const r = await db().query<EtapeLue & { usd: string }>(
    `SELECT id, ts, type, niveau, titre, detail, ok, duree_ms, usd FROM boite_noire
     WHERE trace_id IS NULL AND (niveau <> 'info' OR NOT ok) AND ts > now() - ($1 || ' hours')::interval
     ORDER BY id DESC LIMIT $2`,
    [String(heures), limite],
  );
  return r.rows.map((x) => ({ ...x, usd: Number(x.usd) }));
}

export type StatsBN = { travaux: number; enErreur: number; interrompus: number; appelsIA: number; outils: number; erreurs: number; reponseMediane: number; usd: number };

export async function statsBoiteNoire(heures = 24): Promise<StatsBN> {
  const h = String(heures);
  const [t, e, m] = await Promise.all([
    db().query<{ n: string; ko: string; coupes: string; usd: string }>(
      `SELECT count(*) AS n, count(*) FILTER (WHERE ok = false OR erreurs > 0) AS ko, count(*) FILTER (WHERE interrompue) AS coupes, coalesce(sum(usd),0) AS usd
       FROM traces WHERE debut > now() - ($1 || ' hours')::interval`, [h]),
    db().query<{ ia: string; outils: string; erreurs: string }>(
      `SELECT count(*) FILTER (WHERE type='modele') AS ia, count(*) FILTER (WHERE type='outil') AS outils,
              count(*) FILTER (WHERE NOT ok OR niveau='error') AS erreurs
       FROM boite_noire WHERE ts > now() - ($1 || ' hours')::interval`, [h]),
    db().query<{ med: string | null }>(
      `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (fin - debut))) AS med
       FROM traces WHERE type='conversation' AND fin IS NOT NULL AND debut > now() - ($1 || ' hours')::interval`, [h]),
  ]);
  return {
    travaux: Number(t.rows[0]?.n ?? 0),
    enErreur: Number(t.rows[0]?.ko ?? 0),
    interrompus: Number(t.rows[0]?.coupes ?? 0),
    usd: Number(t.rows[0]?.usd ?? 0),
    appelsIA: Number(e.rows[0]?.ia ?? 0),
    outils: Number(e.rows[0]?.outils ?? 0),
    erreurs: Number(e.rows[0]?.erreurs ?? 0),
    reponseMediane: Number(m.rows[0]?.med ?? 0),
  };
}

/* --- Rendu texte ------------------------------------------------------------------------ */

export const secondes = (ms: number | null | undefined): string =>
  ms === null || ms === undefined ? "" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0).replace(".", ",")} s`;

/**
 * Une trace en texte brut, prête à coller à un développeur (ou à Claude
 * Code) : c'est ce qui transforme « il a encore raté » en panne réparable.
 */
export function traceEnTexte(t: { trace: TraceResume; etapes: EtapeLue[] }, maxDetail = 600): string {
  const d0 = new Date(t.trace.debut).getTime();
  const etat = t.trace.interrompue ? "COUPÉE NET (arrêt pendant le travail)" : t.trace.ok === false ? "ÉCHEC" : t.trace.erreurs ? `${t.trace.erreurs} erreur(s)` : "OK";
  const lignes = [
    `Trace ${t.trace.id} — ${TYPES_TRACE[t.trace.type as TypeTrace] ?? t.trace.type} — ${new Date(t.trace.debut).toISOString()}`,
    `« ${t.trace.titre} »`,
    `Durée ${secondes(t.trace.duree_ms)} · ${t.trace.etapes} étapes · ${etat} · ${t.trace.usd.toFixed(4)} $`,
    "",
  ];
  for (const e of t.etapes) {
    const decal = `+${((new Date(e.ts).getTime() - d0) / 1000).toFixed(1)}s`.padEnd(8);
    const marque = e.ok && e.niveau !== "error" ? (e.niveau === "warn" ? "⚠" : "✓") : "✗";
    lignes.push(`${decal} ${marque} ${e.type.padEnd(9)} ${e.titre}${e.duree_ms !== null ? ` (${secondes(e.duree_ms)})` : ""}${e.usd ? ` ${e.usd.toFixed(4)} $` : ""}`);
    if (e.detail) lignes.push(`           ${e.detail.slice(0, maxDetail).replace(/\n/g, "\n           ")}`);
  }
  return lignes.join("\n");
}
