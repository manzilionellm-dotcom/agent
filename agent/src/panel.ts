import { config } from "./config.js";
import { dailyBudget, vercelProject } from "./providers.js";
import { spentToday } from "./memory/store.js";
import { CATEGORIES, ROLES, listProviders, spendByDay, spendByMission, usageByProvider, type Category, type MissionCost, type PublicProvider } from "./providers.js";
import { vaultEnabled } from "./vault.js";

/**
 * Le panneau : ajouter, retirer, mettre en pause, prioriser.
 *
 * Ce que ça remplace : une clé d'API vivait dans le .env, donc la changer
 * demandait ssh, un éditeur et un redémarrage. Trois obstacles suffisent pour
 * que personne ne le fasse — et donc pour qu'un fournisseur trop cher tourne
 * un mois de trop, et qu'un fournisseur neuf ne soit jamais essayé.
 *
 * Ici tout est immédiat : coller une clé la met en service en quinze
 * secondes, mettre en pause coupe la dépense sans rien casser, et la colonne
 * « 24 h » dit où part l'argent AVANT la facture.
 *
 * Une clé saisie ici n'est jamais réaffichée — même à son propriétaire. Une
 * page capable de remontrer un secret est une page dont la fuite le révèle.
 */

const LABELS: Record<Category, string> = {
  modele: "Modèles",
  dev: "Développement",
  recherche: "Recherche",
  autre: "Autres services",
};

const AIDE: Record<Category, string> = {
  modele: "Ce qui pense. La priorité décide de l'ordre d'essai ; la cascade ne monte d'un cran que sur un échec.",
  dev: "GitHub, Vercel : ce avec quoi l'agent code et déploie.",
  recherche: "Tavily, SerpAPI : ce avec quoi il cherche sur le web.",
  autre: "Tout le reste — transcription, notifications, ce que tu ajouteras.",
};

export type PanelState = {
  heure: string;
  coffre: boolean;
  depense: { jour: number; plafond: number };
  vercel: string;
  categories: Array<{ id: Category; titre: string; aide: string; services: PublicProvider[] }>;
  consommation: Array<{ provider: string; model: string; appels: number; usd: number; tokens: number }>;
  /** `quand` est déjà formaté ici : le rendu ne doit pas dépendre du fuseau du serveur. */
  missions: Array<MissionCost & { quand: string }>;
  jours: Array<{ jour: string; usd: number }>;
  roles: readonly string[];
};

export async function panelState(): Promise<PanelState> {
  const cfg = config();
  const [tous, conso, missions, jours, jour, plafond, vercel] = await Promise.all([
    listProviders().catch(() => [] as PublicProvider[]),
    usageByProvider(24).catch(() => []),
    spendByMission(24).catch(() => [] as MissionCost[]),
    spendByDay(14).catch(() => []),
    spentToday().catch(() => 0),
    dailyBudget().catch(() => cfg.DAILY_BUDGET_USD),
    vercelProject().catch(() => cfg.VERCEL_PROJECT),
  ]);
  return {
    heure: new Date().toLocaleString("fr-FR", { timeZone: cfg.TZ }),
    coffre: vaultEnabled(),
    depense: { jour, plafond },
    vercel: vercel ?? "",
    categories: CATEGORIES.map((c) => ({ id: c, titre: LABELS[c], aide: AIDE[c], services: tous.filter((s) => s.category === c) })),
    consommation: conso,
    missions: missions.map((m) => ({ ...m, quand: new Date(m.dernier).toLocaleString("fr-FR", { timeZone: cfg.TZ }) })),
    jours,
    roles: ROLES,
  };
}

