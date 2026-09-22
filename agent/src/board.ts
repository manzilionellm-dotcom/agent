import { config } from "./config.js";
import { dailyBudget } from "./providers.js";
import { db } from "./memory/db.js";
import { spentToday } from "./memory/store.js";
import { listAgents } from "./agents/store.js";
import { listTasks } from "./agents/tasks.js";
import { recentEvents } from "./events.js";
import { listCredentials, vaultEnabled } from "./vault.js";
import { screenAlive } from "./screen.js";
import { logger } from "./logger.js";

/**
 * Tableau de bord : ce que fait l'agent, en une page.
 *
 * Tout ce qu'on affiche ici existait déjà par l'API (/agents, /tasks,
 * /agents/:id/timeline). Ce qui manquait, c'est de pouvoir le REGARDER sans
 * fabriquer une requête avec un jeton. La différence n'est pas cosmétique :
 * une information qu'on ne consulte jamais ne sert à rien, et on ne consulte
 * pas ce qui demande trois commandes.
 *
 * La page se rafraîchit toute seule et ne dépend d'aucune bibliothèque :
 * elle doit s'ouvrir sur un téléphone, en 3G, depuis la rue.
 */

type Etat = {
  heure: string;
  mode: string;
  depense: { jour: number; plafond: number };
  navigateur: { configure: string; ecran: boolean };
  coffre: { actif: boolean; sites: number };
  agents: Array<{ id: string; nom: string; role: string; etat: string; autonomie: number; depense24h: number }>;
  taches: Array<{ id: number; agent: string; titre: string; statut: string; tentative: string; usd: number; quand: string; erreur: string | null }>;
  journal: Array<{ quand: string; genre: string; niveau: string; agent: string | null; message: string }>;
};

export async function boardState(): Promise<Etat> {
  const cfg = config();
  // Tout en parallèle : la page est consultée depuis un téléphone, et six
  // allers-retours en série sur une base distante se voient à l'œil nu.
  const [jour, plafond, agents, taches, journal, coffre, ecran, spend] = await Promise.all([
    spentToday().catch(() => 0),
    dailyBudget().catch(() => cfg.DAILY_BUDGET_USD),
    listAgents().catch(() => []),
    listTasks(undefined, undefined, 40).catch(() => []),
    recentEvents(60).catch(() => []),
    vaultEnabled() ? listCredentials().catch(() => []) : Promise.resolve([]),
    screenAlive().catch(() => false),
    db()
      .query<{ agent_id: string; usd: string }>(
        `SELECT agent_id, coalesce(sum(usd),0) AS usd FROM agent_tasks WHERE created_at > now() - interval '24 hours' GROUP BY agent_id`,
      )
      .then((r) => new Map(r.rows.map((x) => [x.agent_id, Number(x.usd)])))
      .catch(() => new Map<string, number>()),
  ]);

  return {
    heure: new Date().toLocaleString("fr-FR", { timeZone: cfg.TZ }),
    mode: cfg.AUTONOMY_MODE,
    depense: { jour, plafond },
    navigateur: { configure: cfg.BROWSER_CDP_URL ?? "Chromium du sandbox", ecran },
    coffre: { actif: vaultEnabled(), sites: coffre.length },
    agents: agents.map((a) => ({ id: a.id, nom: a.name, role: a.role, etat: a.state, autonomie: a.autonomy, depense24h: spend.get(a.id) ?? 0 })),
    taches: taches.map((t) => ({
      id: t.id,
      agent: t.agent_id,
      titre: t.title,
      statut: t.status,
      tentative: `${t.attempt}/${t.max_attempts}`,
      usd: t.usd,
      quand: t.created_at,
      erreur: t.error,
    })),
    journal: journal.map((e) => ({ quand: String(e.ts), genre: e.kind, niveau: e.level ?? "info", agent: e.agent_id ?? null, message: e.message ?? "" })),
  };
}

