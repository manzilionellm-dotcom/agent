import { config } from "./config.js";
import { action } from "./panel-plus.js";
import { SECTIONS } from "./panel-sections.js";
import {
  PERIODES, TYPES_TRACE, incidentsHorsTrace, lireTrace, listerTraces, secondes, statsBoiteNoire, traceEnTexte,
  type EtapeLue, type Filtre, type StatsBN, type TraceResume, type TypeTrace,
} from "./boite-noire.js";
import {
  GRAVITES, MODES_WHATSAPP, RETENTIONS, TENDANCES, derniereInspection, historiqueSante, listerProblemes, rapportDeveloppeur, reglagesInspecteur,
  type Inspection, type Probleme, type Reglages,
} from "./inspecteur.js";

/**
 * Les deux sections qui répondent à « qu'est-ce qui ne va pas ? » :
 *
 * - Diagnostic : la conclusion. Santé sur 100, problèmes classés du plus
 *   grave au plus bénin, pour chacun ce qu'il faut faire et où — et le
 *   rapport à donner tel quel au développeur.
 * - Boîte noire : la preuve. Chaque travail rejoué étape par étape, avec la
 *   durée de chaque étape dessinée à l'échelle : l'étape qui traîne se voit
 *   avant de se lire.
 *
 * Le diagnostic renvoie à la boîte noire par ses liens de traces ; c'est
 * toute l'idée : un problème qu'on ne peut pas ouvrir pour voir, on finit par
 * ne plus y croire.
 */

export type VueBN = { type: string; etat: "tous" | "erreurs" | "interrompus"; q: string; heures: number; trace: string };

export function lireVue(p: URLSearchParams): VueBN {
  const type = p.get("bn_type") ?? "";
  const etat = p.get("bn_etat");
  const h = p.get("bn_h") ?? "24";
  return {
    type: type in TYPES_TRACE ? type : "",
    etat: etat === "erreurs" || etat === "interrompus" ? etat : "tous",
    q: (p.get("bn_q") ?? "").slice(0, 100),
    heures: h in PERIODES ? Number(h) : 24,
    trace: (p.get("trace") ?? "").slice(0, 40),
  };
}

export type DiagState = {
  reglages: Reglages;
  derniere?: Inspection;
  historique: Array<{ at: string; sante: number }>;
  ouverts: Probleme[];
  clos: Probleme[];
  rapport: string;
  tz: string;
  bn: { vue: VueBN; stats: StatsBN; traces: TraceResume[]; trace?: { trace: TraceResume; etapes: EtapeLue[] }; horsTrace: EtapeLue[] };
};

const VIDE_STATS: StatsBN = { travaux: 0, enErreur: 0, interrompus: 0, appelsIA: 0, outils: 0, erreurs: 0, reponseMediane: 0, usd: 0 };

export async function diagState(vue: VueBN): Promise<DiagState> {
  const f: Filtre = { type: vue.type, etat: vue.etat, q: vue.q, heures: vue.heures };
  const [reglages, derniere, historique, ouverts, clos, rapport, stats, traces, trace, horsTrace] = await Promise.all([
    reglagesInspecteur(),
    derniereInspection().catch(() => undefined),
    historiqueSante(14).catch(() => []),
    listerProblemes("ouvert").catch(() => [] as Probleme[]),
    listerProblemes("clos", 30).catch(() => [] as Probleme[]),
    rapportDeveloppeur().catch((e) => `Rapport indisponible : ${String(e)}`),
    statsBoiteNoire(24).catch(() => VIDE_STATS),
    listerTraces(f, 60).catch(() => [] as TraceResume[]),
    vue.trace ? lireTrace(vue.trace).catch(() => undefined) : Promise.resolve(undefined),
    incidentsHorsTrace(vue.heures, 30).catch(() => [] as EtapeLue[]),
  ]);
  return { reglages, derniere, historique, ouverts, clos, rapport, tz: config().TZ, bn: { vue, stats, traces, trace, horsTrace } };
}

