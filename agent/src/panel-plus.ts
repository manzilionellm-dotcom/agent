import { config } from "./config.js";
import { listProviders } from "./providers.js";
import { listerFaits, listerProfil, memoireActive, type Fait, type FichierProfil } from "./souvenirs.js";
import { heureLocale, listerRappels, type Rappel } from "./rappels.js";
import { INSTRUCTIONS_MAX, listerCompetences, type Competence } from "./competences.js";
import { decrire, listerDeclencheurs, type Declencheur } from "./declencheurs.js";
import { googleConfigured } from "./tools/google.js";

/**
 * Les sections du panneau qui répondent aux fonctions de Grok : mémoire
 * visible et effaçable, rappels et tâches, compétences, déclencheurs
 * e-mail, images. Tout ce que le bot sait faire par la conversation se
 * voit et se corrige ici — une fonction qu'on ne peut que dicter, on ne
 * sait jamais ce qu'elle a vraiment retenu.
 */

export type PlusState = {
  memoire: boolean;
  faits: Fait[];
  profil: FichierProfil[];
  rappels: Rappel[];
  competences: Competence[];
  declencheurs: Declencheur[];
  gmail: boolean;
  image: boolean;
  tz: string;
};

export async function plusState(): Promise<PlusState> {
  const [memoire, faits, profil, rappels, competences, declencheurs, services] = await Promise.all([
    memoireActive().catch(() => true),
    listerFaits(150).catch(() => [] as Fait[]),
    listerProfil().catch(() => [] as FichierProfil[]),
    listerRappels({ tous: true }).catch(() => [] as Rappel[]),
    listerCompetences().catch(() => [] as Competence[]),
    listerDeclencheurs().catch(() => [] as Declencheur[]),
    listProviders().catch(() => []),
  ]);
  return {
    memoire,
    faits,
    profil,
    rappels,
    competences,
    declencheurs,
    gmail: googleConfigured(),
    image: services.some((x) => x.id === "image" && x.enabled && x.has_key),
    tz: config().TZ,
  };
}

const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * Un petit formulaire à un bouton : action + champs cachés.
 *
 * La confirmation s'échappe en DEUX temps, dans cet ordre : d'abord en
 * chaîne JavaScript (JSON.stringify), puis en HTML. L'inverse — échapper en
 * HTML puis poser des apostrophes autour — casse : le navigateur redécode
 * `&#39;` en `'` AVANT que le JavaScript ne lise l'attribut. « qu'il »
 * ferme alors la chaîne, la boîte de confirmation plante, et le formulaire
 * part SANS rien demander — « Tout oublier » effaçait tout d'un clic. Et un
 * nom de compétence choisi pour ça aurait exécuté du code dans la page.
 */