export function boardPage(): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Manzi Junior — tableau de bord</title>
<meta name="robots" content="noindex">
<style>
:root{color-scheme:light dark;--fg:#141414;--muted:#6b6b6b;--bg:#fafafa;--card:#fff;--line:#e6e6e6;
      --ok:#0a7d3f;--go:#1d5fd0;--warn:#a86400;--bad:#c0392b}
@media(prefers-color-scheme:dark){:root{--fg:#e9e9e9;--muted:#9a9a9a;--bg:#121212;--card:#1b1b1b;--line:#2c2c2c;
      --ok:#3ddc84;--go:#7aa7ff;--warn:#e0a63a;--bad:#ff6b5e}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:56rem;margin:0 auto;padding:1.25rem 1rem 4rem}
header{display:flex;flex-wrap:wrap;align-items:baseline;gap:.75rem;margin-bottom:1.25rem}
h1{font-size:1.25rem;margin:0;letter-spacing:-.01em}
h2{font-size:.8rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:2rem 0 .6rem;font-weight:600}
.maj{color:var(--muted);font-size:.8rem;margin-left:auto}
.tuiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(9.5rem,1fr));gap:.6rem}
.t{background:var(--card);border:1px solid var(--line);border-radius:9px;padding:.7rem .8rem}
.t b{display:block;font-size:1.35rem;font-weight:600;letter-spacing:-.02em;margin-bottom:.1rem}
.t span{color:var(--muted);font-size:.78rem}
.jauge{height:3px;background:var(--line);border-radius:2px;margin-top:.5rem;overflow:hidden}
.jauge i{display:block;height:100%;background:var(--go)}
.jauge i.warn{background:var(--warn)}.jauge i.bad{background:var(--bad)}
table{width:100%;border-collapse:collapse;font-size:.88rem;background:var(--card);border:1px solid var(--line);border-radius:9px;overflow:hidden}
td,th{padding:.55rem .7rem;text-align:left;border-top:1px solid var(--line);vertical-align:top}
th{font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);border-top:none;font-weight:600}
tr:first-child td{border-top:none}
.p{display:inline-block;font-size:.72rem;padding:.08em .45em;border-radius:4px;border:1px solid currentColor;font-weight:600}
.ok{color:var(--ok)}.go{color:var(--go)}.warn{color:var(--warn)}.bad{color:var(--bad)}
.muted{color:var(--muted)}
.err{color:var(--bad);font-size:.8rem;display:block;margin-top:.15rem}
.vide{color:var(--muted);padding:.9rem .7rem;background:var(--card);border:1px solid var(--line);border-radius:9px;font-size:.88rem}
.j{font-size:.83rem;padding:.3rem 0;border-top:1px solid var(--line);display:flex;gap:.55rem}
.j:first-child{border-top:none}
.j time{color:var(--muted);font-variant-numeric:tabular-nums;flex:0 0 auto}
.liens{margin-top:2.5rem;font-size:.85rem}
.liens a{color:var(--muted);margin-right:1.1rem}
@media(max-width:34rem){.cacher{display:none}}
</style></head><body><main>
<header><h1>Manzi Junior</h1><span class="maj" id="maj">chargement…</span></header>
<div id="app"><p class="vide">Chargement…</p></div>
<div class="liens"><a href="/panel">Panneau</a><a href="/vault">Coffre</a><a href="/screen">Écran du navigateur</a><a href="/healthz">Santé</a></div>
</main>
<script>
const E = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const C = {done:"ok",completed:"ok",idle:"ok",running:"go",working:"go",pending:"go",
           blocked:"warn",paused:"warn",retry:"warn",failed:"bad",error:"bad",cancelled:"bad"};
const heure = s => { const d = new Date(s); return isNaN(d) ? "" : d.toLocaleTimeString("fr-FR",{hour:"2-digit",minute:"2-digit"}); };

