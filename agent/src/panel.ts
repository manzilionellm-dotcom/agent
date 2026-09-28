import { config } from "./config.js";
import { dailyBudget, plafondTexte, vercelProject } from "./providers.js";
import { spentToday } from "./memory/store.js";
import { CATEGORIES, DEPOT_IDS, ROLES, listProviders, spendByDay, spendByMission, usageByProvider, type Category, type MissionCost, type PublicProvider } from "./providers.js";
import { approbationsActives } from "./channels/approvals.js";
import { CARACTERES, EMOJIS, LANGUES, LIBRE_MAX, LONGUEURS, NOM_MAX, REFLEXIONS, REGLES_MAX, blocPersonnalite, personnalite, type Personnalite } from "./personality.js";
import { VOIX_MODES, voixReglages, type VoixReglages } from "./voice.js";
import { LANGUES_ECOUTE, langueEcoute, sourceEcoute } from "./ecoute.js";
import { MDP_MIN, motDePasseDefini } from "./login.js";
import { screenAlive } from "./screen.js";
import { ecranBranche } from "./navigator.js";
import { menuPanneau } from "./panel-sections.js";
import { SITES } from "./browsing/sites.js";
import { listCredentials, vaultEnabled, type PublicCredential } from "./vault.js";
import { CSS_DIAG, diagState, lireVue, sectionBoiteNoire, sectionDiagnostic, type DiagState, type VueBN } from "./panel-diagnostic.js";
import { PRESETS } from "./llm/aiguillage.js";
import { plusState, sectionCompetences, sectionCrochets, sectionDeclencheurs, sectionImages, sectionMemoire, sectionRappels, sectionRefus, type PlusState } from "./panel-plus.js";

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
  approbations: boolean;
  perso: Personnalite;
  voix: VoixReglages & { service: boolean };
  ecoute: { source?: string; fournisseur: string; langue: string };
  mdp: boolean;
  navigateur: { vivant: boolean; branche: boolean; comptes: PublicCredential[] };
  plus: PlusState;
  diag: DiagState;
  categories: Array<{ id: Category; titre: string; aide: string; services: PublicProvider[] }>;
  consommation: Array<{ provider: string; model: string; appels: number; usd: number; tokens: number }>;
  /** `quand` est déjà formaté ici : le rendu ne doit pas dépendre du fuseau du serveur. */
  missions: Array<MissionCost & { quand: string }>;
  jours: Array<{ jour: string; usd: number }>;
  roles: readonly string[];
};