export const CSS_DIAG = `
.sante{font-size:2.1rem !important}
.g-critique{color:var(--bad)}.g-haute{color:var(--warn)}.g-moyenne{color:var(--go)}.g-basse{color:var(--muted)}
.prob{border-left:4px solid var(--line)}
.prob.critique{border-left-color:var(--bad)}.prob.haute{border-left-color:var(--warn)}.prob.moyenne{border-left-color:var(--go)}
.prob .quoi{margin-top:.45rem;font-size:.88rem}
.prob .quoi b{font-weight:600}
.prob .ia{margin-top:.45rem;font-size:.85rem;padding:.45rem .6rem;border-radius:6px;background:color-mix(in srgb,var(--go) 8%,transparent)}
.chips{display:flex;flex-wrap:wrap;gap:.3rem;margin-top:.3rem}
.chip{font-size:.72rem;padding:.05em .5em;border-radius:99px;border:1px solid var(--line);color:var(--muted)}
.chip.alerte{border-color:var(--bad);color:var(--bad);font-weight:600}
.ex{font:.78rem/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);white-space:pre-wrap;word-break:break-word;margin:.25rem 0 0}
.filtres{display:grid;grid-template-columns:repeat(auto-fit,minmax(8.5rem,1fr));gap:.5rem;align-items:end;margin-bottom:.6rem}
.filtres label{margin:0}
.filtres button{height:2.35rem}
tr.ko td:first-child{box-shadow:inset 3px 0 var(--bad)}
tr.alerte td:first-child{box-shadow:inset 3px 0 var(--warn)}
tr.sel{background:color-mix(in srgb,var(--go) 9%,transparent)}
td a{color:var(--go);text-decoration:none}
.chute{background:var(--card);border:1px solid var(--line);border-radius:9px;padding:.8rem;margin-bottom:.8rem}
.etape{display:grid;grid-template-columns:4.2rem 1fr;gap:.15rem .6rem;padding:.35rem 0;border-top:1px solid var(--line);font-size:.85rem}
.etape:first-of-type{border-top:none}
.etape .quand{color:var(--muted);font-variant-numeric:tabular-nums;font-size:.78rem;padding-top:.1rem}
.etape .piste{grid-column:2;height:5px;background:var(--line);border-radius:3px;position:relative;margin:.2rem 0}
.etape .piste i{position:absolute;top:0;height:100%;border-radius:3px;background:var(--go);min-width:3px}
.etape.ko .piste i{background:var(--bad)}.etape.warn .piste i{background:var(--warn)}
.etape.ko .nom{color:var(--bad)}
.etape details{grid-column:2}
.etape details summary{margin:0;font-size:.78rem}
.type{display:inline-block;min-width:4.6rem;font-size:.7rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
`;