const CSS = `
:root{color-scheme:light dark;--fg:#141414;--muted:#6b6b6b;--bg:#fafafa;--card:#fff;--line:#e6e6e6;
      --ok:#0a7d3f;--go:#1d5fd0;--warn:#a86400;--bad:#c0392b}
@media(prefers-color-scheme:dark){:root{--fg:#e9e9e9;--muted:#9a9a9a;--bg:#121212;--card:#1b1b1b;--line:#2c2c2c;
      --ok:#3ddc84;--go:#7aa7ff;--warn:#e0a63a;--bad:#ff6b5e}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:58rem;margin:0 auto;padding:1.25rem 1rem 5rem}
header{display:flex;flex-wrap:wrap;align-items:baseline;gap:.75rem;margin-bottom:1.5rem}
h1{font-size:1.25rem;margin:0;letter-spacing:-.01em}
h2{font-size:.82rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:2.25rem 0 .2rem;font-weight:600}
.aide{color:var(--muted);font-size:.85rem;margin:.1rem 0 .7rem}
.maj{color:var(--muted);font-size:.8rem;margin-left:auto}
.notice{border-left:3px solid var(--go);padding:.6rem .9rem;background:color-mix(in srgb,var(--fg) 5%,transparent);border-radius:0 5px 5px 0;margin-bottom:1.25rem}
.notice.warn{border-left-color:var(--warn)}
.notice.bad{border-left-color:var(--bad)}
.notice.bon{border-left-color:var(--ok)}
.tuiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(10rem,1fr));gap:.6rem;margin-bottom:.5rem}
.t{background:var(--card);border:1px solid var(--line);border-radius:9px;padding:.7rem .8rem}
.t b{display:block;font-size:1.3rem;font-weight:600;letter-spacing:-.02em}
.t span{color:var(--muted);font-size:.78rem}
.jauge{height:3px;background:var(--line);border-radius:2px;margin-top:.5rem;overflow:hidden}
.jauge i{display:block;height:100%;background:var(--go)}
.jauge i.warn{background:var(--warn)}.jauge i.bad{background:var(--bad)}
.s{background:var(--card);border:1px solid var(--line);border-radius:9px;padding:.75rem .85rem;margin-bottom:.5rem;
   display:grid;grid-template-columns:1fr auto;gap:.5rem 1rem;align-items:start}
.s.off{opacity:.55}
.s .nom{font-weight:600}
.s .det{color:var(--muted);font-size:.82rem;word-break:break-all}
.s .cout{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.s .cout b{display:block;font-size:1rem}
.s .cout span{color:var(--muted);font-size:.75rem}
.act{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:.4rem;margin-top:.2rem}
.p{display:inline-block;font-size:.7rem;padding:.08em .45em;border-radius:4px;border:1px solid currentColor;font-weight:600}
.ok{color:var(--ok)}.go{color:var(--go)}.warn{color:var(--warn)}.bad{color:var(--bad)}
button{padding:.32rem .7rem;font-size:.82rem;border-radius:6px;border:1px solid var(--line);background:transparent;color:var(--fg);cursor:pointer}
button:hover{border-color:var(--go)}
button.principal{background:var(--go);color:#fff;border-color:transparent;padding:.55rem 1.1rem;font-size:.92rem}
button.danger:hover{border-color:var(--bad);color:var(--bad)}
a.b{display:inline-block;padding:.32rem .7rem;font-size:.82rem;border-radius:6px;border:1px solid var(--line);color:var(--fg);text-decoration:none}
a.b:hover{border-color:var(--go)}
a.b.encours{border-color:var(--go);color:var(--go)}
form.ajout{background:var(--card);border:1px solid var(--line);border-radius:9px;padding:1rem;margin-top:.5rem}
.grille{display:grid;grid-template-columns:repeat(auto-fit,minmax(13rem,1fr));gap:.6rem 1rem}
label{display:block;font-size:.82rem;color:var(--muted);margin-bottom:.5rem}
input,select{display:block;width:100%;margin-top:.25rem;padding:.5rem .6rem;font-size:.95rem;color:var(--fg);
             background:var(--bg);border:1px solid var(--line);border-radius:6px}
input:focus,select:focus{outline:2px solid var(--go);outline-offset:1px;border-color:transparent}
.roles{display:flex;flex-wrap:wrap;gap:.7rem;margin-top:.3rem}
.roles label{display:flex;align-items:center;gap:.3rem;color:var(--fg);font-size:.88rem;margin:0}
.roles input{width:auto;margin:0}
table{width:100%;border-collapse:collapse;font-size:.87rem;background:var(--card);border:1px solid var(--line);border-radius:9px;overflow:hidden}
td,th{padding:.5rem .7rem;text-align:left;border-top:1px solid var(--line)}
th{font-size:.7rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);border-top:none;font-weight:600}
td.n{text-align:right;font-variant-numeric:tabular-nums}
.barres{display:flex;align-items:flex-end;gap:3px;height:56px;margin:.4rem 0 .2rem}
.barres div{flex:1;background:var(--go);border-radius:2px 2px 0 0;min-height:2px;opacity:.85}
.vide{color:var(--muted);font-size:.88rem;padding:.7rem 0}
.liens{margin-top:2.5rem;font-size:.85rem}
.liens a{color:var(--muted);margin-right:1.1rem}
`;