export async function panelState(vue: VueBN = lireVue(new URLSearchParams())): Promise<PanelState> {
  const cfg = config();
  const [tous, conso, missions, jours, jour, plafond, vercel, approbations, perso, voix, mdp, vivant, comptes, plus, diag, ecoute, langue] = await Promise.all([
    listProviders().catch(() => [] as PublicProvider[]),
    usageByProvider(24).catch(() => []),
    spendByMission(24).catch(() => [] as MissionCost[]),
    spendByDay(14).catch(() => []),
    spentToday().catch(() => 0),
    dailyBudget().catch(() => cfg.DAILY_BUDGET_USD),
    vercelProject().catch(() => cfg.VERCEL_PROJECT),
    approbationsActives().catch(() => true),
    personnalite(),
    voixReglages(),
    motDePasseDefini().catch(() => false),
    screenAlive().catch(() => false),
    listCredentials().catch(() => [] as PublicCredential[]),
    plusState(),
    diagState(vue),
    sourceEcoute().catch(() => undefined),
    langueEcoute().catch(() => "fr"),
  ]);
  return {
    heure: new Date().toLocaleString("fr-FR", { timeZone: cfg.TZ }),
    coffre: vaultEnabled(),
    depense: { jour, plafond },
    vercel: vercel ?? "",
    approbations,
    perso,
    voix: { ...voix, service: tous.some((x) => x.id === "voix" && x.enabled && x.has_key) },
    // Le nom de la source seulement : la clé ne quitte jamais le serveur.
    ecoute: { source: ecoute?.nom, fournisseur: ecoute && /openai/i.test(ecoute.base) ? "openai" : ecoute && /mistral/i.test(ecoute.base) ? "mistral" : "groq", langue },
    mdp,
    navigateur: { vivant, branche: ecranBranche(), comptes },
    plus,
    diag,
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
textarea{display:block;width:100%;margin-top:.25rem;padding:.5rem .6rem;font:.95rem/1.45 inherit;color:var(--fg);
         background:var(--bg);border:1px solid var(--line);border-radius:6px;min-height:6.5rem;resize:vertical}
textarea:focus{outline:2px solid var(--go);outline-offset:1px;border-color:transparent}
.apercu{white-space:pre-wrap;font:.8rem/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);background:var(--bg);
        border:1px solid var(--line);border-radius:6px;padding:.6rem .7rem;margin-top:.6rem;max-height:14rem;overflow:auto}
details summary{cursor:pointer;color:var(--muted);font-size:.85rem;margin-top:.6rem}
.sommaire{display:flex;flex-wrap:wrap;gap:.35rem .9rem;font-size:.85rem;margin:.2rem 0 .5rem}
.sommaire a{color:var(--go);text-decoration:none}
.roles{display:flex;flex-wrap:wrap;gap:.7rem;margin-top:.3rem}
.roles label{display:flex;align-items:center;gap:.3rem;color:var(--fg);font-size:.88rem;margin:0}
.roles input{width:auto;margin:0}
table{width:100%;border-collapse:collapse;font-size:.87rem;background:var(--card);border:1px solid var(--line);border-radius:9px;overflow:hidden}
td,th{padding:.5rem .7rem;text-align:left;border-top:1px solid var(--line)}
th{font-size:.7rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);border-top:none;font-weight:600}
td.n{text-align:right;font-variant-numeric:tabular-nums}
.barres{display:flex;align-items:flex-end;gap:3px;height:56px;margin:.4rem 0 .2rem}
.barres div{flex:1;background:var(--go);border-radius:2px 2px 0 0;min-height:2px;opacity:.85}
.defile{overflow-x:auto;-webkit-overflow-scrolling:touch;border-radius:9px}
.defile table{min-width:100%}
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

function options<T extends Record<string, { titre: string }>>(table: T, courant: string): string {
  return Object.entries(table).map(([k, v]) => `<option value="${k}"${k === courant ? " selected" : ""}>${esc(v.titre)}</option>`).join("");
}

/**
 * Personnalité. L'aperçu montre le texte EXACT ajouté au prompt : sans lui,
 * on règle des menus déroulants en devinant leur effet. Avec, on lit ce que
 * le modèle lira.
 */
function sectionPersonnalite(st: PanelState): string {
  const p = st.perso;
  const carac = Object.entries(CARACTERES)
    .map(([k, v]) => `<label style="display:flex;gap:.5rem;align-items:flex-start;color:var(--fg);margin:.35rem 0"><input type="radio" name="caractere" value="${k}"${k === p.caractere ? " checked" : ""} style="width:auto;margin-top:.3rem"> <span><b>${esc(v.titre)}</b> <span class="det">— ${esc(v.resume)}</span></span></label>`)
    .join("");
  return `<h2 id="personnalite">Personnalité</h2>
<p class="aide">Comment il te parle, comment il réfléchit, comment il exécute. Effet au message suivant, sans redémarrage. Aucun réglage ne lui permet de refuser un ordre : ils changent la façon de faire, jamais le fait de faire.</p>
<form class="ajout" method="post">
  <input type="hidden" name="op" value="personnalite">
  <div class="grille">
    <label>Son nom<input name="nom" maxlength="${NOM_MAX}" value="${esc(p.nom)}"></label>
    <label>Son raisonnement<select name="reflexion">${options(REFLEXIONS, p.reflexion)}</select></label>
    <label>Longueur des réponses<select name="longueur">${options(LONGUEURS, p.longueur)}</select></label>
    <label>Emojis<select name="emojis">${options(EMOJIS, p.emojis)}</select></label>
    <label>Langue<select name="langue">${options(LANGUES, p.langue)}</select></label>
  </div>
  <label>Caractère</label>
  ${carac}
  <label style="margin-top:.7rem">Tes consignes à toi <span class="det">(facultatif, ${LIBRE_MAX} caractères max — ce que tu veux qu'il sache ou fasse toujours)</span>
    <textarea name="libre" maxlength="${LIBRE_MAX}" placeholder="Ex. : Appelle-moi « patron ». Mes priorités : le site IPTV, puis DHgate. Quand tu trouves un produit, donne toujours le prix en couronnes suédoises.">${esc(p.libre)}</textarea></label>
  <label style="margin-top:.7rem">Règles absolues <span class="det">(une par ligne, ${REGLES_MAX} caractères max — approbations et interdits en langage naturel ; elles priment sur tout, y compris sur « exécute sans demander »)</span>
    <textarea name="regles" maxlength="${REGLES_MAX}" placeholder="Ex. :&#10;Jamais d'envoi d'e-mail sans mon OK.&#10;Jamais d'achat ni de paiement.&#10;Ne publie une annonce qu'après m'avoir montré le texte.&#10;Ne touche jamais aux mails de ma banque.">${esc(p.regles)}</textarea></label>
  <button class="principal">Enregistrer la personnalité</button>
  <details><summary>Voir exactement ce qu'il reçoit</summary><div class="apercu">${esc(blocPersonnalite(p))}</div></details>
</form>`;
}