function action(op: string, champs: Record<string, string | number>, texte: string, classe = "", confirmer = ""): string {
  const caches = Object.entries(champs).map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`).join("");
  const conf = confirmer ? ` onclick="return confirm(${esc(JSON.stringify(confirmer))})"` : "";
  return `<form method="post" style="display:inline"><input type="hidden" name="op" value="${op}">${caches}<button class="${classe}"${conf}>${texte}</button></form>`;
}

export function sectionMemoire(p: PlusState): string {
  const faits = p.faits.length
    ? p.faits
        .map((f) => `<div class="s"><div><div class="det">${esc(f.topic)} · ${esc(heureLocale(f.created_at))}</div><div>${esc(f.fact)}</div></div>
          <div class="act" style="grid-column:auto;margin:0">${action("oublier_fait", { fid: f.id }, "Oublier", "danger")}</div></div>`)
        .join("")
    : `<p class="vide">Aucun fait retenu.</p>`;
  const profil = p.profil.length
    ? p.profil
        .map((f) => `<div class="s"><div><div class="nom">${esc(f.path.replace("/memories/", ""))}</div><div class="apercu" style="margin-top:.3rem;max-height:9rem">${esc(f.content)}</div></div>
          <div class="act" style="grid-column:auto;margin:0">${action("oublier_profil", { chemin: f.path }, "Oublier", "danger", "Effacer ce fichier de profil ?")}</div></div>`)
        .join("")
    : `<p class="vide">Profil vide.</p>`;
  return `<h2 id="memoire">Ce qu'il sait de toi</h2>
<p class="aide">Tout ce qu'il a retenu, lisible et effaçable. Tu peux aussi lui dire « oublie que… » sur WhatsApp. ${p.memoire ? "Mémoire active : il retient ce qui compte et s'appuie sur ton profil." : "<b>Mémoire coupée</b> : il ne retient plus rien et ne lit plus ton profil."}</p>
<div class="act" style="margin-bottom:.6rem">
  ${action("memoire", { etat: p.memoire ? "off" : "on" }, p.memoire ? "Couper la mémoire" : "Réactiver la mémoire")}
  ${p.faits.length || p.profil.length ? action("oublier_tout", {}, "Tout oublier", "danger", "Effacer TOUT ce qu'il sait de toi ? C'est définitif.") : ""}
</div>
<details${p.profil.length ? " open" : ""}><summary>Ton profil (${p.profil.length})</summary>${profil}</details>
<details><summary>Faits retenus (${p.faits.length})</summary>${faits}</details>`;
}

export function sectionRappels(p: PlusState): string {
  const liste = p.rappels.length
    ? `<table><tr><th>N°</th><th>Quoi</th><th>Quand</th><th></th></tr>${p.rappels
        .map((r) => `<tr${r.actif ? "" : ' style="opacity:.55"'}><td>${r.id}</td>
          <td><span class="p">${r.type === "tache" ? "tâche" : "rappel"}</span> ${esc(r.quoi.slice(0, 160))}${r.dernier_resultat && r.type === "tache" ? `<div class="det">dernier résultat : ${esc(r.dernier_resultat.slice(0, 140))}</div>` : ""}</td>
          <td class="det">${r.actif ? esc(heureLocale(r.prochain)) : "terminé"}${r.cron ? `<br>rythme ${esc(r.cron)}` : ""}${r.executions ? `<br>${r.executions} fois` : ""}</td>
          <td>${r.actif ? action("rappel_annuler", { rid: r.id }, "Annuler") : action("rappel_supprimer", { rid: r.id }, "Retirer", "danger")}</td></tr>`)
        .join("")}</table>`
    : `<p class="vide">Rien de planifié.</p>`;
  return `<h2 id="rappels">Rappels et tâches</h2>
<p class="aide">Un <b>rappel</b> t'envoie le texte tel quel à l'heure dite (gratuit). Une <b>tâche</b> est une demande qu'il exécute à l'heure dite, avec tous ses outils, et dont il t'envoie le résultat. Sur WhatsApp : « rappelle-moi demain 9 h de… », « chaque matin à 8 h, donne-moi… ». Heures de ${esc(p.tz)}.</p>
${liste}
<form class="ajout" method="post">
  <input type="hidden" name="op" value="rappel_creer">
  <div class="grille">
    <label>Type<select name="type"><option value="rappel">Rappel (texte envoyé tel quel)</option><option value="tache">Tâche (il l'exécute)</option></select></label>
    <label>Une fois, le<input name="quand" type="datetime-local"></label>
    <label>Ou chaque… <span class="det">(cron : « 0 8 * * * » = chaque jour 8 h)</span><input name="cron" placeholder="0 8 * * 1-5"></label>
  </div>
  <label>Quoi<textarea name="quoi" maxlength="1000" required placeholder="Ex. rappel : payer IONOS. Ex. tâche : cherche le prix du Titan Gel sur DHgate et compare avec hier."></textarea></label>
  <button class="principal">Planifier</button>
</form>`;
}

export function sectionCompetences(p: PlusState): string {
  const liste = p.competences.length
    ? p.competences
        .map((c) => `<details class="s" style="display:block${c.actif ? "" : ";opacity:.55"}"><summary style="color:var(--fg)"><b>${esc(c.nom)}</b>${c.actif ? "" : ' <span class="p warn">en pause</span>'} <span class="det">— quand ${esc(c.quand)}</span></summary>
          <form method="post" style="margin-top:.5rem"><input type="hidden" name="op" value="competence_enregistrer"><input type="hidden" name="nom" value="${esc(c.nom)}">
            <label>Quand l'appliquer<input name="quand" value="${esc(c.quand)}" maxlength="300"></label>
            <label>Comment<textarea name="instructions" maxlength="${INSTRUCTIONS_MAX}">${esc(c.instructions)}</textarea></label>
            <button class="principal">Enregistrer</button></form>
          <div class="act">${action("competence_basculer", { nom: c.nom, etat: c.actif ? "off" : "on" }, c.actif ? "Mettre en pause" : "Réactiver")} ${action("competence_oublier", { nom: c.nom }, "Supprimer", "danger", `Supprimer la compétence « ${c.nom} » ?`)}</div>
        </details>`)
        .join("")
    : `<p class="vide">Aucune compétence apprise. Dis-lui sur WhatsApp : « à partir de maintenant, quand… fais… ».</p>`;
  return `<h2 id="competences">Compétences</h2>
<p class="aide">Ce que tu lui apprends une fois et qu'il applique ensuite tout seul, dans chaque conversation — une méthode, un format, une règle. Un FAIT va dans la mémoire ; une FAÇON DE FAIRE, ici. Même nom = la nouvelle version remplace l'ancienne.</p>
${liste}
<form class="ajout" method="post">
  <input type="hidden" name="op" value="competence_enregistrer">
  <div class="grille">
    <label>Nom<input name="nom" maxlength="60" required placeholder="prix 1688"></label>
    <label>Quand l'appliquer<input name="quand" maxlength="300" required placeholder="quand je demande un prix sur 1688 ou DHgate"></label>
  </div>
  <label>Comment<textarea name="instructions" maxlength="${INSTRUCTIONS_MAX}" required placeholder="Convertis toujours en couronnes suédoises, ajoute les frais de port vers la Suède, et donne le prix total par unité pour 10, 50 et 100 pièces."></textarea></label>
  <button class="principal">Apprendre la compétence</button>
</form>`;
}

export function sectionDeclencheurs(p: PlusState): string {
  const averti = p.gmail
    ? ""
    : `<p class="notice warn">Gmail n'est pas branché sur le serveur (jeton Google absent ou révoqué) : les déclencheurs sont enregistrés mais ne tournent pas. Refais <code>deploy/google-auth.ps1</code> pour les activer.</p>`;
  const liste = p.declencheurs.length
    ? `<table><tr><th>Nom</th><th>Condition</th><th>Consigne</th><th class="n">Fois</th><th></th></tr>${p.declencheurs
        .map((d) => `<tr${d.actif ? "" : ' style="opacity:.55"'}><td>${esc(d.nom)}</td><td class="det">${esc(decrire(d))}</td><td class="det">${esc(d.consigne.slice(0, 120))}</td><td class="n">${d.declenches}</td>
          <td>${action("declencheur_basculer", { did: d.id, etat: d.actif ? "off" : "on" }, d.actif ? "Pause" : "Reprendre")} ${action("declencheur_supprimer", { did: d.id }, "Supprimer", "danger", `Supprimer « ${d.nom} » ?`)}</td></tr>`)
        .join("")}</table>`
    : `<p class="vide">Aucun déclencheur.</p>`;
  return `<h2 id="declencheurs">Surveillance de la boîte mail</h2>
<p class="aide">Quand un e-mail correspond, il exécute ta consigne (résumer, extraire les dates et montants, préparer une réponse en brouillon) et t'envoie le résultat sur WhatsApp. Vérifié toutes les 5 minutes ; seuls les e-mails arrivés après la création comptent. Le contenu d'un e-mail est traité à part, sans accès à tes outils : il peut préparer un brouillon, jamais envoyer.</p>
${averti}
${liste}
<form class="ajout" method="post">
  <input type="hidden" name="op" value="declencheur_creer">
  <div class="grille">
    <label>Nom<input name="nom" maxlength="80" required placeholder="Factures"></label>
    <label>De <span class="det">(adresse ou domaine, facultatif)</span><input name="expediteur" maxlength="200" placeholder="ionos.com"></label>
    <label>Mots de l'objet <span class="det">(séparés par des virgules, l'un OU l'autre)</span><input name="sujet" maxlength="200" placeholder="facture, invoice, faktura"></label>
    <label style="display:flex;gap:.5rem;align-items:center;color:var(--fg);margin-top:1.4rem"><input type="checkbox" name="piece_jointe" value="on" style="width:auto;margin:0"> Seulement avec pièce jointe</label>
  </div>
  <label>Consigne<textarea name="consigne" maxlength="1500" required placeholder="Extrais le montant, la date d'échéance et le fournisseur. Dis-moi en une ligne si c'est urgent."></textarea></label>
  <button class="principal">Créer le déclencheur</button>
</form>`;
}

export function sectionImages(p: PlusState): string {
  return `<h2 id="images">Images</h2>
<p class="aide">Il crée une image quand tu le lui demandes (« fais-moi une bannière pour mon site IPTV ») et te l'envoie sur WhatsApp.</p>
${p.image
    ? `<form method="post"><input type="hidden" name="op" value="testimage"><button>Tester : m'envoyer une image</button></form>`
    : `<p class="notice warn">Aucun service « image ». Ajoute-le dans le formulaire des services : identifiant <code>image</code>, type « Compatible OpenAI », et au choix — <b>OpenAI</b> : adresse <code>https://api.openai.com/v1</code>, modèle <code>gpt-image-1</code> ; <b>xAI, le moteur de Grok</b> : adresse <code>https://api.x.ai/v1</code>, modèle <code>grok-imagine-image-2.0</code>. Puis ta clé.</p>`}`;
}