function rendu(d) {
  const part = d.depense.plafond ? Math.min(100, d.depense.jour / d.depense.plafond * 100) : 0;
  const cls = part > 90 ? "bad" : part > 60 ? "warn" : "";
  const tuiles = \`<div class="tuiles">
    <div class="t"><b>\${d.depense.jour.toFixed(2)} $</b><span>dépensé aujourd'hui · plafond \${d.depense.plafond} $</span>
      <div class="jauge"><i class="\${cls}" style="width:\${part}%"></i></div></div>
    <div class="t"><b>\${d.agents.length}</b><span>agent(s) · mode \${E(d.mode)}</span></div>
    <div class="t"><b>\${d.taches.filter(t=>t.statut==="running"||t.statut==="pending").length}</b><span>tâche(s) en cours</span></div>
    <div class="t"><b>\${d.coffre.sites}</b><span>site(s) au coffre\${d.coffre.actif?"":" · désactivé"}</span></div>
    <div class="t"><b>\${d.navigateur.ecran?"en ligne":"éteint"}</b><span>écran du navigateur</span></div>
  </div>\`;

  const agents = d.agents.length ? \`<table><tr><th>Agent</th><th>Rôle</th><th>État</th><th class="cacher">Autonomie</th><th>24 h</th></tr>\` +
    d.agents.map(a => \`<tr><td><strong>\${E(a.nom)}</strong><br><span class="muted">\${E(a.id)}</span></td>
      <td class="muted">\${E(a.role)||"—"}</td>
      <td><span class="p \${C[a.etat]||""}">\${E(a.etat)}</span></td>
      <td class="cacher muted">\${a.autonomie}</td>
      <td>\${a.depense24h.toFixed(2)} $</td></tr>\`).join("") + "</table>"
    : \`<p class="vide">Aucun agent. Dis-lui « crée un agent qui… » sur WhatsApp.</p>\`;

  const taches = d.taches.length ? \`<table><tr><th>Tâche</th><th>Agent</th><th>Statut</th><th class="cacher">Essai</th><th>Coût</th></tr>\` +
    d.taches.map(t => \`<tr><td>\${E(t.titre)}\${t.erreur?\`<span class="err">\${E(t.erreur.slice(0,160))}</span>\`:""}</td>
      <td class="muted">\${E(t.agent)}</td>
      <td><span class="p \${C[t.statut]||""}">\${E(t.statut)}</span></td>
      <td class="cacher muted">\${E(t.tentative)}</td>
      <td class="muted">\${t.usd.toFixed(2)} $</td></tr>\`).join("") + "</table>"
    : \`<p class="vide">Aucune tâche enregistrée.</p>\`;

  const journal = d.journal.length ? d.journal.map(e =>
      \`<div class="j"><time>\${heure(e.quand)}</time><span class="\${e.niveau==="error"?"bad":e.niveau==="warn"?"warn":""}">\${E(e.message)||E(e.genre)}</span></div>\`).join("")
    : \`<p class="vide">Rien dans le journal.</p>\`;

  document.getElementById("app").innerHTML =
    tuiles + "<h2>Agents</h2>" + agents + "<h2>Tâches</h2>" + taches + "<h2>Journal</h2><div>" + journal + "</div>";
  document.getElementById("maj").textContent = "à jour · " + d.heure;
}

async function tic() {
  try {
    const r = await fetch("/board.json", { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    rendu(await r.json());
  } catch (e) {
    // Dire qu'on ne sait plus, plutôt que laisser des chiffres périmés à
    // l'écran : un tableau de bord qui ment est pire que pas de tableau.
    document.getElementById("maj").textContent = "hors ligne — " + e.message;
  }
}
tic(); setInterval(tic, 5000);
</script></body></html>`;
}

/** Utilisé par la page ; exporté pour que l'API rende exactement ce que la page affiche. */
export async function boardJson(): Promise<string> {
  try {
    return JSON.stringify(await boardState());
  } catch (e) {
    logger.error({ err: String(e) }, "tableau de bord");
    throw e;
  }
}