/** Voix. Le service est une clé comme une autre ; ici on règle quand et comment il parle. */
function sectionVoix(st: PanelState): string {
  const v = st.voix;
  const manque = !v.service
    ? `<p class="notice warn">Aucun service « voix » actif. <b>Gratuit :</b> sur le serveur, <code>bash deploy/voix-gratuite.sh</code> installe une voix française qui tourne chez toi (aucune clé, aucun coût par message, ~400 Mo de mémoire). <b>Payant :</b> ajoute-le dans le formulaire plus bas — identifiant <code>voix</code>, type « Compatible OpenAI », adresse <code>https://api.openai.com/v1</code>, modèle <code>gpt-4o-mini-tts</code>, et ta clé OpenAI.</p>`
    : "";
  return `<h2 id="voix">Voix</h2>
<p class="aide">Il te répond en note vocale sur WhatsApp. Si la voix échoue, le texte part quand même — tu ne perds jamais une réponse. Un lien part toujours aussi par écrit : un lien lu à voix haute ne se clique pas. Le coût de la synthèse n'est pas compté dans les tableaux de cette page : il se lit chez le fournisseur.</p>
${manque}
<form class="ajout" method="post">
  <input type="hidden" name="op" value="voix">
  <div class="grille">
    <label>Quand parler<select name="mode">${Object.entries(VOIX_MODES).map(([k, t]) => `<option value="${k}"${k === v.mode ? " selected" : ""}>${esc(t)}</option>`).join("")}</select></label>
    <label>Voix <span class="det">(voix gratuite : ff_siwis, la seule en français ; OpenAI : alloy, ash, coral, echo, fable, nova, onyx, sage, shimmer…)</span><input name="nom" value="${esc(v.nom)}" maxlength="30"></label>
    <label style="display:flex;gap:.5rem;align-items:center;color:var(--fg);margin-top:1.4rem"><input type="checkbox" name="texte" value="on"${v.texteAussi ? " checked" : ""} style="width:auto;margin:0"> Envoyer aussi le texte</label>
  </div>
  <label>Comment il parle <span class="det">(ton, débit, accent — pris en compte par les modèles gpt-4o-mini-tts)</span>
    <textarea name="consignes" maxlength="600" placeholder="Ex. : Voix posée et assurée, débit un peu rapide, ton complice. Français avec un léger accent d'Afrique centrale.">${esc(v.consignes)}</textarea></label>
  <button class="principal">Enregistrer la voix</button>
</form>
<form method="post" style="margin-top:.5rem"><input type="hidden" name="op" value="testvoix"><button${v.service ? "" : " disabled"}>Tester la voix sur mon WhatsApp</button></form>
${sectionEcoute(st)}`;
}

/**
 * L'écoute des vocaux : ce qu'il faut pour qu'il ENTENDE, pas seulement qu'il
 * parle. Une clé Groq ou OpenAI suffit ; s'il en trouve déjà une au panneau,
 * il s'en sert sans qu'on la recolle.
 */