const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function bouton(action: string, id: string, texte: string, classe = ""): string {
  return `<form method="post" style="display:inline"><input type="hidden" name="op" value="${action}"><input type="hidden" name="id" value="${esc(id)}">` +
         `<button class="${classe}"${action === "delete" ? ` onclick="return confirm('Supprimer ${esc(id)} ?')"` : ""}>${texte}</button></form>`;
}

function service(s: PublicProvider, enEdition: boolean): string {
  const etat = !s.enabled ? `<span class="p warn">en pause</span>`
    : s.over_cap ? `<span class="p bad">plafond atteint</span>`
    : !s.has_key ? `<span class="p bad">sans clé</span>`
    : `<span class="p ok">actif</span>`;
  const det = [s.model, s.base_url, s.category === "modele" ? s.roles : "", s.note].filter(Boolean).join(" · ");
  return `<div class="s${s.enabled && s.has_key ? "" : " off"}">
  <div><div class="nom">${esc(s.label || s.id)} ${etat} <span class="p">p${s.priority}</span></div>
       <div class="det">${esc(det)}</div></div>
  <div class="cout"><b>${s.spend24h.toFixed(2)} $</b><span>24 h${s.daily_cap_usd > 0 ? ` / ${s.daily_cap_usd} $` : ""}</span>
       <span>${s.spend30d.toFixed(2)} $ sur 30 j</span></div>
  <div class="act">
    <a class="b${enEdition ? " encours" : ""}" href="/panel?edit=${encodeURIComponent(s.id)}#formulaire">Modifier</a>
    ${s.has_key ? bouton("test", s.id, "Tester la clé") : ""}
    ${bouton(s.enabled ? "pause" : "reprendre", s.id, s.enabled ? "Mettre en pause" : "Réactiver")}
    ${bouton("up", s.id, "▲ prioriser")}
    ${bouton("down", s.id, "▼ reculer")}
    ${bouton("delete", s.id, "Supprimer", "danger")}
  </div></div>`;
}

/**
 * @param edit identifiant d'un service à charger dans le formulaire.
 *
 * Sans lui, le formulaire repartait de ses valeurs par défaut à chaque fois.
 * Taper l'identifiant d'un service existant pour corriger une note remettait
 * donc la priorité à 50, les rôles à « chat,worker » et — le pire — le
 * plafond de dépense à 0, c'est-à-dire aucune limite. Le formulaire promettait
 * une modification et livrait un remplacement.
 */