const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const quand = (ts: string | Date, tz: string): string =>
  new Date(ts).toLocaleString("fr-FR", { timeZone: tz, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

function lienTrace(id: string, vue?: VueBN): string {
  const p = new URLSearchParams(id ? { trace: id } : {});
  if (vue) {
    if (vue.type) p.set("bn_type", vue.type);
    if (vue.etat !== "tous") p.set("bn_etat", vue.etat);
    if (vue.heures !== 24) p.set("bn_h", String(vue.heures));
    if (vue.q) p.set("bn_q", vue.q);
  }
  return `/panel?${p.toString()}#boitenoire`;
}

/** Copier sans quitter le téléphone : le presse-papiers, et la sélection en repli pour les vieux navigateurs. */
function copier(id: string, texte: string): string {
  return `<button type="button" onclick="var t=document.getElementById('${id}');t.select();(navigator.clipboard?navigator.clipboard.writeText(t.value):Promise.resolve(document.execCommand('copy'))).then(()=>{this.textContent='Copié ✓'})">${texte}</button>`;
}

function carte(p: Probleme, tz: string): string {
  const g = GRAVITES[p.gravite];
  const alerte = p.tendance === "revenu" || p.tendance === "aggrave" || p.tendance === "nouveau";
  const traces = p.traces.length ? `<div class="chips">${p.traces.map((t, i) => `<a class="b" href="${lienTrace(t)}">Voir la trace ${p.traces.length > 1 ? i + 1 : ""}</a>`).join("")}</div>` : "";
  return `<div class="s prob ${p.gravite}">
  <div>
    <div class="nom"><span class="g-${p.gravite}">${g.pastille}</span> ${esc(p.titre)}</div>
    <div class="chips"><span class="chip g-${p.gravite}">${g.titre}</span><span class="chip${alerte ? " alerte" : ""}">${esc(TENDANCES[p.tendance] ?? p.tendance)}</span>
      <span class="chip">${esc(p.source)}</span><span class="chip">${p.occurrences} fois / 24 h</span>${p.usd ? `<span class="chip">${p.usd.toFixed(2)} $</span>` : ""}
      <span class="chip">depuis ${esc(quand(p.premiere, tz))}</span></div>
    ${p.detail ? `<div class="det" style="margin-top:.35rem">${esc(p.detail)}</div>` : ""}
    ${p.correction ? `<div class="quoi"><b>Que faire :</b> ${esc(p.correction)}${p.section ? ` <a href="#${p.section}">→ ${esc(SECTIONS[p.section].titre)}</a>` : ""}</div>` : ""}
    ${p.cause ? `<div class="ia"><b>Analyse IA</b> <span class="det">(confiance ${esc(p.confiance || "?")} — à vérifier)</span><br>Cause : ${esc(p.cause)}<br>Remède : ${esc(p.remede)} <span class="det">· ${p.qui === "toi" ? "tu peux le régler au panneau" : "demande une modification du code"}</span></div>` : ""}
    ${p.exemples.length ? `<details><summary>Preuves (${p.exemples.length})</summary>${p.exemples.map((e) => `<p class="ex">${esc(e)}</p>`).join("")}</details>` : ""}
    ${traces}
  </div>
  <div class="act" style="grid-column:1/-1">
    ${action("probleme", { sig: p.signature, statut: "resolu" }, "C'est réglé")}
    ${action("probleme", { sig: p.signature, statut: "ignore" }, "Ignorer", "", "Ne plus compter ce problème dans la santé ? Il restera visible dans « Réglés et ignorés ».")}
    ${p.ticket ? `<a class="b" href="${esc(p.ticket)}" target="_blank" rel="noopener">Ticket GitHub ↗</a>` : action("probleme_ticket", { sig: p.signature }, "Créer un ticket GitHub")}
  </div></div>`;
}

export function sectionDiagnostic(d: DiagState): string {
  const ins = d.derniere;
  const s = ins?.sante;
  const couleur = s === undefined ? "" : s >= 85 ? "ok" : s >= 60 ? "warn" : "bad";
  const etatIA: Record<string, string> = {
    aucune: "non demandée pour ce scan", en_cours: "en cours… recharge dans une minute", faite: "faite", echec: "en échec (voir boîte noire)",
    coupee: "coupée", plafond: "sautée : plafond du jour atteint", rien: "rien à analyser",
  };
  const max = 100;
  const histo = d.historique.length > 1
    ? `<div class="barres" title="santé des dernières inspections">${d.historique.map((h) => `<div style="height:${Math.max(3, (h.sante / max) * 100)}%;background:var(--${h.sante >= 85 ? "ok" : h.sante >= 60 ? "warn" : "bad"})" title="${esc(quand(h.at, d.tz))} · ${h.sante}/100"></div>`).join("")}</div>`
    : "";
  const ouverts = d.ouverts.length
    ? d.ouverts.map((p) => carte(p, d.tz)).join("")
    : ins ? `<p class="vide">Aucun problème ouvert. ✅</p>` : `<p class="vide">Pas encore d'inspection : clique « Scanner maintenant ».</p>`;
  const clos = d.clos.length
    ? `<table><tr><th>Problème</th><th>État</th><th></th></tr>${d.clos.map((p) => `<tr><td>${esc(p.titre)}<div class="det">${esc(TENDANCES[p.tendance] ?? p.tendance)} · dernier vu ${esc(quand(p.derniere, d.tz))}</div></td>
        <td>${p.statut === "ignore" ? "ignoré" : "réglé"}</td><td>${action("probleme", { sig: p.signature, statut: "ouvert" }, "Rouvrir")}</td></tr>`).join("")}</table>`
    : `<p class="vide">Rien.</p>`;
  const r = d.reglages;
  const sel = (a: string, b: string): string => (a === b ? " selected" : "");
  return `<h2 id="diagnostic">Diagnostic</h2>
<p class="aide">Chaque jour à ${esc(r.heure)}, l'inspecteur relit tout ce qu'il a fait : erreurs, outils ratés, clés refusées, messages non livrés, argent perdu, réponses « je ne peux pas », et tes « ça marche pas ». Les constats viennent des faits enregistrés, pas d'un modèle ; l'analyse IA propose ensuite une cause et un remède, et toute affirmation sans preuve exacte est jetée.</p>
<div class="tuiles">
  <div class="t"><b class="sante ${couleur}">${s === undefined ? "—" : `${s}`}<span style="font-size:1rem;color:var(--muted)">/100</span></b><span>santé${ins ? ` · ${esc(quand(ins.at, d.tz))}` : ""}</span>${histo}</div>
  <div class="t"><b>${d.ouverts.length}</b><span>problème(s) ouvert(s)${ins ? ` · ${ins.critiques} critique(s), ${ins.hautes} grave(s)` : ""}</span></div>
  <div class="t"><b style="font-size:1rem">${esc(etatIA[ins?.analyse_etat ?? "aucune"] ?? ins?.analyse_etat)}</b><span>analyse IA${ins?.analyse_usd ? ` · ${ins.analyse_usd.toFixed(3)} $` : ""}${ins?.ecartes ? ` · ${ins.ecartes} affirmation(s) sans preuve écartée(s)` : ""}</span></div>
</div>
${ins?.priorite ? `<p class="notice"><b>Priorité du jour :</b> ${esc(ins.priorite)}</p>` : ""}
<div class="act" style="margin:.4rem 0 .8rem">
  ${action("inspecter", { ia: "on" }, "Scanner maintenant", "principal")}
  ${action("inspecter", { ia: "off" }, "Scanner sans IA (gratuit)")}
</div>
${ouverts}
<details><summary>Réglés et ignorés (${d.clos.length})</summary>${clos}</details>
<details><summary>Rapport pour le développeur (à coller à Claude Code)</summary>
  <p class="aide">Tout ce qui est ouvert, avec les preuves et les traces, sans aucun secret (clés, numéros, liens de connexion masqués). Copie-le et colle-le dans ta conversation avec Claude Code : c'est ce qu'il lui faut pour réparer.</p>
  <textarea id="rapport" readonly style="min-height:14rem;font:.78rem/1.45 ui-monospace,SFMono-Regular,Menlo,monospace">${esc(d.rapport)}</textarea>
  <div class="act" style="margin-top:.4rem">${copier("rapport", "Copier le rapport")}</div>
</details>
<details><summary>Réglages de l'inspecteur</summary>
<form class="ajout" method="post">
  <input type="hidden" name="op" value="inspecteur_reglages">
  <div class="grille">
    <label>Heure du passage quotidien (${esc(d.tz)})<input name="heure" type="time" value="${esc(r.heure)}" required></label>
    <label>Analyse IA<select name="ia"><option value="on"${sel(r.ia ? "on" : "off", "on")}>Oui (quelques centimes par jour)</option><option value="off"${sel(r.ia ? "on" : "off", "off")}>Non (gratuit, constats seulement)</option></select></label>
    <label>Message WhatsApp<select name="whatsapp">${Object.entries(MODES_WHATSAPP).map(([k, v]) => `<option value="${k}"${sel(r.whatsapp, k)}>${esc(v)}</option>`).join("")}</select></label>
    <label>Garder la boîte noire<select name="retention">${RETENTIONS.map((j) => `<option value="${j}"${sel(String(r.retention), String(j))}>${j} jours</option>`).join("")}</select></label>
  </div>
  <button class="principal">Enregistrer</button>
</form>
</details>`;
}

function badgeEtat(t: TraceResume): string {
  if (t.interrompue) return `<span class="p bad">coupé net</span>`;
  if (!t.fin) return `<span class="p go">en cours</span>`;
  if (t.ok === false) return `<span class="p bad">échec</span>`;
  if (t.erreurs) return `<span class="p warn">${t.erreurs} erreur${t.erreurs > 1 ? "s" : ""}</span>`;
  return `<span class="p ok">ok</span>`;
}

function chute(t: { trace: TraceResume; etapes: EtapeLue[] }, tz: string, vue: VueBN): string {
  const d0 = new Date(t.trace.debut).getTime();
  const total = Math.max(1, t.trace.duree_ms, ...t.etapes.map((e) => new Date(e.ts).getTime() - d0));
  const etapes = t.etapes.map((e) => {
    const fin = new Date(e.ts).getTime() - d0;
    // L'étape est écrite quand elle FINIT : son début, c'est sa fin moins sa durée.
    const debut = Math.max(0, fin - (e.duree_ms ?? 0));
    const classe = !e.ok || e.niveau === "error" ? " ko" : e.niveau === "warn" ? " warn" : "";
    return `<div class="etape${classe}">
      <span class="quand">+${secondes(debut) || "0 ms"}</span>
      <div><span class="type">${esc(e.type)}</span> <span class="nom">${esc(e.titre)}</span>${e.duree_ms !== null ? ` <span class="det">${secondes(e.duree_ms)}</span>` : ""}${e.usd ? ` <span class="det">${e.usd.toFixed(4)} $</span>` : ""}</div>
      <div class="piste"><i style="left:${((debut / total) * 100).toFixed(2)}%;width:${(((e.duree_ms ?? 0) / total) * 100).toFixed(2)}%"></i></div>
      ${e.detail ? `<details><summary>détail</summary><p class="ex">${esc(e.detail)}</p></details>` : ""}
    </div>`;
  }).join("");
  const texte = traceEnTexte(t, 1200);
  return `<div class="chute">
  <div class="nom">${esc(TYPES_TRACE[t.trace.type as TypeTrace] ?? t.trace.type)} — « ${esc(t.trace.titre)} » ${badgeEtat(t.trace)}</div>
  <div class="det">${esc(quand(t.trace.debut, tz))} · ${secondes(t.trace.duree_ms)} · ${t.trace.etapes} étapes · ${t.trace.usd.toFixed(4)} $ · ${esc(t.trace.id)}</div>
  <div style="margin-top:.6rem">${etapes || `<p class="vide">Aucune étape enregistrée.</p>`}</div>
  <details><summary>Copier cette trace (pour Claude Code)</summary>
    <textarea id="trace-texte" readonly style="min-height:10rem;font:.78rem/1.45 ui-monospace,SFMono-Regular,Menlo,monospace">${esc(texte)}</textarea>
    <div class="act" style="margin-top:.4rem">${copier("trace-texte", "Copier la trace")}</div>
  </details>
  <div class="act" style="margin-top:.5rem"><a class="b" href="${lienTrace("", vue)}">Fermer</a></div>
</div>`;
}

export function sectionBoiteNoire(d: DiagState): string {
  const { vue, stats, traces, trace, horsTrace } = d.bn;
  const sel = (a: string, b: string): string => (a === b ? " selected" : "");
  const liste = traces.length
    ? `<div class="defile"><table><tr><th>Quand</th><th>Travail</th><th class="n">Durée</th><th>État</th><th class="n">Coût</th></tr>${traces
        .map((t) => `<tr class="${t.interrompue || t.ok === false ? "ko" : t.erreurs ? "alerte" : ""}${trace?.trace.id === t.id ? " sel" : ""}">
          <td class="det">${esc(quand(t.debut, d.tz))}</td>
          <td><a href="${lienTrace(t.id, vue)}">${esc(t.titre || "(sans titre)")}</a><div class="det">${esc(TYPES_TRACE[t.type as TypeTrace] ?? t.type)} · ${t.etapes} étapes</div></td>
          <td class="n">${secondes(t.duree_ms)}</td><td>${badgeEtat(t)}</td><td class="n">${t.usd ? `${t.usd.toFixed(3)} $` : "—"}</td></tr>`)
        .join("")}</table></div>`
    : `<p class="vide">Rien d'enregistré pour ce filtre${vue.q ? ` (« ${esc(vue.q)} »)` : ""}.</p>`;
  const hors = horsTrace.length
    ? horsTrace.map((e) => `<div class="etape${!e.ok || e.niveau === "error" ? " ko" : " warn"}"><span class="quand">${esc(quand(e.ts, d.tz))}</span>
        <div><span class="type">${esc(e.type)}</span> <span class="nom">${esc(e.titre)}</span></div>${e.detail ? `<details><summary>détail</summary><p class="ex">${esc(e.detail)}</p></details>` : ""}</div>`).join("")
    : `<p class="vide">Rien.</p>`;
  return `<h2 id="boitenoire">Boîte noire</h2>
<p class="aide">L'enregistrement de tout ce qu'il fait. Chaque travail (un message, une mission, un rappel, un e-mail) est rejoué étape par étape : ce qu'il a reçu, chaque modèle appelé, chaque outil avec ce qu'il lui a donné et ce qu'il a rendu, chaque envoi WhatsApp, chaque erreur — avec la durée et le coût. Les clés, numéros et liens de connexion sont masqués avant d'être écrits. Gardée ${d.reglages.retention} jours.</p>
<div class="tuiles">
  <div class="t"><b>${stats.travaux}</b><span>travaux sur 24 h · ${stats.enErreur} avec erreur${stats.interrompus ? ` · <b class="bad" style="display:inline;font-size:inherit">${stats.interrompus} coupé(s) net</b>` : ""}</span></div>
  <div class="t"><b>${stats.appelsIA}</b><span>appels IA · ${stats.outils} outils</span></div>
  <div class="t"><b>${stats.reponseMediane ? secondes(Math.round(stats.reponseMediane * 1000)) : "—"}</b><span>temps de réponse médian</span></div>
  <div class="t"><b>${stats.usd.toFixed(2)} $</b><span>coût enregistré sur 24 h</span></div>
</div>
${trace ? chute(trace, d.tz, vue) : vue.trace ? `<p class="notice warn">Trace introuvable (effacée ou identifiant faux).</p>` : ""}
<form class="filtres" method="get" action="/panel#boitenoire">
  <label>Type<select name="bn_type"><option value="">Tous</option>${Object.entries(TYPES_TRACE).map(([k, v]) => `<option value="${k}"${sel(vue.type, k)}>${esc(v)}</option>`).join("")}</select></label>
  <label>État<select name="bn_etat"><option value="tous"${sel(vue.etat, "tous")}>Tous</option><option value="erreurs"${sel(vue.etat, "erreurs")}>Avec erreur</option><option value="interrompus"${sel(vue.etat, "interrompus")}>Coupés net</option></select></label>
  <label>Période<select name="bn_h">${Object.entries(PERIODES).map(([k, v]) => `<option value="${k}"${sel(String(vue.heures), k)}>${esc(v)}</option>`).join("")}</select></label>
  <label>Chercher<input name="bn_q" value="${esc(vue.q)}" placeholder="mot, outil, erreur…"></label>
  <button>Filtrer</button>
</form>
${liste}
<details><summary>Incidents hors travail (${horsTrace.length}) — démarrage, tâches de fond</summary>${hors}</details>
<div class="act" style="margin-top:.8rem">${action("boite_noire_vider", {}, "Vider la boîte noire", "danger", "Effacer tout l'enregistrement ? Le diagnostic perd sa mémoire des jours passés.")}</div>`;
}