function sectionEcoute(st: PanelState): string {
  const e = st.ecoute;
  const etat = e.source
    ? `<p class="notice bon">Il écoute tes vocaux (clé : ${esc(e.source)}). Parle-lui normalement sur WhatsApp : il transcrit et répond.</p>`
    : `<p class="notice warn"><b>Il n'entend pas encore tes vocaux.</b> Une clé Mistral déjà présente dans Services suffit (il la réutilise tout seul). Sinon colle une clé ci-dessous : Groq a une offre gratuite : sur <b>console.groq.com</b> → <i>API Keys</i> → <i>Create API Key</i>, copie la clé (elle commence par <code>gsk_</code>) et colle-la ici.</p>`;
  const sel = (a: string, b: string): string => (a === b ? " selected" : "");
  return `<h2 id="ecoute" style="margin-top:1.8rem">Écoute de tes vocaux</h2>
<p class="aide">Pour qu'il comprenne les messages vocaux que tu lui envoies sur WhatsApp. La clé se colle ici, jamais dans une conversation.</p>
${etat}
<form class="ajout" method="post" autocomplete="off">
  <input type="hidden" name="op" value="ecoute">
  <div class="grille">
    <label>Fournisseur<select name="fournisseur"><option value="groq"${sel(e.fournisseur, "groq")}>Groq (rapide, offre gratuite)</option><option value="mistral"${sel(e.fournisseur, "mistral")}>Mistral (Voxtral, 0,003 $/min)</option><option value="openai"${sel(e.fournisseur, "openai")}>OpenAI</option></select></label>
    <label>Clé d'API<input name="cle" type="password" placeholder="${e.source ? "(en place — laisse vide pour la garder)" : "gsk_… ou sk-…"}"></label>
    <label>Langue que tu parles<select name="langue">${Object.entries(LANGUES_ECOUTE).map(([k, t]) => `<option value="${k}"${sel(e.langue, k)}>${esc(t)}</option>`).join("")}</select></label>
  </div>
  <button class="principal">Enregistrer l'écoute</button>
</form>
<form method="post" style="margin-top:.5rem"><input type="hidden" name="op" value="testecoute"><button${e.source ? "" : " disabled"}>Tester l'écoute</button></form>`;
}

/**
 * Son navigateur. Ouvrir un site dans le Chromium du serveur, s'y connecter
 * à la main, et le bot garde la session. Deux chemins pour « ajouter un
 * site » : la session (on se connecte soi-même, rien n'est stocké hors du
 * navigateur) ou le coffre (identifiant + mot de passe chiffrés, que le bot
 * tape seul le jour où la session expire). La page dit lequel sert à quoi.
 */
/**
 * « Déposer une clé » : une case et un bouton, sans le formulaire complet
 * d'un service (identifiant, type d'API, priorité…) qui n'a rien à faire là
 * quand on veut juste remplacer une clé refusée.
 */
function sectionCle(st: PanelState, tous: PublicProvider[]): string {
  const choix = [...tous.map((s) => ({ id: s.id, label: s.label || s.id })), ...DEPOT_IDS.filter((id) => !tous.some((s) => s.id === id)).map((id) => ({ id, label: id === "github" ? "GitHub" : "Vercel" }))];
  const options = choix.map((c) => `<option value="${esc(c.id)}"${c.id === "github" ? " selected" : ""}>${esc(c.label)}</option>`).join("");
  const off = st.coffre ? "" : " disabled";
  return `<h2 id="cle">Déposer une clé</h2>
<form class="ajout" method="post" autocomplete="off">
  <input type="hidden" name="op" value="depot">
  <div class="grille">
    <label>Pour quel service<select name="id"${off}>${options}</select></label>
    <label>Clé API / secrète<input name="cle" type="password" autocomplete="off" spellcheck="false" placeholder="Colle ta clé ici" required${off}></label>
  </div>
  <button class="principal"${off}>Enregistrer de manière sécurisée</button>
  <p class="aide">Chiffrée sur ton serveur et jamais réaffichée : ni ici, ni au bot, ni dans WhatsApp. Elle est testée auprès du service dès l'enregistrement, et le résultat s'affiche en haut de la page. Elle reste en place jusqu'à ce que tu en colles une autre.${st.coffre ? "" : " <b>Indisponible : VAULT_KEY absente du serveur.</b>"}</p>
</form>`;
}