export function panelPage(st: PanelState, notice = "", edit = "", ton: "" | "bon" | "bad" = ""): string {
  const tous = st.categories.flatMap((c) => c.services);
  const e = edit ? tous.find((s) => s.id === edit) : undefined;
  const rolesEdit = e ? e.roles.split(",").map((r) => r.trim()) : [];
  const sel = (a: string, b: string): string => (a === b ? " selected" : "");
  const part = st.depense.plafond ? Math.min(100, (st.depense.jour / st.depense.plafond) * 100) : 0;
  const cls = part > 90 ? "bad" : part > 60 ? "warn" : "";
  const actifs = st.categories.flatMap((c) => c.services).filter((s) => s.enabled && s.has_key).length;
  const total24 = st.consommation.reduce((a, x) => a + x.usd, 0);
  const max = Math.max(0.0001, ...st.jours.map((j) => j.usd));

  const cats = st.categories
    .map(
      (c) => `<h2>${c.titre}</h2><p class="aide">${c.aide}</p>` +
        (c.services.length ? c.services.map((s) => service(s, s.id === edit)).join("") : `<p class="vide">Aucun service dans cette catégorie.</p>`),
    )
    .join("");

  const parMission = st.missions.length
    ? `<table><tr><th>Travail</th><th class="n">Lancements</th><th class="n">Coût</th><th>Dernier</th></tr>` +
      st.missions
        .map((m) => `<tr><td>${esc(m.mission)}</td><td class="n">${m.lancements}</td><td class="n">${m.usd.toFixed(3)} $</td>` +
                    `<td class="det">${esc(m.quand)}</td></tr>`)
        .join("") + `</table>`
    : `<p class="vide">Aucune mission facturée dans les 24 dernières heures.</p>`;

  const conso = st.consommation.length
    ? `<table><tr><th>Service</th><th>Modèle</th><th class="n">Appels</th><th class="n">Jetons</th><th class="n">Coût</th></tr>` +
      st.consommation
        .map((x) => `<tr><td>${esc(x.provider)}</td><td class="det">${esc(x.model)}</td><td class="n">${x.appels}</td>` +
                    `<td class="n">${x.tokens.toLocaleString("fr-FR")}</td><td class="n">${x.usd.toFixed(3)} $</td></tr>`)
        .join("") + `</table>`
    : `<p class="vide">Aucun appel dans les 24 dernières heures.</p>`;

  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Manzi Junior — panneau</title><meta name="robots" content="noindex">
<style>${CSS}</style></head><body><main>
<header><h1>Panneau</h1><span class="maj">à jour · ${esc(st.heure)}</span></header>

${notice ? `<p class="notice${ton ? ` ${ton}` : ""}">${esc(notice)}</p>` : ""}
${st.coffre ? "" : `<p class="notice warn">VAULT_KEY absente du .env : impossible de chiffrer une clé, donc impossible d'en enregistrer une ici. Génère-la avec <code>openssl rand -base64 32</code>.</p>`}
${st.depense.jour >= st.depense.plafond ? `<p class="notice bad">Plafond du jour atteint (${st.depense.jour.toFixed(2)} $ sur ${st.depense.plafond} $) : l'agent refuse de lancer une mission jusqu'à minuit. Relève-le en bas de page, ou laisse-le couper si c'est voulu.</p>` : ""}
${st.depense.jour > 0 && total24 === 0 ? `<p class="notice warn">« Dépensé aujourd'hui » vient du compteur global, qui existait avant ce panneau. Le détail par service, lui, ne compte que depuis l'installation du panneau : c'est pour ça que les deux chiffres ne collent pas encore. Ils se rejoindront d'ici 24 h.</p>` : ""}

<div class="tuiles">
  <div class="t"><b>${st.depense.jour.toFixed(2)} $</b><span>dépensé aujourd'hui · plafond ${st.depense.plafond} $</span>
    <div class="jauge"><i class="${cls}" style="width:${part}%"></i></div></div>
  <div class="t"><b>${actifs}</b><span>service(s) actif(s)</span></div>
  <div class="t"><b>${total24.toFixed(2)} $</b><span>sur 24 h, tous services</span></div>
  <div class="t"><b>${st.jours.reduce((a, j) => a + j.usd, 0).toFixed(2)} $</b><span>sur 14 jours</span>
    <div class="barres">${st.jours.map((j) => `<div style="height:${Math.max(2, (j.usd / max) * 100)}%" title="${esc(j.jour)} · ${j.usd.toFixed(2)} $"></div>`).join("")}</div></div>
</div>

${cats}

<h2 id="formulaire">${e ? `Modifier « ${esc(e.label || e.id)} »` : "Ajouter un service"}</h2>
<p class="aide">${e
  ? `Les champs portent les valeurs actuelles : ce que tu ne touches pas reste tel quel. La clé, elle, n'est jamais réaffichée — laisse-la vide pour garder celle qui est en place.`
  : `Pour en modifier un existant, clique « Modifier » sur sa carte plutôt que de retaper son identifiant ici : ce formulaire-ci part des valeurs par défaut et les écraserait.`}</p>
<form class="ajout" method="post" autocomplete="off">
  <input type="hidden" name="op" value="put">
  <div class="grille">
    <label>Identifiant<input name="id" placeholder="groq" required value="${esc(e?.id ?? "")}"${e ? " readonly" : ""} ${st.coffre ? "" : "disabled"}></label>
    <label>Nom affiché<input name="label" placeholder="Groq" value="${esc(e?.label ?? "")}" ${st.coffre ? "" : "disabled"}></label>
    <label>Catégorie<select name="category" ${st.coffre ? "" : "disabled"}>
      <option value="modele"${sel(e?.category ?? "modele", "modele")}>Modèle</option><option value="dev"${sel(e?.category ?? "", "dev")}>Développement</option>
      <option value="recherche"${sel(e?.category ?? "", "recherche")}>Recherche</option><option value="autre"${sel(e?.category ?? "", "autre")}>Autre</option></select></label>
    <label>Type d'API<select name="kind" ${st.coffre ? "" : "disabled"}>
      <option value="openai_compat"${sel(e?.kind ?? "openai_compat", "openai_compat")}>Compatible OpenAI</option><option value="anthropic"${sel(e?.kind ?? "", "anthropic")}>Anthropic</option></select></label>
    <label>Adresse de l'API<input name="baseUrl" placeholder="https://api.groq.com/openai/v1" value="${esc(e?.base_url ?? "")}" ${st.coffre ? "" : "disabled"}></label>
    <label>Modèle<input name="model" placeholder="llama-3.3-70b-versatile" value="${esc(e?.model ?? "")}" ${st.coffre ? "" : "disabled"}></label>
    <label>Clé d'API<input name="apiKey" type="password" placeholder="${e?.has_key ? "(enregistrée — inchangée si vide)" : "colle-la ici"}" ${st.coffre ? "" : "disabled"}></label>
    <label>Priorité <span class="det">(1 = essayé en premier)</span><input name="priority" type="number" min="1" max="99" value="${e?.priority ?? 50}" ${st.coffre ? "" : "disabled"}></label>
    <label>Plafond 24 h en $ <span class="det">(0 = aucun)</span><input name="dailyCap" type="number" min="0" step="0.5" value="${e?.daily_cap_usd ?? 0}" ${st.coffre ? "" : "disabled"}></label>
    <label>Note<input name="note" placeholder="à quoi il sert" value="${esc(e?.note ?? "")}" ${st.coffre ? "" : "disabled"}></label>
  </div>
  <label>Rôles <span class="det">(modèles seulement)</span>
    <span class="roles">${st.roles.map((r) => `<label><input type="checkbox" name="roles" value="${r}"${(e ? rolesEdit.includes(r) : r === "chat" || r === "worker") ? " checked" : ""} ${st.coffre ? "" : "disabled"}> ${r}</label>`).join("")}</span>
  </label>
  <button class="principal" ${st.coffre ? "" : "disabled"}>Enregistrer</button>
  ${e ? `<a class="b" href="/panel" style="margin-left:.6rem">Annuler</a>` : ""}
</form>

<h2>Qui a coûté, 24 dernières heures</h2>
<p class="aide">Par travail. C'est la question qu'on se pose devant une facture : changer de modèle ne sert à rien si c'est une mission qui boucle.</p>
${parMission}

<h2>Par modèle, 24 dernières heures</h2>
<p class="aide">Le même argent, vu de l'autre côté : quel fournisseur l'a encaissé.</p>
${conso}

<h2>Projet Vercel à suivre</h2>
<p class="aide">Après un push, l'agent attend le déploiement de CE projet et te rend son adresse. Tu n'as pas à le deviner : branche le jeton Vercel, clique « Tester la clé » sur sa carte, et la liste des projets que le jeton voit s'affiche en haut de cette page.</p>
<form class="ajout" method="post">
  <input type="hidden" name="op" value="vercel">
  <div class="grille"><label>Nom du projet <span class="det">(vide = aucun suivi)</span><input name="projet" placeholder="mon-site" value="${esc(st.vercel)}"></label></div>
  <button class="principal">Enregistrer le projet</button>
</form>

<h2>Plafond journalier</h2>
<p class="aide">Global, tous services confondus. Au-delà, l'agent refuse de lancer une mission — c'est le garde-fou qui empêche une boucle de coûter une nuit entière.</p>
<form class="ajout" method="post">
  <input type="hidden" name="op" value="budget">
  <div class="grille"><label>Plafond en $ par jour<input name="daily" type="number" min="0.5" step="0.5" value="${st.depense.plafond}"></label></div>
  <button class="principal">Changer le plafond</button>
</form>

<div class="liens"><a href="/board">Tableau de bord</a><a href="/vault">Coffre</a><a href="/screen">Écran</a></div>
</main></body></html>`;
}