function sectionNavigateur(st: PanelState): string {
  const n = st.navigateur;
  const etat = !n.branche
    ? `<p class="notice warn">Le navigateur du bot n'est pas relié à l'écran (BROWSER_CDP_URL vide sur le serveur) : un site ouvert d'ici serait invisible. Lance <code>bash deploy/desktop-up.sh</code> sur le serveur.</p>`
    : !n.vivant
      ? `<p class="notice warn">L'écran ne répond pas. Le conteneur « desktop » est peut-être arrêté : <code>bash deploy/desktop-up.sh</code> sur le serveur.</p>`
      : "";
  const connus = SITES.filter((x) => x.loginUrl)
    .map((x) => `<option value="${esc(x.loginUrl!)}">${esc(x.name)} — ${esc(x.host)}</option>`)
    .join("");
  const coffre = n.comptes.length
    ? `<table><tr><th>Site</th><th>Compte</th><th class="n">Connexions</th></tr>${n.comptes
        .map((c) => `<tr><td>${esc(c.site)}${c.has_totp ? ` <span class="p ok">2FA</span>` : ""}</td><td class="det">${esc(c.login)}</td><td class="n">${c.uses}</td></tr>`)
        .join("")}</table>`
    : `<p class="vide">Aucun identifiant au coffre pour l'instant.</p>`;
  return `<h2 id="navigateur">Son navigateur</h2>
<p class="aide">Le Chromium du serveur, celui dans lequel il travaille. Ouvre un site ici, connecte-toi à la main sur l'écran, ferme : la session reste sur le serveur et il s'en sert ensuite. Aucun mot de passe ne passe par cette page.</p>
${etat}
<div class="act" style="margin-bottom:.6rem"><a class="b" href="/screen" target="_blank" rel="noopener">Ouvrir son écran</a></div>
<form class="ajout" method="post">
  <input type="hidden" name="op" value="ouvrir_site">
  <div class="grille">
    <label>Ouvrir un site dans son navigateur<input name="url" placeholder="vinted.se, linkedin.com/login, …" required${n.branche ? "" : " disabled"}></label>
  </div>
  <button class="principal"${n.branche ? "" : " disabled"}>Ouvrir et aller à l'écran</button>
</form>
${connus ? `<form class="ajout" method="post">
  <input type="hidden" name="op" value="ouvrir_site">
  <div class="grille"><label>Ou la page de connexion d'un site qu'il connaît<select name="url"${n.branche ? "" : " disabled"}>${connus}</select></label></div>
  <button${n.branche ? "" : " disabled"}>Ouvrir la connexion</button>
</form>` : ""}
<form method="post" style="margin-top:.5rem"><input type="hidden" name="op" value="sites_connectes"><button${n.branche ? "" : " disabled"}>Voir les sites où il a une session</button></form>

<p class="aide" style="margin-top:1.2rem"><b>Qu'il se connecte seul, même quand la session expire :</b> mets l'identifiant et le mot de passe au <a href="/vault">coffre</a>. Ils y sont chiffrés, il les tape lui-même dans la page, et ne les voit jamais.</p>
${coffre}
<div class="act" style="margin-top:.5rem"><a class="b encours" href="/vault#import">Importer tous mes mots de passe</a><a class="b" href="/vault">Ajouter un site au coffre</a></div>`;
}

/** Accès : le mot de passe qui permet d'ouvrir le panneau depuis n'importe où. */
function sectionAcces(st: PanelState): string {
  return `<h2 id="acces">Accès depuis n'importe où</h2>
<p class="aide">${st.mdp
    ? "Un mot de passe est défini : ouvre l'adresse du panneau depuis n'importe quel navigateur, tape-le, tu es dedans pour trente jours : mets /panel et /screen en signets sur ton téléphone. Cinq erreurs bloquent l'adresse quinze minutes."
    : "Sans mot de passe, tu entres avec un code envoyé sur ton WhatsApp depuis la page de connexion : rien à retenir, trente jours par navigateur. Un mot de passe est un chemin en plus, utile si WhatsApp est indisponible."}</p>
<form class="ajout" method="post" autocomplete="off">
  <input type="hidden" name="op" value="motdepasse">
  <div class="grille">
    <label>${st.mdp ? "Nouveau mot de passe" : "Mot de passe"} <span class="det">(${MDP_MIN} caractères minimum)</span><input name="mdp" type="password" minlength="${MDP_MIN}" autocomplete="new-password" required></label>
    <label>Encore une fois<input name="mdp2" type="password" minlength="${MDP_MIN}" autocomplete="new-password" required></label>
  </div>
  <button class="principal">${st.mdp ? "Changer le mot de passe" : "Définir le mot de passe"}</button>
</form>
${st.mdp ? `<form method="post" style="margin-top:.5rem"><input type="hidden" name="op" value="retirermdp"><button class="danger" onclick="return confirm('Retirer le mot de passe ? On entrera avec un code WhatsApp ou un lien du bot.')">Retirer le mot de passe</button></form>` : ""}`;
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
  // « preset:gemini » : formulaire d'ajout prérempli pour une offre gratuite.
  // Ce n'est pas une modification — l'identifiant reste modifiable et rien
  // n'existe tant que Lionel n'a pas collé sa clé et enregistré.
  const preset = edit.startsWith("preset:") ? PRESETS[edit.slice(7)] : undefined;
  const e = edit && !preset ? tous.find((s) => s.id === edit) : undefined;
  const pf = e ?? (preset ? { id: preset.id, label: preset.label, category: "modele", kind: "openai_compat", base_url: preset.baseUrl, model: preset.model, priority: preset.priority, daily_cap_usd: 0, note: preset.note, has_key: false, roles: "chat,worker" } : undefined);
  const rolesEdit = e ? e.roles.split(",").map((r) => r.trim()) : [];
  const sel = (a: string, b: string): string => (a === b ? " selected" : "");
  const part = Number.isFinite(st.depense.plafond) && st.depense.plafond ? Math.min(100, (st.depense.jour / st.depense.plafond) * 100) : 0;
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
    ? `<div class="defile"><table><tr><th>Travail</th><th>Modèle visé</th><th class="n">Lancements</th><th class="n">Coût</th><th>Dernier</th></tr>` +
      st.missions
        .map((m) => `<tr><td>${esc(m.mission)}</td><td class="det">${esc(m.modele)}</td><td class="n">${m.lancements}</td><td class="n">${m.usd.toFixed(3)} $</td>` +
                    `<td class="det">${esc(m.quand)}</td></tr>`)
        .join("") + `</table></div>`
    : `<p class="vide">Aucune mission facturée dans les 24 dernières heures.</p>`;

  const conso = st.consommation.length
    ? `<div class="defile"><table><tr><th>Service</th><th>Modèle</th><th class="n">Appels</th><th class="n">Jetons</th><th class="n">Coût</th></tr>` +
      st.consommation
        .map((x) => `<tr><td>${esc(x.provider)}</td><td class="det">${esc(x.model)}</td><td class="n">${x.appels}</td>` +
                    `<td class="n">${x.tokens.toLocaleString("fr-FR")}</td><td class="n">${x.usd.toFixed(3)} $</td></tr>`)
        .join("") + `</table></div>`
    : `<p class="vide">Aucun appel dans les 24 dernières heures.</p>`;

  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Manzi Junior — panneau</title><meta name="robots" content="noindex">
<style>${CSS}${CSS_DIAG}</style></head><body><main>
<header><h1>${esc(st.perso.nom)} — panneau</h1><span class="maj">à jour · ${esc(st.heure)} · <a href="/logout" style="color:inherit">se déconnecter</a></span></header>
<nav class="sommaire">${menuPanneau()}</nav>

${notice ? `<p class="notice${ton ? ` ${ton}` : ""}">${esc(notice)}</p>` : ""}
${st.coffre ? "" : `<p class="notice warn">VAULT_KEY absente du .env : impossible de chiffrer une clé, donc impossible d'en enregistrer une ici. Génère-la avec <code>openssl rand -base64 32</code>.</p>`}
${st.depense.jour >= st.depense.plafond ? `<p class="notice bad">Plafond du jour atteint (${st.depense.jour.toFixed(2)} $ sur ${plafondTexte(st.depense.plafond)}) : l'agent refuse de lancer une mission jusqu'à minuit. Relève-le en bas de page, ou laisse-le couper si c'est voulu.</p>` : ""}
${Number.isFinite(st.depense.plafond) ? "" : `<p class="notice warn">Aucune limite de dépense : Lionel a désactivé le plafond. Seul le budget de chaque mission borne encore la dépense. « remets les limites » sur WhatsApp pour le rétablir.</p>`}
${st.depense.jour > 0 && total24 === 0 ? `<p class="notice warn">« Dépensé aujourd'hui » vient du compteur global, qui existait avant ce panneau. Le détail par service, lui, ne compte que depuis l'installation du panneau : c'est pour ça que les deux chiffres ne collent pas encore. Ils se rejoindront d'ici 24 h.</p>` : ""}

<div class="tuiles">
  <div class="t"><b>${st.depense.jour.toFixed(2)} $</b><span>dépensé aujourd'hui · plafond ${plafondTexte(st.depense.plafond)}</span>
    <div class="jauge"><i class="${cls}" style="width:${part}%"></i></div></div>
  <div class="t"><b>${actifs}</b><span>service(s) actif(s)</span></div>
  <div class="t"><b>${total24.toFixed(2)} $</b><span>sur 24 h, tous services</span></div>
  <div class="t"><b>${st.jours.reduce((a, j) => a + j.usd, 0).toFixed(2)} $</b><span>sur 14 jours</span>
    <div class="barres">${st.jours.map((j) => `<div style="height:${Math.max(2, (j.usd / max) * 100)}%" title="${esc(j.jour)} · ${j.usd.toFixed(2)} $"></div>`).join("")}</div></div>
</div>

${sectionDiagnostic(st.diag)}

${sectionCle(st, tous)}

${sectionBoiteNoire(st.diag)}

${sectionPersonnalite(st)}

${sectionVoix(st)}

${sectionNavigateur(st)}

${sectionMemoire(st.plus)}

${sectionCompetences(st.plus)}

${sectionRappels(st.plus)}

${sectionDeclencheurs(st.plus)}

${sectionCrochets(st.plus)}

${sectionRefus(st.plus)}

${sectionImages(st.plus)}

<div id="services"></div>
${cats}

<h2 id="formulaire">${e ? `Modifier « ${esc(e.label || e.id)} »` : "Ajouter un service"}</h2>
<p class="aide">${e
  ? `Les champs portent les valeurs actuelles : ce que tu ne touches pas reste tel quel. La clé, elle, n'est jamais réaffichée — laisse-la vide pour garder celle qui est en place.`
  : `Pour en modifier un existant, clique « Modifier » sur sa carte plutôt que de retaper son identifiant ici : ce formulaire-ci part des valeurs par défaut et les écraserait.`}</p>
${preset ? `<p class="notice bon">Offre gratuite préremplie. Crée ta clé sur <b>${esc(preset.ou)}</b>, colle-la dans « Clé d'API », puis « Enregistrer » et « Tester la clé » sur sa carte. La clé ne se colle qu'ici, jamais dans WhatsApp.</p>` : ""}
<p class="aide">Modèles gratuits en un clic : ${Object.entries(PRESETS).map(([k, v]) => `<a class="b" href="/panel?edit=preset:${k}#formulaire">${esc(v.label)}</a>`).join(" ")} — l'aiguillage les fait passer devant pour la conversation, et garde les payants en secours. Limites : Gemini gratuit ≈ quelques centaines de requêtes par jour, OpenRouter gratuit 50 par jour (1 000 après un seul achat de 10 $ de crédit). Sur les offres gratuites, Google et Mistral peuvent utiliser les échanges pour entraîner leurs modèles.</p>
<form class="ajout" method="post" autocomplete="off">
  <input type="hidden" name="op" value="put">
  <div class="grille">
    <label>Identifiant<input name="id" placeholder="groq" required value="${esc(pf?.id ?? "")}"${e ? " readonly" : ""} ${st.coffre ? "" : "disabled"}></label>
    <label>Nom affiché<input name="label" placeholder="Groq" value="${esc(pf?.label ?? "")}" ${st.coffre ? "" : "disabled"}></label>
    <label>Catégorie<select name="category" ${st.coffre ? "" : "disabled"}>
      <option value="modele"${sel(pf?.category ?? "modele", "modele")}>Modèle</option><option value="dev"${sel(pf?.category ?? "", "dev")}>Développement</option>
      <option value="recherche"${sel(pf?.category ?? "", "recherche")}>Recherche</option><option value="autre"${sel(pf?.category ?? "", "autre")}>Autre</option></select></label>
    <label>Type d'API<select name="kind" ${st.coffre ? "" : "disabled"}>
      <option value="openai_compat"${sel(pf?.kind ?? "openai_compat", "openai_compat")}>Compatible OpenAI</option><option value="anthropic"${sel(pf?.kind ?? "", "anthropic")}>Anthropic</option></select></label>
    <label>Adresse de l'API<input name="baseUrl" placeholder="https://api.groq.com/openai/v1" value="${esc(pf?.base_url ?? "")}" ${st.coffre ? "" : "disabled"}></label>
    <label>Modèle<input name="model" placeholder="llama-3.3-70b-versatile" value="${esc(pf?.model ?? "")}" ${st.coffre ? "" : "disabled"}></label>
    <label>Clé d'API<input name="apiKey" type="password" placeholder="${e?.has_key ? "(enregistrée — inchangée si vide)" : "colle-la ici"}" ${st.coffre ? "" : "disabled"}></label>
    <label>Priorité <span class="det">(1 = essayé en premier)</span><input name="priority" type="number" min="1" max="99" value="${pf?.priority ?? 50}" ${st.coffre ? "" : "disabled"}></label>
    <label>Plafond 24 h en $ <span class="det">(0 = aucun)</span><input name="dailyCap" type="number" min="0" step="0.5" value="${pf?.daily_cap_usd ?? 0}" ${st.coffre ? "" : "disabled"}></label>
    <label>Note<input name="note" placeholder="à quoi il sert" value="${esc(pf?.note ?? "")}" ${st.coffre ? "" : "disabled"}></label>
  </div>
  <label>Rôles <span class="det">(modèles seulement)</span>
    <span class="roles">${st.roles.map((r) => `<label><input type="checkbox" name="roles" value="${r}"${(e ? rolesEdit.includes(r) : r === "chat" || r === "worker") ? " checked" : ""} ${st.coffre ? "" : "disabled"}> ${r}</label>`).join("")}</span>
  </label>
  <button class="principal" ${st.coffre ? "" : "disabled"}>Enregistrer</button>
  ${e ? `<a class="b" href="/panel" style="margin-left:.6rem">Annuler</a>` : ""}
</form>

<h2 id="depense">Qui a coûté, 24 dernières heures</h2>
<p class="aide">Par travail, et par modèle visé au départ. C'est la question qu'on se pose devant une facture : changer de modèle ne sert à rien si c'est une mission qui boucle. « Visé » et pas « facturé » : si la cascade est montée d'un cran sur un échec, c'est le suivant qui a encaissé — le tableau du dessous tranche, à partir d'aujourd'hui.</p>
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

${sectionAcces(st)}

<h2 id="approbations">Approbations avant une action irréversible</h2>
<p class="aide">Quand c'est actif, un envoi d'e-mail ou un outil irréversible te demande « OUI-XXXX » sur WhatsApp avant de partir. Coupé, il part directement. ${st.approbations ? "Actif." : "<b>Coupé — tout s'exécute sans te demander.</b>"}</p>
<form class="ajout" method="post">
  <input type="hidden" name="op" value="approbations">
  <input type="hidden" name="etat" value="${st.approbations ? "off" : "on"}">
  <button class="principal">${st.approbations ? "Couper les approbations" : "Réactiver les approbations"}</button>
</form>

<h2 id="plafond">Plafond journalier</h2>
<p class="aide">Global, tous services confondus. Au-delà, l'agent refuse de lancer une mission — c'est le garde-fou qui empêche une boucle de coûter une nuit entière.</p>
<form class="ajout" method="post">
  <input type="hidden" name="op" value="budget">
  <div class="grille"><label>Plafond en $ par jour <span class="det">(0 = aucune limite)</span><input name="daily" type="number" min="0" step="0.5" value="${Number.isFinite(st.depense.plafond) ? st.depense.plafond : 0}"></label></div>
  <button class="principal">Changer le plafond</button>
</form>
<form class="ajout" method="post" style="margin-top:.6rem">
  <input type="hidden" name="op" value="alerte">
  <div class="grille"><label>Alerte en $ par jour <span class="det">(0 = jamais — un message WhatsApp au seuil ; au double, les missions passent en réflexion éco jusqu'à minuit, rien n'est arrêté)</span><input name="seuil" type="number" min="0" step="0.5" value="${st.plus.alerte}"></label></div>
  <button class="principal">Changer l'alerte</button>
</form>

<div class="liens"><a href="/board">Tableau de bord</a><a href="/vault">Coffre</a><a href="/screen">Écran</a></div>
</main></body></html>`;
}
